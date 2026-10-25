# 07 — Chord-native payments (booking tools + Paystack connector)

Iteration 3, 2026-10-24. Trigger: field note 4. On WhatsApp/simulator delivery, Chord blocks
any reply containing a payment link that "didn't come from the booking tools". Our MCP
checkout link (`/pay/AL-…`) is therefore never seen by customers. Decision (account owner):
move payment collection onto Chord's sanctioned path instead of working around the guard.

Sources: the public docs (webhooks guide) and Chord's authenticated OpenAPI document
(`GET /api-docs`). The OpenAPI document lists endpoints the guides don't cover: catalogs,
bookings, resources, and connector sessions.

## What stays the same (constitution still holds)

- Our backend remains the source of truth for catalogue, offers, stock, order totals and
  order state (§1, §2). `create_pending_order` still reserves stock atomically.
- Stock is committed only in `confirmPayment`, exactly once (§4). The only change is which
  trusted event calls it.
- The simulated checkout and admin test event remain for local/dev and owner overrides.

## Target flow

```
customer agrees ─► MCP create_pending_order (our backend)
                     ├─ reserves stock, persists order AL-XXXXXX (pending_payment)
                     └─ upserts Chord catalog item {id: AL-XXXXXX, amount_minor: order.total}   ⚠ C-1
agent ─► Chord built-in payment/booking tool for item AL-XXXXXX                          ⚠ C-2
          └─ Chord creates booking (awaiting_payment) + hosted Paystack TEST link (trusted)
customer pays on Paystack (test card) ─► Paystack → Chord connector webhook
          └─ Chord confirms booking ─► webhook booking.confirmed ─► POST /webhooks/chord (ours)
                                         └─ verify signature, dedupe, match order, check amount
                                            → confirmPayment(provider 'chord_booking') → stock committed once
agent ─► get_payment_status (unchanged) ─► "paid"
```

## Requirements

- **P-1 Paystack connector.** The workspace has a Paystack connector session created with a
  **test** secret key (`POST /v1/workspaces/{ws}/connectors/paystack/sessions`, form fields ⚠ C-3).
  The setup script refuses any key that doesn't start with `sk_test_`. The key is sent to Chord
  only and is never stored in this repo.
- **P-2 Per-order payable item.** WHEN `create_pending_order` succeeds, THE backend SHALL upsert
  an item `{id: <order ref>, name: "Order <ref>", amount_minor: total_kobo, available: true}`
  into the workspace catalog "Adire Lane orders", attached to the teammate. Paid, cancelled or
  expired orders SHALL be marked `available: false`. If the sync fails, the order still exists,
  and the tool returns `payment_ready: false` so the agent can hand over instead of inventing a
  link.
- **P-3 Agent pays through Chord's tool.** The skill instructs the agent to call the built-in
  payment/booking tool for the catalog item whose id equals the order reference, with
  the order reference in the booking title. It must send the link **only as returned by that
  tool**. Our MCP tools no longer return `payment_link` when `PAYMENT_MODE=chord`.
- **P-4 Webhook receiver.** `POST /webhooks/chord` SHALL:
  - verify `X-Chord-Signature = sha256=hex(HMAC_SHA256(secret, raw_body))` in constant time,
    tested against the doc vector;
  - deduplicate on `X-Chord-Delivery-Id`;
  - on `booking.confirmed`, find the order reference (`AL-XXXXXX`) in the booking
    title/description/payment message, and require `amount_paid` × 100 to equal the order total
    and `currency` to equal NGN;
  - call `confirmPayment` with idempotency key `chord-booking:<booking_id>` (as built, the payment
    row's provider is `paystack`, because Chord collects through its Paystack connector; the key
    prefix tells the sources apart);
  - answer 2xx for anything it has recorded, including ignored events, so Chord doesn't retry
    forever.
- **P-5 Failure events.** `booking.payment_failed`, `booking.payment_mismatch` and
  `booking.payment_late` are logged. A mismatch or late payment opens a handover
  (`payment_dispute`).
- **P-6 Registration.** The setup script registers the webhook (`POST /v1/webhooks`, events
  `booking.confirmed`, `booking.payment_failed`, `booking.payment_mismatch`,
  `booking.payment_late`, `conversation.escalated`). It uses a generated `whsec_` secret stored
  as a Fly secret, and sends `POST /v1/webhooks/{id}/test` to prove the path.
- **P-7 Costs and limits.** Catalog sync is one Chord API call per order, made from the backend
  through the same 60 rpm key. A server-side limiter keeps it to ≤ 20 rpm. No model credits are
  used. The setup steps are free management calls.

## Open questions to verify live (⚠)

