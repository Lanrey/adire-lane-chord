// HTTP surface: /mcp (Chord), /pay (checkout), /webhooks/paystack, /admin (owner). Spec 03-design §D6, §D8.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import type { DB } from './db.ts';
import type { Config } from './config.ts';
import { BusinessError } from './errors.ts';
import { buildMcpServer, buildOwnerMcpServer } from './tools.ts';
import { cancelOrder, getOrderRow, listOrders, orderItems, orderView } from './orders.ts';
import {
  confirmFromPaystack, confirmPayment, consumeCheckoutNonce, issueCheckoutNonce,
  paystackInitialize, paystackVerify, verifyPaystackSignature,
} from './payments.ts';
import { listHandovers, resolveHandover } from './handover.ts';
import { addVariant, createProduct, listProductsAdmin, updateProduct, updateVariant } from './admin.ts';
import { formatNaira } from './money.ts';
import { resetDemo } from './seed.ts';
import { handleChordEvent, verifyChordSignature } from './chordWebhook.ts';
import type { ChordEvent } from './chordWebhook.ts';
import type { PaystackTxn } from './payments.ts';
import { ChordCatalogSync } from './chordSync.ts';
import { ChordApi } from './chordApi.ts';
import { Notifier } from './notify.ts';
import { Sweeper } from './sweeper.ts';
import { ownerBrief } from './ownerBrief.ts';
import { humanReason } from './reasons.ts';
import { verifyPendingWithPaystack } from './sweeper.ts';


function safeEqual(a: string, b: string): boolean {
  // Hash both sides so lengths match and timing does not leak length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function bearer(req: Request): string {
  const h = req.header('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:16px;color:#1b1b1b;background:#faf7f2}
.banner{background:#b00020;color:#fff;padding:10px 12px;border-radius:8px;font-weight:700;text-align:center}
.card{background:#fff;border-radius:12px;padding:16px;margin-top:14px;box-shadow:0 1px 4px #0002}
table{width:100%;border-collapse:collapse}td{padding:4px 0}td:last-child{text-align:right}
.total td{font-weight:700;border-top:1px solid #ddd;padding-top:8px}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#1d3557;color:#fff;font-size:16px;margin-top:14px}
.ok{color:#0a7d32;font-weight:700}.muted{color:#666;font-size:13px}</style></head><body>${body}</body></html>`;
}

/** Log tool name + argument keys/types, never values (specs/04 T-8, constitution §8). */
export function argShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [argShape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, argShape(x)]));
  return v === null ? 'null' : typeof v;
}
function logCallShape(body: unknown) {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs as { method?: string; params?: { name?: string; arguments?: unknown } }[]) {
    if (m?.method === 'tools/call') console.log(JSON.stringify({ evt: 'mcp_call', tool: m.params?.name, args: argShape(m.params?.arguments) }));
  }
}

/** Fixed-window per-key limiter (specs/06 R-4.5). In-memory is fine for one machine. */
export function rateLimit(maxPerMinute: number) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.windowStart >= 60_000) {
      hits.set(key, { windowStart: t, count: 1 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++h.count > maxPerMinute) {
      res.status(429).set('Retry-After', String(Math.ceil((h.windowStart + 60_000 - t) / 1000)))
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null });
      return;
    }
    next();
  };
}

