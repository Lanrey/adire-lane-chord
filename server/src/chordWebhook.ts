// Chord booking webhooks → trusted payment confirmation (specs/07 P-4, P-5).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { BusinessError } from './errors.ts';
import { getOrderRow } from './orders.ts';
import { confirmPayment } from './payments.ts';
import { openHandover } from './handover.ts';

/** Body signature: "sha256=" + hex(HMAC_SHA256(secret, raw body)) — no timestamp header on these deliveries. */
export function verifyChordSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

type Booking = {
  booking_id?: string; title?: string; description?: string; payment_message?: string;
  amount_paid?: string; currency?: string; paystack_transaction_reference?: string; payment_reference?: string;
  reason?: string;
};
export type ChordEvent = { id: string; type: string; timestamp: number; data: Booking & Record<string, unknown> };

const REF = /\bAL-[A-Z2-9]{6}\b/i;
export function orderRefFromBooking(b: Booking): string | null {
  for (const field of [b.title, b.description, b.payment_message]) {
    const m = field?.match(REF);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

export type ChordEventResult = { outcome: string; order_reference?: string; reason?: string; previous?: string };

export function handleChordEvent(db: DB, event: ChordEvent, deliveryId: string): ChordEventResult {
  // Deduplicate on X-Chord-Delivery-Id (stable across retries).
  const seen = db.prepare('SELECT outcome FROM chord_delivery WHERE delivery_id = ?').get(deliveryId) as { outcome: string } | undefined;
  if (seen) return { outcome: 'duplicate_delivery', previous: seen.outcome };
  const outcome = process(db, event);
  db.prepare('INSERT INTO chord_delivery (delivery_id, event_type, outcome, received_at) VALUES (?, ?, ?, ?)')
    .run(deliveryId, event.type, outcome.outcome, now());
  return outcome;
}

function process(db: DB, event: ChordEvent): { outcome: string; order_reference?: string; reason?: string } {
  const b = event.data ?? {};
  const ref = orderRefFromBooking(b);
  switch (event.type) {
    case 'booking.confirmed': {
      if (!ref) return { outcome: 'ignored_no_order_reference' };
      const order = getOrderRow(db, ref);
      if (!order) return { outcome: 'ignored_unknown_order', order_reference: ref };
      const amountKobo = Math.round(Number(b.amount_paid) * 100);
      if (!Number.isFinite(amountKobo)) return { outcome: 'ignored_no_amount', order_reference: ref };
      try {
        const r = confirmPayment(db, {
          orderReference: ref,
          provider: 'paystack',
          providerReference: b.paystack_transaction_reference ?? b.payment_reference ?? b.booking_id ?? null,
          idempotencyKey: `chord-booking:${b.booking_id ?? event.id}`,
          amountKobo,
          currency: (b.currency ?? '').toUpperCase(),
          rawEvent: { source: 'chord_webhook', event_id: event.id, booking_id: b.booking_id },
        });
        return { outcome: r.outcome, order_reference: ref };
      } catch (err) {
        if (err instanceof BusinessError && err.code === 'AMOUNT_MISMATCH') {
          openHandover(db, { reason_category: 'payment_dispute', summary: `Chord booking ${b.booking_id} paid ${b.amount_paid} ${b.currency} for ${ref}, which does not match the order total. Not confirmed; owner must review.`, order_reference: ref });
          return { outcome: 'amount_mismatch_handover', order_reference: ref };
        }
        throw err;
      }
    }
    case 'booking.payment_mismatch':
    case 'booking.payment_late': {
      openHandover(db, { reason_category: 'payment_dispute', summary: `Chord reported ${event.type} for booking ${b.booking_id}${ref ? ` (order ${ref})` : ''}. Owner must review the payment.`, order_reference: ref ?? undefined });
      return { outcome: 'handover_opened', order_reference: ref ?? undefined };
    }
    case 'booking.payment_failed': {
      if (ref) {
        db.prepare('INSERT INTO payment_failure (order_reference, reason, source, at) VALUES (?, ?, ?, ?)')
          .run(ref, (b.reason ?? 'payment_failed').toString().slice(0, 120), 'chord_booking', now());
      }
      return { outcome: 'payment_failed_recorded', order_reference: ref ?? undefined, reason: b.reason ?? 'payment_failed' };
    }
    default:
      return { outcome: 'ignored_event_type' };
  }
}
