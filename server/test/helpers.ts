import { openDb } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { createPendingOrder } from '../src/orders.ts';
import type { CreateOrderInput } from '../src/orders.ts';

export function freshDb(): DB {
  const db = openDb(':memory:');
  seed(db);
  return db;
}

export const opts = { reservationMinutes: 30, paymentLink: (r: string) => `https://shop.test/pay/${r}` };

export const ada = { name: 'Ada Obi', phone: '0803 123 4567' };

let buyer = 0;
/** Each call is a different buyer unless `customer` is given (orders are idempotent per customer + items). */
export function order(db: DB, items: CreateOrderInput['items'], fulfilment: CreateOrderInput['fulfilment'] = { method: 'pickup' }, customer?: CreateOrderInput['customer']) {
  const c = customer ?? { name: ada.name, phone: `0803${String(1000000 + ++buyer).slice(-7)}` };
  return createPendingOrder(db, { customer: c, items, fulfilment }, opts);
}

export function stockOf(db: DB, sku: string): number | null {
  return (db.prepare('SELECT stock_quantity AS q FROM variant WHERE sku = ?').get(sku) as { q: number | null }).q;
}
