// Restock waitlist + lost-demand log (specs/08 I-2): turn "sorry, sold out" into data and follow-ups.
import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { assertSellable, availableQuantity, resolveSku } from './catalogue.ts';
import type { ProductRow, VariantRow } from './catalogue.ts';
import { normalisePhone } from './orders.ts';
import { toKobo } from './money.ts';

export type DemandKind = 'no_match' | 'out_of_stock' | 'below_floor' | 'fixed_price_haggle' | 'waitlist_join';

/** Never throws: demand logging must not break a sale. */
export function logDemand(db: DB, kind: DemandKind, e: { sku?: string | null; detail?: string | null; amountNaira?: number | null }) {
  try {
    db.prepare('INSERT INTO demand_event (kind, sku, detail, amount, at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, e.sku ?? null, e.detail?.slice(0, 120) ?? null, e.amountNaira ? toKobo(e.amountNaira) : null, now());
  } catch (err) {
    console.error('[demand]', (err as Error).message);
  }
}

export function joinWaitlist(db: DB, input: { sku: string; customer_name: string; customer_phone: string }) {
  return tx(db, () => {
    const { product, variant } = resolveSku(db, input.sku);
    assertSellable(product, variant);
    const phone = normalisePhone(input.customer_phone);
    const existing = db.prepare("SELECT id FROM waitlist WHERE variant_id = ? AND customer_phone = ? AND status = 'waiting'").get(variant.id, phone) as { id: string } | undefined;
    const available = availableQuantity(db, product, variant);
    const id = existing?.id ?? 'WL-' + randomBytes(3).toString('hex').toUpperCase();
    if (!existing) {
      db.prepare(
        `INSERT INTO waitlist (id, variant_id, customer_name, customer_phone, status, created_at) VALUES (?, ?, ?, ?, 'waiting', ?)
         ON CONFLICT(variant_id, customer_phone) DO UPDATE SET id = excluded.id, status = 'waiting', customer_name = excluded.customer_name, created_at = excluded.created_at, notified_at = NULL`,
      ).run(id, variant.id, input.customer_name.trim(), phone, now());
      logDemand(db, 'waitlist_join', { sku: variant.sku });
    }
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE variant_id = ? AND status = 'waiting'").get(variant.id) as { n: number }).n;
    return {
      waitlist_reference: id,
      sku: variant.sku,
      product_name: product.name,
      currently_available: available,
      people_waiting: Number(waiting),
      next_step: `Tell the customer they're on the list (reference ${id}) and we'll message them in this chat as soon as it's back. Always quote ${id}.`,
    };
  });
}

/** Waiting entries whose variant is now in stock (for the sweeper). */
export function restockedWaitlist(db: DB) {
  const rows = db.prepare(
    `SELECT w.id, w.customer_name, w.variant_id, v.sku, p.name AS product_name, v.attributes_json
     FROM waitlist w JOIN variant v ON v.id = w.variant_id JOIN product p ON p.id = v.product_id
     WHERE w.status = 'waiting' AND v.active = 1 AND p.active = 1 ORDER BY w.created_at`,
  ).all() as { id: string; customer_name: string; variant_id: number; sku: string; product_name: string; attributes_json: string }[];
  return rows.filter((r) => {
    const v = db.prepare('SELECT * FROM variant WHERE id = ?').get(r.variant_id) as VariantRow;
    const p = db.prepare('SELECT * FROM product WHERE id = ?').get(v.product_id) as ProductRow;
    const a = availableQuantity(db, p, v);
    return a === null || a > 0;
  });
}

export function markWaitlistNotified(db: DB, id: string) {
  db.prepare("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?").run(now(), id);
}
