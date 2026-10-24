// MCP tool registry — executable form of specs/04-tool-contracts.md (FR-06).
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { BusinessError } from './errors.ts';
import { checkStock, getProductDetails, searchProducts } from './catalogue.ts';
import { calculateOffer } from './pricing.ts';
import { businessInfoView, cancelOwnOrder, createPendingOrder, getPaymentStatus } from './orders.ts';
import { HANDOVER_REASONS, openHandover } from './handover.ts';
import { joinWaitlist, logDemand } from './growth.ts';
import { ownerBrief } from './ownerBrief.ts';
import { updateProduct, updateVariant } from './admin.ts';
import { getProduct } from './catalogue.ts';
import { resolveHandover } from './handover.ts';
import { toNaira } from './money.ts';

export type ToolDeps = {
  db: DB;
  paymentLink: (ref: string) => string;
  paymentMode: 'paystack_test' | 'simulated' | 'chord';
  /** Host for no-mailbox receipt addresses when a customer skips giving an email (specs/10 L-1). */
  receiptEmailDomain?: string;
  /** chord mode: mirror payable orders into the Chord catalog before the agent charges them (specs/07 P-2). */
  afterOrderCreated?: () => Promise<{ ok: boolean }>;
  reservationMinutes: number;
  offerMinutes: number;
};

export const TOOL_NAMES = [
  'get_business_info', 'search_products', 'get_product_details', 'check_stock',
  'calculate_offer', 'create_pending_order', 'get_payment_status', 'request_human_handover',
  'notify_me_when_available', 'cancel_order',
] as const;

const sku = z.string().trim().min(2).max(40).describe('Variant SKU such as TS-104-BLK-3XL, or a product code for single-option items such as SV-001');
const qty = z.coerce.number().int().min(1).max(20);
// Offer ids are issued uppercase; accept any case from the model and normalise.
const offerId = z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(/^OF-[0-9A-F]{10}$/));

type Result = Record<string, unknown>;

