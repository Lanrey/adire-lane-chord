# 05 — Tasks

Tasks follow the PRD six-hour plan (§10). Each task names the requirements it
satisfies and how it is verified. Status: `[x]` done and verified · `[~]` built, but
needs live Chord credentials to verify · `[ ]` not started.

## Phase 0 — Verify Chord (00:00–00:30)
- [x] T0.1 Read the Chord docs and map PRD terms to Chord terms → `02-chord-integration.md`
- [x] T0.2 Key smoke test: `GET /v1/teammates` and one `POST /v1/external-chat/messages` (`npm run chord:smoke`)
- [~] T0.3 MCP tools confirmed on external-chat API ✔. Simulator (partner OAuth) connection still to do

## Phase 1 — Inventory (00:30–01:45)
- [x] T1.1 Schema + `tx()` helper (D3) — FR-01..03
- [x] T1.2 Seed Adire Lane catalogue (PRD appendix) — FR-01, FR-02
- [x] T1.3 Admin CRUD `/admin/products`, `/admin/variants/:sku` with admin token — FR-01 · `test/admin.test.ts`

## Phase 2 — Tools (01:45–03:15)
- [x] T2.1 `search_products`, `get_product_details`, `check_stock` (D7, D4) — FR-02, FR-03, FR-05 · AT-01..03
- [x] T2.2 `calculate_offer` + offer tokens (D5) — FR-04 · AT-04, AT-05
- [x] T2.3 `create_pending_order` with atomic reservation (D4, D6) — FR-07 · AT-06
- [x] T2.4 MCP Streamable HTTP endpoint + bearer auth (D8) — FR-06 · `test/mcp.test.ts`
- [x] T2.5 Deploy to public HTTPS, register with Chord, discover tools, check health (`npm run chord:setup`)

## Phase 3 — Agent behaviour (03:15–04:15)
- [x] T3.1 Write the skill `skill/adire-lane-sales` (D9) — B-1, CR-1..10
- [x] T3.2 Skill published via API (rev 3). Escalation triggers are rejected for skill teammates (F-2), so the skill handles handover
- [x] T3.3 AT-01..AT-10 run live through `/v1/external-chat/messages` (ledger in field notes)

## Phase 4 — Payment (04:15–05:00)
- [x] T4.1 `confirmPayment` idempotent commit (D6) — FR-08, FR-09 · AT-07..09
- [x] T4.2 Simulated checkout `/pay/:ref` (clearly labelled) + admin test event
- [x] T4.3 Paystack test mode: initialize, HMAC webhook, verify callback — B-2
- [x] T4.4 `get_payment_status`, `request_human_handover` — FR-08, FR-10 · AT-07, AT-10

## Phase 5 — E2E & demo (05:00–06:00)
- [x] T5.1 Automated backend acceptance suite AT-01..AT-10 (`npm test`)
- [x] T5.2 `/admin` dashboard showing orders, stock and handovers — FR-11
- [~] T5.3 Simulator run-through of `docs/demo-script.md`, record the 3-minute video
- [x] T5.4 README, field-notes template, go-live note

