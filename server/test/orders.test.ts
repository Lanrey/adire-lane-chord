// AT-06 order creation (FR-07)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, order, stockOf, ada } from './helpers.ts';
import { getOrderRow, getPaymentStatus } from '../src/orders.ts';
import { checkStock } from '../src/catalogue.ts';
import { BusinessError } from '../src/errors.ts';

test('AT-06 pending order is persisted with reference, correct totals and payment link', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 2 }], { method: 'delivery', zone: 'lagos_island', address: '5 Admiralty Way, Lekki' });
  assert.match(o.order_reference, /^AL-[A-Z2-9]{6}$/);
  assert.equal(o.subtotal, 28000);
  assert.equal(o.delivery_fee, 3500);
  assert.equal(o.total, 31500);
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.payment_link, `https://shop.test/pay/${o.order_reference}`);
  const row = getOrderRow(db, o.order_reference)!;
  assert.equal(row.total, 3150000, 'stored in kobo');
  assert.equal(row.payment_status, 'unpaid');
  assert.equal(stockOf(db, 'TS-105-WHT-XL'), 4, 'stock is reserved, not deducted, before payment');
  assert.equal(checkStock(db, 'TS-105-WHT-XL', 1).available, 2);
});

test('delivery requires a known zone and an address; pickup is free', () => {
  const db = freshDb();
  const code = (c: string) => (e: unknown) => e instanceof BusinessError && e.code === c;
  assert.throws(() => order(db, [{ sku: 'SV-001', quantity: 1 }], { method: 'delivery' }), code('ZONE_REQUIRED'));
  assert.throws(() => order(db, [{ sku: 'SV-001', quantity: 1 }], { method: 'delivery', zone: 'mars' }), code('UNKNOWN_ZONE'));
  assert.throws(() => order(db, [{ sku: 'SV-001', quantity: 1 }], { method: 'delivery', zone: 'lagos_mainland' }), code('ADDRESS_REQUIRED'));
  assert.equal(order(db, [{ sku: 'SV-001', quantity: 1 }]).delivery_fee, 0);
});

test('two buyers cannot both reserve the last unit', () => {
  const db = freshDb();
  order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  assert.throws(() => order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]), (e: unknown) => e instanceof BusinessError && e.code === 'INSUFFICIENT_STOCK');
});

test('duplicate lines for the same SKU are summed against stock', () => {
  const db = freshDb();
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 2 }, { sku: 'TS-104-BLK-3XL', quantity: 1 }]),
    (e: unknown) => e instanceof BusinessError && e.code === 'INSUFFICIENT_STOCK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, 0, 'nothing persisted on failure');
});

test('expired reservations release stock (lazy expiry)', () => {
  const db = freshDb();
  const o = order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  db.prepare('UPDATE orders SET reserved_until = 0 WHERE reference = ?').run(o.order_reference);
  assert.equal(checkStock(db, 'SN-210-BLK-42', 1).can_fulfil, true);
  assert.equal(getPaymentStatus(db, o.order_reference, (r) => r).reservation_expired, true);
});

test('phone numbers are normalised to +234', () => {
  const db = freshDb();
  order(db, [{ sku: 'SV-001', quantity: 1 }], { method: 'pickup' }, ada);
  assert.equal(db.prepare('SELECT phone FROM customer').get()!.phone, '+2348031234567');
});

test('repeat create for the same customer + items returns the same order (live finding: 3 orders for 1 purchase)', () => {
  const db = freshDb();
  const a = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }], { method: 'pickup' }, ada);
  const b = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 1 }], { method: 'pickup' }, { name: 'Ada O.', phone: '+2348031234567' });
  assert.equal(b.order_reference, a.order_reference);
  assert.equal(b.existing, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, 1);
  assert.equal(checkStock(db, 'TS-105-WHT-XL', 1).available, 3, 'reserved once');
  const c = order(db, [{ sku: 'TS-105-WHT-XL', quantity: 2 }], { method: 'pickup' }, ada);
  assert.notEqual(c.order_reference, a.order_reference, 'different items → new order');
});