export function buildApp(db: DB, cfg: Config, opts: {
  catalogSync?: ChordCatalogSync; api?: ChordApi; notifier?: Notifier;
  paystackVerifyImpl?: (key: string, ref: string) => Promise<PaystackTxn | null>;
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  const paymentMode = cfg.paymentMode ?? (cfg.paystackSecretKey ? 'paystack_test' as const : 'simulated' as const);
  const api = opts.api ?? (cfg.chord ? new ChordApi(cfg.chord) : null);
  const catalogSync = opts.catalogSync ?? (api && paymentMode === 'chord' ? new ChordCatalogSync(api) : null);
  const resync = () => catalogSync ? catalogSync.sync(db) : Promise.resolve({ ok: false as const, error: 'no catalog sync' });
  const notifier = opts.notifier ?? (api ? new Notifier(db, api) : null);
  /** Every trusted confirmation funnels here: tell the customer, remember the purchase, drop the payable item. */
  const afterPaid = (ref: string) => {
    if (notifier) void notifier.paymentReceived(ref);
    if (catalogSync) void catalogSync.sync(db);
  };
  // Chord mode: verify pending orders straight with Paystack by reference (spec 07 rev. after C-2).
  const paystackKey = cfg.paystackSecretKey;
  const verifyRef = async (key: string, ref: string) => {
    try { return await paystackVerify(key, ref); } catch (err) {
      if (/not found|404/i.test((err as Error).message)) return null; // never initialised
      throw err;
    }
  };
  const verifySweep = paymentMode === 'chord' && paystackKey
    ? () => verifyPendingWithPaystack(db, paystackKey, notifier, afterPaid, opts.paystackVerifyImpl ?? verifyRef)
    : undefined;
  const sweeper = notifier ? new Sweeper(db, notifier, { api, reconcileBookings: paymentMode === 'chord', onPaid: afterPaid, paystackVerify: verifySweep }) : null;
  app.locals.sweeper = sweeper;
  const paidOutcome = (o: string | undefined) => o === 'confirmed' || o === 'confirmed_needs_attention';
  const paymentLink = (ref: string) => `${cfg.publicBaseUrl}/pay/${ref}`;

  // Paystack webhook needs the raw body for HMAC, so it is registered before express.json().
  app.post('/webhooks/paystack', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!cfg.paystackSecretKey) return res.status(404).end();
    const raw = req.body as Buffer;
    if (!verifyPaystackSignature(cfg.paystackSecretKey, raw, req.header('x-paystack-signature'))) {
      console.warn(JSON.stringify({ evt: 'paystack_webhook_rejected', reason: 'bad_signature' }));
      return res.status(401).end();
    }
    const event = JSON.parse(raw.toString('utf8')) as { event: string; data: Parameters<typeof confirmFromPaystack>[1] };
    if (event.event === 'charge.success') {
      try {
        const r = confirmFromPaystack(db, event.data, event);
        console.log(JSON.stringify({ evt: 'paystack_webhook', ...r }));
        if (r && paidOutcome(r.outcome)) afterPaid(r.order_reference);
      } catch (err) {
        console.error(JSON.stringify({ evt: 'paystack_webhook_error', message: (err as Error).message }));
        // 200 anyway: a retry will not fix an amount mismatch; it is logged for the owner.
      }
    }
    res.status(200).end();
  });

  // Chord booking webhooks (specs/07 P-4): raw body for the HMAC, dedupe on X-Chord-Delivery-Id.
  app.post('/webhooks/chord', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!cfg.chordWebhookSecret) return res.status(404).end();
    const raw = req.body as Buffer;
    if (!verifyChordSignature(cfg.chordWebhookSecret, raw, req.header('x-chord-signature'))) {
      console.warn(JSON.stringify({ evt: 'chord_webhook_rejected', reason: 'bad_signature' }));
      return res.status(401).end();
    }
    const deliveryId = req.header('x-chord-delivery-id') ?? req.header('x-chord-event-id') ?? '';
    if (!deliveryId) return res.status(400).end();
    const event = JSON.parse(raw.toString('utf8')) as ChordEvent;
    try {
      const r = handleChordEvent(db, event, deliveryId);
      console.log(JSON.stringify({ evt: 'chord_webhook', type: event.type, delivery: deliveryId, ...r }));
      if (paidOutcome(r.outcome) && r.order_reference) afterPaid(r.order_reference);
      if (r.outcome === 'payment_failed_recorded' && r.order_reference && notifier) void notifier.paymentFailed(r.order_reference, humanReason(r.reason));
      res.status(200).json({ ok: true, outcome: r.outcome });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'chord_webhook_error', type: event.type, message: (err as Error).message }));
      res.status(500).end(); // let Chord retry transient failures
    }
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.get('/healthz', (_req, res) => { res.json({ ok: true, payment_mode: paymentMode }); });

  // ------------------------------------------------------------------ MCP (Chord)
  app.post('/mcp', rateLimit(cfg.mcpMaxPerMinute ?? 120), async (req, res) => {
    if (!safeEqual(bearer(req), cfg.mcpToken)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    logCallShape(req.body);
    const server = buildMcpServer({
      db, paymentMode, reservationMinutes: cfg.reservationMinutes, offerMinutes: cfg.offerMinutes,
      receiptEmailDomain: new URL(cfg.publicBaseUrl).hostname,
      paymentLink: paymentMode === 'chord' ? () => '' : paymentLink,
      afterOrderCreated: paymentMode === 'chord' ? resync : undefined,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp]', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Owner-only MCP (specs/08 I-3): separate token, separate tool set, for the "Owner Brief" teammate.
  app.post('/mcp/owner', rateLimit(30), async (req, res) => {
    if (!cfg.ownerMcpToken || !safeEqual(bearer(req), cfg.ownerMcpToken)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    logCallShape(req.body);
    const server = buildOwnerMcpServer(db, { ownerPin: cfg.ownerPin, onStockChanged: () => { if (sweeper) void sweeper.restocks(); } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ------------------------------------------------------------------ Checkout
  // Access log for the checkout (path + status + timing, no customer data) so payment problems are diagnosable.
  app.use('/pay', (req, res, next) => {
    const t = Date.now();
    res.on('finish', () => console.log(JSON.stringify({ evt: 'pay_http', method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t, ua: (req.header('user-agent') ?? '').slice(0, 60) })));
    next();
  });
  app.use('/pay', rateLimit(30));
  app.get('/pay/:ref', async (req, res) => {
    // Chat apps/Markdown often glue punctuation to links ("AL-XXXXXX." or "AL-XXXXXX**"): redirect to the clean URL.
    const clean = String(req.params.ref).match(/^AL-[A-Za-z0-9]{6}/)?.[0];
    if (clean && clean !== req.params.ref) return res.redirect(301, `/pay/${clean.toUpperCase()}`);
    const order = getOrderRow(db, String(req.params.ref));
    if (!order) return res.status(404).send(page('Not found', '<div class="card">Order not found.</div>'));
    const items = orderItems(db, order.id);
    const summary = `<div class="card"><h2>Adire Lane — order ${esc(order.reference)}</h2><table>
      ${items.map((i) => `<tr><td>${i.quantity} × ${esc(i.name)} <span class="muted">${esc(i.sku)}</span></td><td>${formatNaira(i.line_total)}</td></tr>`).join('')}
      <tr><td>Delivery</td><td>${formatNaira(order.delivery_fee)}</td></tr>
      <tr class="total"><td>Total</td><td>${formatNaira(order.total)}</td></tr></table></div>`;

    if (order.payment_status === 'paid') {
      return res.send(page('Paid', `${summary}<div class="card ok">✅ This order is paid. Thank you!</div>`));
    }
    if (order.status !== 'pending_payment') {
      return res.send(page('Unavailable', `${summary}<div class="card">This order is ${esc(order.status)} and cannot be paid.</div>`));
    }
    if (cfg.paystackSecretKey) {
      try {
        const url = await paystackInitialize(cfg.paystackSecretKey, {
          email: `customer+${order.reference.toLowerCase()}@example.com`,
          amountKobo: order.total,
          reference: `${order.reference}-${Date.now()}`,
          callbackUrl: `${cfg.publicBaseUrl}/pay/${order.reference}/callback`,
          orderReference: order.reference,
        });
        return res.redirect(303, url);
      } catch (err) {
        console.error('[paystack]', (err as Error).message);
        return res.status(502).send(page('Payment unavailable', `${summary}<div class="card">The payment provider is unavailable right now. Please try again in a few minutes or reply on WhatsApp.</div>`));
      }
    }
    const nonce = issueCheckoutNonce(db, order.reference);
    res.send(page('Test checkout', `<div class="banner">TEST MODE — SIMULATED PAYMENT. NO MONEY MOVES.</div>${summary}
      <form class="card" method="post" action="/pay/${esc(order.reference)}/simulate">
        <input type="hidden" name="nonce" value="${nonce}">
        <p class="muted">This page stands in for a payment provider during the demo. Pressing the button sends a trusted, server-side test confirmation for exactly ${formatNaira(order.total)}.</p>
        <button type="submit">Simulate successful payment of ${formatNaira(order.total)}</button>
      </form>`));
  });

  app.post('/pay/:ref/simulate', (req, res) => {
    if (cfg.paystackSecretKey) return res.status(404).end(); // simulated mode only
    const ref = String(req.params.ref);
    const nonce = String((req.body as { nonce?: string }).nonce ?? '');
    const order = getOrderRow(db, ref);
    if (!order || !consumeCheckoutNonce(db, order.reference, nonce)) {
      console.warn(JSON.stringify({ evt: 'simulated_payment_rejected', ref, reason: !order ? 'order_not_found' : 'bad_nonce', has_nonce: Boolean(nonce) }));
      return res.status(400).send(page('Invalid', '<div class="card">Invalid or expired checkout session. Reopen the payment link.</div>'));
    }
    const r = confirmPayment(db, {
      orderReference: order.reference, provider: 'simulated', providerReference: `SIM-${nonce.slice(0, 8)}`,
      idempotencyKey: `simulated:${order.reference}:${nonce}`, amountKobo: order.total, currency: order.currency,
    });
    console.log(JSON.stringify({ evt: 'simulated_payment', ...r }));
    if (paidOutcome(r.outcome)) afterPaid(order.reference);
    res.redirect(303, `/pay/${order.reference}`);
  });

  app.get('/pay/:ref/callback', async (req, res) => {
    const reference = String(req.query.reference ?? req.query.trxref ?? '');
    if (!cfg.paystackSecretKey || !reference) return res.redirect(303, `/pay/${req.params.ref}`);
    try {
      const txn = await paystackVerify(cfg.paystackSecretKey, reference);
      const r = confirmFromPaystack(db, txn, { source: 'verify_callback', reference });
      console.log(JSON.stringify({ evt: 'paystack_verify', reference, outcome: r?.outcome ?? 'not_successful' }));
      if (r && paidOutcome(r.outcome)) afterPaid(r.order_reference);
    } catch (err) {
      console.error('[paystack verify]', (err as Error).message);
    }
    res.redirect(303, `/pay/${req.params.ref}`);
  });

  // ------------------------------------------------------------------ Owner admin
  app.get('/admin', (_req, res) => {
    res.type('html').send(readFileSync(new URL('./admin.html', import.meta.url), 'utf8'));
  });

  const admin = express.Router();
  admin.use((req: Request, res: Response, next: NextFunction) => {
    if (!safeEqual(bearer(req), cfg.adminToken)) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required' } });
    next();
  });
  admin.get('/products', (_req, res) => { res.json(listProductsAdmin(db)); });
  admin.post('/products', (req, res) => { res.status(201).json(createProduct(db, req.body)); });
  admin.patch('/products/:code', (req, res) => { res.json(updateProduct(db, String(req.params.code), req.body)); });
  admin.post('/products/:code/variants', (req, res) => { res.status(201).json(addVariant(db, String(req.params.code), req.body)); });
  admin.patch('/variants/:sku', (req, res) => {
    res.json(updateVariant(db, String(req.params.sku), req.body));
    if (sweeper) void sweeper.restocks(); // restock alerts go out right away, not on the next sweep
  });
  admin.get('/orders', (_req, res) => { res.json(listOrders(db)); });
  admin.get('/orders/:ref', (req, res) => {
    const o = getOrderRow(db, String(req.params.ref));
    if (!o) throw new BusinessError('NOT_FOUND', 'No such order');
    res.json(orderView(db, o));
  });
  admin.post('/orders/:ref/cancel', (req, res) => { res.json(cancelOrder(db, String(req.params.ref))); });
  // Trusted backend test event (PRD §5.3). Requires an Idempotency-Key header.
  admin.post('/orders/:ref/confirm-payment', (req, res) => {
    const key = req.header('idempotency-key');
    if (!key) throw new BusinessError('INVALID_INPUT', 'Idempotency-Key header is required');
    const o = getOrderRow(db, String(req.params.ref));
    if (!o) throw new BusinessError('NOT_FOUND', 'No such order');
    const r = confirmPayment(db, {
      orderReference: o.reference, provider: 'admin_test', providerReference: `ADMIN-${key}`,
      idempotencyKey: `admin:${key}`, amountKobo: o.total, currency: o.currency,
    });
    if (paidOutcome(r.outcome)) afterPaid(o.reference);
    res.json({ ...r, order: orderView(db, getOrderRow(db, o.reference)!) });
  });
  admin.get('/handovers', (_req, res) => { res.json(listHandovers(db)); });
  admin.post('/handovers/:id/resolve', (req, res) => {
    if (!resolveHandover(db, String(req.params.id))) throw new BusinessError('NOT_FOUND', 'No such handover');
    res.json({ ok: true });
  });
  admin.post('/reset-demo', (_req, res) => { resetDemo(db); res.json({ ok: true, message: 'Demo data re-seeded' }); });
  admin.get('/brief', (_req, res) => { res.json(ownerBrief(db)); });
  admin.get('/notifications', (_req, res) => { res.json(db.prepare('SELECT * FROM notification ORDER BY updated_at DESC LIMIT 100').all()); });
  admin.get('/waitlist', (_req, res) => {
    res.json(db.prepare('SELECT w.id, v.sku, w.customer_name, w.customer_phone, w.status, w.created_at, w.notified_at FROM waitlist w JOIN variant v ON v.id = w.variant_id ORDER BY w.created_at DESC LIMIT 200').all());
  });
  admin.post('/sweep', async (_req, res) => { if (sweeper) await sweeper.tick(); res.json({ ok: Boolean(sweeper) }); });
  admin.get('/tool-log', (_req, res) => { res.json(db.prepare('SELECT * FROM tool_log ORDER BY id DESC LIMIT 100').all()); });
  app.use('/admin', admin);

  // Error envelope
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    if (err instanceof BusinessError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID_STATE' || err.code === 'INSUFFICIENT_STOCK' ? 409 : err.code === 'INTERNAL' ? 500 : 400;
      return res.status(status).json({ error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  return app;
}
