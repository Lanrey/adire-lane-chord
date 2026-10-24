# Deployment field notes

These are the three problems that cost the most, built on `api.chordhq.xyz` (2026-10-23 to 24).
Request IDs are included for tracing. Every other incident, the doc-contradiction table and the
credit record are in [`field-notes-appendix.md`](field-notes-appendix.md).

## 1. Payment links from a custom tool are silently blocked on WhatsApp

**What happened.** A simulator conversation created order AL-QJDMRW and sent our checkout link.
The customer instead saw: *"Blocked a reply with a payment link that didn't come from the
booking tools."* They typed "continue". The tester reported it as "payment is failing".

**How I found it.**
- Our side looked healthy: no payment attempts, and a scripted pay-through worked.
- Chord's thread history showed the reply as `delivery_status: "sent"`, link intact.
- `POST /v1/external-chat/messages` returns the *unfiltered* reply, so every API test had passed.
- Only the simulator's own text revealed the guard. None of the 28 guide pages mentions it.

**Fix.** I didn't disguise the URL (it's an anti-phishing control). Instead I moved payment onto
Chord's Paystack connector. That uncovered four undocumented details:
- The session needs `webhook_secret` as well as the key. The 400 names one field at a time.
- The agent's tool is `initialize_transaction`, and it takes **`amount_kobo` from the model**. Our
  order tool now returns exact `payment_tool_args`, and stock commits only when the amount verified
  with Paystack equals the order total.
- The default thresholds let the agent call `process_refund` up to ₦10,000 with no human. I set
  human approval for any amount.
- No `booking.*` webhook fires on this path. The backend verifies with Paystack by reference.

**Verified:** AL-LG8CBJ was paid by test card at 04:34:53, confirmed at 04:35:48 (stock −1 once),
and "✅ Payment received" was in the chat at 04:36:20, all at 0 credits for the follow-up.

**What Chord should change.** Document the guard. Mark blocked turns (`delivery_status:
"blocked"` + reason) and return that from the API. Let MCP servers declare verified
`trusted_link_domains`. Document the connector's tools, arguments and thresholds, and default
`process_refund` to human approval. The brief suggests "Paystack in test mode" through a custom
tool, and today that can't reach a customer on the required channel.

## 2. Tool failures are invisible, and the model papers over them

**What happened.**
- `create_pending_order` failed 5/5 times. The agent told the customer "Retrying with the details
  corrected", then claimed a handover it never made.
- A day later it re-called the order tool on "confirm" and on "yes", making **three orders for
  one purchase**, each reserving stock.
- In the owner's own test, Paystack rejected an email and the customer read: *"The fallback email
  was rejected, so I'll ask Olusola for his own email."* That leaked internal state and guessed a
  pronoun.

**How I found it.**
- `steps` and turn metadata show only `{"name", "ok": false}`, with no arguments and no error text.
- Our own `tool_log` had no rows, so the calls died in MCP schema validation. It was the only tool
  with nested objects.
- The duplicates showed up as three order references in one thread.

**Fix.**
- Flat tool schemas.
- Logging of argument keys and types (no values).
- Idempotent `create_pending_order` per customer + items.
- Skill rules: no process narration; one purchase = one order; never claim a handover without
  calling the tool.
- A "Talking to customers" section with success, neutral and failure examples, and a test that bans
  codes, units, tool words and links from automatic messages (spec 10).

**What Chord should change.**
- Put MCP `isError` text into `steps[].result`.
- Validate advertised schemas at discovery and warn.
- Stop a tool loop after N identical failures and force escalation.

## 3. Configuration traps that silently widen or remove behaviour

**What happened.**
- Creating an escalation trigger as the guide shows (`owner_id`) → **500 INTERNAL**
  (`4465c4ee-8c20-4e05-804e-0471c4681892`).
- Without it, attaching → **409 ABORTED**: "This teammate uses skill files". Skill teammates can't
  have escalation triggers, and no page says so.
- API-created teammates start with skills **disabled**, which needs `POST …/skills/migrate`. Also
  undocumented.
- An **empty** `mcp_server_ids` means *all* servers. The default teammate could already call our
  sales tools, and would have gained the owner-data server the moment it was enabled.

**How I found it.** I bisected request bodies one field at a time with free management calls. The
owner-setup script lists every teammate's MCP assignment before enabling a server, and that's
what exposed the empty list.

**Fix.**
- Escalation lives in the skill plus our handover record plus `handover_to_human`. Verified:
  thread → `human_active`.
- Every teammate is pinned to an explicit server list. Setup refuses to continue if the sales
  teammate's list is empty.

**What Chord should change.**
- Fix the 500.
- Add "skill teammates: no procedures" to the escalation guide, and "call migrate" to the
  skills guide.
- Make `set_mcp_server_ids: []` mean *none*, or default new servers to unassigned.
