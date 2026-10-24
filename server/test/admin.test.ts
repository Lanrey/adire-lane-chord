// FR-01 owner CRUD, FR-11 order inspection, trusted admin test event
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN_TOKEN } from './http-helpers.ts';
import { order } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
const api = (path: string, init: RequestInit = {}, token = ADMIN_TOKEN) =>
  fetch(`${srv.base}/admin${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('admin routes need the admin token', async () => {
  assert.equal((await api('/orders', {}, 'wrong')).status, 401);
  assert.equal((await api('/orders')).status, 200);
});

test('FR-01 create, read and update a product with variants', async () => {
  const created = await api('/products', { method: 'POST', body: JSON.stringify({
    code: 'CP-301', name: 'Bucket Hat – Adire', base_price: 9000, pricing_mode: 'negotiable', minimum_price: 8000, tags: 'hat bucket adire',
    variants: [{ sku: 'CP-301-IND', attributes: { colour: 'indigo' }, stock_quantity: 5 }],
  }) });
  assert.equal(created.status, 201);
  const p = await api('/products/CP-301', { method: 'PATCH', body: JSON.stringify({ base_price: 9500 }) });
  assert.equal((await p.json()).base_price, 9500);
  const v = await api('/variants/CP-301-IND', { method: 'PATCH', body: JSON.stringify({ stock_quantity: 7 }) });
  assert.equal((await v.json()).variants[0].stock_quantity, 7);
  const list = await (await api('/products')).json();
  assert.ok(list.some((x: { code: string }) => x.code === 'CP-301'));
});

test('FR-01 negotiable product without a valid floor is rejected', async () => {
  const r = await api('/products', { method: 'POST', body: JSON.stringify({
    code: 'CP-302', name: 'Cap', base_price: 5000, pricing_mode: 'negotiable', minimum_price: 6000, variants: [{ sku: 'CP-302-B', stock_quantity: 1 }],
  }) });
  assert.equal(r.status, 400);
  const patch = await api('/products/TS-105', { method: 'PATCH', body: JSON.stringify({ pricing_mode: 'negotiable' }) });
  assert.equal(patch.status, 400);
});

test('FR-11 + admin test event: confirm-payment is idempotent on Idempotency-Key', async () => {
  const o = order(srv.db, [{ sku: 'TS-106-BLK-2XL', quantity: 1 }]);
  assert.equal((await api(`/orders/${o.order_reference}/confirm-payment`, { method: 'POST' })).status, 400, 'key required');
  const first = await (await api(`/orders/${o.order_reference}/confirm-payment`, { method: 'POST', headers: { 'Idempotency-Key': 'demo-1' } })).json();
  const again = await (await api(`/orders/${o.order_reference}/confirm-payment`, { method: 'POST', headers: { 'Idempotency-Key': 'demo-1' } })).json();
  assert.equal(first.outcome, 'confirmed');
  assert.equal(again.outcome, 'already_processed');
  const view = await (await api(`/orders/${o.order_reference}`)).json();
  assert.equal(view.payment_status, 'paid');
  assert.equal(view.items[0].sku, 'TS-106-BLK-2XL');
  const prods = await (await api('/products')).json();
  const v = prods.find((p: { code: string }) => p.code === 'TS-106').variants.find((x: { sku: string }) => x.sku === 'TS-106-BLK-2XL');
  assert.equal(v.stock_quantity, 1);
});

test('dashboard and health endpoints respond', async () => {
  assert.match(await (await fetch(`${srv.base}/admin`)).text(), /owner view/);
  assert.deepEqual(await (await fetch(`${srv.base}/healthz`)).json(), { ok: true, payment_mode: 'simulated' });
});

test('reset-demo restores seed stock and clears orders', async () => {
  order(srv.db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  const r = await api('/reset-demo', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(await (await api('/orders')).json(), []);
  const prods = await (await api('/products')).json();
  assert.equal(prods.find((p: { code: string }) => p.code === 'TS-104').variants.find((v: { sku: string }) => v.sku === 'TS-104-BLK-3XL').stock_quantity, 2);
});
