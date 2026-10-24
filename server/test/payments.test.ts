// AT-07 false claim, AT-08 confirmation, AT-09 duplicate confirmation (FR-08, FR-09)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb, order, stockOf } from './helpers.ts';
import { getOrderRow, getPaymentStatus } from '../src/orders.ts';
import { confirmFromPaystack, confirmPayment, verifyPaystackSignature } from '../src/payments.ts';
import { BusinessError } from '../src/errors.ts';

const link = (r: string) => `https://shop.test/pay/${r}`;

function confirm(db: ReturnType<typeof freshDb>, ref: string, key: string) {
  const o = getOrderRow(db, ref)!;
  return confirmPayment(db, { orderReference: ref, provider: 'simulated', providerReference: null, idempotencyKey: key, amountKobo: o.total, currency: 'NGN' });
}

test('AT-07 a customer saying "I have paid" changes nothing', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 1 }]);
  // The only thing the agent can do on a claim is read status.
  const s = getPaymentStatus(db, o.order_reference, link);
  assert.equal(s.payment_status, 'unpaid');
  assert.equal(s.order_status, 'pending_payment');
  assert.match(s.note, /Do not treat this order as paid/);
  assert.equal(stockOf(db, 'TS-104-BLK-3XL'), 2);
});

test('AT-08 trusted confirmation marks the order paid and deducts stock once', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 2 }], { method: 'delivery', zone: 'lagos_mainland', address: '1 Herbert Macaulay Way' });
  const r = confirm(db, o.order_reference, 'evt-1');
  assert.equal(r.outcome, 'confirmed');
  assert.equal(stockOf(db, 'TS-104-BLK-3XL'), 0);
  const s = getPaymentStatus(db, o.order_reference, link);
  assert.equal(s.payment_status, 'paid');
  assert.equal(s.order_status, 'paid');
  assert.equal(s.payment_link, null);
});

test('AT-09 the same confirmation twice, or a second event, does not double-deduct', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }]);
  assert.equal(confirm(db, o.order_reference, 'evt-1').outcome, 'confirmed');
  assert.equal(confirm(db, o.order_reference, 'evt-1').outcome, 'already_processed');
  assert.equal(confirm(db, o.order_reference, 'evt-2').outcome, 'already_processed');
  assert.equal(stockOf(db, 'TS-105-WHT-XL'), 3);
  const payments = db.prepare('SELECT status FROM payment ORDER BY id').all().map((p) => p.status);
  assert.deepEqual(payments, ['succeeded', 'ignored']);
});

test('amount mismatch is rejected and changes nothing', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }]);
  assert.throws(() => confirmPayment(db, { orderReference: o.order_reference, provider: 'paystack', providerReference: 'x', idempotencyKey: 'k', amountKobo: 100, currency: 'NGN' }),
    (e: unknown) => e instanceof BusinessError && e.code === 'AMOUNT_MISMATCH');
  assert.equal(getOrderRow(db, o.order_reference)!.payment_status, 'unpaid');
  assert.equal(stockOf(db, 'TS-105-WHT-XL'), 4);
});

test('payment after reservation expiry when stock is gone → paid_needs_attention + handover, never negative stock', () => {
  const db = freshDb();
  const first = order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  db.prepare('UPDATE orders SET reserved_until = 0 WHERE reference = ?').run(first.order_reference);
  const second = order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  assert.equal(confirm(db, second.order_reference, 'b').outcome, 'confirmed');
  const late = confirm(db, first.order_reference, 'a');
  assert.equal(late.outcome, 'confirmed_needs_attention');
  assert.equal(stockOf(db, 'SN-210-BLK-42'), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM handover WHERE order_reference = ?").get(first.order_reference)!.n, 1);
});

test('untracked services confirm without touching stock', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'SV-001', quantity: 1 }]);
  assert.equal(confirm(db, o.order_reference, 's').outcome, 'confirmed');
  assert.equal(stockOf(db, 'SV-001'), null);
});

test('Paystack: signature check and charge.success mapping are idempotent', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }]);
  const secret = 'sk_test_example';
  const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
  const sig = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(verifyPaystackSignature(secret, body, sig), true);
  assert.equal(verifyPaystackSignature(secret, body, sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')), false);
  assert.equal(verifyPaystackSignature(secret, body, undefined), false);

  const txn = { reference: `${o.order_reference}-1700000000000`, status: 'success', amount: 1400000, currency: 'NGN', metadata: { order_reference: o.order_reference } };
  assert.equal(confirmFromPaystack(db, txn, {})!.outcome, 'confirmed');
  assert.equal(confirmFromPaystack(db, txn, {})!.outcome, 'already_processed', 'webhook + verify callback for the same txn');
  assert.equal(confirmFromPaystack(db, { ...txn, status: 'failed' }, {}), null);
  assert.equal(stockOf(db, 'TS-105-WHT-XL'), 3);
});

test('live finding: Paystack reports a declined card as "abandoned" + gateway_response; a closed checkout is not a failure', async () => {
  const { isFailedAttempt } = await import('../src/sweeper.ts');
  const base = { reference: 'AL-X', amount: 1, currency: 'NGN' };
  assert.equal(isFailedAttempt({ ...base, status: 'abandoned', gateway_response: 'Transaction declined. Please use the test card.' } as never), true);
  assert.equal(isFailedAttempt({ ...base, status: 'abandoned', gateway_response: 'The transaction was not completed' } as never), false);
  assert.equal(isFailedAttempt({ ...base, status: 'failed', gateway_response: 'Insufficient Funds' } as never), true);
  assert.equal(isFailedAttempt({ ...base, status: 'success', gateway_response: 'Successful' } as never), false);
});
