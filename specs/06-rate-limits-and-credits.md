# 06 — Rate limits, connections and credit budget

Added in iteration 2 after the integration key was issued. Inputs from the account owner:
**60 requests/minute** on the key, **50 credits** in total. Facts were checked live on
2026-10-23 with read-only calls, which cost no credits:

| Observation | Source |
|-------------|--------|
| Every response carries `x-ratelimit-limit: 60`, `x-ratelimit-remaining`, `x-ratelimit-reset` (seconds) | `GET /v1/teammates` response headers |
| Balance is readable: `GET /v1/workspaces/{ws}/credits/transactions` → `balance_after_cents` (5000 = 50 credits) | live |
| `GET /v1/usage` → `debited_credits`, `request_count` per key | live (all zero before any chat) |
| Skills are **disabled** on the pre-existing teammate (`"enabled": false`) | `GET /v1/teammates/{id}/skills` |
| Only one workspace teammate exists ("Chord Assistant"). No MCP servers. External-chat bridge `disconnected` | live |

## R-1 Rate limit (60 rpm)

- R-1.1 THE setup/smoke client SHALL pace itself to at most **50 requests/minute** using a
  sliding 60-second window. That leaves 10 rpm headroom for the simulator and Chord app traffic
  sharing the key.
- R-1.2 WHEN a response reports `x-ratelimit-remaining ≤ 2`, THE client SHALL wait
  `x-ratelimit-reset` seconds before sending the next request.
- R-1.3 WHEN a `429 RATE_LIMIT_EXCEEDED` arrives, THE client SHALL sleep for `Retry-After` and retry.
  For `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `SPEND_CHECK_UNAVAILABLE`
  and `SPEND_CAP_UNAVAILABLE` it SHALL use exponential backoff (1s, 2s, 4s, with jitter), up to
  3 attempts.
- R-1.4 THE client SHALL branch on `error.code`, not on the status alone. `CREDITS_UNAVAILABLE`
  (429), `PAYMENT_REQUIRED` (402) and `MEMORY_CAP_EXCEEDED` (429) SHALL stop immediately with a
  message for the account owner. These are never retried.
- R-1.5 Only idempotent requests are retried: GET, PUT, and POSTs that carry an idempotency
  key or `message_id`. A chat send always carries a `message_id`, so a retry is deduplicated by
  Chord and never charged twice (Chat docs: "A repeat of the same value is deduplicated").

## R-2 Credit budget (50 credits)

Only billable model work costs credits. That means chat turns (`/v1/external-chat/messages`,
simulator messages, in-app test chats). Management calls (MCP registration, discovery, health,
skills, procedures, reads) cost nothing but still count against the rate limit.

| Bucket | Credits | Use |
|--------|---------|-----|
| Smoke verification | ≤ 3 | 1 turn proving the MCP tool path, plus a re-test if the skill changes |
| Demo rehearsal + 3-min recording | ≤ 17 | Demo script runs 1→5→6→8 and 9, once each, plus one retake |
| **Reserve for reviewers** | **≥ 30** | "Leave it live so we can talk to it". Never spent by our scripts |

- R-2.1 Before every chat send, THE smoke script SHALL read the live balance. It SHALL refuse
  to send if balance − estimated turn cost < `CHORD_CREDIT_FLOOR` (default **30**).
- R-2.2 THE script SHALL record each billable turn (time, message_id, thread_id, balance
  before/after, measured cost) in `.chord-ledger.json` (gitignored). It SHALL use the measured
  average as the estimate for the next turn (initial estimate: 1 credit).
- R-2.3 THE smoke script SHALL default to **one** turn, and SHALL require `--yes` for scripted
  runs longer than 3 turns. It prints the projected spend before sending.
- R-2.4 Tool and backend logic is iterated with the local test suite (0 credits), never with
  the model. A conversation is only re-run after a skill or tool contract change.
- R-2.5 `npm run chord:credits` prints balance, debited credits and the ledger. It makes only
  free reads.

## R-3 Fewer model iterations per turn (each tool round trip costs model work)

- R-3.1 `search_products` SHALL return the live `available` count for every variant it lists.
  This is the same reservation-aware calculation `check_stock` uses (D4). When search has
  narrowed to a single variant and the quantity is 1, the agent does not need a separate
  `check_stock` call. `create_pending_order` still re-validates stock atomically, so
  constitution §5 still holds.
- R-3.2 The essentials of the business brief are inlined in SKILL.md. Reference files are read
  only when their topic comes up (negotiation, handover, examples). This avoids a
  `cognition__skill_read_file` round trip on every first reply.
- R-3.3 Tool outputs stay compact: no nulls, no internal ids, and at most 5 search results.

## R-4 Connections (Chord → MCP server)

- R-4.1 The server SHALL run on an always-on machine (`auto_stop_machines = "off"`,
  `min_machines_running = 1`), so a Chord tool call never waits on a cold start.
- R-4.2 HTTP keep-alive: `keepAliveTimeout` 75s, above typical proxy idle timeouts of
  60s, and `headersTimeout` 80s. That way Chord and the Fly proxy can reuse connections.
- R-4.3 MCP stays stateless JSON (no SSE sessions to hold open). Each tool call is one POST.
- R-4.4 A tool call SHALL finish in < 500 ms server-side (SQLite, local). Paystack calls happen
  only on the `/pay` page, never inside a tool.
- R-4.6 Region: `api.chordhq.xyz` resolves to an AWS us-east-1 load balancer
  (`api-gateway-alb-….us-east-1.elb.amazonaws.com`). The server therefore runs in Fly `iad`
  (Ashburn, VA), the same metro, to minimise tool-call latency on every model iteration.
  Customers' browsers only touch `/pay`, where an extra ~150 ms from Lagos is irrelevant.
- R-4.5 The server SHALL apply its own limit to `/mcp`: 120 requests/minute per client IP
  (Chord's egress). A runaway tool loop then fails fast with JSON-RPC errors instead of
  hammering the DB.

## Traceability

| Req | Implementation | Verification |
|-----|----------------|--------------|
| R-1.x | `scripts/chord.ts` (`RateLimiter`, `chord()` retry policy) | `server/test/chord-client.test.ts` (mock HTTP server) |
| R-2.x | `scripts/chord-credits.ts`, `scripts/chord-smoke.ts` | ledger file + live balance before/after |
| R-3.1 | `catalogue.ts` variant `available` | `test/catalogue.test.ts` |
| R-3.2 | `skill/adire-lane-sales/SKILL.md` | `docs/field-notes.md` (steps per turn) |
| R-4.x | `fly.toml`, `index.ts`, `http.ts` | `fly status`, health probe latency |

## Measured results (live, 2026-10-23)

| Metric | Value |
|--------|-------|
| Billable turns to prove AT-01..AT-10 live (incl. one failure loop) | 14 |
| Credits spent | 1.51 (50.00 → 48.49) |
| Cost per turn | 0.07 (1 tool) · 0.08 (status check) · 0.12 (3 tools) · 0.20 (6-call failure loop). Mean 0.11 |
| Management calls (setup, probes, reads) | ~35, 0 credits, no 429s |
| MCP health from Chord | 17–21 ms. Tool latency 14–76 ms |
| Remaining spendable above the 30-credit reviewer floor | 18.49 credits ≈ 170 turns |

Takeaway: cost tracks tool iterations per turn, so R-3 (fewer round trips) and spec 04 T-7
(flat inputs, no failure loops) are the main levers. The 30-credit floor is generous at this
rate. It can be lowered to 20 if the recording needs retakes.
