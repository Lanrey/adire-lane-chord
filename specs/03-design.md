# 03 — Design

## D1. Stack choices

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Node ≥ 23.6, TypeScript run directly (type stripping) | No build step, so less to break in a 6-hour build |
| Storage | `node:sqlite` (built in), WAL mode, one file | Real transactions for reserve/commit, no native deps, easy to inspect |
| MCP | `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport` (stateless, JSON responses) | Chord's supported tool-connection method |
| HTTP | Express 5 | The SDK already uses it, and it's small |
| Validation | Zod (also drives the MCP input schemas) | One schema for runtime checks and the tool contract |
| Tests | `node --test` | Built in |
| Hosting | Fly.io (Dockerfile + volume) or any HTTPS host. ngrok for a quick dev tunnel | Chord blocks private/loopback MCP URLs |

## D2. Modules (`server/src`)

```
config.ts      env parsing (PORT, PUBLIC_BASE_URL, MCP_TOKEN, ADMIN_TOKEN, PAYSTACK_SECRET_KEY, DB_PATH)
db.ts          schema + migrations + tx() helper (BEGIN IMMEDIATE … COMMIT/ROLLBACK)
seed.ts        Adire Lane business + PRD appendix catalogue
money.ts       integer kobo helpers, ₦ formatting
catalogue.ts   search, product details, stock (FR-01..03, FR-05)
pricing.ts     calculate_offer + offer tokens (FR-04)
orders.ts      create_pending_order, get_order, reservations, expiry (FR-07, FR-11)
payments.ts    confirmPayment (idempotent commit), Paystack init/verify/webhook (FR-08, FR-09)
handover.ts    request_human_handover (FR-10)
tools.ts       MCP tool registry: zod schemas → service calls → {ok,…} envelopes (FR-06)
http.ts        Express app: /mcp, /pay, /webhooks/paystack, /admin, /healthz
index.ts       boot
```

Services take a `db` handle as a parameter, so tests run against an in-memory database.

## D3. Data model (PRD §7, simplified per §7 note)

Money is stored as **integer kobo** (₦1 = 100 kobo) to avoid floating-point errors.

```
business(id, name, currency, payment_terms, policies_json, delivery_zones_json, created_at)
product(id, business_id, code UNIQUE, name, description, item_type[product|service],
        base_price, pricing_mode[fixed|negotiable], minimum_price NULL, unit,
        stock_tracking_enabled, tags, active, updated_at)
variant(id, product_id, sku UNIQUE, attributes_json {size,colour}, price_override NULL,
        stock_quantity NULL, active)
offer(id 'OF-…', variant_id, quantity, requested_price, agreed_unit_price, expires_at, created_at)
customer(id, name, phone, delivery_address NULL)      -- upsert by phone
conversation(id, customer_phone UNIQUE, chord_thread_id NULL, status[open|handover], handover_reason, updated_at)
orders(id, reference UNIQUE 'AL-XXXXXX', business_id, customer_id, status, payment_status,
       subtotal, delivery_fee, total, currency, fulfilment_method, delivery_zone, delivery_address,
       reserved_until, created_at, updated_at)
order_item(id, order_id, product_id, variant_id, quantity, list_unit_price, agreed_unit_price,
           offer_id NULL, line_total)
payment(id, order_id, provider[paystack|simulated|admin_test], provider_reference,
        idempotency_key UNIQUE, status[succeeded|ignored], amount, currency, confirmed_at, raw_event_json)
handover(id 'HO-…', customer_phone, customer_name, reason_category, summary, order_reference NULL,
         status[open|resolved], created_at)
tool_log(id, tool, ok, error_code, order_reference, latency_ms, at)   -- no customer PII
```

Services have one variant per item. Its `stock_quantity` is NULL, and the product's
`stock_tracking_enabled` is 0.

## D4. Availability & reservations (FR-03, FR-07, FR-09)