| # | Question | How to verify | Fallback |
|---|----------|---------------|----------|
| C-1 ✅ | Can a catalog item carry an arbitrary per-order amount, and can items be updated per order (full-replace `items` on PUT)? | **Verified 2026-10-24:** created "Adire Lane orders" (`3ada74de…`), PUT item `AL-QJDMRW` at `amount_minor: 1350000` → 200, attached to the teammate → 200 | — |
| C-2 ✅ (see Live resolution: `initialize_transaction`) | What are the built-in payment tool's name and arguments, and does it charge a catalog item? | Enable `bookings` + `paystack` tool types, then send one test turn and read `steps[].tool_name` | Create the booking server-side (`POST …/bookings` with `payment_message`). ⚠ That link would come from *our* tool, so it may still be blocked |
| C-3 ✅ | Paystack session form fields | **Verified:** empty body → `400 "paystack_secret_key is required"`. Body is `{"paystack_secret_key": "sk_test_…"}` | — |
| C-4 (moot: the live path creates no booking) | Does `booking.confirmed` include `amount_paid`/`currency` and our reference? | Webhook test delivery + one real test payment | Fetch `GET …/bookings/{id}` before confirming |
| C-5 (partly ✅: catalogs + teammate attach OK) | Is the API key's scope enough for catalogs, bookings, connector sessions and webhooks? | First call of each | Do that step in the Chord app |

## Traceability

| Req | Implementation | Verification |
|-----|----------------|--------------|
| P-1, P-6 | `scripts/chord-payments-setup.ts` | live run (free) |
| P-2 | `server/src/chordSync.ts`, `tools.ts` | `test/chord-webhook.test.ts` (mocked Chord) |
| P-3 | `skill/adire-lane-sales/SKILL.md` | live simulator turn |
| P-4, P-5 | `server/src/http.ts` `/webhooks/chord`, `payments.ts` | `test/chord-webhook.test.ts` (doc vector, dedupe, amount check, idempotency) |

## Status (before the Paystack key; superseded by "Live resolution" below)

- Built and tested (56/56): webhook receiver (doc test vector, dedupe, amount check, exactly-once
  stock, handover on mismatch/late), catalog sync (exact per-order totals, paid orders removed),
  `PAYMENT_MODE=chord` tool behaviour (no self-issued links), setup script `chord:payments`.
- **Blocked on:** a Paystack **test** secret key from the account owner (P-1). Then C-2 (built-in
  tool name/arguments) gets verified with one live turn, the skill is updated, and the mode is
  switched on Fly.
- Until the switch, production stays in `simulated` mode, so its payment links are still blocked on WhatsApp.

## Live resolution (2026-10-24, with the Paystack test key)

- **C-3 complete:** the Paystack session needs `paystack_secret_key` **and** `webhook_secret`
  (400s name one missing field at a time). Paystack signs webhooks with the secret key, so both
  are the same key. Session `ShuijpyxnNXq8RXKGw-9Qw`, health `HEALTHY` (Paystack `/balance` 200).
- **C-2 resolved:** the built-in tool is **`initialize_transaction`** `{email, amount_kobo,
  reference, metadata}` (Paystack connector, not bookings). It returned a hosted
  `checkout.paystack.com` link, which is the trusted link.
  - **The model supplies `amount_kobo`.** So `create_pending_order` now returns
    `payment_tool_args` to copy verbatim (amount, reference = our order ref), and stock commits only
    when the **verified** paid amount equals `order.total` (wrong amount → no confirm + handover).
  - Because this path creates a Paystack transaction, not a Chord booking, `booking.confirmed`
    may never fire. Confirmation is therefore **verified directly with Paystack** by reference
    every minute (sweeper, `paystack:<ref>` idempotency key, same as the webhook path).
- **Connector thresholds** (`/connectors/paystack/thresholds`), changed deliberately:
  - `initialize_transaction` confirmation: from > ₦10,000 to > ₦100,000. The customer already
    confirmed the order summary.
  - `process_refund` human approval: from > ₦10,000 to **any amount**, so the agent can never
    refund on its own.
- **Live findings fixed:** the model re-called `create_pending_order` on "confirm"/"yes", making
  3 orders for 1 purchase. Order creation is now idempotent per customer + items while a hold is
  live (`existing: true`). Duplicates AL-FURVX5 and AL-DV8QVP were cancelled.
- **Paystack dashboard webhook** set by the owner (2026-10-24) to Chord's connector endpoint
  `/api/paystack/connector/webhook/ShuijpyxnNXq8RXKGw-9Qw`, so Chord also sees payments. Our
  Paystack verify sweep remains the source of confirmation.
- **✅ Verified end to end:**

| Time (UTC, 2026-10-24) | Event |
|---|---|
| 04:28 | Agent calls Chord's `initialize_transaction` with `payment_tool_args` → `checkout.paystack.com/o0wmqnpovv0kfkz`, reference **AL-LG8CBJ**, 1,400,000 kobo |
| 04:34:53 | Customer pays on Paystack checkout (test card ··4081) → Paystack `success` |
| 04:35:48 | Our verify sweep confirms: order `paid`, one payment row (`paystack:AL-LG8CBJ`, ₦14,000), TS-105-WHT-XL stock 3 → 2 |
| 04:35:49 | Purchase memory written for the customer |
| 04:36:20 | "✅ Payment received for order AL-LG8CBJ…" delivered into the customer's thread (scheduled MESSAGE, 0 credits) |

Payment to customer confirmation took **87 seconds**. No `booking.*` webhook arrived from Chord, as
expected, because this path creates a Paystack transaction rather than a booking. That confirms
the decision not to depend on it.
