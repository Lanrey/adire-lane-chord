# 08 — Assessment-driven improvements (iteration 4)

Input: the TSG assessment rubric (Integration 25%, Field notes 25%, Creativity 20%, Customer
thinking 15%, Communication 15%). Also a page-by-page re-read of all 28 public guide pages plus
Chord's authenticated OpenAPI document (392 paths), 2026-10-24.

## Baseline score (before this iteration)

| Area | Score | Gap |
|------|-------|-----|
| Integration | 3 | Customers can't pay on WhatsApp: the link guard blocks our link. Failed payments aren't handled live, and nobody is told when a payment lands |
| Field notes | 4 | Strong evidence, but long, with open TO FILLs. Several doc contradictions found in the re-read are not captured yet |
| Creativity | 3 | Floor-price offers are good. Otherwise a standard sales bot that uses few of Chord's features |
| Customer thinking | 3 | The go-live note is partly technical and out of date on payments |
| Communication | 3 | README is long. Role and problem statement are placeholders. No recording script |

## Facts verified live today (0 credits)

| Fact | Evidence |
|------|----------|
| `POST /v1/scheduled-tasks` `MESSAGE` with `platform: DIRECT_LINE` delivers into an existing **external_chat** thread as an outbound agent turn | task `task_c646a1…` → COMPLETED. Turn visible in `GET /v1/threads/6adb197b…/turns` |
| `MESSAGE` tasks cost **0 credits** (no model run) | credits ledger: no deduction at 03:45 |
| `GET /v1/threads?workspace_id=&q=AL-QJDMRW` finds the conversation in which the agent quoted that reference | returned `6adc0fff…` (the tester's simulator thread) |
| Simulator threads are `external_chat`, with `metadata.partner_chat.sender_id` = `sim:<uuid>` | `GET /v1/threads/6adc0fff…` |
| Memories feature is enabled for the tenant | `GET …/memories` → 200 |
| `GET /v1/dashboard/summary` gives escalation rate per teammate | 200 (Adire Lane: 5 handled, 20% escalation) |
| Simulator turns are billed via `/partner/v1/external-chat/messages`, about 0.04–0.17 each | credits ledger |

## Improvements

### I-1 Proactive order updates (Integration, Customer thinking)
The agent can't start a conversation, but Chord scheduled `MESSAGE` tasks can post into the
customer's existing thread for free. The backend finds that thread by searching for the order
reference the agent quoted.
- **Payment received:** "✅ Payment received for AL-…: ₦X. Pickup from 10am at… / Delivery
  ETA…". Sent on every trusted confirmation (Chord booking webhook, simulated, admin).
- **Payment failed** (`booking.payment_failed`): the reason, plus "reply PAY and I'll send a
  fresh secure link". `get_payment_status` also returns `last_failure`, so the agent can explain it.
- **Hold expiring:** a sweeper sends one reminder about 20 minutes into the 30-minute hold if
  the order is still unpaid.
- **Guards:** the thread must belong to our teammate. Nothing is sent while
  `control_state != agent_active` (a human is talking). One message per (order, kind), enforced by
  a unique key. Failures are logged and retried by the sweeper. No payment links are ever put in
  these messages (the link guard; links come only from Chord's booking tool).

### I-2 Restock waitlist + lost-demand capture (Creativity)
- New tool `notify_me_when_available(sku, customer_name, customer_phone)` → `WL-XXXXXX`. The
  agent quotes the reference so the thread can be found later.
- When the owner restocks (admin stock edit), waitlisted customers get a free proactive message
  ("the XL Eko Nights is back. Reply YES and I'll hold one"). Each entry is notified at most once.
- **Lost-demand log:** searches with no match, out-of-stock requests, and offers rejected below
  the floor or on fixed-price items. This turns "missed sales" into data the owner can act on.

### I-3 Owner's evening brief, run by a second Chord teammate (Creativity, Customer thinking)
- Second teammate **"Adire Lane Owner Brief"**, scoped to a **separate** MCP server
  (`/mcp/owner`, separate token) that exposes only `get_owner_brief`. The sales teammate never
  sees owner data, and the owner teammate never talks to customers.
- A Chord **schedule** (DAILY 20:00 Africa/Lagos) asks it to write a 6-line WhatsApp-style
  brief:
  - sales and revenue today
  - unpaid or expired orders
  - open handovers
  - top lost demand ("3 people wanted XL Eko Nights")
  - negotiation stats (average discount, offers below floor)
  - low stock
- Cost: about 0.1 credit/day. The same brief appears free at `/admin`.

### I-4 Repeat-customer memory (Creativity)
After a paid order, the backend writes a Chord memory for that customer ("Bought Eko Nights
black, size L, 2026-10-24, paid ₦13,500"). Its `customer_id` is the thread's sender id. The skill
tells the agent to use `## Customer Memory` ("Same size L as last time?"). Best-effort; failures
are logged only.

### I-5 Payments go through Chord's booking tools (from spec 07)
Built and tested. Blocked only on the owner's Paystack **test** key. Spec 07 gains a
reconciliation sweep: pending orders with a Chord booking are checked against
`GET …/bookings` every 5 minutes, so a missed webhook still confirms (the docs advise
reconciling business-critical events).

### I-6 Writing (Field notes, Communication, Customer thinking)
- Field notes: the top 5 incidents in full, then a compact table of the doc contradictions
  found in the re-read, each with a concrete fix the Chord team could ship next week.
- Go-live note: rewritten for a non-technical owner, with honest limits and real risks.
- README: one screen for the reviewer, then details. Submission summary with role and problem
  statement. A 3-minute recording script.
- `docs/assessment.md`: self-score against the rubric with evidence links.

## Non-goals
Real WhatsApp numbers (`connectors/whatsapp/rent`) cost money and are outside the brief.
Event subscriptions run without a thread, so they're not useful for customer messaging (docs).
Knowledge bundles: the business facts fit in skill references, so a bundle adds cost without benefit.

## Rate/credit impact
All new backend → Chord calls (thread search, scheduled tasks, memories, bookings sweep) go
through one server-side limiter at ≤ 20 rpm. The only new model spend is the daily owner brief
(about 0.1 credit) and its one-off test run.

## Status (2026-10-24, verified live)

| Item | State | Evidence |
|------|-------|----------|
| I-1 proactive updates | ✅ live | AL-9B8F86 "✅ Payment received" delivered into thread `6adc2c25…` via task `task_095c…`, 0 credits. Failure, hold and restock covered by `proactive.test.ts` |
| I-2 waitlist + lost demand | ✅ live | WL-2B9421 → admin restock → "back in stock" in the same thread. `demand_event` logged |
| I-3 owner brief teammate | ✅ live | Teammate `17a67b32…`, MCP `mcp-cc3495ed…` (owner-only), schedule `sch_33de…` daily 20:00 Africa/Lagos. Test run produced an accurate brief (0.05 credits) |
| I-4 customer memory | ✅ live | Memory written for `smoke-proactive-1` after the AL-9B8F86 payment |
| I-5 payments via Chord + reconciliation | ✅ live | AL-LG8CBJ paid via Chord `initialize_transaction` → Paystack → verify sweep → stock −1 once → customer notified in 87s (spec 07) |
| I-6 writing | ✅ | field notes, go-live note, README, recording script, `docs/assessment.md` |

Security follow-up: the default "Chord Assistant" teammate had an empty MCP assignment (= all
servers). It is now pinned to the sales server only (field note 5).
