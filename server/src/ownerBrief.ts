// Owner's evening brief (specs/08 I-3): what sold, what's stuck, what demand we missed.
import type { DB } from './db.ts';
import { now } from './db.ts';
import { formatNaira, toNaira } from './money.ts';

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is UTC+1, no DST

/** Start of "today" in Lagos as epoch ms. */
export function lagosDayStart(at = now()): number {
  const local = at + LAGOS_OFFSET_MS;
  return local - (local % 86_400_000) - LAGOS_OFFSET_MS;
}

/** True outside 10:00–19:00 Lagos time, or on a Sunday (shop closed). */
export function isAfterHours(at: number): boolean {
  const local = new Date(at + LAGOS_OFFSET_MS);
  const h = local.getUTCHours();
  return local.getUTCDay() === 0 || h < 10 || h >= 19;
}

/** What the assistant changed (specs/09 G-2), not just what happened. */
export function impact(db: DB, since: number) {
  const paid = db.prepare("SELECT id, reference, total, created_at, paid_at, customer_id FROM orders WHERE payment_status = 'paid' AND paid_at >= ?").all(since) as
    { id: number; reference: string; total: number; created_at: number; paid_at: number; customer_id: number }[];
  const afterHours = paid.filter((o) => isAfterHours(o.created_at));
  const recovered = paid.filter((o) => db.prepare(
    "SELECT 1 FROM notification WHERE ref = ? AND kind IN ('hold_reminder','payment_failed') AND status = 'sent' AND updated_at < ?",
  ).get(o.reference, o.paid_at));
  const conversions = db.prepare(
    `SELECT COUNT(DISTINCT w.id) AS n, COALESCE(SUM(oi.line_total),0) AS v FROM waitlist w
     JOIN customer c ON c.phone = w.customer_phone
     JOIN orders o ON o.customer_id = c.id AND o.payment_status = 'paid' AND o.paid_at >= ? AND o.created_at >= w.created_at
     JOIN order_item oi ON oi.order_id = o.id AND oi.variant_id = w.variant_id`,
  ).get(since) as { n: number; v: number };
  const listTotal = db.prepare(
    `SELECT COALESCE(SUM(oi.list_unit_price*oi.quantity),0) AS list, COALESCE(SUM(oi.line_total),0) AS sold FROM order_item oi
     JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' AND o.paid_at >= ?`,
  ).get(since) as { list: number; sold: number };
  const sum = (xs: { total: number }[]) => xs.reduce((a, o) => a + o.total, 0);
  return {
    after_hours_sales: afterHours.length, after_hours_value: toNaira(sum(afterHours)),
    recovered_by_followups: recovered.length, recovered_value: toNaira(sum(recovered)),
    waitlist_conversions: Number(conversions.n), waitlist_value: toNaira(Number(conversions.v)),
    average_discount_pct: listTotal.list ? Math.round((1 - listTotal.sold / listTotal.list) * 1000) / 10 : 0,
    line: `Assistant impact: ${afterHours.length} after-hours sale(s) (${formatNaira(sum(afterHours))}), ${recovered.length} recovered by follow-ups (${formatNaira(sum(recovered))}), ${Number(conversions.n)} restock-list sale(s) (${formatNaira(Number(conversions.v))}); average discount ${listTotal.list ? Math.round((1 - listTotal.sold / listTotal.list) * 1000) / 10 : 0}%.`,
  };
}

