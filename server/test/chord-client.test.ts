// specs/06 R-1: pacing, Retry-After, backoff, stop codes, no retry of non-idempotent POSTs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chord, ChordError, RateLimiter } from '../../scripts/chord.ts';

process.env.CHORD_API_KEY = 'test-key';
let server: Server;
let base = '';
const plan: { status: number; code?: string; headers?: Record<string, string> }[] = [];
let hits = 0;

before(async () => {
  server = createServer((_req, res) => {
    hits++;
    const step = plan.shift() ?? { status: 200 };
    res.writeHead(step.status, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '1', ...step.headers });
    res.end(JSON.stringify(step.status < 300 ? { ok: true } : { error: { code: step.code, message: 'x' } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const opts = () => ({ baseUrl: base, limiter: new RateLimiter(1000), backoffMs: 5 });

test('R-1.3 RATE_LIMIT_EXCEEDED sleeps Retry-After then succeeds', async () => {
  hits = 0;
  plan.push({ status: 429, code: 'RATE_LIMIT_EXCEEDED', headers: { 'retry-after': '1' } });
  const t = Date.now();
  assert.deepEqual(await chord('GET', '/x', undefined, opts()), { ok: true });
  assert.equal(hits, 2);
  assert.ok(Date.now() - t >= 950);
});

test('R-1.3 transient 503 codes back off and retry', async () => {
  hits = 0;
  plan.push({ status: 503, code: 'SERVICE_UNAVAILABLE' }, { status: 503, code: 'SPEND_CHECK_UNAVAILABLE' });
  await chord('GET', '/x', undefined, opts());
  assert.equal(hits, 3);
});

test('R-1.4 CREDITS_UNAVAILABLE (429) and PAYMENT_REQUIRED stop immediately', async () => {
  for (const [status, code] of [[429, 'CREDITS_UNAVAILABLE'], [402, 'PAYMENT_REQUIRED']] as const) {
    hits = 0;
    plan.push({ status, code });
    await assert.rejects(chord('GET', '/x', undefined, opts()), (e: unknown) => e instanceof ChordError && e.code === code);
    assert.equal(hits, 1);
  }
});

test('R-1.5 non-idempotent POST is not retried', async () => {
  hits = 0;
  plan.push({ status: 503, code: 'UNAVAILABLE' });
  await assert.rejects(chord('POST', '/x', {}, opts()));
  assert.equal(hits, 1);
  plan.length = 0;
});

test('R-1.1 limiter never exceeds N per window', async () => {
  const lim = new RateLimiter(3, 300);
  const t = Date.now();
  for (let i = 0; i < 4; i++) await lim.acquire();
  assert.ok(Date.now() - t >= 280, '4th call waited for the window');
});

test('R-1.2 low x-ratelimit-remaining pauses until reset', async () => {
  const lim = new RateLimiter(100);
  lim.observe(new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1' }));
  const t = Date.now();
  await lim.acquire();
  assert.ok(Date.now() - t >= 900);
});