## Iteration 2 — integration key, rate limits, credits, deployment (specs/06)
- [x] T6.1 Spec 06: rate limit, credit budget, round-trip reduction, connection requirements
- [x] T6.2 Rate-limited, retry-aware Chord client (50 rpm, header pacing, Retry-After, stop codes) · `test/chord-client.test.ts`
- [x] T6.3 Credit guard + ledger + `chord:credits` (live balance from the credits ledger)
- [x] T6.4 Search returns live `available` (R-3.1). Skill inlines business essentials (R-3.2)
- [x] T6.5 Server keep-alive 75s, `/mcp` 120 rpm/IP and `/pay` 30 rpm/IP limits
- [x] T6.6 Deploy to Fly `iad` (next to Chord's us-east-1). Dedicated teammate created, skills migrated, MCP registered, teammate activated
- [x] T6.7 Live fix: flat `create_pending_order` contract (T-7) + argument-shape logging (T-8) after the nested-arg failures
- [x] T6.8 Skill hardening: no process narration, real handover on repeated tool failure
- [x] T6.9 `/admin/reset-demo` for clean recordings
- [x] T6.10 Field notes rewritten from real incidents
- [ ] T6.11 Connect the WhatsApp simulator (Chord Connect consent: needs the account owner in a browser), record the video, fill the TO FILL notes
- [x] T6.13 Payment incident (field note 4): `/pay` access + rejection logging, punctuation-tolerant pay links · test added
- [ ] T6.12 Rotate the integration key after the exercise (it was shared in a chat transcript)

## Iteration 3 — Chord-native payments (specs/07)
- [x] T7.1 Spec 07 from the authenticated OpenAPI doc (catalogs, bookings, connector sessions)
- [x] T7.2 `/webhooks/chord` receiver + `chord_delivery` dedupe table · `test/chord-webhook.test.ts`
- [x] T7.3 Catalog sync (per-order item at exact agreed total) + `PAYMENT_MODE=chord` tool behaviour
- [x] T7.4 Live checks C-1 (catalog per-order amounts) and C-3 (Paystack form field)
- [x] T7.5 `scripts/chord-payments-setup.ts` (Paystack session, tool scope report, webhook register + test)
- [x] T7.6 Paystack TEST key → `chord:payments` (session `ShuijpyxnNXq8RXKGw-9Qw` HEALTHY, booking webhook registered), `PAYMENT_MODE=chord` on Fly
- [x] T7.7 C-2: built-in tool is `initialize_transaction` (model supplies `amount_kobo`) → `payment_tool_args`, idempotent orders, thresholds, skill rev 5
- [x] T7.8 Live test-card payment AL-LG8CBJ → Paystack verify sweep → paid, stock −1 once, proactive message in 87s (no `booking.*` webhook on this path, by design)

## Iteration 4 — assessment-driven improvements (specs/08)
- [x] T8.1 Page-by-page review of 28 guide pages + authenticated OpenAPI (5 parallel reviewers)
- [x] T8.2 Live probes (0 credits): DIRECT_LINE MESSAGE into external_chat, thread search by reference, memories flag, dashboard
- [x] T8.3 Notifier (payment received/failed, hold reminder, restock) + sweeper + guards · `proactive.test.ts`
- [x] T8.4 `notify_me_when_available` tool + lost-demand log
- [x] T8.5 Owner Brief teammate, owner-only MCP `/mcp/owner`, daily schedule; default teammate pinned
- [x] T8.6 Purchase memories; skill rev 4 (waitlist, failures, PAY/YES replies, returning customers)
- [x] T8.7 Reconciliation sweep for Chord bookings (missed webhooks)
- [x] T8.8 Docs: field notes, go-live note, README, recording script, self-assessment
- [x] T8.9 Paystack test key → spec 07 go-live
- [ ] T8.10 Record the 3-minute video (`docs/demo-script.md`), after `POST /admin/reset-demo`
- [ ] T8.11 Rotate the Chord integration key and Paystack test key after review (both were shared in chat)

## Iteration 5 — closing the gaps to 5/5 (specs/09)
- [x] T9.1 Owner write tools (`update_stock`, `set_price_rules`, `list_open_handovers`, `resolve_handover`), PIN-gated, audited · live chat verified
- [x] T9.2 Impact metrics (after-hours, recovered by follow-ups, waitlist conversions, discount %) in brief + `/admin`
- [x] T9.3 Live declined-card proof (AL-XWNGM3) → found and fixed Paystack `abandoned`-means-declined
- [x] T9.4 Field notes cut to top 3 + appendix; go-live note with the 24-hour rule and NDPA; `SUBMISSION.md`; `demo:reset`; `ROADMAP.md`
- [ ] T9.5 Recording + role line + AI-usage note (owner of the submission)

## Iteration 6 — customer-facing language (specs/10)
- [x] T10.1 Owner test review: thread `6adc3b0f…` → 5 issues (email, rising counter, "sold out" own item, no cancel, technical duplicate message)
- [x] T10.2 Valid no-mailbox receipt fallback (verified against Paystack) + "or just say skip"
- [x] T10.3 Constant counter-offer per item · `pricing.test.ts`
- [x] T10.4 `cancel_order` tool + skill switch flow · live AL-MQQKDB cancelled
- [x] T10.5 Plain automatic templates + duplicate suppression + banned-token test
- [x] T10.6 Skill "Talking to customers" (success/neutral/failure examples), rev 6 → 7
- [x] T10.7 Docs: README, SUBMISSION, demo script, field notes, assessment
