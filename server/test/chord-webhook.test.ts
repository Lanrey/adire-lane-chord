// specs/07: Chord booking webhooks → confirmPayment, and per-order catalog sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { verifyChordSignature, orderRefFromBooking } from '../src/chordWebhook.ts';
import { ChordCatalogSync } from '../src/chordSync.ts';
import { startServer, MCP_TOKEN } from './http-helpers.ts';
import { stockOf } from './helpers.ts';

const SECRET = 'whsec_test_secret_for_adire_lane';

test('P-4 signature matches the vector published in the Chord webhooks guide', () => {
  const body = Buffer.from('{"id":"9f1c2f7e-4a1b-4d21-9a45-1f0e6bb0c111","type":"chat.completed","timestamp":1800000000000,"data":{"session_id":"sess_42","teammate_id":"tm_support"}}');
  const vector = 'sha256=3e77061fd99ee2f98a54f25aaa298098ffdaf55f8706ace0a24c52dde9bdfcb8';
  assert.equal(verifyChordSignature('whsec_a_long_random_string', body, vector), true);
  assert.equal(verifyChordSignature('whsec_a_long_random_string', body, vector.replace(/.$/, '0')), false);
  assert.equal(verifyChordSignature('wrong', body, vector), false);
  assert.equal(verifyChordSignature('whsec_a_long_random_string', body, undefined), false);
});

test('order reference is found in title, description or payment message', () => {
  assert.equal(orderRefFromBooking({ title: 'Adire Lane order al-abc234' }), 'AL-ABC234');
  assert.equal(orderRefFromBooking({ title: 'Payment', payment_message: 'Pay for AL-XYZ789 here' }), 'AL-XYZ789');
  assert.equal(orderRefFromBooking({ title: 'Consultation' }), null);
});

// Fake Chord catalog API recording what the backend sends.
const catalogPuts: { items: { id: string; amount_minor: number }[] }[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/catalogs') && (!init?.method || init.method === 'GET')) return json({ catalogs: [] });
  if (u.endsWith('/catalogs') && init?.method === 'POST' && u.includes('/workspaces/')) return json({ id: 'cat-1', name: 'Adire Lane orders' }, 201);
  if (u.includes('/teammates/') && u.endsWith('/catalogs')) return json({ ok: true });
  if (u.includes('/catalogs/cat-1') && init?.method === 'PUT') { catalogPuts.push(JSON.parse(String(init.body))); return json({ id: 'cat-1' }); }
  return json({ error: { code: 'NOT_FOUND' } }, 404);
}) as typeof fetch;

let srv: Awaited<ReturnType<typeof startServer>>;
let client: Client;
before(async () => {
  const sync = new ChordCatalogSync({ baseUrl: 'https://chord.test', apiKey: 'k', workspaceId: 'ws', teammateId: 'tm' }, fakeFetch);
  srv = await startServer({ paymentMode: 'chord', chordWebhookSecret: SECRET }, { catalogSync: sync });
  client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
});
after(async () => { await client.close(); await srv.close(); });

