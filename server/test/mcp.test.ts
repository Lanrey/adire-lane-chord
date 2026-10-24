// FR-06 tools over MCP Streamable HTTP + contract checks T-1..T-5 (specs/04-tool-contracts.md)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, MCP_TOKEN } from './http-helpers.ts';
import { TOOL_NAMES } from '../src/tools.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
let client: Client;

async function connect(token: string) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { raw: r, data: JSON.parse((r.content as { text: string }[])[0].text) };
}

before(async () => { srv = await startServer(); client = await connect(MCP_TOKEN); });
after(async () => { await client.close(); await srv.close(); });

test('T-5 tool list is exactly the contract', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  const create = tools.find((t) => t.name === 'create_pending_order')!;
  const props = Object.keys((create.inputSchema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props.sort(), ['customer_name', 'customer_phone', 'delivery_address', 'delivery_zone', 'extra_items', 'fulfilment_method', 'offer_id', 'quantity', 'sku']);
  // T-7: every top-level property is a scalar, except extra_items (array, also accepted as a JSON string)
  const types = Object.values((create.inputSchema as { properties: Record<string, { type?: string }> }).properties).map((p) => p.type ?? 'any');
  assert.ok(!types.includes('object'), `no nested objects: ${types}`);
});

test('bad bearer token is rejected', async () => {
  const res = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${srv.base}/mcp`)).status, 405);
});

test('full sales flow over MCP: search → stock → negotiate → order → claim → pay → status', async () => {
  const s = await call('search_products', { query: 'black oversized tee 3xl' });
  assert.equal(s.data.ok, true);
  assert.ok(s.data.results.some((r: { code: string }) => r.code === 'TS-104'));

  const stock = await call('check_stock', { sku: 'TS-104-BLK-3XL', quantity: 1 });
  assert.equal(stock.data.can_fulfil, true);

  const low = await call('calculate_offer', { sku: 'TS-104-BLK-3XL', requested_unit_price: 11000, quantity: 1 });
  assert.equal(low.data.decision, 'rejected_below_floor');
  const deal = await call('calculate_offer', { sku: 'TS-104-BLK-3XL', requested_unit_price: low.data.counter_offer, quantity: 1 });
  assert.equal(deal.data.decision, 'accepted');

  const o = await call('create_pending_order', {
    customer_name: 'Tolu Ade', customer_phone: '+2348090000000',
    sku: 'TS-104-BLK-3XL', quantity: 1, offer_id: deal.data.offer_id.toLowerCase(),
    fulfilment_method: 'delivery', delivery_zone: 'lagos_mainland', delivery_address: '3 Akoka Road, Yaba',
  });
  assert.equal(o.data.ok, true, JSON.stringify(o.data));
  assert.equal(o.data.total, deal.data.unit_price + 2500);
  assert.equal(o.data.payment_mode, 'simulated');

  // AT-07 over the wire
  const claim = await call('get_payment_status', { order_reference: o.data.order_reference });
  assert.equal(claim.data.payment_status, 'unpaid');

  // Simulated checkout: open page (gets nonce) → submit → paid
  const html = await (await fetch(`${srv.base}/pay/${o.data.order_reference}`)).text();
  assert.match(html, /TEST MODE — SIMULATED PAYMENT/);
  const nonce = html.match(/name="nonce" value="([0-9a-f]+)"/)![1];
  const post = () => fetch(`${srv.base}/pay/${o.data.order_reference}/simulate`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}` });
  assert.equal((await post()).status, 303);
  assert.equal((await post()).status, 303, 'double-submit is harmless');
  const paid = await call('get_payment_status', { order_reference: o.data.order_reference });
  assert.equal(paid.data.payment_status, 'paid');
  const after = await call('check_stock', { sku: 'TS-104-BLK-3XL', quantity: 1 });
  assert.equal(after.data.available, 1, 'exactly one unit deducted');
});

test('T-1 the model cannot pass a price into create_pending_order', async () => {
  const r = await client.callTool({ name: 'create_pending_order', arguments: {
    customer_name: 'Sneaky', customer_phone: '08011112222', sku: 'TS-105-WHT-XL', quantity: 1, unit_price: 100,
    fulfilment_method: 'pickup',
  } });
  assert.equal(r.isError, true);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id IN (SELECT id FROM customer WHERE name = ?)').get('Sneaky')!.n, 0);
});

test('business errors come back as ok:false envelopes, not transport errors', async () => {
  const r = await call('check_stock', { sku: 'ZZ-999', quantity: 1 });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error.code, 'NOT_FOUND');
  const oos = await call('create_pending_order', { customer_name: 'Bayo', customer_phone: '08022223333', sku: 'SN-210-BLK-43', quantity: 1, fulfilment_method: 'pickup' });
  assert.equal(oos.data.error.code, 'INSUFFICIENT_STOCK');
});

test('AT-10 request_human_handover over MCP', async () => {
  const r = await call('request_human_handover', { reason_category: 'customer_request', summary: 'Customer asked to speak to Kemi about a bulk order.', customer_phone: '08033334444' });
  assert.equal(r.data.ok, true);
  assert.match(r.data.next_step, /handover_to_human/);
});

test('tool calls are logged without customer details', () => {
  const rows = srv.db.prepare('SELECT * FROM tool_log').all() as Record<string, unknown>[];
  assert.ok(rows.length >= 8);
  assert.ok(!JSON.stringify(rows).includes('Tolu'), 'no names in tool_log');
});

test('R-4.5 /mcp rate limit returns 429 with Retry-After', async () => {
  const { startServer: start } = await import('./http-helpers.ts');
  const s2 = await start({ mcpMaxPerMinute: 2 });
  const hit = () => fetch(`${s2.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  await hit(); await hit();
  const third = await hit();
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  await s2.close();
});

test('T-7 multi-item orders accept extra_items as an array or a JSON string; numeric strings are coerced', async () => {
  const asString = await call('create_pending_order', {
    customer_name: 'Kunle', customer_phone: '08055556666', sku: 'TS-105-WHT-XL', quantity: '1',
    extra_items: JSON.stringify([{ sku: 'SV-001', quantity: 1 }]), fulfilment_method: 'pickup',
  });
  assert.equal(asString.data.ok, true, JSON.stringify(asString.data));
  assert.equal(asString.data.items.length, 2);
  assert.equal(asString.data.total, 14000 + 5000);
  const asArray = await call('create_pending_order', {
    customer_name: 'Kunle', customer_phone: '08055556666', sku: 'TS-105-WHT-XL', quantity: 1,
    extra_items: [{ sku: 'SV-001', quantity: 2 }], fulfilment_method: 'pickup',
  });
  assert.equal(asArray.data.total, 14000 + 10000);
});

test('checkout link tolerates punctuation glued on by chat formatting', async () => {
  for (const junk of ['.', ')', '**', ',']) {
    const r = await fetch(`${srv.base}/pay/AL-ABC234${junk}`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/pay/AL-ABC234');
  }
});