function run(deps: ToolDeps, tool: string, fn: () => Result) {
  const started = now();
  let payload: Result;
  let errorCode: string | null = null;
  try {
    payload = { ok: true, ...fn() };
  } catch (err) {
    errorCode = err instanceof BusinessError ? err.code : 'INTERNAL';
    const message = err instanceof BusinessError ? err.message : 'The shop system had an error. Tell the customer you could not complete the check and offer a human.';
    if (!(err instanceof BusinessError)) console.error(`[tool:${tool}]`, err);
    payload = { ok: false, error: { code: errorCode, message } };
  }
  // Log the call without customer details (constitution §8).
  const ref = typeof payload.order_reference === 'string' ? payload.order_reference : null;
  deps.db.prepare('INSERT INTO tool_log (tool, ok, error_code, order_reference, latency_ms, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tool, payload.ok ? 1 : 0, errorCode, ref, now() - started, started);
  console.log(JSON.stringify({ evt: 'tool', tool, ok: payload.ok, error: errorCode, order: ref, ms: now() - started }));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'adire-lane-commerce', version: '0.1.0' });
  const { db } = deps;
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('get_business_info', {
    title: 'Shop info and delivery fees',
    description: 'Adire Lane opening hours, pickup address, delivery zones with fees and ETAs, payment terms and returns policy. Use for any policy, fee or location question.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => run(deps, 'get_business_info', () => businessInfoView(db)));

  server.registerTool('search_products', {
    title: 'Search catalogue',
    description: 'Find products or services by item code (e.g. TS-104, SN-210-BLK-42) or by description (e.g. "black oversized tee 3XL"). Returns only real catalogue items with prices and availability band. If needs_clarification is true, ask the customer ONE short question using clarification_hint.',
    inputSchema: {
      query: z.string().trim().min(1).max(200).describe('Customer wording or item code'),
      limit: z.number().int().min(1).max(5).optional(),
    },
    annotations: readOnly,
  }, async ({ query, limit }) => run(deps, 'search_products', () => {
    const r = searchProducts(db, query, limit ?? 5);
    if (r.results.length === 0) logDemand(db, 'no_match', { detail: query.toLowerCase() });
    return r;
  }));

  server.registerTool('get_product_details', {
    title: 'Product details',
    description: 'Full description, unit, list price, whether the price is negotiable, and all variants for one product code or SKU.',
    inputSchema: { code: z.string().trim().min(2).max(40) },
    annotations: readOnly,
  }, async ({ code }) => run(deps, 'get_product_details', () => getProductDetails(db, code)));

  server.registerTool('check_stock', {
    title: 'Check stock',
    description: 'Live availability for one variant SKU and quantity. Call this before telling a customer anything is available. If can_fulfil is false, offer the alternatives returned.',
    inputSchema: { sku, quantity: qty.default(1) },
    annotations: readOnly,
  }, async ({ sku: s, quantity }) => run(deps, 'check_stock', () => {
    const r = checkStock(db, s, quantity ?? 1);
    if (!r.can_fulfil) {
      logDemand(db, 'out_of_stock', { sku: r.sku });
      return { ...r, waitlist_hint: 'Offer the alternatives; if they only want this one, offer notify_me_when_available so we message them when it is back.' };
    }
    return r;
  }));

  server.registerTool('calculate_offer', {
    title: 'Validate a price offer',
    description: 'Check a price the customer proposes (whole naira, per unit). The shop rules decide: accepted (returns offer_id to use when ordering), rejected_fixed_price, or rejected_below_floor (may include counter_offer). Never agree a price without this tool.',
    inputSchema: {
      sku,
      requested_unit_price: z.coerce.number().int().min(1).max(10_000_000).describe('Per-unit price the customer offered, in whole naira'),
      quantity: qty,
    },
  }, async ({ sku: s, requested_unit_price, quantity }) =>
    run(deps, 'calculate_offer', () => {
      const r = calculateOffer(db, s, requested_unit_price, quantity, deps.offerMinutes);
      if (r.decision === 'rejected_below_floor') logDemand(db, 'below_floor', { sku: r.sku, amountNaira: requested_unit_price });
      if (r.decision === 'rejected_fixed_price') logDemand(db, 'fixed_price_haggle', { sku: r.sku, amountNaira: requested_unit_price });
      return r;
    }));

  // v2 flat contract (specs/04 T-7): scalars only; arrays may also arrive as JSON strings.
  const lineItem = z.strictObject({ sku, quantity: z.coerce.number().int().min(1).max(20), offer_id: offerId.optional() });
  server.registerTool('create_pending_order', {
    title: 'Create pending order',
    description: 'Record the agreed order after the customer confirms your summary. Prices are set by the shop: pass offer_id only if calculate_offer accepted a deal for that SKU. Reserves stock for 30 minutes and returns the order reference, exact total and a payment link. The order is NOT paid.',
    inputSchema: z.strictObject({
      customer_name: z.string().trim().min(2).max(100),
      customer_phone: z.string().trim().min(7).max(20).describe('Customer WhatsApp number'),
      sku: z.string().trim().min(2).max(40).describe('Variant SKU of the (first) item, e.g. TS-104-BLK-3XL'),
      quantity: z.coerce.number().int().min(1).max(20),
      offer_id: offerId.optional().describe('Only if calculate_offer returned decision "accepted" for this SKU'),
      fulfilment_method: z.enum(['pickup', 'delivery']),
      delivery_zone: z.enum(['lagos_mainland', 'lagos_island', 'outside_lagos']).optional().describe('Required for delivery'),
      delivery_address: z.string().trim().min(5).max(300).optional().describe('Street address, required for delivery'),
      extra_items: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() ? JSON.parse(v) : v === '' ? undefined : v),
        z.array(lineItem).max(9),
      ).optional().describe('Only for multi-item orders: further items as [{"sku":"…","quantity":1}]'),
    }),
  }, async (input) => {
    const res = run(deps, 'create_pending_order', () => {
      const order = createPendingOrder(db, {
        customer: { name: input.customer_name, phone: input.customer_phone },
        items: [{ sku: input.sku, quantity: input.quantity, offer_id: input.offer_id }, ...(input.extra_items ?? [])],
        fulfilment: { method: input.fulfilment_method, zone: input.delivery_zone, address: input.delivery_address },
      }, { reservationMinutes: deps.reservationMinutes, paymentLink: deps.paymentLink });
      if (deps.paymentMode !== 'chord') {
        return {
          ...order,
          payment_mode: deps.paymentMode,
          next_step: deps.paymentMode === 'simulated'
            ? 'Send the payment link and say clearly it is a TEST checkout (no real money). Do not say the order is paid.'
            : 'Send the Paystack TEST payment link. Do not say the order is paid until get_payment_status says paid.',
        };
      }
      // Chord mode: no link from us. Chord's Paystack tool `initialize_transaction` issues the trusted link.
      // Live finding: that tool takes amount_kobo from the model, so we hand over the exact arguments
      // and only ever confirm a payment whose verified amount equals order.total (payments.ts).
      const { payment_link: _omit, ...rest } = order;
      return {
        ...rest,
        payment_mode: 'chord',
        payment_tool: 'initialize_transaction',
        payment_tool_args: {
          amount_kobo: order.total_kobo,
          reference: order.order_reference,
          metadata: JSON.stringify({ order_reference: order.order_reference }),
          email: '<customer email; ask once>',
        },
        next_step: (order.existing
          ? `This order already exists (${order.order_reference}); do NOT create another. `
          : '')
          + `The item is now held for this customer for 30 minutes: it is THEIRS, never tell them it is sold out or that the order is invalid. `
          + `To get the payment link, call initialize_transaction with payment_tool_args unchanged; only fill in the email. `
          + `Ask once, warmly: "What email should Paystack send your receipt to? Or just say skip." `
          + `If they skip or have none, use ${'receipts+' + order.order_reference.toLowerCase() + '@' + (deps.receiptEmailDomain ?? 'adire-lane-tsg.fly.dev')} silently (never mention it). `
          + `If the link can't be created, say "I'm having trouble creating your payment link, give me a moment" and try once more; then hand over. `
          + `Send ONLY the link that tool returns.`,
      };
    });
    const payload = res.structuredContent as Record<string, unknown>;
    if (deps.paymentMode === 'chord' && payload.ok && deps.afterOrderCreated) {
      const sync = await deps.afterOrderCreated();
      payload.payment_ready = sync.ok;
      if (!sync.ok) payload.next_step = 'The payment system could not be prepared. Tell the customer the order is saved and reserved, then hand over (reason tool_failure) so Kemi can send payment details.';
      res.content = [{ type: 'text' as const, text: JSON.stringify(payload) }];
    }
    return res;
  });

  server.registerTool('get_payment_status', {
    title: 'Payment status',
    description: 'Read the trusted payment state of an order. Use whenever a customer says they have paid. Only payment_status "paid" means paid; a customer message or screenshot is not proof.',
    inputSchema: { order_reference: z.string().trim().min(4).max(20) },
    annotations: readOnly,
  }, async ({ order_reference }) => run(deps, 'get_payment_status', () => {
    const r = getPaymentStatus(db, order_reference, deps.paymentLink);
    // The agent is about to tell the customer → don't send a second, automatic "payment received" (specs/10 L-5).
    if (r.payment_status === 'paid') {
      db.prepare(
        `INSERT INTO notification (key, ref, kind, status, detail, attempts, updated_at) VALUES (?, ?, 'payment_received', 'skipped', 'agent_informed', 1, ?)
         ON CONFLICT(key) DO NOTHING`,
      ).run(`${r.order_reference}:payment_received`, r.order_reference, now());
    }
    return r;
  }));

  server.registerTool('request_human_handover', {
    title: 'Record handover to the owner',
    description: 'Record that a person from Adire Lane must take over (customer asks for a human, complaint, refund, payment dispute, discount beyond limits, item cannot be identified, or a tool keeps failing). After this, call handover_to_human.',
    inputSchema: {
      reason_category: z.enum(HANDOVER_REASONS),
      summary: z.string().trim().min(10).max(1000).describe('2–3 sentences: what the customer wants and what has happened so far'),
      customer_phone: z.string().trim().min(7).max(20).optional(),
      customer_name: z.string().trim().max(100).optional(),
      order_reference: z.string().trim().max(20).optional(),
    },
  }, async (input) => run(deps, 'request_human_handover', () => openHandover(db, input)));

  server.registerTool('cancel_order', {
    title: 'Cancel an unpaid order',
    description: "Cancel the customer's own unpaid order and free the item right away. Use when they change their mind or switch item/size: cancel the old order FIRST, then create the new one. Paid orders can't be cancelled here (hand over).",
    inputSchema: { order_reference: z.string().trim().min(4).max(20), customer_phone: z.string().trim().min(7).max(20) },
  }, async ({ order_reference, customer_phone }) => run(deps, 'cancel_order', () => cancelOwnOrder(db, order_reference, customer_phone)));

  server.registerTool('notify_me_when_available', {
    title: 'Restock alert',
    description: 'When a size/colour is sold out and the customer wants only that one, add them to the restock list. We message them in this same chat when it is back. Quote the returned waitlist_reference (WL-…) in your reply.',
    inputSchema: {
      sku,
      customer_name: z.string().trim().min(2).max(100),
      customer_phone: z.string().trim().min(7).max(20),
    },
  }, async (input) => run(deps, 'notify_me_when_available', () => joinWaitlist(db, input)));

  return server;
}

