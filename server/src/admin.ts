// Owner catalogue management (FR-01). Validated with the same rules the DB CHECKs enforce.
import { z } from 'zod';
import type { DB } from './db.ts';
import { now, tx } from './db.ts';
import { BusinessError } from './errors.ts';
import { getProduct, variantsOf } from './catalogue.ts';
import type { ProductRow, VariantRow } from './catalogue.ts';
import { toKobo, toNaira } from './money.ts';

const naira = z.number().positive().max(10_000_000);

export const VariantInput = z.strictObject({
  sku: z.string().trim().regex(/^[A-Z0-9-]{2,40}$/i),
  attributes: z.record(z.string(), z.string()).default({}),
  price_override: naira.nullable().optional(),
  stock_quantity: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
});

export const ProductInput = z.strictObject({
  code: z.string().trim().regex(/^[A-Z]{2}-\d{3}$/i, 'Code format is XX-000'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  item_type: z.enum(['product', 'service']).default('product'),
  base_price: naira,
  pricing_mode: z.enum(['fixed', 'negotiable']),
  minimum_price: naira.nullable().optional(),
  unit: z.string().trim().max(30).default('piece'),
  stock_tracking_enabled: z.boolean().default(true),
  tags: z.string().trim().max(300).default(''),
  active: z.boolean().default(true),
  variants: z.array(VariantInput).min(1).max(50),
});

export const ProductPatch = ProductInput.omit({ code: true, variants: true }).partial();
export const VariantPatch = VariantInput.omit({ sku: true, attributes: true }).extend({ attributes: z.record(z.string(), z.string()).optional() }).partial();

function checkPricing(mode: string, base: number, min: number | null | undefined) {
  if (mode === 'negotiable' && (min == null || min > base)) {
    throw new BusinessError('INVALID_INPUT', 'A negotiable product needs a minimum_price that is no higher than base_price');
  }
}

export function productAdminView(db: DB, p: ProductRow) {
  return {
    code: p.code, name: p.name, description: p.description, item_type: p.item_type,
    base_price: toNaira(p.base_price), pricing_mode: p.pricing_mode,
    minimum_price: p.minimum_price === null ? null : toNaira(p.minimum_price),
    unit: p.unit, stock_tracking_enabled: Boolean(p.stock_tracking_enabled), tags: p.tags, active: Boolean(p.active),
    variants: variantsOf(db, p.id).map((v: VariantRow) => ({
      sku: v.sku, attributes: JSON.parse(v.attributes_json),
      price_override: v.price_override === null ? null : toNaira(v.price_override),
      stock_quantity: v.stock_quantity, active: Boolean(v.active),
    })),
  };
}

export function listProductsAdmin(db: DB) {
  return (db.prepare('SELECT * FROM product ORDER BY code').all() as ProductRow[]).map((p) => productAdminView(db, p));
}

export function createProduct(db: DB, raw: unknown) {
  const p = ProductInput.parse(raw);
  checkPricing(p.pricing_mode, p.base_price, p.minimum_price);
  return tx(db, () => {
    if (getProduct(db, p.code)) throw new BusinessError('INVALID_STATE', `Product ${p.code} already exists`);
    const r = db.prepare(
      `INSERT INTO product (business_id, code, name, description, item_type, base_price, pricing_mode, minimum_price, unit,
         stock_tracking_enabled, tags, active, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.code.toUpperCase(), p.name, p.description, p.item_type, toKobo(p.base_price), p.pricing_mode,
      p.pricing_mode === 'negotiable' && p.minimum_price != null ? toKobo(p.minimum_price) : null,
      p.unit, p.stock_tracking_enabled ? 1 : 0, p.tags, p.active ? 1 : 0, now());
    const pid = Number(r.lastInsertRowid);
    for (const v of p.variants) addVariantRow(db, pid, v, p.stock_tracking_enabled);
    return productAdminView(db, getProduct(db, p.code)!);
  });
}

function addVariantRow(db: DB, productId: number, v: z.infer<typeof VariantInput>, tracked: boolean) {
  if (db.prepare('SELECT 1 FROM variant WHERE sku = ?').get(v.sku)) throw new BusinessError('INVALID_STATE', `SKU ${v.sku} already exists`);
  db.prepare('INSERT INTO variant (product_id, sku, attributes_json, price_override, stock_quantity, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(productId, v.sku.toUpperCase(), JSON.stringify(v.attributes), v.price_override ? toKobo(v.price_override) : null,
      tracked ? (v.stock_quantity ?? 0) : null, v.active === false ? 0 : 1);
}

export function addVariant(db: DB, code: string, raw: unknown) {
  const v = VariantInput.parse(raw);
  return tx(db, () => {
    const p = getProduct(db, code);
    if (!p) throw new BusinessError('NOT_FOUND', `No product ${code}`);
    addVariantRow(db, p.id, v, Boolean(p.stock_tracking_enabled));
    return productAdminView(db, p);
  });
}

export function updateProduct(db: DB, code: string, raw: unknown) {
  const patch = ProductPatch.parse(raw);
  return tx(db, () => {
    const p = getProduct(db, code);
    if (!p) throw new BusinessError('NOT_FOUND', `No product ${code}`);
    const mode = patch.pricing_mode ?? p.pricing_mode;
    const base = patch.base_price ?? toNaira(p.base_price);
    const min = patch.minimum_price !== undefined ? patch.minimum_price : p.minimum_price === null ? null : toNaira(p.minimum_price);
    checkPricing(mode, base, min);
    db.prepare(
      `UPDATE product SET name = ?, description = ?, item_type = ?, base_price = ?, pricing_mode = ?, minimum_price = ?, unit = ?,
         stock_tracking_enabled = ?, tags = ?, active = ?, updated_at = ? WHERE id = ?`,
    ).run(patch.name ?? p.name, patch.description ?? p.description, patch.item_type ?? p.item_type, toKobo(base), mode,
      mode === 'negotiable' && min != null ? toKobo(min) : null, patch.unit ?? p.unit,
      patch.stock_tracking_enabled === undefined ? p.stock_tracking_enabled : patch.stock_tracking_enabled ? 1 : 0,
      patch.tags ?? p.tags, patch.active === undefined ? p.active : patch.active ? 1 : 0, now(), p.id);
    return productAdminView(db, getProduct(db, code)!);
  });
}

export function updateVariant(db: DB, sku: string, raw: unknown) {
  const patch = VariantPatch.parse(raw);
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM variant WHERE sku = ?').get(sku) as VariantRow | undefined;
    if (!v) throw new BusinessError('NOT_FOUND', `No variant ${sku}`);
    db.prepare('UPDATE variant SET attributes_json = ?, price_override = ?, stock_quantity = ?, active = ? WHERE id = ?').run(
      patch.attributes ? JSON.stringify(patch.attributes) : v.attributes_json,
      patch.price_override === undefined ? v.price_override : patch.price_override === null ? null : toKobo(patch.price_override),
      patch.stock_quantity === undefined ? v.stock_quantity : patch.stock_quantity,
      patch.active === undefined ? v.active : patch.active ? 1 : 0,
      v.id,
    );
    const p = db.prepare('SELECT * FROM product WHERE id = ?').get(v.product_id) as ProductRow;
    return productAdminView(db, p);
  });
}
