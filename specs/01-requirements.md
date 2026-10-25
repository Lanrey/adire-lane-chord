# 01 — Requirements

Sources: `AI_Sales_Agent_PRD_6_Hour_MVP.docx` (FR-xx, AT-xx) and the TSG Labs Build
Exercise brief (B-x). Acceptance criteria use EARS phrasing
(*WHEN … THE SYSTEM SHALL …*). Each requirement is traced to its design section
(`03-design.md`) and to the tests that prove it (`server/test/*`).

## Business (made-up, for the exercise)

**Adire Lane** is a small streetwear boutique in Yaba, Lagos. It sells oversized
tees and sneakers and also offers a laptop-repair assessment on the side. The owner,
Kemi, takes almost every order over WhatsApp. Two things cost her sales: she misses
messages at night and during lectures, and she spends a lot of time answering
"how much?", "do you have it in 3XL?" and "last price?". She also has to check
bank alerts by hand before she sends anything out.

**Job the agent does end to end:** take a WhatsApp customer from "do you have this?"
to a recorded order with a test payment link. The agent negotiates only within
Kemi's floor price, and stock is committed only after payment is confirmed.

## Brief constraints (B)

| ID  | Constraint | How we satisfy it |
|-----|-----------|-------------------|
| B-1 | At least one self-written skill with business context | `skill/adire-lane-sales/` (SKILL.md + references) |
| B-2 | At least one custom tool calling an external system | Remote MCP server `server/` (our hosted mock commerce API), plus Paystack test mode when keys are present |
| B-3 | Full conversation in the WhatsApp simulator where the agent takes a real action | `create_pending_order` persists an order, and payment confirmation commits stock |
| B-4 | Built and run on Chord | Teammate + published skill + MCP server registered through the Chord API (`scripts/chord-setup.ts`) |
| B-5 | Test keys and made-up data only | Seeded catalogue; Paystack `sk_test_` enforced in code |

## Functional requirements

### FR-01 Catalogue CRUD (P0)
- WHEN the owner sends `POST /admin/products` with a valid admin token, THE SYSTEM SHALL persist the product and its variants and return them.
- WHEN the owner sends `PATCH /admin/products/:code` or `PATCH /admin/variants/:sku`, THE SYSTEM SHALL update the price, floor, pricing mode, stock or active flag.
- WHEN an admin route is called without a valid admin token, THE SYSTEM SHALL respond `401`.
- THE SYSTEM SHALL reject a negotiable product whose `minimum_price` is missing or greater than `base_price`.

### FR-02 Item codes & variants (P0)
- WHEN the agent searches for an exact product code (e.g. `TS-104`) or variant SKU (e.g. `TS-104-BLK-3XL`), THE SYSTEM SHALL return that product as an `exact` match first.
- THE SYSTEM SHALL expose each variant's attributes (size, colour), SKU, effective price and availability.

### FR-03 Stock tracking (P0)
- WHEN `check_stock(sku, quantity)` is called, THE SYSTEM SHALL return `available = stock_quantity − active reservations` and `can_fulfil`.
- WHERE `stock_tracking_enabled` is false (services), THE SYSTEM SHALL report the item as available without a quantity.

### FR-04 Fixed and negotiable pricing (P0)
- WHEN an offer is made on a `fixed` item, THE SYSTEM SHALL return `decision: "rejected_fixed_price"` and the list price.
- WHEN an offer on a `negotiable` item is ≥ `minimum_price`, THE SYSTEM SHALL return `decision: "accepted"` and an `offer_id` valid for 60 minutes.
- WHEN an offer is < `minimum_price`, THE SYSTEM SHALL return `decision: "rejected_below_floor"` with a `counter_offer` ≥ the floor, and SHALL NOT issue an `offer_id`.
- WHEN an offer is above the list price, THE SYSTEM SHALL accept it at the list price, so a customer is never charged more than the listing.

### FR-05 Natural-language search (P0)
- WHEN the agent searches free text (e.g. "black oversized shirt"), THE SYSTEM SHALL return up to 5 ranked catalogue matches with `match_type` and a `needs_clarification` flag set when more than one plausible product or variant remains.
- THE SYSTEM SHALL return only catalogue records. If nothing matches, it returns an empty list.

### FR-06 Tools exposed to Chord (P0)
- THE SYSTEM SHALL expose the tools in `04-tool-contracts.md` over MCP Streamable HTTP at `POST /mcp`, protected by a bearer token.
- WHEN a tool fails validation, THE SYSTEM SHALL return a structured error (`ok:false, error.code, error.message`) rather than throwing a transport error.

