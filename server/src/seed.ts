// Seed data: one business + PRD appendix catalogue, extended so every acceptance
// test has something to bite on (an out-of-stock variant, an ambiguous "black tee").
// All data is made up (brief ground rules).
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { openDb, tx, now } from './db.ts';
import type { DB } from './db.ts';
import { toKobo } from './money.ts';

export const BUSINESS_INFO = {
  // Customer-facing words (specs/10). The address is invented for the exercise.
  opening_hours: 'Monday to Saturday, 10am to 7pm (closed on Sundays)',
  pickup_address: 'our studio at 12 Herbert Macaulay Way, Yaba, Lagos',
  delivery_zones: [
    { zone: 'lagos_mainland', label: 'Lagos Mainland (Yaba, Surulere, Ikeja, Gbagada…)', fee: toKobo(2500), eta: 'same day if paid before 2pm, otherwise next day' },
    { zone: 'lagos_island', label: 'Lagos Island (VI, Ikoyi, Lekki, Ajah)', fee: toKobo(3500), eta: 'next working day' },
    { zone: 'outside_lagos', label: 'Outside Lagos (interstate courier)', fee: toKobo(5000), eta: '2–4 working days' },
  ],
  returns_policy:
    'Size exchanges within 3 days of delivery if the item is unworn with tags on. No cash refunds by the assistant: refund requests go to the owner.',
};

type SeedVariant = { sku: string; attributes: Record<string, string>; stock: number | null; price?: number };
type SeedProduct = {
  code: string; name: string; description: string; item_type: 'product' | 'service';
  base_price: number; pricing_mode: 'fixed' | 'negotiable'; minimum_price?: number;
  unit: string; tracked: boolean; tags: string; variants: SeedVariant[];
};

export const CATALOGUE: SeedProduct[] = [
  {
    code: 'TS-104', name: 'Oversized T-shirt – Eko Nights (Black)',
    description: 'Heavyweight 240gsm cotton oversized tee, dropped shoulders, plain black.',
    item_type: 'product', base_price: 15000, pricing_mode: 'negotiable', minimum_price: 13500,
    unit: 'piece', tracked: true, tags: 't-shirt oversized black plain cotton',
    variants: [
      { sku: 'TS-104-BLK-L', attributes: { colour: 'black', size: 'L' }, stock: 3 },
      { sku: 'TS-104-BLK-XL', attributes: { colour: 'black', size: 'XL' }, stock: 0 },
      { sku: 'TS-104-BLK-3XL', attributes: { colour: 'black', size: '3XL' }, stock: 2 },
    ],
  },
  {
    code: 'TS-105', name: 'Oversized T-shirt – Cloud (White)',
    description: 'Heavyweight 240gsm cotton oversized tee, plain white.',
    item_type: 'product', base_price: 14000, pricing_mode: 'fixed',
    unit: 'piece', tracked: true, tags: 't-shirt oversized white plain cotton',
    variants: [
      { sku: 'TS-105-WHT-L', attributes: { colour: 'white', size: 'L' }, stock: 0 },
      { sku: 'TS-105-WHT-XL', attributes: { colour: 'white', size: 'XL' }, stock: 4 },
    ],
  },
  {
    code: 'TS-106', name: 'Oversized Graphic T-shirt – Adire Print (Black)',
    description: 'Oversized black tee with an indigo adire-pattern back print.',
    item_type: 'product', base_price: 18000, pricing_mode: 'negotiable', minimum_price: 16000,
    unit: 'piece', tracked: true, tags: 't-shirt oversized black graphic print adire',
    variants: [
      { sku: 'TS-106-BLK-XL', attributes: { colour: 'black', size: 'XL' }, stock: 1 },
      { sku: 'TS-106-BLK-2XL', attributes: { colour: 'black', size: '2XL' }, stock: 2 },
    ],
  },
  {
    code: 'SN-210', name: 'Low-top Sneakers – Midnight',
    description: 'Black low-top leather sneakers with gum sole.',
    item_type: 'product', base_price: 38000, pricing_mode: 'negotiable', minimum_price: 35000,
    unit: 'pair', tracked: true, tags: 'sneakers shoes black leather',
    variants: [
      { sku: 'SN-210-BLK-42', attributes: { colour: 'black', size: 'EU 42' }, stock: 1 },
      { sku: 'SN-210-BLK-43', attributes: { colour: 'black', size: 'EU 43' }, stock: 0 },
    ],
  },
  {
    code: 'SV-001', name: 'Basic laptop repair assessment',
    description: 'Diagnostic check of a laptop fault with a written quote for the fix. Drop-off at the studio.',
    item_type: 'service', base_price: 5000, pricing_mode: 'fixed',
    unit: 'assessment', tracked: false, tags: 'service laptop repair diagnosis computer',
    variants: [{ sku: 'SV-001', attributes: { type: 'service' }, stock: null }],
  },
];

export function seed(db: DB): void {
  tx(db, () => {
    const t = now();
    db.prepare(
      `INSERT INTO business (id, name, currency, payment_terms, info_json, created_at)
       VALUES (1, 'Adire Lane', 'NGN', ?, ?, ?)`,
    ).run('Full payment before dispatch or pickup. Card, bank transfer or USSD via the payment link.', JSON.stringify(BUSINESS_INFO), t);

    const insP = db.prepare(
      `INSERT INTO product (business_id, code, name, description, item_type, base_price, pricing_mode,
        minimum_price, unit, stock_tracking_enabled, tags, active, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const insV = db.prepare(
      `INSERT INTO variant (product_id, sku, attributes_json, price_override, stock_quantity, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    for (const p of CATALOGUE) {
      const r = insP.run(
        p.code, p.name, p.description, p.item_type, toKobo(p.base_price), p.pricing_mode,
        p.minimum_price ? toKobo(p.minimum_price) : null, p.unit, p.tracked ? 1 : 0, p.tags, t,
      );
      for (const v of p.variants) {
        insV.run(Number(r.lastInsertRowid), v.sku, JSON.stringify(v.attributes), v.price ? toKobo(v.price) : null, v.stock);
      }
    }
  });
}

/** Wipe all data and re-seed atomically (demo reset; safe while the server is running). */
export function resetDemo(db: DB): void {
  tx(db, () => {
    for (const t of ['owner_action', 'payment_failure', 'notification', 'demand_event', 'waitlist', 'chord_delivery', 'tool_log', 'checkout_nonce', 'payment', 'order_item', 'orders', 'offer', 'handover', 'conversation', 'customer', 'variant', 'product', 'business']) {
      db.exec(`DELETE FROM ${t}`);
    }
    seed(db);
  });
}

/** Keep the stored business info in step with the code (config-as-code), without touching orders/stock. */
export function syncBusinessInfo(db: DB): void {
  db.prepare('UPDATE business SET info_json = ? WHERE id = 1').run(JSON.stringify(BUSINESS_INFO));
}

export function isSeeded(db: DB): boolean {
  return Boolean(db.prepare('SELECT 1 FROM business WHERE id = 1').get());
}

// `npm run seed` → wipe and re-seed the configured database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.env.DB_PATH ?? './data/adire-lane.db';
  if (process.argv.includes('--reset') && path !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
  const db = openDb(path);
  if (!isSeeded(db)) seed(db);
  console.log(`Seeded ${path}`);
}