const send = (event: unknown, deliveryId: string, secret = SECRET) => {
  const body = JSON.stringify(event);
  return fetch(`${srv.base}/webhooks/chord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chord-Delivery-Id': deliveryId, 'X-Chord-Event': (event as { type: string }).type,
      'X-Chord-Signature': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') },
    body,
  });
};

test('P-2/P-3 chord mode: order returns no link of ours, syncs exact total to the catalog', async () => {
  const r = await client.callTool({ name: 'create_pending_order', arguments: {
    customer_name: 'Ada Obi', customer_phone: '08031234567', sku: 'TS-105-WHT-XL', quantity: 1, fulfilment_method: 'pickup' } });
  const data = JSON.parse((r.content as { text: string }[])[0].text);
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(data.payment_link, undefined, 'no self-issued payment link in chord mode');
  assert.equal(data.payment_mode, 'chord');
  assert.equal(data.payment_ready, true);
  assert.match(data.next_step, /initialize_transaction/);
  const last = catalogPuts.at(-1)!;
  assert.deepEqual(last.items.map((i) => [i.id, i.amount_minor]), [[data.order_reference, 1400000]]);
  (globalThis as { ref?: string }).ref = data.order_reference;
});

test('P-4 booking.confirmed with matching amount confirms once; retries and duplicates are no-ops', async () => {
  const ref = (globalThis as { ref?: string }).ref!;
  const evt = { id: 'evt-1', type: 'booking.confirmed', timestamp: Date.now(), data: { booking_id: 'bk_1', title: `Adire Lane order ${ref}`, status: 'confirmed', amount_paid: '14000.00', currency: 'NGN', paystack_transaction_reference: 'T123' } };
  assert.equal((await send(evt, 'dlv-1', 'wrong-secret')).status, 401, 'bad signature rejected');
  const first = await (await send(evt, 'dlv-1')).json();
  assert.equal(first.outcome, 'confirmed');
  assert.equal((await (await send(evt, 'dlv-1')).json()).outcome, 'duplicate_delivery', 'same delivery retried');
  assert.equal((await (await send({ ...evt, id: 'evt-2' }, 'dlv-2')).json()).outcome, 'already_processed', 'second registration / same booking');
  assert.equal(stockOf(srv.db, 'TS-105-WHT-XL'), 3, 'stock committed exactly once');
  const status = await client.callTool({ name: 'get_payment_status', arguments: { order_reference: ref } });
  assert.equal(JSON.parse((status.content as { text: string }[])[0].text).payment_status, 'paid');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(catalogPuts.at(-1)!.items, [], 'paid order removed from the payable catalog');
});

test('P-4/P-5 wrong amount is not confirmed and opens a handover; unrelated events are acknowledged', async () => {
  const r = await client.callTool({ name: 'create_pending_order', arguments: {
    customer_name: 'Bayo', customer_phone: '08022223333', sku: 'SV-001', quantity: 1, fulfilment_method: 'pickup' } });
  const ref = JSON.parse((r.content as { text: string }[])[0].text).order_reference;
  const bad = { id: 'evt-3', type: 'booking.confirmed', timestamp: Date.now(), data: { booking_id: 'bk_2', title: `Order ${ref}`, amount_paid: '100', currency: 'NGN' } };
  assert.equal((await (await send(bad, 'dlv-3')).json()).outcome, 'amount_mismatch_handover');
  const row = srv.db.prepare('SELECT payment_status FROM orders WHERE reference = ?').get(ref) as { payment_status: string };
  assert.equal(row.payment_status, 'unpaid');
  assert.equal((await (await send({ id: 'e4', type: 'booking.payment_late', timestamp: 1, data: { booking_id: 'bk_3', title: `Order ${ref}` } }, 'dlv-4')).json()).outcome, 'handover_opened');
  assert.equal((await (await send({ id: 'e5', type: 'conversation.escalated', timestamp: 1, data: {} }, 'dlv-5')).json()).outcome, 'ignored_event_type');
});

test('C-2 live contract: order returns exact initialize_transaction args; Paystack verify sweep confirms once and only at the right amount', async () => {
  const { startServer: start } = await import('./http-helpers.ts');
  const txns = new Map<string, { status: string; amount: number }>();
  const verifyImpl = async (_k: string, ref: string) => {
    const t = txns.get(ref);
    return t ? { reference: ref, status: t.status, amount: t.amount, currency: 'NGN', metadata: JSON.stringify({ order_reference: ref }) } : null;
  };
  const { fakeChord } = await import('./fake-chord.ts');
  const { ChordApi } = await import('../src/chordApi.ts');
  const fc = fakeChord();
  const s2 = await start({ paymentMode: 'chord', chordWebhookSecret: SECRET, paystackSecretKey: 'sk_test_x' },
    { api: new ChordApi({ baseUrl: 'https://chord.test', apiKey: 'k', workspaceId: 'ws', teammateId: fc.teammateId }, fc.fetchImpl, 1000), paystackVerifyImpl: verifyImpl });
  const c = new Client({ name: 't2', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${s2.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  const mk = async () => JSON.parse(((await c.callTool({ name: 'create_pending_order', arguments: {
    customer_name: 'Funmi Bello', customer_phone: '08061234567', sku: 'TS-105-WHT-XL', quantity: 1, fulfilment_method: 'pickup' } })).content as { text: string }[])[0].text);
  const o = await mk();
  assert.equal(o.payment_tool, 'initialize_transaction');
  assert.deepEqual({ a: o.payment_tool_args.amount_kobo, r: o.payment_tool_args.reference }, { a: 1400000, r: o.order_reference });
  const again = await mk();
  assert.equal(again.order_reference, o.order_reference, 'no duplicate order on repeat');
  assert.match(again.next_step, /do NOT create another/);

  const sweep = (s2 as unknown as { db: unknown }) && (await fetch(`${s2.base}/admin/sweep`, { method: 'POST', headers: { Authorization: 'Bearer admin-test-token-0123456789abcdef' } }));
  assert.equal(sweep.status, 200);
  // wrong amount from the model-filled tool → never confirmed, owner alerted
  txns.set(o.order_reference, { status: 'success', amount: 100 });
  await fetch(`${s2.base}/admin/sweep`, { method: 'POST', headers: { Authorization: 'Bearer admin-test-token-0123456789abcdef' } });
  let row = s2.db.prepare('SELECT payment_status FROM orders WHERE reference = ?').get(o.order_reference) as { payment_status: string };
  assert.equal(row.payment_status, 'unpaid');
  assert.equal((s2.db.prepare("SELECT COUNT(*) AS n FROM handover WHERE order_reference = ?").get(o.order_reference) as { n: number }).n, 1);
  // correct amount → confirmed exactly once
  txns.set(o.order_reference, { status: 'success', amount: 1400000 });
  for (let i = 0; i < 2; i++) await fetch(`${s2.base}/admin/sweep`, { method: 'POST', headers: { Authorization: 'Bearer admin-test-token-0123456789abcdef' } });
  row = s2.db.prepare('SELECT payment_status FROM orders WHERE reference = ?').get(o.order_reference) as { payment_status: string };
  assert.equal(row.payment_status, 'paid');
  assert.equal(stockOf(s2.db, 'TS-105-WHT-XL'), 3);
  await c.close();
  await s2.close();
});
