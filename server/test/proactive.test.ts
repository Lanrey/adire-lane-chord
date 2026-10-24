// specs/08: proactive updates, waitlist + restock, lost demand, owner brief/MCP, payment failure, reconciliation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, MCP_TOKEN, ADMIN_TOKEN } from './http-helpers.ts';
import { fakeChord } from './fake-chord.ts';
import { ChordApi } from '../src/chordApi.ts';
import { Notifier } from '../src/notify.ts';
import { Sweeper } from '../src/sweeper.ts';
import { order, stockOf } from './helpers.ts';
import { ownerBrief } from '../src/ownerBrief.ts';

const OWNER_TOKEN = 'owner-test-token-0123456789abcdef';
const SECRET = 'whsec_proactive_test';
const chord = fakeChord();
const api = new ChordApi({ baseUrl: 'https://chord.test', apiKey: 'k', workspaceId: 'ws', teammateId: chord.teammateId }, chord.fetchImpl, 1000);
let srv: Awaited<ReturnType<typeof startServer>>;
let client: Client;
let notifier: Notifier;

before(async () => {
  srv = await startServer({ ownerMcpToken: OWNER_TOKEN, chordWebhookSecret: SECRET }, { api, notifier: undefined });
  notifier = new Notifier(srv.db, api);
  client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
});
after(async () => { await client.close(); await srv.close(); });

const call = async (name: string, args: Record<string, unknown>, c = client) => {
  const text = ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  try { return JSON.parse(text); } catch { throw new Error(text); }
};
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${srv.base}/admin${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) } });

test('I-1 payment received → one free MESSAGE into the thread where the agent quoted the order, plus a purchase memory', async () => {
  const o = order(srv.db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }]);
  chord.addThread('th-1', `Your order ${o.order_reference} is created`);
  // confirm through the trusted admin event, which funnels into afterPaid()
  const r = await admin(`/orders/${o.order_reference}/confirm-payment`, { method: 'POST', headers: { 'Idempotency-Key': 'k1' } });
  assert.equal((await r.json()).outcome, 'confirmed');
  await new Promise((res) => setTimeout(res, 100));
  const task = chord.state.tasks.at(-1)!;
  assert.equal((task.body as { task_type: string }).task_type, 'MESSAGE');
  const payload = (task.body as { payload: { platform: string; conversation_id: string; body: string } }).payload;
  assert.equal(payload.platform, 'DIRECT_LINE');
  assert.equal(payload.conversation_id, 'th-1');
  assert.match(payload.body, /We've received your payment of ₦14,000/);
  assert.match(payload.body, new RegExp(`order number is ${o.order_reference}`));
  assert.doesNotMatch(payload.body, /https?:\/\//, 'no links in proactive messages (link guard)');
  assert.equal(chord.state.memories.at(-1)!.customer_id, 'sim:th-1');
  assert.match(String(chord.state.memories.at(-1)!.content), /TS-105-WHT-XL/);
  // second confirmation attempt → no second message
  const before = chord.state.tasks.length;
  await notifier.paymentReceived(o.order_reference);
  assert.equal(chord.state.tasks.length, before, 'at most one message per (order, kind)');
});

test('I-1 never messages a thread a human has taken over, or a thread of another teammate', async () => {
  const a = order(srv.db, [{ sku: 'SV-001', quantity: 1 }]);
  chord.addThread('th-human', `ref ${a.order_reference}`, 'human_active');
  assert.equal((await notifier.holdReminder(a.order_reference, 10)).status, 'skipped');
  const b = order(srv.db, [{ sku: 'SV-001', quantity: 1 }]);
  chord.addThread('th-other', `ref ${b.order_reference}`, 'agent_active', 'some-other-teammate');
  assert.equal((await notifier.holdReminder(b.order_reference, 10)).status, 'failed');
});

test('I-1 hold reminder fires once ~20 min into the hold, only while unpaid', async () => {
  const o = order(srv.db, [{ sku: 'TS-106-BLK-XL', quantity: 1 }]);
  chord.addThread('th-hold', `order ${o.order_reference}`);
  srv.db.prepare('UPDATE orders SET created_at = ? WHERE reference = ?').run(Date.now() - 21 * 60_000, o.order_reference);
  const sweeper = new Sweeper(srv.db, notifier);
  await sweeper.tick();
  await sweeper.tick();
  const reminders = chord.state.tasks.filter((t) => JSON.stringify(t.body).includes('"th-hold"') && JSON.stringify(t.body).includes('more minutes'));
  assert.equal(reminders.length, 1);
});