### FR-07 Pending orders (P0)
- WHEN `create_pending_order` is called with customer details, items (SKU, quantity, optional `offer_id`) and fulfilment, THE SYSTEM SHALL, in one transaction, revalidate price, offer and stock, compute subtotal, delivery fee and total, reserve stock for 30 minutes, and persist an order in `pending_payment` with a reference like `AL-7K3P9Q`.
- IF any item is unavailable, inactive or carries an invalid or expired offer, THE SYSTEM SHALL create nothing and return the reason.
- THE SYSTEM SHALL return a payment link and the exact total.

### FR-08 Payment state (P0)
- THE SYSTEM SHALL keep an order `unpaid` until one of these happens: a verified Paystack `charge.success` with matching amount and currency, a simulated-checkout confirmation, or an admin-token test confirmation.
- WHEN `get_payment_status` is called, THE SYSTEM SHALL return the stored state only.

### FR-09 Inventory on confirmation (P0)
- WHEN a payment is confirmed, THE SYSTEM SHALL in one transaction mark the payment `succeeded`, move the order to `paid`, and decrement the stock of every tracked item.
- WHEN the same confirmation (same idempotency key) or any later confirmation for an already-paid order arrives, THE SYSTEM SHALL change nothing and report `already_processed`.
- IF stock is no longer sufficient at confirmation (e.g. the reservation expired and another order sold the unit), THE SYSTEM SHALL record the payment, set the order to `paid_needs_attention`, open a handover, and SHALL NOT let stock go negative.

### FR-10 Human handover (P0)
- WHEN `request_human_handover` is called, THE SYSTEM SHALL persist a handover with reason category, summary, customer contact and optional order reference, and return its ID.
- The skill SHALL then make the teammate call Chord's built-in `handover_to_human` so the Chord thread moves to `human_active`.
- The teammate SHALL NOT claim a human has replied.

### FR-11 Order inspection (P0)
- THE SYSTEM SHALL expose `GET /admin/orders`, `GET /admin/orders/:ref`, `GET /admin/handovers` and a read-only dashboard at `/admin`, with order reference, items, total, payment state and order state.

### Out of scope (deliberately left out)
FR-12 appointment scheduling, FR-13 live WhatsApp, real payments, refunds, multi-tenant
admin and auth beyond a single admin token (plus the owner PIN, specs/09), delivery-partner
integration, and image recognition. (Analytics and abandoned-cart recovery were moved into
scope in iterations 4–5; see Amendments.)

## Conversation rules (PRD §9) → skill
CR-1 natural and concise, and never claims to be human · CR-2 tools for every fact ·
CR-3 one clarifying question when a request is ambiguous · CR-4 never say "available"
without `check_stock` · CR-5 never go below the backend's answer · CR-6 summarise the order
before creating it · CR-7 never say "paid" without `get_payment_status` · CR-8 minimum data ·
CR-9 escalate complaints, disputes, uncertainty and requests for a human · CR-10 if a tool
fails, say so and don't guess.

## Acceptance tests (PRD §11) — traceability

| AT | Scenario | Backend proof (automated) | Conversation proof (simulator script) |
|----|----------|---------------------------|---------------------------------------|
| AT-01 | Exact code lookup | `test/catalogue.test.ts` | `docs/demo-script.md` #1 |
| AT-02 | Ambiguous request | `test/catalogue.test.ts` | #2 |
| AT-03 | Out of stock variant | `test/catalogue.test.ts`, `test/orders.test.ts` | #3 |
| AT-04 | Discount on fixed price | `test/pricing.test.ts` | #4 |
| AT-05 | Below negotiation floor | `test/pricing.test.ts` | #5 |
| AT-06 | Order creation | `test/orders.test.ts` | #6 |
| AT-07 | False payment claim | `test/payments.test.ts` | #7 |
| AT-08 | Payment confirmation | `test/payments.test.ts` | #8 |
| AT-09 | Duplicate confirmation | `test/payments.test.ts` | (backend only) |
| AT-10 | Handover | `test/handover.test.ts`, `test/mcp.test.ts` | #9 |

## Amendments
- **FR-04 (2026-10-24, specs/10):** the counter-offer is the same for every below-floor bid on an item
  (never increases as the bid rises).
- **FR-07a (2026-10-24):** a customer can cancel their own unpaid order (`cancel_order`), releasing stock at once.
- **Scope (2026-10-24, specs/08–09):** basic analytics (owner brief, lost-demand log, impact numbers)
  and abandoned-cart recovery (hold reminder, payment-failed message, restock alerts) are now in scope.
- **FR-11a (2026-10-24, specs/08–09):** the owner also has an owner-only MCP endpoint `/mcp/owner`
  (separate token) with the brief and PIN-gated write tools; see `04-tool-contracts.md`.
- **CR-11 (2026-10-24):** every customer-facing message (agent replies and automatic follow-ups) uses plain,
  non-technical language. See the "Talking to customers" rules in the skill.
