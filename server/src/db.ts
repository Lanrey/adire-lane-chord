// SQLite schema and transaction helper (spec 03-design §D3).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS business (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  payment_terms TEXT NOT NULL,
  info_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES business(id),
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL CHECK (item_type IN ('product','service')),
  base_price INTEGER NOT NULL CHECK (base_price > 0),
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN ('fixed','negotiable')),
  minimum_price INTEGER,
  unit TEXT NOT NULL DEFAULT 'piece',
  stock_tracking_enabled INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  CHECK (pricing_mode = 'fixed' OR (minimum_price IS NOT NULL AND minimum_price > 0 AND minimum_price <= base_price))
);
CREATE TABLE IF NOT EXISTS variant (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES product(id),
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  price_override INTEGER,
  stock_quantity INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS offer (
  id TEXT PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variant(id),
  quantity INTEGER NOT NULL,
  requested_price INTEGER NOT NULL,
  agreed_unit_price INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  delivery_address TEXT
);
CREATE TABLE IF NOT EXISTS conversation (
  id INTEGER PRIMARY KEY,
  customer_phone TEXT NOT NULL UNIQUE,
  chord_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handover')),
  handover_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  business_id INTEGER NOT NULL REFERENCES business(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','paid','paid_needs_attention','cancelled')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid','paid')),
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fulfilment_method TEXT NOT NULL CHECK (fulfilment_method IN ('pickup','delivery')),
  delivery_zone TEXT,
  delivery_address TEXT,
  reserved_until INTEGER NOT NULL,
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_item (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  variant_id INTEGER NOT NULL REFERENCES variant(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  list_unit_price INTEGER NOT NULL,
  agreed_unit_price INTEGER NOT NULL,
  offer_id TEXT,
  line_total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('paystack','simulated','admin_test')),
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('succeeded','ignored')),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  raw_event_json TEXT
);
CREATE TABLE IF NOT EXISTS handover (
  id TEXT PRIMARY KEY,
  customer_phone TEXT,
  customer_name TEXT,
  reason_category TEXT NOT NULL,
  summary TEXT NOT NULL,
  order_reference TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkout_nonce (
  nonce TEXT PRIMARY KEY,
  order_reference TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_log (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_code TEXT,
  order_reference TEXT,
  latency_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chord_delivery (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variant(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  UNIQUE (variant_id, customer_phone)
);
CREATE TABLE IF NOT EXISTS demand_event (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('no_match','out_of_stock','below_floor','fixed_price_haggle','waitlist_join')),
  sku TEXT,
  detail TEXT,
  amount INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification (
  key TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  thread_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_failure (
  id INTEGER PRIMARY KEY,
  order_reference TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_action (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_item_variant ON order_item(variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, reserved_until);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run fn inside BEGIN IMMEDIATE so concurrent writers are serialised (spec D4).
 * Nested calls reuse the outer transaction.
 */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = (): number => Date.now();
