// AT-01 exact lookup, AT-02 ambiguous request, AT-03 out of stock (FR-02, FR-03, FR-05)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, order } from './helpers.ts';
import { checkStock, getProductDetails, searchProducts } from '../src/catalogue.ts';
import { BusinessError } from '../src/errors.ts';

test('AT-01 exact product code returns that product first with price and availability', () => {
  const db = freshDb();
  const r = searchProducts(db, 'Do you have TS-104?');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].code, 'TS-104');
  assert.equal(r.results[0].match_type, 'exact');
  assert.equal(r.results[0].unit_price, 15000);
  assert.equal(r.needs_clarification, true, 'TS-104 has several sizes, so ask which');
  const three = r.results[0].variants.find((v) => v.sku === 'TS-104-BLK-3XL')!;
  assert.equal(three.availability, 'low_stock');
});

test('AT-01 exact variant SKU resolves to just that variant', () => {
  const db = freshDb();
  const r = searchProducts(db, 'ts-104-blk-3xl');
  assert.equal(r.results[0].match_type, 'exact');
  assert.deepEqual(r.results[0].variants.map((v) => v.sku), ['TS-104-BLK-3XL']);
  assert.equal(r.needs_clarification, false);
  assert.equal(r.results[0].variants[0].available, 2, 'R-3.1 live count in search');
  assert.equal(checkStock(db, 'TS-104-BLK-3XL', 1).available, 2);
});

test('AT-02 "black oversized shirt" is ambiguous and offers the closest options', () => {
  const db = freshDb();
  const r = searchProducts(db, 'black oversized shirt');
  const codes = r.results.map((x) => x.code);
  assert.ok(codes.includes('TS-104') && codes.includes('TS-106'), `got ${codes}`);
  assert.equal(r.needs_clarification, true);
  assert.match(r.clarification_hint ?? '', /TS-104|TS-106/);
  assert.ok(!codes.includes('SN-210'), 'sneakers are not a shirt');
});

test('AT-02 size words narrow variants ("black tee 3xl")', () => {
  const db = freshDb();
  const r = searchProducts(db, 'black tee xxxl');
  const ts104 = r.results.find((x) => x.code === 'TS-104')!;
  assert.deepEqual(ts104.variants.map((v) => v.sku), ['TS-104-BLK-3XL']);
});

test('natural language finds sneakers and the service; nonsense finds nothing', () => {
  const db = freshDb();
  assert.equal(searchProducts(db, 'black kicks size 42').results[0].code, 'SN-210');
  assert.equal(searchProducts(db, 'can you fix my laptop').results[0].code, 'SV-001');
  assert.equal(searchProducts(db, 'iphone 15 pro').results.length, 0);
});

test('AT-03 zero-stock variant is not available and alternatives are offered', () => {
  const db = freshDb();
  const s = checkStock(db, 'TS-104-BLK-XL', 1);
  assert.equal(s.available, 0);
  assert.equal(s.can_fulfil, false);
  assert.deepEqual(s.alternatives.map((a) => a.sku).sort(), ['TS-104-BLK-3XL', 'TS-104-BLK-L']);
  const view = searchProducts(db, 'TS-104-BLK-XL').results[0].variants[0];
  assert.equal(view.availability, 'out_of_stock');
});

test('AT-03 ordering an out-of-stock variant is refused', () => {
  const db = freshDb();
  assert.throws(() => order(db, [{ sku: 'TS-105-WHT-L', quantity: 1 }]), (e: unknown) => e instanceof BusinessError && e.code === 'INSUFFICIENT_STOCK');
});

test('FR-03 pending reservations reduce availability; services are untracked', () => {
  const db = freshDb();
  order(db, [{ sku: 'SN-210-BLK-42', quantity: 1 }]);
  assert.equal(searchProducts(db, 'SN-210-BLK-42').results[0].variants[0].available, 0, 'search sees reservations too');
  assert.equal(checkStock(db, 'SN-210-BLK-42', 1).can_fulfil, false);
  const svc = checkStock(db, 'SV-001', 3);
  assert.equal(svc.tracked, false);
  assert.equal(svc.can_fulfil, true);
  assert.equal(getProductDetails(db, 'SV-001').product.item_type, 'service');
});

test('inactive products are hidden from search and cannot be sold', () => {
  const db = freshDb();
  db.prepare("UPDATE product SET active = 0 WHERE code = 'TS-106'").run();
  assert.ok(!searchProducts(db, 'adire print tee').results.some((r) => r.code === 'TS-106'));
  assert.throws(() => checkStock(db, 'TS-106-BLK-XL', 1), (e: unknown) => e instanceof BusinessError && e.code === 'INACTIVE');
});
