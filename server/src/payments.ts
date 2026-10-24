// Payment confirmation + Paystack test mode (FR-08, FR-09; spec 03-design §D6).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { BusinessError } from './errors.ts';
import { getOrderRow, orderItems } from './orders.ts';
import { openHandover } from './handover.ts';
import { formatNaira } from './money.ts';

export type PaymentProvider = 'paystack' | 'simulated' | 'admin_test';

export type ConfirmInput = {
  orderReference: string;
  provider: PaymentProvider;
  providerReference: string | null;
  idempotencyKey: string;
  amountKobo: number;
  currency: string;
  rawEvent?: unknown;
};

export type ConfirmResult =
  | { outcome: 'confirmed'; order_reference: string; status: 'paid' }
  | { outcome: 'confirmed_needs_attention'; order_reference: string; status: 'paid_needs_attention'; handover_id: string }
  | { outcome: 'already_processed'; order_reference: string; status: string };

/**
 * The only code path that marks an order paid and decrements stock.
 * Idempotent on idempotencyKey and on order state (AT-08, AT-09).
 */
export function confirmPayment(db: DB, input: ConfirmInput): ConfirmResult {
  return tx(db, () => {
    const t = now();
    const order = getOrderRow(db, input.orderReference);
    if (!order) throw new BusinessError('NOT_FOUND', `No order ${input.orderReference}`);

    const seen = db.prepare('SELECT 1 FROM payment WHERE idempotency_key = ?').get(input.idempotencyKey);
    if (seen) return { outcome: 'already_processed', order_reference: order.reference, status: order.status };

    const insertPayment = (status: 'succeeded' | 'ignored') => db.prepare(
      `INSERT INTO payment (order_id, provider, provider_reference, idempotency_key, status, amount, currency, confirmed_at, raw_event_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(order.id, input.provider, input.providerReference, input.idempotencyKey, status, input.amountKobo, input.currency, t,
      input.rawEvent ? JSON.stringify(input.rawEvent) : null);

    if (order.status !== 'pending_payment') {
      insertPayment('ignored');
      return { outcome: 'already_processed', order_reference: order.reference, status: order.status };
    }
    if (input.amountKobo !== order.total || input.currency !== order.currency) {
      throw new BusinessError('AMOUNT_MISMATCH',
        `Payment of ${formatNaira(input.amountKobo)} ${input.currency} does not match order total ${formatNaira(order.total)} ${order.currency}`);
    }

    // Stock this order may take = on-hand minus units reserved by *other* live pending orders.
    const items = orderItems(db, order.id).filter((i) => i.stock_tracking_enabled);
    const short = items.filter((i) => {
      const onHand = (db.prepare('SELECT stock_quantity AS q FROM variant WHERE id = ?').get(i.variant_id) as { q: number | null }).q;
      if (onHand === null) return false;
      const reservedByOthers = Number((db.prepare(
        `SELECT COALESCE(SUM(oi.quantity),0) AS q FROM order_item oi JOIN orders o ON o.id = oi.order_id
         WHERE oi.variant_id = ? AND o.id <> ? AND o.status = 'pending_payment' AND o.reserved_until > ?`,
      ).get(i.variant_id, order.id, t) as { q: number }).q);
      return onHand - reservedByOthers < i.quantity;
    });

    insertPayment('succeeded');

    if (short.length > 0) {
      db.prepare("UPDATE orders SET status = 'paid_needs_attention', payment_status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").run(t, t, order.id);
      const handover = openHandover(db, {
        reason_category: 'payment_dispute',
        summary: `Order ${order.reference} was paid but stock ran out for ${short.map((s) => s.sku).join(', ')} (reservation expired). Owner must arrange a substitute or refund.`,
        order_reference: order.reference,
      });
      return { outcome: 'confirmed_needs_attention', order_reference: order.reference, status: 'paid_needs_attention', handover_id: handover.handover_id };
    }

    const dec = db.prepare('UPDATE variant SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?');
    for (const i of items) {
      const r = dec.run(i.quantity, i.variant_id, i.quantity);
      if (Number(r.changes) !== 1) throw new BusinessError('INTERNAL', `Stock update failed for ${i.sku}`); // rolls back everything
    }
    db.prepare("UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").run(t, t, order.id);
    return { outcome: 'confirmed', order_reference: order.reference, status: 'paid' };
  });
}

// ---------------------------------------------------------------- simulated checkout

export function issueCheckoutNonce(db: DB, orderReference: string): string {
  const nonce = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO checkout_nonce (nonce, order_reference, created_at) VALUES (?, ?, ?)').run(nonce, orderReference, now());
  return nonce;
}

export function consumeCheckoutNonce(db: DB, orderReference: string, nonce: string): boolean {
  const row = db.prepare('SELECT order_reference FROM checkout_nonce WHERE nonce = ?').get(nonce) as { order_reference: string } | undefined;
  return Boolean(row && row.order_reference === orderReference);
}

// ---------------------------------------------------------------- Paystack (test mode only)

const PAYSTACK_API = 'https://api.paystack.co';

export async function paystackInitialize(secretKey: string, args: { email: string; amountKobo: number; reference: string; callbackUrl: string; orderReference: string }) {
  const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: args.email,
      amount: args.amountKobo,
      currency: 'NGN',
      reference: args.reference,
      callback_url: args.callbackUrl,
      metadata: { order_reference: args.orderReference },
    }),
  });
  const body = (await res.json()) as { status: boolean; message: string; data?: { authorization_url: string } };
  if (!res.ok || !body.status || !body.data) throw new Error(`Paystack initialize failed (${res.status}): ${body.message}`);
  return body.data.authorization_url;
}

export type PaystackTxn = { reference: string; status: string; amount: number; currency: string; metadata?: { order_reference?: string } | string };

export async function paystackVerify(secretKey: string, reference: string): Promise<PaystackTxn> {
  const res = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const body = (await res.json()) as { status: boolean; message: string; data?: PaystackTxn };
  if (!res.ok || !body.status || !body.data) throw new Error(`Paystack verify failed (${res.status}): ${body.message}`);
  return body.data;
}

export function verifyPaystackSignature(secretKey: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map a successful Paystack transaction to our order (reference format: AL-XXXXXX-n). */
export function confirmFromPaystack(db: DB, txn: PaystackTxn, rawEvent: unknown): ConfirmResult | null {
  if (txn.status !== 'success') return null;
  const meta = typeof txn.metadata === 'object' ? txn.metadata : undefined;
  const orderRef = meta?.order_reference ?? txn.reference.replace(/-\d+$/, '');
  return confirmPayment(db, {
    orderReference: orderRef,
    provider: 'paystack',
    providerReference: txn.reference,
    idempotencyKey: `paystack:${txn.reference}`,
    amountKobo: txn.amount,
    currency: txn.currency,
    rawEvent,
  });
}