test('I-2 sold out → waitlist → owner restocks → customer gets one restock message', async () => {
  const stock = await call('check_stock', { sku: 'TS-104-BLK-XL', quantity: 1 });
  assert.equal(stock.can_fulfil, false);
  assert.match(stock.waitlist_hint, /notify_me_when_available/);
  const wl = await call('notify_me_when_available', { sku: 'TS-104-BLK-XL', customer_name: 'Tolu', customer_phone: '08090000000' });
  assert.match(wl.waitlist_reference, /^WL-[0-9A-F]{6}$/);
  assert.equal(wl.people_waiting, 1);
  const again = await call('notify_me_when_available', { sku: 'TS-104-BLK-XL', customer_name: 'Tolu', customer_phone: '+2348090000000' });
  assert.equal(again.waitlist_reference, wl.waitlist_reference, 'same person, same list entry');
  chord.addThread('th-wl', `You're on the list, reference ${wl.waitlist_reference}`);
  await admin('/variants/TS-104-BLK-XL', { method: 'PATCH', body: JSON.stringify({ stock_quantity: 5 }) });
  await new Promise((res) => setTimeout(res, 100));
  const msgs = chord.state.tasks.filter((t) => JSON.stringify(t.body).includes('"th-wl"'));
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0].body), /back in stock/);
  const list = await (await admin('/waitlist')).json();
  assert.equal(list.find((w: { id: string }) => w.id === wl.waitlist_reference).status, 'notified');
});

test('I-2 lost demand is logged: no match, sold out, below floor, fixed-price haggling', async () => {
  await call('search_products', { query: 'iphone charger' });
  await call('calculate_offer', { sku: 'TS-104-BLK-3XL', requested_unit_price: 9000, quantity: 1 });
  await call('calculate_offer', { sku: 'TS-105-WHT-XL', requested_unit_price: 10000, quantity: 1 });
  const kinds = (srv.db.prepare('SELECT kind FROM demand_event').all() as { kind: string }[]).map((k) => k.kind);
  for (const k of ['no_match', 'out_of_stock', 'below_floor', 'fixed_price_haggle', 'waitlist_join']) assert.ok(kinds.includes(k), `missing ${k}`);
});

