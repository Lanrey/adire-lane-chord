// Pending orders with atomic stock reservation (FR-07, FR-11; spec 03-design §D4, §D6).
import { randomInt } from 'node:crypto';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { BusinessError } from './errors.ts';
import { assertSellable, availableQuantity, listPrice, resolveSku } from './catalogue.ts';
import { redeemOffer } from './pricing.ts';
import { formatNaira, toNaira } from './money.ts';

export type OrderStatus = 'pending_payment' | 'paid' | 'paid_needs_attention' | 'cancelled';

export type OrderRow = {
  id: number; reference: string; business_id: number; customer_id: number; status: OrderStatus;
  payment_status: 'unpaid' | 'paid'; subtotal: number; delivery_fee: number; total: number; currency: string;
  fulfilment_method: 'pickup' | 'delivery'; delivery_zone: string | null; delivery_address: string | null;
  reserved_until: number; paid_at: number | null; created_at: number; updated_at: number;
};

export type CreateOrderInput = {
  customer: { name: string; phone: string };
  items: { sku: string; quantity: number; offer_id?: string }[];
  fulfilment: { method: 'pickup' | 'delivery'; zone?: string; address?: string };
};

type Zone = { zone: string; label: string; fee: number; eta: string };

export function businessInfo(db: DB) {
  const b = db.prepare('SELECT * FROM business WHERE id = 1').get() as
    { name: string; currency: string; payment_terms: string; info_json: string };
  const info = JSON.parse(b.info_json) as { opening_hours: string; pickup_address: string; delivery_zones: Zone[]; returns_policy: string };
  return { name: b.name, currency: b.currency, payment_terms: b.payment_terms, ...info };
}

export function businessInfoView(db: DB) {
  const info = businessInfo(db);
  return {
    ...info,
    delivery_zones: info.delivery_zones.map((z) => ({
      zone: z.zone, label: z.label, fee: toNaira(z.fee), fee_display: formatNaira(z.fee), eta: z.eta,
    })),
  };
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion on WhatsApp
function newReference(db: DB): string {
  for (;;) {
    let s = 'AL-';
    for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM orders WHERE reference = ?').get(s)) return s;
  }
}

export function normalisePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (/^0\d{10}$/.test(digits)) return '+234' + digits.slice(1);
  if (/^234\d{10}$/.test(digits)) return '+' + digits;
  return digits;
}

