// Chord API client for setup scripts — rate-limited and retry-aware (specs/06 R-1).
import { randomUUID } from 'node:crypto';

export function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name} (see .env.example)`);
  return v;
}

export class ChordError extends Error {
  status: number;
  code: string | null;
  body: unknown;
  requestId: string | null;
  constructor(status: number, body: unknown, requestId: string | null, what: string) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? null;
    super(`${what} → HTTP ${status}${code ? ` ${code}` : ''}${requestId ? ` (X-Request-Id ${requestId})` : ''}: ${JSON.stringify(body)}`);
    this.status = status;
    this.code = code;
    this.body = body;
    this.requestId = requestId;
  }
}

/** Codes that only a person can clear: never retry (R-1.4). */
export const STOP_CODES = new Set(['CREDITS_UNAVAILABLE', 'PAYMENT_REQUIRED', 'MEMORY_CAP_EXCEEDED', 'CREDIT_ALLOCATION_AMBIGUOUS', 'CREDIT_POOL_UNAVAILABLE']);
const BACKOFF_CODES = new Set(['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'SPEND_CHECK_UNAVAILABLE', 'SPEND_CAP_UNAVAILABLE', 'BILLING_ADMISSION_UNAVAILABLE', 'OPERATOR_PRICING_UNAVAILABLE']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window limiter plus server-header pacing (R-1.1, R-1.2). */
export class RateLimiter {
  maxPerMinute: number;
  windowMs: number;
  sent: number[] = [];
  pauseUntil = 0;
  constructor(maxPerMinute = 50, windowMs = 60_000) {
    this.maxPerMinute = maxPerMinute;
    this.windowMs = windowMs;
  }
  async acquire(): Promise<void> {
    for (;;) {
      const t = Date.now();
      this.sent = this.sent.filter((s) => t - s < this.windowMs);
      const waitHeader = this.pauseUntil - t;
      const waitWindow = this.sent.length >= this.maxPerMinute ? this.windowMs - (t - this.sent[0]) + 5 : 0;
      const wait = Math.max(waitHeader, waitWindow);
      if (wait <= 0) { this.sent.push(t); return; }
      await sleep(wait);
    }
  }
  observe(headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.has('x-ratelimit-remaining') && remaining <= 2 && reset > 0) {
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + reset * 1000);
    }
  }
}

export const limiter = new RateLimiter(Number(process.env.CHORD_MAX_RPM ?? 50));
export let requestCount = 0;

type ChordOpts = { idempotent?: boolean; maxAttempts?: number; baseUrl?: string; limiter?: RateLimiter; backoffMs?: number };

export async function chord<T = unknown>(method: string, path: string, body?: unknown, opts: ChordOpts = {}): Promise<T> {
  const base = (opts.baseUrl ?? process.env.CHORD_BASE_URL ?? 'https://api.chordhq.xyz').replace(/\/+$/, '');
  const lim = opts.limiter ?? limiter;
  const idempotent = opts.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE');
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? 1000;

  for (let attempt = 1; ; attempt++) {
    await lim.acquire();
    requestCount++;
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${env('CHORD_API_KEY')}`,
          'X-Request-ID': randomUUID(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(130_000), // just above the 120s chat ceiling
      });
    } catch (err) {
      if (idempotent && attempt < maxAttempts) { await sleep(backoff * 2 ** (attempt - 1)); continue; }
      throw err;
    }
    lim.observe(res.headers);
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (res.ok) return parsed as T;

    const err = new ChordError(res.status, parsed, res.headers.get('x-request-id'), `${method} ${path}`);
    if (err.code && STOP_CODES.has(err.code)) throw err;
    const canRetry = idempotent && attempt < maxAttempts;
    if (canRetry && (err.code === 'RATE_LIMIT_EXCEEDED' || (res.status === 429 && !err.code))) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 1);
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }
    if (canRetry && ((err.code && BACKOFF_CODES.has(err.code)) || res.status === 503 || res.status === 502)) {
      await sleep(backoff * 2 ** (attempt - 1) + Math.random() * 250);
      continue;
    }
    throw err;
  }
}

/** Live balance in credits, from the workspace wallet statement (free read). */
export async function creditBalance(workspaceId: string): Promise<number | null> {
  const r = await chord<{ items: { balance_after_cents: number; created_at: number }[] }>('GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}/credits/transactions`);
  if (!r.items?.length) return null;
  const latest = [...r.items].sort((a, b) => b.created_at - a.created_at)[0];
  return latest.balance_after_cents / 100;
}

export const log = (step: string, msg: string) => console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
export const warn = (step: string, msg: string) => console.log(`\x1b[33m[${step}] ⚠ ${msg}\x1b[0m`);