`available(variant) = stock_quantity − Σ quantity of order_items whose order is
pending_payment AND reserved_until > now`

- A reservation is created by the pending order and lasts 30 minutes (`RESERVATION_MINUTES`).
- An expired reservation stops counting without any job running (lazy expiry). A
  `pending_payment` order whose `reserved_until` has passed is shown as `expired` by
  `get_order`, but it can still be paid. Confirmation re-checks the actual stock (D6).
- `create_pending_order` runs under `BEGIN IMMEDIATE`. SQLite then serialises writers,
  so two buyers racing for the last unit can't both reserve it (PRD §13 risk 4).

## D5. Pricing & negotiation (FR-04)

```
effective_list_price = variant.price_override ?? product.base_price
calculate_offer(sku, requested_unit_price, qty):
  fixed                  → rejected_fixed_price, unit_price = list
  requested ≥ list       → accepted at list (never overcharge)
  requested ≥ minimum    → accepted at requested, offer_id issued (60 min)
  requested < minimum    → rejected_below_floor,
                           counter_offer = max(minimum, round_up_500((requested + list)/2))
```

The floor is never returned directly. The counter-offer is the midpoint, clamped to the
floor, so a very low bid can surface the floor. This is acceptable because the owner
set that floor as a price she is happy to sell at. An offer is tied to `sku` and
`quantity ≤ offer.quantity`. `create_pending_order` re-validates it: it must exist, be
unexpired, match the SKU, and the price must still be ≥ the current floor (the owner
may have raised it since the offer).

## D6. Order & payment state machine (FR-07..09)

```
            create_pending_order
                  │
                  ▼
   ┌──── pending_payment (payment_status=unpaid) ────┐
   │              │ confirmPayment(key)               │ owner cancels (admin)
   │              ▼                                   ▼
   │   stock ok? ─yes─► paid (payment_status=paid)   cancelled
   │              └no─► paid_needs_attention (+handover HO-…)
   └─ customer "I paid" → no transition (AT-07)
```

`confirmPayment({orderRef, provider, providerReference, idempotencyKey, amount, currency})`
runs as one `BEGIN IMMEDIATE` transaction:
1. If `payment.idempotency_key` already exists → `already_processed` (AT-09).
2. Load the order. If it isn't `pending_payment` → insert payment `ignored` → `already_processed`.
3. If `amount ≠ order.total` or the currency differs → reject `amount_mismatch` (nothing changes).
4. For each tracked item: `UPDATE variant SET stock_quantity = stock_quantity − q WHERE id=? AND stock_quantity ≥ q`.
   If any row count is 0, roll that back with a savepoint, set the status to `paid_needs_attention`, and open a handover.
5. Insert payment `succeeded`, set the order to `paid` / `payment_status=paid`, commit.

Trusted sources (constitution §3):
- **Paystack (test mode)**, only when `PAYSTACK_SECRET_KEY` starts with `sk_test_`.
  `/pay/:ref` calls `POST https://api.paystack.co/transaction/initialize` (amount in kobo,
  reference `<orderRef>-<n>`, metadata.order_reference) → 302 to `authorization_url`.
  `POST /webhooks/paystack` checks `x-paystack-signature` = HMAC-SHA512(raw body, secret)
  using a timing-safe comparison, handles `charge.success`, and uses idempotency key
  `paystack:<data.reference>`. The `/pay/:ref/callback` return page calls
  `GET /transaction/verify/:reference` as a backup path (same idempotency key).
- **Simulated checkout**, used when no Paystack key is set. `/pay/:ref` renders a page with a
  red **"TEST MODE – SIMULATED PAYMENT, NO MONEY MOVES"** banner. Its button POSTs
  `/pay/:ref/simulate` with a one-time nonce in the form, and the idempotency key is
  `simulated:<ref>:<nonce>`. This stands in for the payment provider's hosted page.
- **Admin test event**: `POST /admin/orders/:ref/confirm-payment` with header
  `Idempotency-Key` and the admin token.

