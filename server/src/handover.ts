// Human handover records (FR-10). The skill then calls Chord's built-in handover_to_human.
import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { normalisePhone } from './orders.ts';

export const HANDOVER_REASONS = [
  'customer_request', 'complaint', 'payment_dispute', 'refund', 'price_beyond_limit',
  'unidentified_product', 'tool_failure', 'other',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export type HandoverInput = {
  reason_category: HandoverReason;
  summary: string;
  customer_phone?: string;
  customer_name?: string;
  order_reference?: string;
};

export function openHandover(db: DB, input: HandoverInput) {
  return tx(db, () => {
    const t = now();
    const id = 'HO-' + randomBytes(4).toString('hex').toUpperCase();
    const phone = input.customer_phone ? normalisePhone(input.customer_phone) : null;
    db.prepare(
      `INSERT INTO handover (id, customer_phone, customer_name, reason_category, summary, order_reference, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(id, phone, input.customer_name ?? null, input.reason_category, input.summary, input.order_reference ?? null, t);
    if (phone) {
      db.prepare(
        `INSERT INTO conversation (customer_phone, status, handover_reason, updated_at) VALUES (?, 'handover', ?, ?)
         ON CONFLICT(customer_phone) DO UPDATE SET status = 'handover', handover_reason = excluded.handover_reason, updated_at = excluded.updated_at`,
      ).run(phone, input.reason_category, t);
    }
    return {
      handover_id: id,
      status: 'open' as const,
      next_step: 'Now call handover_to_human with this reason. Tell the customer a team member will follow up; do not say a human has replied.',
    };
  });
}

export function listHandovers(db: DB) {
  return db.prepare('SELECT * FROM handover ORDER BY created_at DESC LIMIT 200').all();
}

export function resolveHandover(db: DB, id: string) {
  const r = db.prepare("UPDATE handover SET status = 'resolved' WHERE id = ?").run(id);
  return Number(r.changes) === 1;
}