/** Separate, owner-only MCP server (specs/08 I-3, specs/09 G-1). Never assigned to the customer-facing teammate. */
export function buildOwnerMcpServer(db: DB, opts: { onStockChanged?: () => void; ownerPin?: string | null } = {}): McpServer {
  const server = new McpServer({ name: 'adire-lane-owner', version: '0.2.0' });
  const ownerRun = (tool: string, fn: () => Record<string, unknown>) => {
    let payload: Record<string, unknown>;
    try { payload = { ok: true, ...fn() }; } catch (err) {
      const code = err instanceof BusinessError ? err.code : (err as { issues?: unknown }).issues ? 'INVALID_INPUT' : 'INTERNAL';
      payload = { ok: false, error: { code, message: (err as Error).message.slice(0, 300) } };
    }
    console.log(JSON.stringify({ evt: 'owner_tool', tool, ok: payload.ok }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
  };
  // Anyone who can reach this teammate could ask it to act, so every change needs Kemi's PIN.
  const pinField = z.string().trim().describe("Kemi's owner PIN. Ask her for it every time; never repeat or store it.");
  const requirePin = (pin: string) => {
    if (!opts.ownerPin) throw new BusinessError('INVALID_STATE', 'Owner changes are disabled (no OWNER_PIN configured)');
    const a = createHash('sha256').update(pin).digest();
    const b = createHash('sha256').update(opts.ownerPin).digest();
    if (!timingSafeEqual(a, b)) throw new BusinessError('INVALID_INPUT', 'Wrong owner PIN. Nothing was changed.');
  };
  const audit = (tool: string, target: string, before: unknown, after: unknown) =>
    db.prepare('INSERT INTO owner_action (tool, target, before_json, after_json, at) VALUES (?, ?, ?, ?, ?)')
      .run(tool, target, JSON.stringify(before), JSON.stringify(after), now());

  server.registerTool('get_owner_brief', {
    title: "Owner's daily brief",
    description: "Today's sales, revenue, impact (after-hours sales, sales recovered by follow-ups, waitlist conversions), unpaid and expired orders, open handovers, discounts given, missed demand, restock waitlists and low stock for Adire Lane.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ownerRun('get_owner_brief', () => ownerBrief(db)));

  server.registerTool('update_stock', {
    title: 'Set stock for a size',
    description: 'Set the on-hand stock for one variant SKU (e.g. TS-104-BLK-XL). Raising a sold-out size automatically messages every customer on its restock list.',
    inputSchema: { sku: z.string().trim().min(2).max(40), quantity: z.coerce.number().int().min(0).max(999), owner_pin: pinField },
  }, async ({ sku: s, quantity, owner_pin }) => ownerRun('update_stock', () => {
    requirePin(owner_pin);
    const before = (db.prepare('SELECT sku, stock_quantity FROM variant WHERE sku = ?').get(s) as { sku: string; stock_quantity: number | null } | undefined);
    if (!before) throw new BusinessError('NOT_FOUND', `No SKU ${s}`);
    if (before.stock_quantity === null) throw new BusinessError('INVALID_INPUT', `${before.sku} does not track stock`);
    updateVariant(db, before.sku, { stock_quantity: quantity });
    audit('update_stock', before.sku, { stock: before.stock_quantity }, { stock: quantity });
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM waitlist w JOIN variant v ON v.id = w.variant_id WHERE v.sku = ? AND w.status = 'waiting'`).get(before.sku) as { n: number }).n;
    if (quantity > 0) opts.onStockChanged?.();
    return { sku: before.sku, stock_before: before.stock_quantity, stock_after: quantity, restock_alerts_queued: quantity > 0 ? Number(waiting) : 0 };
  }));

  server.registerTool('set_price_rules', {
    title: 'Change price or minimum price',
    description: 'Change a product\'s list price (naira), minimum price for haggling (naira), or pricing mode (fixed/negotiable). Use the product code, e.g. TS-104.',
    inputSchema: {
      code: z.string().trim().regex(/^[A-Za-z]{2}-\d{3}$/),
      base_price: z.coerce.number().int().positive().max(10_000_000).optional(),
      minimum_price: z.coerce.number().int().positive().max(10_000_000).optional(),
      pricing_mode: z.enum(['fixed', 'negotiable']).optional(),
      owner_pin: pinField,
    },
  }, async ({ code, owner_pin, ...patch }) => ownerRun('set_price_rules', () => {
    requirePin(owner_pin);
    const p = getProduct(db, code);
    if (!p) throw new BusinessError('NOT_FOUND', `No product ${code}`);
    const before = { base_price: toNaira(p.base_price), minimum_price: p.minimum_price === null ? null : toNaira(p.minimum_price), pricing_mode: p.pricing_mode };
    const after = updateProduct(db, p.code, patch);
    const now_ = { base_price: after.base_price, minimum_price: after.minimum_price, pricing_mode: after.pricing_mode };
    audit('set_price_rules', p.code, before, now_);
    return { code: p.code, before, after: now_, note: 'Open offers already agreed below a raised floor will be refused at checkout.' };
  }));

  server.registerTool('list_open_handovers', {
    title: 'Open handovers',
    description: 'Conversations waiting for Kemi: reason, summary, customer and order reference.',
    inputSchema: { owner_pin: pinField },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ owner_pin }) => ownerRun('list_open_handovers', () => {
    requirePin(owner_pin);
    return { handovers: db.prepare("SELECT id, reason_category, summary, customer_name, order_reference, created_at FROM handover WHERE status = 'open' ORDER BY created_at").all() };
  }));

  server.registerTool('resolve_handover', {
    title: 'Mark a handover resolved',
    description: 'Mark an open handover (HO-…) as dealt with, with a short note of what Kemi did.',
    inputSchema: { handover_id: z.string().trim().regex(/^HO-[0-9A-Fa-f]{8}$/), note: z.string().trim().min(3).max(300), owner_pin: pinField },
  }, async ({ handover_id, note, owner_pin }) => ownerRun('resolve_handover', () => {
    requirePin(owner_pin);
    const id = handover_id.toUpperCase();
    if (!resolveHandover(db, id)) throw new BusinessError('NOT_FOUND', `No open handover ${id}`);
    audit('resolve_handover', id, { status: 'open' }, { status: 'resolved', note });
    return { handover_id: id, status: 'resolved' };
  }));
  return server;
}
