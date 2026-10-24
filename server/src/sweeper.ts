// Background sweep every 60s (specs/08 I-1, I-2, I-5). Each step is idempotent and rate-budgeted.
import type { DB } from './db.ts';
import { now } from './db.ts';
import type { Notifier } from './notify.ts';
import type { ChordApi } from './chordApi.ts';
import { markWaitlistNotified, restockedWaitlist } from './growth.ts';
import { getOrderRow } from './orders.ts';
import { confirmFromPaystack, confirmPayment } from './payments.ts';
import type { PaystackTxn } from './payments.ts';
import { openHandover } from './handover.ts';
import { humanReason } from './reasons.ts';
import { orderRefFromBooking } from './chordWebhook.ts';

export const HOLD_REMINDER_AFTER_MIN = 20;

export class Sweeper {
  db: DB;
  notifier: Notifier;
  api: ChordApi | null;
  reconcileBookings: boolean;
  onPaid: (ref: string) => void;
  lastReconcile = 0;
  running = false;
  paystackVerify: (() => Promise<void>) | null;
  constructor(db: DB, notifier: Notifier, opts: { api?: ChordApi | null; reconcileBookings?: boolean; onPaid?: (ref: string) => void; paystackVerify?: () => Promise<void> } = {}) {
    this.db = db;
    this.notifier = notifier;
    this.api = opts.api ?? null;
    this.reconcileBookings = opts.reconcileBookings ?? false;
    this.onPaid = opts.onPaid ?? (() => {});
    this.paystackVerify = opts.paystackVerify ?? null;
  }

  start(intervalMs = 60_000) {
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref();
    return timer;
  }

  async tick() {
    if (this.running) return; // never overlap
    this.running = true;
    try {
      await this.holdReminders();
      await this.restocks();
      await this.retryFailed();
      if (this.paystackVerify) await this.paystackVerify();
      if (this.reconcileBookings && now() - this.lastReconcile > 5 * 60_000) await this.reconcile();
    } catch (err) {
      console.error(JSON.stringify({ evt: 'sweep_error', message: (err as Error).message }));
    } finally {
      this.running = false;
    }
  }

  /** One reminder ~20 min into the 30-min hold, only while still unpaid. */
  async holdReminders() {
    const t = now();
    const due = this.db.prepare(
      `SELECT reference, reserved_until FROM orders WHERE status = 'pending_payment' AND created_at <= ? AND reserved_until > ?
       AND reference NOT IN (SELECT ref FROM notification WHERE kind = 'hold_reminder') LIMIT 5`,
    ).all(t - HOLD_REMINDER_AFTER_MIN * 60_000, t) as { reference: string; reserved_until: number }[];
    for (const o of due) await this.notifier.holdReminder(o.reference, Math.max(1, Math.round((o.reserved_until - t) / 60_000)));
  }

  async restocks() {
    for (const w of restockedWaitlist(this.db).slice(0, 5)) {
      const a = JSON.parse(w.attributes_json) as Record<string, string>;
      const attrs = [a.colour, a.size ? `size ${a.size}` : ''].filter(Boolean).join(', ') || 'the size you wanted';
      const r = await this.notifier.restock(w.id, w.product_name, attrs);
      if (r.status === 'sent' || r.status === 'skipped' || r.status === 'duplicate') markWaitlistNotified(this.db, w.id);
    }
  }

  /** Retry failed sends (e.g. thread not yet searchable right after the order) up to 3 attempts. */
  async retryFailed() {
    const failed = this.db.prepare("SELECT ref, kind FROM notification WHERE status = 'failed' AND attempts < 3 AND updated_at < ? LIMIT 5").all(now() - 60_000) as { ref: string; kind: string }[];
    for (const f of failed) {
      if (f.kind === 'payment_received') await this.notifier.paymentReceived(f.ref);
      if (f.kind === 'hold_reminder') {
        const o = getOrderRow(this.db, f.ref);
        if (o?.status === 'pending_payment' && o.reserved_until > now()) await this.notifier.holdReminder(f.ref, Math.max(1, Math.round((o.reserved_until - now()) / 60_000)));
      }
    }
  }