## D7. Search (FR-02, FR-05)

1. Normalise the query: lowercase, strip punctuation, and expand synonyms
   (`tee|tshirt|t-shirt|shirt → t-shirt`, `shoe|shoes|kicks|trainers → sneakers`,
   `xxxl → 3xl`, `laptop|repair|fix → repair`).
2. Exact match: any token equal to a product `code` or variant `sku` gets `match_type:"exact"`
   and score 100.
3. Otherwise score each active product by token hits in name (3), tags (2),
   description (1) and variant attributes (2 for colour/size). Keep products with score > 0
   and sort by score, then name.
4. `needs_clarification = true` when there is no exact match and either several products
   are within 1 point of the top score, or the top product has more than one variant
   matching the attribute tokens given (or the query names no attributes for a multi-variant
   product).
5. Each result includes its variants with `sku`, attributes, `unit_price`, and
   `availability ∈ {in_stock, low_stock(≤2), out_of_stock, not_tracked}`. Exact counts come
   from `check_stock`.

## D8. MCP transport & auth (FR-06)

- `POST /mcp`: bearer check (timing-safe) → new `McpServer` + transport per request
  (stateless) → `transport.handleRequest(req, res, req.body)`.
- `GET /mcp` and `DELETE /mcp` → 405 (no stateful SSE sessions).
- Each tool handler wraps `{ok:true, ...data}` or `{ok:false, error:{code,message}}` and
  writes a `tool_log` row.

## D9. Skill design (B-1, PRD §9)

`skill/adire-lane-sales/`
- `SKILL.md` covers identity (an AI sales assistant for Adire Lane who says plainly that it
  is an AI), the golden rules (CR-1..10), and the step-by-step sales flow with the exact tool
  to call at each step.
- `references/business.md` covers the shop story, opening hours, delivery areas in words,
  returns policy and tone. Prices and fees are deliberately left out (they come from tools).
- `references/negotiation.md` covers how to handle "last price?" and how to present a counter.
- `references/handover.md` covers when to escalate, what to say, and the two-step handover
  (our tool, then `handover_to_human`).
- `references/examples.md` has short example dialogues in Nigerian-English register.

## D10. Configuration & secrets

`.env` (never committed): `PUBLIC_BASE_URL`, `MCP_TOKEN`, `ADMIN_TOKEN`,
`PAYSTACK_SECRET_KEY` (optional, must be `sk_test_…`), `DB_PATH`, and for the setup script
`CHORD_BASE_URL`, `CHORD_API_KEY`, `CHORD_WORKSPACE_ID`, `CHORD_TEAMMATE_ID`.
The server refuses to start if `MCP_TOKEN` or `ADMIN_TOKEN` is shorter than 24 characters,
or if a Paystack key is `sk_live_`.

## D11. Payment confirmation sources (updated after spec 07 went live)

Trusted events that may call `confirmPayment`, all idempotent and all amount-checked:

| Source | Idempotency key | Status |
|--------|-----------------|--------|
| Paystack verify sweep (Chord mode): `GET /transaction/verify/{order_ref}` every 60s for pending orders | `paystack:<reference>` | **Primary, live** (AL-LG8CBJ) |
| Chord `booking.confirmed` webhook (HMAC, deduplicated on delivery id) + bookings reconciliation | `chord-booking:<booking_id>` | Built; not fired by `initialize_transaction` |
| Paystack webhook / verify-on-return (direct Paystack mode) | `paystack:<reference>` | Built |
| Simulated checkout / admin test event | `simulated:…` / `admin:…` | Dev and owner override |

## D12. Negotiation counter (revised by specs/10 L-2)
The original D5 counter was `max(floor, roundUp500((bid + list)/2))`. It **rose** when the customer raised
their bid (live: ₦16k → ₦17k → ₦16k). It is now `roundUp500((floor + list)/2)` per item. That's
deterministic and monotone, and it still never states the floor directly.
