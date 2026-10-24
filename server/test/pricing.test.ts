// AT-04 fixed price, AT-05 negotiation floor (FR-04)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, order } from './helpers.ts';
import { calculateOffer } from '../src/pricing.ts';
import { BusinessError } from '../src/errors.ts';

test('AT-04 discount on a fixed-price item is declined at the stored price', () => {
  const db = freshDb();
  const r = calculateOffer(db, 'TS-105-WHT-XL', 12000, 1);
  assert.equal(r.decision, 'rejected_fixed_price');
  assert.equal(r.unit_price, 14000);
  assert.equal('offer_id' in r, false);
});

test('AT-05 offer below the floor is rejected, with a counter at or above the floor', () => {
  const db = freshDb();
  const r = calculateOffer(db, 'TS-104-BLK-3XL', 10000, 1);
  assert.equal(r.decision, 'rejected_below_floor');
  assert.ok(!('offer_id' in r));
  assert.ok(r.counter_offer! >= 13500 && r.counter_offer! <= 15000, `counter ${r.counter_offer}`);
  assert.equal(r.counter_offer, 14500, 'midway between floor 13,500 and list 15,000, rounded up to ₦500');
});

test('live finding L-2: counter-offers never go up as the customer raises the bid', () => {
  const db = freshDb();
  const counters = [11000, 13000, 15500].map((bid) => calculateOffer(db, 'TS-106-BLK-XL', bid, 1).counter_offer!);
  assert.deepEqual(counters, [17000, 17000, 17000]);
  assert.equal(calculateOffer(db, 'TS-106-BLK-XL', 16000, 1).decision, 'accepted', 'at or above floor is accepted');
});

test('offer at or above the floor is accepted and issues an offer_id', () => {
  const db = freshDb();
  const r = calculateOffer(db, 'TS-104-BLK-3XL', 13500, 1);
  assert.equal(r.decision, 'accepted');
  assert.equal(r.unit_price, 13500);
  assert.match(r.offer_id!, /^OF-[0-9A-F]{10}$/);
});

test('offer above list price is capped at list (never overcharge)', () => {
  const db = freshDb();
  const r = calculateOffer(db, 'SN-210-BLK-42', 40000, 1);
  assert.equal(r.decision, 'accepted');
  assert.equal(r.unit_price, 38000);
});

test('accepted offer flows into the order total; no offer means list price', () => {
  const db = freshDb();
  const deal = calculateOffer(db, 'SN-210-BLK-42', 36000, 1);
  const o = order(db, [{ sku: 'SN-210-BLK-42', quantity: 1, offer_id: deal.offer_id }]);
  assert.equal(o.subtotal, 36000);
  const db2 = freshDb();
  assert.equal(order(db2, [{ sku: 'SN-210-BLK-42', quantity: 1 }]).subtotal, 38000);
});

test('offers cannot be reused on another SKU, a larger quantity, after expiry, or after the floor is raised', () => {
  const db = freshDb();
  const deal = calculateOffer(db, 'TS-104-BLK-3XL', 13500, 1);
  const isCode = (c: string) => (e: unknown) => e instanceof BusinessError && e.code === c;
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-L', quantity: 1, offer_id: deal.offer_id }]), isCode('OFFER_INVALID'));
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 2, offer_id: deal.offer_id }]), isCode('OFFER_INVALID'));
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 1, offer_id: 'OF-0000000000' }]), isCode('OFFER_INVALID'));

  db.prepare("UPDATE product SET minimum_price = 1400000 WHERE code = 'TS-104'").run();
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 1, offer_id: deal.offer_id }]), isCode('OFFER_INVALID'));

  db.prepare("UPDATE product SET minimum_price = 1350000 WHERE code = 'TS-104'").run();
  db.prepare('UPDATE offer SET expires_at = 0 WHERE id = ?').run(deal.offer_id!);
  assert.throws(() => order(db, [{ sku: 'TS-104-BLK-3XL', quantity: 1, offer_id: deal.offer_id }]), isCode('OFFER_EXPIRED'));
});