export function ownerBrief(db: DB, opts: { since?: number } = {}) {
  const since = opts.since ?? lagosDayStart();
  const t = now();
  const paid = db.prepare("SELECT reference, total FROM orders WHERE payment_status = 'paid' AND paid_at >= ?").all(since) as { reference: string; total: number }[];
  const revenue = paid.reduce((s, o) => s + o.total, 0);
  const unpaidLive = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'pending_payment' AND reserved_until > ?").get(t) as { n: number; v: number };
  const expired = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'pending_payment' AND reserved_until <= ? AND created_at >= ?").get(t, since) as { n: number; v: number };
  const attention = db.prepare("SELECT reference FROM orders WHERE status = 'paid_needs_attention'").all() as { reference: string }[];
  const handovers = db.prepare("SELECT id, reason_category, order_reference, summary FROM handover WHERE status = 'open' ORDER BY created_at DESC LIMIT 5").all() as { id: string; reason_category: string; order_reference: string | null; summary: string }[];

  // Discounts actually given on paid orders
  const disc = db.prepare(
    `SELECT COALESCE(SUM((oi.list_unit_price - oi.agreed_unit_price) * oi.quantity),0) AS given, COUNT(CASE WHEN oi.offer_id IS NOT NULL THEN 1 END) AS deals
     FROM order_item oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' AND o.paid_at >= ?`,
  ).get(since) as { given: number; deals: number };

  const demand = db.prepare(
    `SELECT kind, COALESCE(sku, detail) AS what, COUNT(*) AS n, AVG(amount) AS avg_amount FROM demand_event WHERE at >= ?
     GROUP BY kind, COALESCE(sku, detail) ORDER BY n DESC LIMIT 8`,
  ).all(since) as { kind: string; what: string; n: number; avg_amount: number | null }[];
  const waiting = db.prepare(
    `SELECT v.sku, COUNT(*) AS n FROM waitlist w JOIN variant v ON v.id = w.variant_id WHERE w.status = 'waiting' GROUP BY v.sku ORDER BY n DESC`,
  ).all() as { sku: string; n: number }[];
  const lowStock = db.prepare(
    `SELECT v.sku, v.stock_quantity AS q FROM variant v JOIN product p ON p.id = v.product_id
     WHERE p.active = 1 AND v.active = 1 AND p.stock_tracking_enabled = 1 AND v.stock_quantity <= 1 ORDER BY v.stock_quantity, v.sku`,
  ).all() as { sku: string; q: number }[];

  const imp = impact(db, since);
  const lines = [
    `Sales today: ${paid.length} paid order(s), ${formatNaira(revenue)}${paid.length ? ` (${paid.map((p) => p.reference).join(', ')})` : ''}.`,
    `Waiting to pay: ${unpaidLive.n} (${formatNaira(unpaidLive.v)}). Expired unpaid today: ${expired.n} (${formatNaira(expired.v)}).`,
    `Needs you: ${handovers.length} open handover(s)${attention.length ? `, ${attention.length} paid order(s) with a stock problem (${attention.map((a) => a.reference).join(', ')})` : ''}.`,
    `Haggling: ${disc.deals} discounted sale(s), ${formatNaira(disc.given)} given away in discounts.`,
    `Missed demand: ${demand.length ? demand.slice(0, 4).map((d) => `${d.n}× ${d.kind.replace(/_/g, ' ')} ${d.what ?? ''}${d.avg_amount ? ` (avg offer ${formatNaira(d.avg_amount)})` : ''}`).join('; ') : 'none recorded'}.`,
    imp.line,
    `Restock: ${waiting.length ? waiting.map((w) => `${w.sku} has ${w.n} waiting`).join(', ') : 'no waitlists'}. Low stock: ${lowStock.length ? lowStock.map((l) => `${l.sku} (${l.q})`).join(', ') : 'none'}.`,
  ];
  return {
    period_start: new Date(since).toISOString(),
    summary_lines: lines,
    impact: imp,
    numbers: {
      paid_orders: paid.length, revenue: toNaira(revenue), unpaid_live: unpaidLive.n, expired_unpaid_today: expired.n,
      open_handovers: handovers.length, discounts_given: toNaira(disc.given), discounted_sales: disc.deals,
    },
    open_handovers: handovers,
    missed_demand: demand.map((d) => ({ kind: d.kind, item: d.what, count: d.n, avg_offer: d.avg_amount ? toNaira(d.avg_amount) : null })),
    waitlists: waiting,
    low_stock: lowStock,
  };
}
