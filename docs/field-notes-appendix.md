# Field notes — full log (appendix)

The short version is [`field-notes.md`](field-notes.md). This file keeps every incident, the doc
contradictions table, and the credit and rate-limit record.

Everything here happened for real between 2026-10-23 and 24, building against `api.chordhq.xyz`.
That covers workspace `ws-0dc5a492…`, teammates "Adire Lane Sales" `4906e7fa…` and "Adire
Lane Owner Brief" `17a67b32…`, and a backend on Fly `adire-lane-tsg` (region `iad`).
Request IDs are included so the Chord team can trace them.

**Top five, most costly first.** Each has what happened, how I found the cause, the fix, and
what I'd change in Chord.

---

## 1. Payment links from a custom tool are silently blocked on WhatsApp

**What happened.** A full simulator conversation ended in a created order (AL-QJDMRW) and a
payment link, but the customer never saw the link. The simulator instead showed:
> *Blocked a reply with a payment link that didn't come from the booking tools
> (https://adire-lane-tsg.fly.dev/pay/AL-QJDMRW).*

The tester reported this as "payment is failing". They typed "continue", and no payment request
ever reached our server.

**How I found the cause.**
1. Our side looked healthy. `/healthz` was fine, the order existed, and there were no payment rows.
   A scripted pay-through of a throwaway order (AL-CLW5B7) worked.
2. The Chord thread recorded the reply as `delivery_status: "sent"` with the link intact. The
   block isn't visible in thread history.
3. All my API tests had passed, because `POST /v1/external-chat/messages` returns the
   *unfiltered* reply. Only the real channel applies the filter.
4. It was confirmed only when the tester pasted the simulator's message. None of the 28 guide
   pages mentions this guard. The authenticated OpenAPI calls a booking's `payment_link_url`
   "safe to share directly with customers", which was the only hint.

**Fix.** I didn't disguise the URL to slip past an anti-phishing control. Instead:
- Payment moved onto Chord's sanctioned path (`specs/07`). With the Paystack connector
  connected, the agent calls Chord's built-in **`initialize_transaction`**, which returned a real
  `checkout.paystack.com` test link for AL-LG8CBJ.
- Three more live surprises came out of that run:
  - (a) The connector needs `webhook_secret` as well as the key. It is undocumented, and the 400s
    name one field at a time.
  - (b) The tool takes `amount_kobo` **from the model**, so we pass exact arguments and confirm only
    when the paid amount verified with Paystack equals the order total.
  - (c) Default thresholds let the agent run `process_refund` up to ₦10,000 without a human. We set
    human approval for any amount.
- This path makes a Paystack transaction, not a booking, so we don't rely on `booking.confirmed`.
  The backend verifies with Paystack by reference every minute.
- **Result, verified live on AL-LG8CBJ:** Chord's Paystack link was delivered, the customer paid
  with a test card at 04:34:53, our sweep confirmed at 04:35:48 (₦14,000 matched, stock 3 → 2 once),
  and "✅ Payment received" reached the chat at 04:36:20. That is 87 seconds, with 0 credits for the
  follow-up. As predicted, Chord sent no `booking.*` webhook for this path.
- **One more surprise in that run:** the model called `create_pending_order` again on "confirm"
  and on "yes", creating **3 orders for 1 purchase** (AL-FURVX5, AL-DV8QVP, AL-LG8CBJ), and each
  one reserved stock. Fix: orders are idempotent per customer + items while a hold is live, with
  an explicit skill rule ("one purchase = one order"). The duplicates were cancelled. *Chord
  feedback:* show the model, inside a turn, which tool calls already succeeded earlier in the
  conversation, or offer per-tool idempotency hints in the MCP config.

**What I'd change in Chord.**
- Document the guard (what counts as a payment link, which tools are trusted) on the Chat and
  Skills pages.
- Mark the block on the turn (`delivery_status: "blocked"` plus a reason) and return it from
  `/v1/external-chat/messages`, so API tests catch it.
- Let builders register trusted link sources for MCP tools (e.g. `trusted_link_domains` on the
  MCP server, verified by domain ownership). The brief itself suggests "Paystack in test mode"
  through a custom tool, and that path can't work today on the required channel.

## 2. Tool calls with nested-object arguments failed silently, and the agent covered it up

**What happened.** `create_pending_order` failed 5 out of 5 times across two turns. The
customer was told "Retrying with the details corrected", then "I'll hand this over", but no
handover tool was called.

**How I found the cause.**
- `steps` showed only `create_pending_order ✗`. Turn metadata had `{"ok": false}` with no
  arguments and no error text.
- Our `tool_log` had **no rows**, so the call never reached our handler. It was rejected by MCP
  schema validation.
- It was the only tool with nested objects (`customer{}`, `items[{}]`, `fulfilment{}`). All flat
  tools worked.

**Fix.**
- A flat input schema, numbers coerced, offer IDs case-normalised (spec 04 T-7).
- Argument key/type logging (no values) on every `tools/call`.
- Skill rules: never narrate the process or send internal status; never claim a handover without
  calling the tools.
- The next run created AL-46779K first time. The failure loop had cost 0.36 credits, about four
  normal turns.

**What I'd change in Chord.** Put MCP `isError` text in `steps[].result` and turn metadata.
Validate advertised `inputSchema`s at discovery and warn on shapes the runtime handles badly.
Stop a tool loop after N identical failures and force the escalation path.

## 3. Escalation triggers don't work on skill teammates, and the procedures API returns 500 on a documented field

**What happened.**
- `POST /v1/procedures` with `owner_id` (copied from the escalation-rules guide) → **500
  INTERNAL**: `4465c4ee-8c20-4e05-804e-0471c4681892`, `bb122054-faf6-4baa-b4ed-a9ff067c0ddd`.
- Without it, attaching the trigger → **409 ABORTED** "This teammate uses skill files; save an
  explicit skill draft instead of editing legacy procedures".

**How I found the cause.** I changed one field at a time with free calls: minimal body → 201,
`workspace_id` only → 201, `owner_id` only → 500. The 409 text explained the rest. Re-reading
all the guides, no page states that skill teammates lose escalation triggers. procedures.md says
only "fenced after migration".

**Fix.** Escalation lives in the skill plus our `request_human_handover` record plus the built-in
`handover_to_human`. Verified: "debited twice" → `HO-FB4422C3` and thread `human_active`. The
setup script now checks `skills.enabled` first, so it never leaves orphan procedures.

**What I'd change in Chord.** Fix the 500 (or return a 400 that names the field). Add a callout
at the top of the escalation guide for skill teammates. Better, keep triggers working for skills,
since they're a different concern from instructions.

## 4. No documented way to message a customer from a backend event, but one exists

**What happened.** We needed to tell customers "payment received", "payment failed",
"your hold expires soon" and "back in stock". The chat and threads pages offer only
`POST /v1/threads/{id}/messages`, and that requires a human takeover first (which fires
`conversation.escalated` and posts a takeover acknowledgement). Event subscriptions run "with no
conversation, no thread". `POST /v1/threads` is external_chat only.

**How I found the cause.** A page-by-page re-read turned up scheduled tasks
(`POST /v1/scheduled-tasks`, `task_type: MESSAGE`, `platform: DIRECT_LINE`). Three free probes
confirmed the rest:
- A test task delivered into an existing external_chat thread as an outbound agent turn.
- The credits ledger showed **no charge** (no model run).
- `GET /v1/threads?q=AL-QJDMRW` finds the conversation where the agent quoted that reference. So
  the backend can find the right thread without Chord ever giving our MCP server a thread id.

**Fix.** A notifier sends four kinds of message: payment received, payment failed (with a plain
reason), hold reminder at 20 of 30 minutes, and back in stock for the waitlist. Guards: our
teammate's thread only; never while `control_state != agent_active`; one message per
(reference, kind); retry up to 3 times. Verified live on AL-9B8F86 and WL-2B9421 at 0 credits.

**What I'd change in Chord.**
- Pass `thread_id`/`conversation_id` to MCP tools as request metadata (e.g. an
  `X-Chord-Thread-Id` header), so tools can link records to conversations without text search.
- Document DIRECT_LINE delivery into external_chat/partner threads, and state the cost.
- Document what happens on real WhatsApp outside the 24-hour customer-care window (templates).

## 5. An empty MCP assignment means *all* servers, which nearly exposed owner data

**What happened.** I added a second, owner-only MCP server (sales figures and customer phones
for the evening brief). The workspace's default teammate "Chord Assistant" had an empty
`mcp_server_ids`, which Chord treats as **every enabled server**. It could already call our sales
tools, and would have gained owner data the moment the new server was enabled.

**How I found the cause.** The teammates and permissions pages say so ("Removing the last ID
widens access"; "`set_mcp_server_ids: []` does not clear"). The owner-setup script lists every
teammate's assignment before enabling a server.

**Fix.** Scope before enabling. Owner teammate → owner server only; sales teammate → sales server
only; default teammate pinned to the sales server. The script refuses to continue if the sales
teammate's list is empty.

**What I'd change in Chord.** Make "no MCP servers" expressible (`set_mcp_server_ids: []` should
mean none), or default new servers to *unassigned*. Show a warning in the app when enabling a
server will reach teammates with an empty list.

---

## Doc contradictions found in the page-by-page re-read (quick fixes)

| # | Where | What the docs say vs what happens | Suggested fix |
|---|-------|-----------------------------------|---------------|
| D1 | Concepts / Chat vs External chat | "send a new `session_id` to start a fresh conversation" vs "`session_id` does not fork the history". Live: a new session for the same sender reused the thread | One definition of conversation identity per surface, stated in Concepts |
| D2 | Chat vs Streaming | gated turn `thread_id` is `null` (sync) vs "an empty string" (stream). `steps` null vs `[]` | Pick one; we observed `[]` |
| D3 | Chat vs Partner chat | `agent_invoked` true "when the teammate ran and produced an answer" vs "can be true when execution produced no deliverable reply". Live: the handover turn returned `reply: null` but was **billed 0.12** | Document billing for gated and handover turns, and return the `thread_id` |
| D4 | Build a teammate / Skills | API-created teammates start with `skills.enabled: false`, so `POST …/skills/migrate` is needed. Not stated anywhere | One sentence in Skills: "API-created teammates: call migrate first" |
| D5 | OpenAPI | Booking create has no amount field. `status` enum omits `awaiting_payment`. `source_platform` lists FRONT/INTERCOM/SLACK only. Booking PUT and Paystack session bodies untyped | Type them. Explain how a booking gets its price |
| D6 | Webhooks | "4 attempts" (guide) vs "retried 3 times" (OpenAPI). Guide says "There is no `webhook:update`", but the spec defines it | Align |
| D7 | Public guides | Catalogs, bookings, resources, Paystack/WhatsApp connectors, dashboard, feedback and stats are in the authenticated `/api-docs` (392 paths) but have no guide. The public contract is 101 paths | A "Take payments" guide covering catalog → booking → `payment_link_url` → webhooks |
| D8 | Docs hosting | The docs' canonical URL and sitemap point to `tsg-labs.github.io/docs`, which now returns 404 | Update canonical and sitemap to `api.chordhq.xyz/docs` |
| D9 | MCP servers | Health probe is HTTP 200 with `status: "error"` on failure | Non-2xx, or `ok:false` |
| D11 | Paystack connector (OpenAPI) | Session body untyped. Live it needs `paystack_secret_key` + `webhook_secret`. Built-in tools (`initialize_transaction`, `create_invoice`, `process_refund`) and their thresholds are documented nowhere | Document the connector's tools, arguments and default thresholds. Default `process_refund` to human approval |
| D10 | Escalation rules | Stored rules ship **off** (`ESCALATION_RULES_DEPRECATED`) after five sections describing them | Lead with that |

## Smaller incidents

- **Deploy left the app without public IPs** (deployment, not Chord). The first `fly deploy`
  failed with `401` on release creation. The retry "succeeded", but `fly ips list` was empty, so
  the host didn't resolve. Fixed with `fly ips allocate-v4 --shared` and `allocate-v6`. Locally,
  a cached NXDOMAIN needed `curl --resolve`. `fly logs` also failed over IPv6 here, so I read
  our own `/admin/tool-log`, and from then on treated the app's own observability as essential.
- **The agent narrated its process** in one reply ("no negotiation tool check is needed…"). Fixed
  with a skill rule and re-tested clean.
- **A test run hung once and silently blocked a deploy.** The deploy was chained after
  `npm test`, which sat idle for about 10 minutes, so the logging fix never shipped until I noticed
  release v9 was still current. Re-running with a 20s per-test timeout passed 66/66 in normal time.
  I couldn't reproduce the hang, so the root cause is **unknown**. Mitigation: `npm test` now uses
  `--test-timeout=20000`, and deploys are no longer chained to a long test run.
- **Paystack reports a declined card as `abandoned`, not `failed`** (Paystack, not Chord). A live
  decline on AL-XWNGM3 (`POST /charge`, test card 4084080000005408) was ignored by our sweep for two
  minutes. Raw `GET /transaction/verify` showed `status: "abandoned"` with `gateway_response:
  "Transaction declined…"`. A customer who just closed the checkout is also `abandoned`, but with
  "The transaction was not completed". Fix: `isFailedAttempt()` treats abandoned plus any other
  gateway response as a failure. After deploy, `last_failure` was recorded within a minute.
- **A PIN typed in chat ends up in transcripts.** Testing the owner PIN gate stored the PIN in the
  Chord thread and in my local credit ledger (the smoke script logs message text). I scrubbed the
  ledger and rotated the PIN. A chat PIN is a stop-gap: the real fix is owner identity from the
  channel (Kemi's verified WhatsApp number bound to the owner teammate). *Chord feedback:* expose
  the verified sender identity to MCP tools, so authorisation doesn't depend on secrets in chat.
- **The owner's own simulator test found five customer-facing problems** (thread `6adc3b0f…`, spec 10):
  - Paystack rejects `.example` emails ("email must be a valid email", verified with
    `/transaction/initialize`), so the fallback failed and the agent narrated it.
  - The counter-offer formula *rose* with the bid (₦16k → ₦17k → ₦16k).
  - The agent re-checked stock after ordering and called the customer's own held XL "sold out".
  - There was no way to cancel or switch an order.
  - The automatic "payment received" message duplicated the agent's own, in log-like wording.

  Fixes: a no-mailbox fallback on our own domain, a constant counter, a "the item is theirs" rule,
  `cancel_order`, and plain templates with duplicate suppression. Re-run live: all five gone.
- **Chat formatting can glue punctuation onto links.** `/pay/AL-XXXXXX.` returned 404. These now
  redirect to the clean URL (test added).

## Rate limits and credits

- **Rate limit:** every response carries `x-ratelimit-limit: 60`. Setup scripts pace to 50 rpm,
  the backend to ≤ 20 rpm. Retries honour `Retry-After`. `CREDITS_UNAVAILABLE` and
  `PAYMENT_REQUIRED` are never retried. No 429 was hit.
- **Credits:** 50.00 → **44.13** after two days (5.87 spent in total).
  - My API tests: 1.99 credits.
  - The tester's simulator session: 1.12 credits (12 turns).
  - Owner brief run: 0.05 credits.
  - Paystack payment-path testing: about 0.81 credits (5 turns, inflated by the duplicate-order
    turns).
  - Owner-by-chat live test: 0.19 credits (3 turns). The live declined-card test cost 0 (Paystack
    API plus MCP, no model turns).
  - A turn costs about 0.04–0.17 credits, scaling with tool calls.
  - Proactive messages, setup, discovery, health and reads cost nothing.
  - The smoke script refuses to drop below a 30-credit reviewer reserve.
- **Security:** the integration key was pasted in a chat transcript during the build. It lives
  only in the gitignored `.env` (mode 600) and as a Fly secret. **Rotate it after review.**

## Still open

- Confirm in the simulator UI that proactive messages appear without a refresh. (In Chord's
  thread history they arrive as normal outbound agent turns.)
- Rotate the Chord integration key **and** the Paystack test key after review. Both were pasted in
  a chat transcript. They live only in `.env` (mode 600), Fly secrets, and Chord's connector.
- Small observability gap, fixed: the verify sweep didn't log successful confirmations, so the
  payment was briefly visible only in the database. It now logs `paystack_verified`.
