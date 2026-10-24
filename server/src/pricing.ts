// Negotiation rules (FR-04; spec 03-design §D5). The backend, not the model, decides prices.
import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { BusinessError } from './errors.ts';
import { assertSellable, listPrice, resolveSku } from './catalogue.ts';
import type { ProductRow, VariantRow } from './catalogue.ts';
import { formatNaira, roundUpTo500, toKobo, toNaira } from './money.ts';

export type OfferDecision = 'accepted' | 'rejected_fixed_price' | 'rejected_below_floor';

export type OfferResult = {
  sku: string; quantity: number; decision: OfferDecision;
  list_unit_price: number; list_unit_price_display: string;
  unit_price: number; unit_price_display: string; total_for_quantity: number; message_hint: string;
  counter_offer?: number; counter_offer_display?: string; offer_id?: string; offer_expires_at?: string;
};

export type OfferRow = {
  id: string; variant_id: number; quantity: number; requested_price: number;
  agreed_unit_price: number; expires_at: number; created_at: number;
};

/** Floor in kobo. Fixed-price items have floor = list price. */
export function floorPrice(p: ProductRow, v: VariantRow): number {
  const list = listPrice(p, v);
  if (p.pricing_mode === 'fixed' || p.minimum_price === null) return list;
  // A variant price override scales the floor proportionally.
  return v.price_override ? Math.round((p.minimum_price * v.price_override) / p.base_price) : p.minimum_price;
}

export function calculateOffer(db: DB, sku: string, requestedNaira: number, quantity: number, offerMinutes = 60): OfferResult {
  const { product, variant } = resolveSku(db, sku);
  assertSellable(product, variant);
  const list = listPrice(product, variant);
  const requested = toKobo(requestedNaira);
  const base = { sku: variant.sku, quantity, list_unit_price: toNaira(list), list_unit_price_display: formatNaira(list) };

  if (product.pricing_mode === 'fixed') {
    return {
      ...base,
      decision: 'rejected_fixed_price' as OfferDecision,
      unit_price: toNaira(list),
      unit_price_display: formatNaira(list),
      total_for_quantity: toNaira(list * quantity),
      message_hint: 'This item has a fixed price. Politely keep the listed price; no discount is possible.',
    };
  }

  const floor = floorPrice(product, variant);
  if (requested < floor) {
    // Fixed per item, independent of the bid, so counters never go UP as the customer raises their
    // offer (live finding: 16k → 17k → 16k). Midway between floor and list, so the floor isn't revealed.
    const counter = Math.min(list, Math.max(floor, roundUpTo500(Math.round((floor + list) / 2))));
    return {
      ...base,
      decision: 'rejected_below_floor' as OfferDecision,
      unit_price: toNaira(list),
      unit_price_display: formatNaira(list),
      counter_offer: toNaira(counter),
      counter_offer_display: formatNaira(counter),
      total_for_quantity: toNaira(list * quantity),
      message_hint: `Kindly decline ${formatNaira(requested)} and offer ${formatNaira(counter)}. This is always the same counter for this item. If they accept, call calculate_offer again with that amount.`,
    };
  }

  const agreed = Math.min(requested, list); // never charge above the listing
  const t = now();
  const offerId = 'OF-' + randomBytes(5).toString('hex').toUpperCase();
  const expiresAt = t + offerMinutes * 60_000;
  db.prepare(
    `INSERT INTO offer (id, variant_id, quantity, requested_price, agreed_unit_price, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(offerId, variant.id, quantity, requested, agreed, expiresAt, t);
  return {
    ...base,
    decision: 'accepted' as OfferDecision,
    unit_price: toNaira(agreed),
    unit_price_display: formatNaira(agreed),
    total_for_quantity: toNaira(agreed * quantity),
    offer_id: offerId,
    offer_expires_at: new Date(expiresAt).toISOString(),
    message_hint: `Deal agreed at ${formatNaira(agreed)} each. Pass offer_id ${offerId} to create_pending_order.`,
  };
}

/** Re-validate an offer at order time (§D5): exists, unexpired, same variant, qty ≤ offered, still ≥ current floor. */
export function redeemOffer(db: DB, offerId: string, p: ProductRow, v: VariantRow, quantity: number, at = now()): number {
  const offer = db.prepare('SELECT * FROM offer WHERE id = ?').get(offerId) as OfferRow | undefined;
  if (!offer || offer.variant_id !== v.id) throw new BusinessError('OFFER_INVALID', `Offer ${offerId} does not apply to ${v.sku}`);
  if (offer.expires_at <= at) throw new BusinessError('OFFER_EXPIRED', `Offer ${offerId} has expired; check the price again with calculate_offer`);
  if (quantity > offer.quantity) throw new BusinessError('OFFER_INVALID', `Offer ${offerId} was agreed for ${offer.quantity}, not ${quantity}`);
  if (p.pricing_mode === 'fixed' || offer.agreed_unit_price < floorPrice(p, v)) {
    throw new BusinessError('OFFER_INVALID', `The price rules for ${v.sku} have changed; check the price again with calculate_offer`);
  }
  return Math.min(offer.agreed_unit_price, listPrice(p, v));
}