  /** Docs: reconcile business-critical events on a schedule. Catch confirmed bookings whose webhook never arrived. */
  async reconcile() {
    this.lastReconcile = now();
    if (!this.api) return;
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending_payment'").get() as { n: number }).n;
    if (!pending) return;
    const r = await this.api.request<{ data: { id: string; title?: string; description?: string; payment_message?: string; status: string; amount_paid?: string; currency?: string; paystack_transaction_reference?: string; payment_reference?: string }[] }>(
      'GET', `/v1/workspaces/${this.api.ws}/bookings?status=confirmed&page_size=50`);
    for (const b of r.data ?? []) {
      const ref = orderRefFromBooking(b);
      const order = ref ? getOrderRow(this.db, ref) : undefined;
      if (!order || order.status !== 'pending_payment' || !b.amount_paid) continue;
      try {
        const res = confirmPayment(this.db, {
          orderReference: order.reference, provider: 'paystack',
          providerReference: b.paystack_transaction_reference ?? b.payment_reference ?? b.id,
          idempotencyKey: `chord-booking:${b.id}`, // same key as the webhook → never double-confirms
          amountKobo: Math.round(Number(b.amount_paid) * 100), currency: (b.currency ?? '').toUpperCase(),
          rawEvent: { source: 'reconcile', booking_id: b.id },
        });
        console.log(JSON.stringify({ evt: 'reconciled', ref: order.reference, outcome: res.outcome }));
        if (res.outcome !== 'already_processed') this.onPaid(order.reference);
      } catch (err) {
        console.error(JSON.stringify({ evt: 'reconcile_error', ref: order.reference, message: (err as Error).message }));
      }
    }
  }
}

/**
 * Live finding (AL-XWNGM3): Paystack's verify endpoint reports a DECLINED card as `abandoned`, not
 * `failed`; only `gateway_response` differs from a customer who simply closed the checkout
 * ("The transaction was not completed"). Treat abandoned + any other gateway response as a failed attempt.
 */
export function isFailedAttempt(txn: PaystackTxn & { gateway_response?: string }): boolean {
  if (txn.status === 'failed') return true;
  if (txn.status !== 'abandoned') return false;
  const g = (txn.gateway_response ?? '').trim();
  return g !== '' && !/not completed/i.test(g);
}

/**
 * Verify pending orders directly with Paystack by reference (= our order reference, which the agent
 * passes to Chord's initialize_transaction). Independent of Chord webhooks; the amount is checked by
 * confirmPayment, so a model-supplied wrong amount can never commit stock.
 */
export async function verifyPendingWithPaystack(
  db: DB,
  secretKey: string,
  notifier: Notifier | null,
  onPaid: (ref: string) => void,
  verify: (key: string, ref: string) => Promise<PaystackTxn | null>,
) {
  const pending = db.prepare(
    `SELECT reference FROM orders WHERE status = 'pending_payment' AND created_at > ? ORDER BY created_at DESC LIMIT 10`,
  ).all(now() - 24 * 3_600_000) as { reference: string }[];
  for (const { reference } of pending) {
    let txn: PaystackTxn | null;
    try { txn = await verify(secretKey, reference); } catch (err) {
      console.error(JSON.stringify({ evt: 'paystack_verify_error', ref: reference, message: (err as Error).message }));
      continue;
    }
    if (!txn) continue; // never initialised → nothing to do
    if (txn.status === 'success') {
      try {
        const r = confirmFromPaystack(db, txn, { source: 'paystack_verify_sweep', reference });
        if (r && r.outcome !== 'already_processed') console.log(JSON.stringify({ evt: 'paystack_verified', ref: reference, outcome: r.outcome, amount: txn.amount }));
        if (r && (r.outcome === 'confirmed' || r.outcome === 'confirmed_needs_attention')) onPaid(r.order_reference);
      } catch (err) {
        // AMOUNT_MISMATCH etc: never confirm; tell the owner once.
        const exists = db.prepare("SELECT 1 FROM handover WHERE order_reference = ? AND reason_category = 'payment_dispute'").get(reference);
        if (!exists) openHandover(db, { reason_category: 'payment_dispute', order_reference: reference, summary: `Paystack shows a successful payment for ${reference}, but it was not confirmed: ${(err as Error).message}. Owner must review.` });
      }
    } else if (isFailedAttempt(txn)) {
      const seen = db.prepare('SELECT 1 FROM payment_failure WHERE order_reference = ? AND source = ?').get(reference, 'paystack_verify');
      if (!seen) {
        const reason = (txn as PaystackTxn & { gateway_response?: string }).gateway_response ?? 'payment_failed';
        db.prepare('INSERT INTO payment_failure (order_reference, reason, source, at) VALUES (?, ?, ?, ?)').run(reference, reason, 'paystack_verify', now());
        if (notifier) void notifier.paymentFailed(reference, humanReason(reason));
      }
    }
  }
}
