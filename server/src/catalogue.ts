// Catalogue reads: search, details, stock (FR-01..03, FR-05; spec 03-design §D4, §D7).
import type { DB } from './db.ts';
import { now } from './db.ts';
import { BusinessError } from './errors.ts';
import { formatNaira, toNaira } from './money.ts';

export type ProductRow = {
  id: number; code: string; name: string; description: string; item_type: 'product' | 'service';
  base_price: number; pricing_mode: 'fixed' | 'negotiable'; minimum_price: number | null;
  unit: string; stock_tracking_enabled: number; tags: string; active: number;
};
export type VariantRow = {
  id: number; product_id: number; sku: string; attributes_json: string;
  price_override: number | null; stock_quantity: number | null; active: number;
};

export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock' | 'not_tracked';
const LOW_STOCK = 2;

export function listPrice(p: ProductRow, v: VariantRow): number {
  return v.price_override ?? p.base_price;
}

/** Units held by unexpired pending orders (lazy reservation expiry, §D4). */
export function reservedQuantity(db: DB, variantId: number, at = now()): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS q FROM order_item oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.variant_id = ? AND o.status = 'pending_payment' AND o.reserved_until > ?`,
  ).get(variantId, at) as { q: number };
  return Number(row.q);
}

/** Available units, or null when the product does not track stock. */
export function availableQuantity(db: DB, p: ProductRow, v: VariantRow): number | null {
  if (!p.stock_tracking_enabled || v.stock_quantity === null) return null;
  return Math.max(0, v.stock_quantity - reservedQuantity(db, v.id));
}

function availabilityOf(available: number | null): Availability {
  if (available === null) return 'not_tracked';
  if (available <= 0) return 'out_of_stock';
  return available <= LOW_STOCK ? 'low_stock' : 'in_stock';
}

export function getProduct(db: DB, code: string): ProductRow | undefined {
  return db.prepare('SELECT * FROM product WHERE code = ?').get(code) as ProductRow | undefined;
}

export function variantsOf(db: DB, productId: number): VariantRow[] {
  return db.prepare('SELECT * FROM variant WHERE product_id = ? ORDER BY id').all(productId) as VariantRow[];
}

/** Resolve a variant SKU, or a product code for single-variant products such as services. */
export function resolveSku(db: DB, sku: string): { product: ProductRow; variant: VariantRow } {
  let variant = db.prepare('SELECT * FROM variant WHERE sku = ?').get(sku.trim()) as VariantRow | undefined;
  if (!variant) {
    const product = getProduct(db, sku.trim());
    const vs = product ? variantsOf(db, product.id) : [];
    if (product && vs.length === 1) variant = vs[0];
    else if (product) {
      throw new BusinessError('INVALID_INPUT', `${product.code} has several variants; use one of: ${vs.map((v) => v.sku).join(', ')}`);
    }
  }
  if (!variant) throw new BusinessError('NOT_FOUND', `No item with code or SKU "${sku}"`);
  const product = db.prepare('SELECT * FROM product WHERE id = ?').get(variant.product_id) as ProductRow;
  return { product, variant };
}

export function assertSellable(product: ProductRow, variant: VariantRow): void {
  if (!product.active || !variant.active) {
    throw new BusinessError('INACTIVE', `${variant.sku} is not currently on sale`);
  }
}

function variantView(db: DB, p: ProductRow, v: VariantRow) {
  const price = listPrice(p, v);
  // Live, reservation-aware count (same calc as check_stock) so the agent can skip a round trip (specs/06 R-3.1).
  const available = v.active ? availableQuantity(db, p, v) : 0;
  return {
    sku: v.sku,
    attributes: JSON.parse(v.attributes_json) as Record<string, string>,
    unit_price: toNaira(price),
    unit_price_display: formatNaira(price),
    availability: availabilityOf(available),
    available,
  };
}

function productView(db: DB, p: ProductRow) {
  return {
    code: p.code,
    name: p.name,
    item_type: p.item_type,
    pricing_mode: p.pricing_mode,
    unit_price: toNaira(p.base_price),
    unit_price_display: formatNaira(p.base_price),
    variants: variantsOf(db, p.id).map((v) => variantView(db, p, v)),
  };
}

// ---------------------------------------------------------------- search (§D7)

const SYNONYMS: Record<string, string> = {
  tee: 't-shirt', tees: 't-shirt', tshirt: 't-shirt', tshirts: 't-shirt', shirt: 't-shirt', shirts: 't-shirt',
  't-shirts': 't-shirt', top: 't-shirt',
  shoe: 'sneakers', shoes: 'sneakers', kicks: 'sneakers', trainers: 'sneakers', sneaker: 'sneakers', canvas: 'sneakers',
  xxl: '2xl', xxxl: '3xl', 'extra-large': 'xl',
  laptop: 'laptop', computer: 'laptop', fix: 'repair', fixing: 'repair', repairs: 'repair',
  white: 'white', blk: 'black', wht: 'white', baggy: 'oversized', oversize: 'oversized', big: 'oversized',
};
const STOPWORDS = new Set(['a', 'an', 'the', 'do', 'you', 'have', 'i', 'want', 'need', 'any', 'in', 'of', 'for', 'size', 'please', 'abeg', 'my', 'me', 'is', 'there', 'one', 'how', 'much']);

export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t)
    .filter((t) => !STOPWORDS.has(t));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function searchProducts(db: DB, query: string, limit = 5) {
  const tokens = tokenize(query);
  const rawUpper = query.toUpperCase().match(/[A-Z]{2}-\d{3}(?:-[A-Z0-9]+)*/g) ?? [];
  const products = db.prepare('SELECT * FROM product WHERE active = 1 ORDER BY name').all() as ProductRow[];

  // 1. exact code / SKU
  for (const code of rawUpper) {
    const v = db.prepare('SELECT * FROM variant WHERE sku = ?').get(code) as VariantRow | undefined;
    const p = v
      ? (db.prepare('SELECT * FROM product WHERE id = ?').get(v.product_id) as ProductRow)
      : getProduct(db, code);
    if (p && p.active) {
      const view = productView(db, p);
      const variants = v ? view.variants.filter((x) => x.sku === v.sku) : view.variants;
      return {
        results: [{ ...view, match_type: 'exact' as const, variants }],
        needs_clarification: !v && variants.length > 1,
        clarification_hint: !v && variants.length > 1 ? `Ask which ${describeAxes(variants)} they want.` : null,
      };
    }
  }

  // 2. scored fuzzy match
  const scored = products
    .map((p) => {
      const name = p.name.toLowerCase();
      const tags = p.tags.toLowerCase().split(/\s+/);
      const vs = variantsOf(db, p.id);
      const attrValues = vs.flatMap((v) => Object.values(JSON.parse(v.attributes_json) as Record<string, string>).map(norm));
      let score = 0;
      for (const t of tokens) {
        if (name.includes(t)) score += 3;
        if (tags.includes(t)) score += 2;
        else if (p.description.toLowerCase().includes(t)) score += 1;
        if (attrValues.includes(norm(t))) score += 2;
      }
      return { p, vs, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  // Drop weak matches (e.g. black sneakers for "black oversized shirt"): keep ≥ half the best score.
  const best = scored[0]?.score ?? 0;
  scored.splice(0, scored.length, ...scored.filter((s) => s.score * 2 >= best).slice(0, limit));

  if (scored.length === 0) {
    return { results: [], needs_clarification: true, clarification_hint: 'Nothing in the catalogue matches. Ask the customer to describe it differently, or offer what we do sell.' };
  }

  const results = scored.map(({ p, vs }) => {
    const view = productView(db, p);
    // Narrow variants by every attribute the query names (e.g. "3xl" → size), if any.
    const attrs = vs.map((v) => JSON.parse(v.attributes_json) as Record<string, string>);
    const mentioned = new Map<string, string>();
    for (const a of attrs) for (const [k, val] of Object.entries(a)) {
      if (tokens.some((t) => norm(t) === norm(val) || norm(t) === norm(val).replace(/^eu/, ''))) mentioned.set(k, norm(val));
    }
    const variants = view.variants.filter((_, i) =>
      [...mentioned].every(([k, val]) => norm(attrs[i][k] ?? '') === val));
    return { ...view, match_type: 'similar' as const, variants };
  });

  const top = scored[0].score;
  const closeRivals = scored.filter((s) => top - s.score <= 1).length;
  const multiVariant = results[0].variants.length > 1;
  const needs = closeRivals > 1 || multiVariant;
  return {
    results,
    needs_clarification: needs,
    clarification_hint: closeRivals > 1
      ? `Several products fit. Ask one short question to pick between: ${results.slice(0, closeRivals).map((r) => `${r.code} ${r.name}`).join('; ')}.`
      : multiVariant ? `Ask which ${describeAxes(results[0].variants)} they want.` : null,
  };
}

function describeAxes(variants: { attributes: Record<string, string> }[]): string {
  const keys = new Set<string>();
  for (const v of variants) for (const [k, val] of Object.entries(v.attributes)) {
    if (variants.some((o) => o.attributes[k] !== val)) keys.add(k);
  }
  return [...keys].join(' / ') || 'option';
}

// ---------------------------------------------------------------- details & stock

export function getProductDetails(db: DB, code: string) {
  let p = getProduct(db, code);
  if (!p) {
    const v = db.prepare('SELECT * FROM variant WHERE sku = ?').get(code) as VariantRow | undefined;
    if (v) p = db.prepare('SELECT * FROM product WHERE id = ?').get(v.product_id) as ProductRow;
  }
  if (!p || !p.active) throw new BusinessError('NOT_FOUND', `No product with code "${code}"`);
  const view = productView(db, p);
  return {
    product: {
      ...view,
      description: p.description,
      unit: p.unit,
      negotiable: p.pricing_mode === 'negotiable',
      list_price: view.unit_price,
      list_price_display: view.unit_price_display,
      stock_tracked: Boolean(p.stock_tracking_enabled),
    },
  };
}

export function checkStock(db: DB, sku: string, quantity: number) {
  const { product, variant } = resolveSku(db, sku);
  assertSellable(product, variant);
  const available = availableQuantity(db, product, variant);
  const canFulfil = available === null || available >= quantity;
  const alternatives = canFulfil
    ? []
    : variantsOf(db, product.id)
        .filter((v) => v.id !== variant.id && v.active)
        .map((v) => ({ v, a: availableQuantity(db, product, v) }))
        .filter(({ a }) => a === null || a >= quantity)
        .map(({ v, a }) => ({ sku: v.sku, attributes: JSON.parse(v.attributes_json), available: a }));
  return {
    sku: variant.sku,
    product_name: product.name,
    attributes: JSON.parse(variant.attributes_json) as Record<string, string>,
    tracked: available !== null,
    available,
    requested: quantity,
    can_fulfil: canFulfil,
    alternatives,
  };
}