test('I-3 owner brief numbers and a separate owner-only MCP server', async () => {
  const brief = ownerBrief(srv.db);
  assert.ok(brief.numbers.paid_orders >= 1);
  assert.equal(brief.summary_lines.length, 7);
  assert.match(brief.summary_lines.join(' '), /Assistant impact/);
  assert.ok(brief.missed_demand.some((d) => d.kind === 'below_floor' && d.avg_offer === 9000));
  // owner MCP: wrong token refused; customer token refused; only get_owner_brief exposed
  const tryOwner = async (token: string) => {
    const c = new Client({ name: 'o', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/owner`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  await assert.rejects(tryOwner(MCP_TOKEN), 'customer-facing token cannot reach owner data');
  const owner = await tryOwner(OWNER_TOKEN);
  assert.deepEqual((await owner.listTools()).tools.map((t) => t.name).sort(),
    ['get_owner_brief', 'list_open_handovers', 'resolve_handover', 'set_price_rules', 'update_stock']);
  const viaMcp = await call('get_owner_brief', {}, owner);
  assert.equal(viaMcp.ok, true);
  await owner.close();
  const customerTools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['get_owner_brief', 'update_stock', 'set_price_rules', 'resolve_handover']) assert.ok(!customerTools.includes(t), `sales teammate never sees ${t}`);
});

test('Integration: booking.payment_failed → last_failure for the agent + friendly proactive message', async () => {
  const o = order(srv.db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  chord.addThread('th-fail', `order ${o.order_reference}`);
  const body = JSON.stringify({ id: 'e-f', type: 'booking.payment_failed', timestamp: Date.now(), data: { booking_id: 'bk_f', title: `Adire Lane order ${o.order_reference}`, reason: 'Declined by bank' } });
  const res = await fetch(`${srv.base}/webhooks/chord`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Chord-Delivery-Id': 'd-f', 'X-Chord-Signature': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex') } });
  assert.equal((await res.json()).outcome, 'payment_failed_recorded');
  const status = await call('get_payment_status', { order_reference: o.order_reference });
  assert.equal(status.payment_status, 'unpaid');
  assert.equal(status.last_failure.reason, 'Declined by bank');
  await new Promise((r) => setTimeout(r, 100));
  const msg = chord.state.tasks.find((t) => JSON.stringify(t.body).includes(`didn't go through`) && JSON.stringify(t.body).includes('"th-fail"'));
  assert.ok(msg, 'customer told about the failure');
  assert.match(JSON.stringify(msg!.body), /the bank declined it/);
  assert.equal(stockOf(srv.db, 'SN-210-BLK-42'), 1, 'no stock change on failure');
});

test('I-5 reconciliation confirms a paid booking whose webhook never arrived, exactly once', async () => {
  const o = order(srv.db, [{ sku: 'TS-106-BLK-2XL', quantity: 1 }]);
  chord.state.bookings.push({ id: 'bk_missed', title: `Adire Lane order ${o.order_reference}`, status: 'confirmed', amount_paid: '18000.0', currency: 'NGN', paystack_transaction_reference: 'T999' });
  const paid: string[] = [];
  const sweeper = new Sweeper(srv.db, notifier, { api, reconcileBookings: true, onPaid: (r) => paid.push(r) });
  await sweeper.reconcile();
  sweeper.lastReconcile = 0;
  await sweeper.reconcile();
  assert.deepEqual(paid, [o.order_reference]);
  assert.equal(stockOf(srv.db, 'TS-106-BLK-2XL'), 1);
});

test('G-1 owner runs the shop by chat: restock triggers waitlist messages, price rules validated, handovers resolved, all audited', async () => {
  const owner = new Client({ name: 'o2', version: '1' });
  await owner.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/owner`), { requestInit: { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } } }));
  // a fresh waitlist entry on a sold-out size
  srv.db.prepare("UPDATE variant SET stock_quantity = 0 WHERE sku = 'SN-210-BLK-43'").run();
  const wl = await call('notify_me_when_available', { sku: 'SN-210-BLK-43', customer_name: 'Ike', customer_phone: '08077770000' });
  chord.addThread('th-owner-wl', `Restock alert ${wl.waitlist_reference}`);
  const noPin = await call('update_stock', { sku: 'sn-210-blk-43', quantity: 2, owner_pin: '000000' }, owner);
  assert.deepEqual([noPin.ok, noPin.error.message], [false, 'Wrong owner PIN. Nothing was changed.']);
  const r = await call('update_stock', { sku: 'sn-210-blk-43', quantity: 2, owner_pin: '246810' }, owner);
  assert.deepEqual([r.ok, r.stock_before, r.stock_after, r.restock_alerts_queued], [true, 0, 2, 1]);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(chord.state.tasks.some((t) => JSON.stringify(t.body).includes('"th-owner-wl"')), 'restock message sent');

  const bad = await call('set_price_rules', { code: 'TS-104', minimum_price: 99999, owner_pin: '246810' }, owner);
  assert.equal(bad.ok, false, 'floor above price rejected');
  const good = await call('set_price_rules', { code: 'TS-104', minimum_price: 14000, owner_pin: '246810' }, owner);
  assert.deepEqual([good.before.minimum_price, good.after.minimum_price], [13500, 14000]);
  const offer = await call('calculate_offer', { sku: 'TS-104-BLK-3XL', requested_unit_price: 13500, quantity: 1 });
  assert.equal(offer.decision, 'rejected_below_floor', 'sales agent sees the new floor immediately');

  await call('request_human_handover', { reason_category: 'refund', summary: 'Customer wants a refund for a damaged tee.', customer_phone: '08011110000' });
  const hos = await call('list_open_handovers', { owner_pin: '246810' }, owner);
  const id = hos.handovers[0].id;
  assert.equal((await call('resolve_handover', { handover_id: id, note: 'Refunded via bank app', owner_pin: '246810' }, owner)).status, 'resolved');
  const audits = (srv.db.prepare('SELECT tool FROM owner_action ORDER BY id').all() as { tool: string }[]).map((a) => a.tool);
  assert.deepEqual(audits, ['update_stock', 'set_price_rules', 'resolve_handover']);
  await owner.close();
});

test('G-2 impact: after-hours sales, follow-up recoveries and waitlist conversions are counted', async () => {
  const { impact, isAfterHours } = await import('../src/ownerBrief.ts');
  assert.equal(isAfterHours(Date.parse('2026-10-24T21:30:00Z')), true, '22:30 Lagos');
  assert.equal(isAfterHours(Date.parse('2026-10-24T12:00:00Z')), false, '13:00 Lagos Saturday');
  assert.equal(isAfterHours(Date.parse('2026-10-25T12:00:00Z')), true, 'Sunday');
  // waitlisted Ike buys the restocked sneakers → conversion; the order was created at night → after-hours
  const o = order(srv.db, [{ sku: 'SN-210-BLK-43', quantity: 1 }], { method: 'pickup' }, { name: 'Ike', phone: '08077770000' });
  srv.db.prepare('UPDATE orders SET created_at = ? WHERE reference = ?').run(Date.parse('2026-10-24T22:10:00Z'), o.order_reference);
  srv.db.prepare("INSERT INTO notification (key, ref, kind, status, detail, attempts, updated_at) VALUES (?, ?, 'hold_reminder', 'sent', 'queued', 1, ?)").run(`${o.order_reference}:hold_reminder`, o.order_reference, Date.now() - 1000);
  await admin(`/orders/${o.order_reference}/confirm-payment`, { method: 'POST', headers: { 'Idempotency-Key': 'imp-1' } });
  const imp = impact(srv.db, 0);
  assert.ok(imp.after_hours_sales >= 1);
  assert.ok(imp.recovered_by_followups >= 1);
  assert.ok(imp.waitlist_conversions >= 1);
  assert.ok(imp.waitlist_value >= 38000);
});

test('specs/10 L-5: every automatic customer message is plain language (no codes, units, tool words or links)', () => {
  const bodies = chord.state.tasks.map((t) => String((t.body as { payload: { body: string } }).payload.body));
  assert.ok(bodies.length >= 5);
  const banned = [/×/, /Africa\//, /made-up/i, /\bSKU\b/i, /WL-/, /\btool\b/i, /fallback/i, /https?:\/\//, /[A-Z]{2}-\d{3}-/];
  for (const b of bodies) for (const re of banned) assert.doesNotMatch(b, re, `"${b}" contains ${re}`);
});

test('specs/10 L-5: agent confirming payment itself suppresses the automatic duplicate', async () => {
  const o = order(srv.db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }]);
  chord.addThread('th-dup', `order ${o.order_reference}`);
  srv.db.prepare("UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = ? WHERE reference = ?").run(Date.now(), o.order_reference);
  const st = await call('get_payment_status', { order_reference: o.order_reference });
  assert.equal(st.payment_status, 'paid');
  const before = chord.state.tasks.length;
  assert.equal((await notifier.paymentReceived(o.order_reference)).status, 'duplicate');
  assert.equal(chord.state.tasks.length, before, 'no second confirmation message');
});

test('specs/10 L-4: customer can cancel their own unpaid order (frees stock); not someone else\'s, not a paid one', async () => {
  const before = (await call('check_stock', { sku: 'TS-104-BLK-L', quantity: 1 })).available;
  const mine = await call('create_pending_order', { customer_name: 'Bola', customer_phone: '08012340000', sku: 'TS-104-BLK-L', quantity: 1, fulfilment_method: 'pickup' });
  assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal((await call('check_stock', { sku: 'TS-104-BLK-L', quantity: 1 })).available, before - 1, 'held');
  const wrong = await call('cancel_order', { order_reference: mine.order_reference, customer_phone: '08099999999' });
  assert.equal(wrong.ok, false);
  const ok = await call('cancel_order', { order_reference: mine.order_reference, customer_phone: '+2348012340000' });
  assert.equal(ok.status, 'cancelled');
  assert.equal((await call('check_stock', { sku: 'TS-104-BLK-L', quantity: 1 })).available, before, 'released immediately');
  const again = await call('cancel_order', { order_reference: mine.order_reference, customer_phone: '08012340000' });
  assert.equal(again.ok, false, 'already cancelled');
});