export function createPendingOrder(
  db: DB,
  input: CreateOrderInput,
  opts: { reservationMinutes: number; paymentLink: (ref: string) => string },
) {
  const info = businessInfo(db);
  let deliveryFee = 0;
  let zone: string | null = null;
  let address: string | null = null;
  if (input.fulfilment.method === 'delivery') {
    if (!input.fulfilment.zone) throw new BusinessError('ZONE_REQUIRED', 'Delivery needs a zone: ' + info.delivery_zones.map((z) => z.zone).join(', '));
    const z = info.delivery_zones.find((d) => d.zone === input.fulfilment.zone);
    if (!z) throw new BusinessError('UNKNOWN_ZONE', `Unknown zone "${input.fulfilment.zone}". Use one of: ${info.delivery_zones.map((d) => d.zone).join(', ')}`);
    if (!input.fulfilment.address?.trim()) throw new BusinessError('ADDRESS_REQUIRED', 'Delivery needs a street address');
    deliveryFee = z.fee;
    zone = z.zone;
    address = input.fulfilment.address.trim();
  }
  const phone = normalisePhone(input.customer.phone);
  if (phone.replace(/\D/g, '').length < 10) throw new BusinessError('INVALID_INPUT', 'Customer phone number looks incomplete');

  // Everything below is one BEGIN IMMEDIATE transaction: revalidate, reserve, persist (§D4).
  return tx(db, () => {
    const t = now();
    // Idempotency (live finding: the model re-called create_pending_order on "confirm" and "yes",
    // creating 3 orders for one purchase). Same customer + same items + same fulfilment while a hold
    // is live → return that order instead of reserving stock again.
    const wantSig = input.items.map((i) => `${i.sku.trim().toUpperCase()}x${i.quantity}`).sort().join('|') + `|${input.fulfilment.method}|${zone ?? ''}`;
    const live = db.prepare(
      `SELECT o.* FROM orders o JOIN customer c ON c.id = o.customer_id
       WHERE c.phone = ? AND o.status = 'pending_payment' AND o.reserved_until > ? ORDER BY o.created_at DESC`,
    ).all(phone, t) as OrderRow[];
    for (const o of live) {
      const sig = orderItems(db, o.id).map((i) => `${i.sku.toUpperCase()}x${i.quantity}`).sort().join('|') + `|${o.fulfilment_method}|${o.delivery_zone ?? ''}`;
      if (sig === wantSig) return { ...createdView(db, o, opts.paymentLink), existing: true };
    }
    const lines: { productId: number; variantId: number; sku: string; name: string; quantity: number; list: number; agreed: number; offerId: string | null; tracked: boolean }[] = [];
    const wantedByVariant = new Map<number, number>();

    for (const item of input.items) {
      const { product, variant } = resolveSku(db, item.sku);
      assertSellable(product, variant);
      const list = listPrice(product, variant);
      const agreed = item.offer_id ? redeemOffer(db, item.offer_id, product, variant, item.quantity, t) : list;
      const want = (wantedByVariant.get(variant.id) ?? 0) + item.quantity;
      wantedByVariant.set(variant.id, want);
      const available = availableQuantity(db, product, variant);
      if (available !== null && available < want) {
        throw new BusinessError('INSUFFICIENT_STOCK', `Only ${available} of ${variant.sku} available right now (asked for ${want})`);
      }
      lines.push({ productId: product.id, variantId: variant.id, sku: variant.sku, name: product.name, quantity: item.quantity, list, agreed, offerId: item.offer_id ?? null, tracked: available !== null });
    }

    const existing = db.prepare('SELECT id FROM customer WHERE phone = ?').get(phone) as { id: number } | undefined;
    let customerId: number;
    if (existing) {
      db.prepare('UPDATE customer SET name = ?, delivery_address = COALESCE(?, delivery_address) WHERE id = ?').run(input.customer.name.trim(), address, existing.id);
      customerId = existing.id;
    } else {
      customerId = Number(db.prepare('INSERT INTO customer (name, phone, delivery_address) VALUES (?, ?, ?)').run(input.customer.name.trim(), phone, address).lastInsertRowid);
    }

    const subtotal = lines.reduce((s, l) => s + l.agreed * l.quantity, 0);
    const total = subtotal + deliveryFee;
    const reference = newReference(db);
    const reservedUntil = t + opts.reservationMinutes * 60_000;
    const orderId = Number(db.prepare(
      `INSERT INTO orders (reference, business_id, customer_id, status, payment_status, subtotal, delivery_fee, total, currency,
         fulfilment_method, delivery_zone, delivery_address, reserved_until, created_at, updated_at)
       VALUES (?, 1, ?, 'pending_payment', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(reference, customerId, subtotal, deliveryFee, total, info.currency, input.fulfilment.method, zone, address, reservedUntil, t, t).lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO order_item (order_id, product_id, variant_id, quantity, list_unit_price, agreed_unit_price, offer_id, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) insItem.run(orderId, l.productId, l.variantId, l.quantity, l.list, l.agreed, l.offerId, l.agreed * l.quantity);

    return { ...createdView(db, getOrderRow(db, reference)!, opts.paymentLink), existing: false };
  });
}

/** The create_pending_order result shape, built from the stored order (new or existing). */
function createdView(db: DB, o: OrderRow, paymentLink: (ref: string) => string) {
  const items = orderItems(db, o.id);
  return {
    order_reference: o.reference,
    status: 'pending_payment' as const,
    payment_status: 'unpaid' as const,
    items: items.map((l) => ({
      sku: l.sku, name: l.name, quantity: l.quantity,
      unit_price: toNaira(l.agreed_unit_price), unit_price_display: formatNaira(l.agreed_unit_price),
      line_total: toNaira(l.line_total), line_total_display: formatNaira(l.line_total),
    })),
    fulfilment: { method: o.fulfilment_method, zone: o.delivery_zone, address: o.delivery_address },
    subtotal: toNaira(o.subtotal), subtotal_display: formatNaira(o.subtotal),
    delivery_fee: toNaira(o.delivery_fee), delivery_fee_display: formatNaira(o.delivery_fee),
    total: toNaira(o.total), total_display: formatNaira(o.total),
    total_kobo: o.total,
    currency: o.currency,
    reserved_until: new Date(o.reserved_until).toISOString(),
    payment_link: paymentLink(o.reference),
  };
}

export function getOrderRow(db: DB, reference: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE reference = ? COLLATE NOCASE').get(reference.trim()) as OrderRow | undefined;
}

export function orderItems(db: DB, orderId: number) {
  return db.prepare(
    `SELECT oi.*, v.sku, v.attributes_json, p.name, p.item_type, p.stock_tracking_enabled FROM order_item oi
     JOIN variant v ON v.id = oi.variant_id JOIN product p ON p.id = oi.product_id WHERE oi.order_id = ?`,
  ).all(orderId) as { variant_id: number; quantity: number; sku: string; name: string; agreed_unit_price: number; line_total: number; stock_tracking_enabled: number; attributes_json: string; item_type: string }[];
}

export function getPaymentStatus(db: DB, reference: string, paymentLink: (ref: string) => string) {
  const o = getOrderRow(db, reference);
  if (!o) throw new BusinessError('NOT_FOUND', `No order with reference "${reference}"`);
  const expired = o.status === 'pending_payment' && o.reserved_until <= now();
  const failure = o.payment_status === 'paid' ? undefined
    : db.prepare('SELECT reason, at FROM payment_failure WHERE order_reference = ? ORDER BY at DESC LIMIT 1').get(o.reference) as { reason: string; at: number } | undefined;
  return {
    order_reference: o.reference,
    order_status: o.status,
    payment_status: o.payment_status,
    total: toNaira(o.total),
    total_display: formatNaira(o.total),
    paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null,
    reservation_expired: expired,
    last_failure: failure ? { reason: failure.reason, at: new Date(failure.at).toISOString() } : null,
    payment_link: o.payment_status === 'unpaid' && o.status === 'pending_payment' ? paymentLink(o.reference) || null : null,
    note: o.payment_status === 'paid'
      ? 'Payment confirmed by a trusted source.'
      : 'No trusted payment confirmation has been received. Do not treat this order as paid. If last_failure is set, explain it kindly and offer a fresh payment link.',
  };
}

export function orderView(db: DB, o: OrderRow) {
  const customer = db.prepare('SELECT name, phone FROM customer WHERE id = ?').get(o.customer_id) as { name: string; phone: string };
  const payments = db.prepare('SELECT provider, provider_reference, idempotency_key, status, amount, confirmed_at FROM payment WHERE order_id = ? ORDER BY id').all(o.id);
  return {
    reference: o.reference,
    status: o.status,
    payment_status: o.payment_status,
    reservation_expired: o.status === 'pending_payment' && o.reserved_until <= now(),
    customer,
    items: orderItems(db, o.id).map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity, unit_price: toNaira(i.agreed_unit_price), line_total: toNaira(i.line_total) })),
    subtotal: toNaira(o.subtotal),
    delivery_fee: toNaira(o.delivery_fee),
    total: toNaira(o.total),
    currency: o.currency,
    fulfilment: { method: o.fulfilment_method, zone: o.delivery_zone, address: o.delivery_address },
    payments,
    created_at: new Date(o.created_at).toISOString(),
    paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null,
  };
}

export function listOrders(db: DB) {
  return (db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all() as OrderRow[]).map((o) => orderView(db, o));
}

/** Customer-initiated cancel of their own unpaid order (specs/10 L-4). Frees the held item at once. */
export function cancelOwnOrder(db: DB, reference: string, customerPhone: string) {
  return tx(db, () => {
    const o = getOrderRow(db, reference);
    const phone = normalisePhone(customerPhone);
    const owner = o ? (db.prepare('SELECT phone FROM customer WHERE id = ?').get(o.customer_id) as { phone: string }).phone : null;
    if (!o || owner !== phone) throw new BusinessError('NOT_FOUND', `No order ${reference} for this customer`);
    if (o.status !== 'pending_payment') throw new BusinessError('INVALID_STATE', `Order ${o.reference} is ${o.status.replace(/_/g, ' ')} and can't be cancelled here; hand over to Kemi`);
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
    return { order_reference: o.reference, status: 'cancelled' as const, released: orderItems(db, o.id).map((i) => ({ sku: i.sku, quantity: i.quantity })) };
  });
}

export function cancelOrder(db: DB, reference: string) {
  return tx(db, () => {
    const o = getOrderRow(db, reference);
    if (!o) throw new BusinessError('NOT_FOUND', `No order ${reference}`);
    if (o.status !== 'pending_payment') throw new BusinessError('INVALID_STATE', `Order ${o.reference} is ${o.status}; only unpaid orders can be cancelled`);
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
    return orderView(db, getOrderRow(db, reference)!);
  });
}
