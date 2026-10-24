// One rate-limited client for every backend → Chord call (specs/07 P-7, specs/08): ≤ 20 rpm, 5s timeout.
import { now } from './db.ts';

export type ChordApiConfig = { baseUrl: string; apiKey: string; workspaceId: string; teammateId: string };

export class ChordApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ChordApi {
  cfg: ChordApiConfig;
  fetchImpl: typeof fetch;
  maxPerMinute: number;
  calls: number[] = [];
  constructor(cfg: ChordApiConfig, fetchImpl: typeof fetch = fetch, maxPerMinute = 20) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.maxPerMinute = maxPerMinute;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const t = now();
    this.calls = this.calls.filter((c) => t - c < 60_000);
    if (this.calls.length >= this.maxPerMinute) throw new ChordApiError(429, 'LOCAL_RATE_BUDGET', 'backend Chord budget exhausted; will retry on next sweep');
    this.calls.push(t);
    const res = await this.fetchImpl(this.cfg.baseUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code: string | null = null;
      try { code = JSON.parse(text)?.error?.code ?? null; } catch { /* not JSON */ }
      throw new ChordApiError(res.status, code, `${method} ${path} → ${res.status} ${code ?? ''}: ${text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  get ws() { return encodeURIComponent(this.cfg.workspaceId); }
  get tm() { return encodeURIComponent(this.cfg.teammateId); }
}
