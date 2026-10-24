# 04 — MCP tool contracts

These are the contracts between the Chord teammate and the backend. The zod schemas in
`server/src/tools.ts` are the executable form of this file. `server/test/mcp.test.ts`
calls the server over MCP and checks the tool list matches this file.

Every result is JSON with `ok: boolean`. On failure:
`{"ok": false, "error": {"code": "<CODE>", "message": "<human readable>"}}`.
Money values are **whole naira** integers in tool I/O (the model handles these more
reliably), with a pre-formatted `*_display` string such as `"₦15,000"`. Storage uses kobo.

| # | Tool | PRD name | Input | Success output (key fields) | Error codes |
|---|------|----------|-------|-----------------------------|-------------|
| 1 | `get_business_info` | — (policy facts) | `{}` | `name, currency, payment_terms, opening_hours, delivery_zones[{zone, fee, eta}], pickup_address, returns_policy` | — |
| 2 | `search_products` | search_products | `{query: string(1..200), limit?: 1..5}` | `results[{code, name, item_type, match_type: exact\|similar, pricing_mode, unit_price, variants[{sku, attributes, unit_price, availability, available}]}], needs_clarification, clarification_hint` | `INVALID_INPUT` |
| 3 | `get_product_details` | get_product_details | `{code: string}` (product code or SKU) | `product{code, name, description, item_type, unit, pricing_mode, negotiable, list_price, variants[…]}` | `NOT_FOUND` |
| 4 | `check_stock` | check_stock | `{sku: string, quantity: int ≥1 = 1}` | `sku, tracked, available (null if untracked), requested, can_fulfil, alternatives[{sku, attributes, available}]` (same product, in stock, when `can_fulfil` false) | `NOT_FOUND`, `INACTIVE` |
| 5 | `calculate_offer` | calculate_offer | `{sku, requested_unit_price: int naira ≥1, quantity: int ≥1}` | `decision: accepted \| rejected_fixed_price \| rejected_below_floor, list_unit_price, unit_price (agreed or list), counter_offer?, offer_id?, offer_expires_at?, total_for_quantity, message_hint` | `NOT_FOUND`, `INACTIVE` |
| 6 | `create_pending_order` | create_pending_order | **flat (v2)**: `{customer_name, customer_phone, sku, quantity, offer_id?, fulfilment_method: pickup\|delivery, delivery_zone?, delivery_address?, extra_items?: [{sku, quantity, offer_id?}] (array or JSON string)}` | `order_reference, status:"pending_payment", items[{sku, name, quantity, unit_price, line_total}], subtotal, delivery_fee, total, currency, reserved_until, payment_link, payment_mode: paystack_test \| simulated` | `INVALID_INPUT`, `NOT_FOUND`, `INACTIVE`, `INSUFFICIENT_STOCK`, `OFFER_INVALID`, `OFFER_EXPIRED`, `ZONE_REQUIRED`, `ADDRESS_REQUIRED`, `UNKNOWN_ZONE` |
| 7 | `get_payment_status` | get_payment_status | `{order_reference}` | `order_reference, order_status, payment_status: unpaid \| paid, total, paid_at?, payment_link? (if unpaid), reservation_expired` | `NOT_FOUND` |
| 8 | `request_human_handover` | request_human_handover | `{customer_phone?, customer_name?, reason_category: customer_request \| complaint \| payment_dispute \| refund \| price_beyond_limit \| unidentified_product \| tool_failure \| other, summary: string(10..1000), order_reference?}` | `handover_id, status:"open", next_step:"Call handover_to_human now with this reason."` | `INVALID_INPUT` |

## Behavioural guarantees (tested)

- T-1 `create_pending_order` has **no price field**. Sending one is rejected as an unknown key.
- T-2 Prices in the output always come from the database or a validated offer.
- T-3 `get_payment_status` never changes state.
- T-4 No tool can mark an order paid, change stock or change prices.
- T-5 The tool list over MCP is exactly the eight names above.
- T-7 (iteration 2, live finding F-11) Tool inputs are **flat scalars**. A live Chord turn sent
  nested-object arguments to the v1 `create_pending_order` and failed schema validation 5/5 times
  before reaching the handler. Every flat-argument tool succeeded. Array inputs also accept a JSON
  string. The top level stays strict, so T-1 (no price key) still holds.
- T-8 Rejected calls (schema or business) are logged with argument **keys and JSON types only**,
  never values (constitution §8), so failures can be diagnosed without customer data.
- T-6 (iteration 2, specs/06 R-3.1) `search_products` variants include the live `available` count
  (null when untracked). It uses the same reservation-aware calculation as `check_stock`.

## Iteration 3 contract changes (live findings, specs/07)

- `create_pending_order` is **idempotent** per customer phone + item set + fulfilment while a hold
  is live, and returns `existing: true` with the same `order_reference`.
- With `PAYMENT_MODE=chord` it returns no `payment_link` of ours. Instead it returns:
  - `payment_tool: "initialize_transaction"` (Chord's Paystack connector tool);
  - `payment_tool_args: {amount_kobo, reference = order_reference, metadata}`, to copy unchanged.
    The model fills only `email`.
  - Guarantee: a payment confirms only if the amount verified with Paystack equals `order.total`.
- New tool `notify_me_when_available(sku, customer_name, customer_phone)` → `waitlist_reference`
  (spec 08).
- `get_payment_status` adds `last_failure {reason, at}`.

## Iteration 6 contract changes (specs/10)
- **New tool** `cancel_order(order_reference, customer_phone)`: cancels the caller's own *unpaid* order and
  releases stock immediately. Errors: `NOT_FOUND` (wrong customer or unknown order), `INVALID_STATE`
  (paid or cancelled). 10 sales tools in total.
- `calculate_offer.counter_offer` is **constant per item**: `roundUp500((floor + list)/2)`, clamped to
  [floor, list]. It never depends on the bid.
- `create_pending_order.next_step` (chord mode): the item is the customer's own while held. Ask for an
  email once with a "skip" option. On skip, use a no-mailbox `receipts+<order>@<our host>` silently.
- `get_payment_status` returning `paid` marks the automatic "payment received" message as already
  delivered by the agent.
