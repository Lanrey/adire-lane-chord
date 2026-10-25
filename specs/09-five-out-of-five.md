# 09 — Closing the gaps to 5/5 (iteration 5)

Input: `docs/assessment.md` (4.50/5). Integration 5, Field notes 5, Creativity 4, Customer thinking 4,
Communication 4.

## G-1 Owner runs the shop by chatting with the Owner teammate (Creativity)
The Owner Brief teammate gains **write** tools on the owner-only MCP server (never exposed to the
sales teammate):

| Tool | Effect | Guard |
|------|--------|-------|
| `update_stock(sku, quantity)` | Sets on-hand stock. Going 0 → >0 triggers waitlist "back in stock" messages | Integer 0..999. Audit row |
| `set_price_rules(code, base_price?, minimum_price?, pricing_mode?)` | Changes price and floor | Same validation as `/admin` (floor ≤ price; negotiable needs a floor). Audit row |
| `list_open_handovers()` / `resolve_handover(id, note)` | Work the handover queue | PIN (handover summaries hold customer details). Resolve is audited |
| `get_owner_brief()` | Unchanged | — |

Every write returns before/after values, so the teammate can confirm exactly what changed. One
Chord platform and two teammates: customers talk to the sales teammate, and Kemi talks to her
back-office teammate, which can change the same live system the sales teammate sells from.

## G-2 Impact numbers (Creativity, Customer thinking)
The owner brief and `/admin` report what the assistant changed, not just activity:
- **After-hours sales:** paid orders created outside 10:00–19:00 Africa/Lagos or on Sunday, and
  their value. These are sales a one-person shop would likely have missed.
- **Recovered by follow-ups:** orders paid *after* a hold reminder or payment-failed message.
- **Waitlist conversions:** waitlisted customers (by phone) who later paid for that SKU.
- **Discount discipline:** average discount given versus list price.

## G-3 Live failed-payment proof (Integration)
Charge a pending order through Paystack's test API with a declining test card, using the order
reference. Show that the sweep records `last_failure`, the customer gets the "didn't go through"
message, `get_payment_status` explains it, and stock is unchanged.

## G-4 Writing (Field notes, Customer thinking, Communication)
- Field notes: the **three** most important problems in full. Everything else moves to
  `docs/field-notes-appendix.md`. This follows the brief: "two or three real problems are worth
  more than a long list".
- Go-live note: still at most half a page. Adds the WhatsApp 24-hour rule (proactive messages
  need approved templates on a real number), Nigeria Data Protection Act 2023 duties (phone
  numbers and purchase memories; deletion on request), and a named owner for each alert.
- `SUBMISSION.md`: the six required deliverables mapped to files and links, with your placeholders
  clearly marked. Plus a recording cue card and a one-command demo reset (`npm run demo:reset`).

## Out of my hands (stated honestly)
The 3-minute recording, the role line, the AI-usage note, and real owner validation. These are
yours.

## Status (2026-10-24)

| Item | State | Evidence |
|------|-------|----------|
| G-1 owner runs the shop by chat | ✅ live | Kemi: "How did we do today?" → brief with impact. "set the white Cloud L to 4" → asked for PIN → `TS-105-WHT-L 0 → 4`, audited (0.04–0.08 credits/turn) |
| G-2 impact numbers | ✅ | Live brief: "3 after-hours sales (₦33,000)…"; `proactive.test.ts` |
| G-3 live failed payment | ✅ | AL-XWNGM3 declined via Paystack `/charge`. Found that `verify` reports declines as `abandoned`. Fixed `isFailedAttempt()`. `last_failure` recorded within a minute of deploy |
| G-4 writing | ✅ | field notes (807 words after spec 10) + appendix, go-live (240 words), `SUBMISSION.md`, `ROADMAP.md`, `demo:reset` |
| Recording, role, AI-usage note | ⏳ owner | — |
