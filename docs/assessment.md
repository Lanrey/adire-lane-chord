# Final assessment (2026-10-24)

Checked against the brief (re-read, including role weights) and the live system: both teammates
active, skill rev 7 live, both tool servers healthy, Paystack connected, 73/73 tests.
**Role: Forward-deployed Engineering**, which weights Integration and Field notes most.

## Brief and deliverables

| Item | Status |
|------|--------|
| Skill with business context | ✅ `skill/adire-lane-sales` |
| Custom tool calling an external system | ✅ Hosted API (10 tools) + Paystack test mode |
| Simulator conversation with a real action | ✅ Order paid by test card, stock committed, customer told |
| 1. Role + problem (3–4 sentences, non-technical) | ✅ README and SUBMISSION |
| 2. Agent live | ✅ Keep Fly running and ≥ 30 credits for 5 days |
| 3. Repo + README | ✅ Private GitHub repo `Lanrey/adire-lane-chord` |
| 4. 3-minute recording | ❌ **To do**: `npm --prefix server run demo:reset`, then `docs/demo-script.md` |
| 5. Field notes (2–3 problems) | ✅ 3 problems, each with what / how found / fix / Chord change |
| 6. Go-live note ≤ ½ page | ✅ 240 words |
| AI use in README | ✅ Where / how / why |
| Test keys and made-up data only | ✅ Personal data from a test run removed (backend reset, Chord memory and conversations deleted). One Paystack *test* transaction keeps a personal email; Paystack has no delete API |

## Scores

| Area | Weight | Score | Why |
|------|--------|-------|-----|
| Integration | 25% | **5** | Real payment through Chord's Paystack connector, verified before stock moves. A live declined card handled. Empty search, sold out, wrong amount, missed webhook, duplicate orders and human takeover all handled |
| Field notes | 25% | **5** | Three real problems with error text, request IDs, how the cause was found, the fix, and concrete Chord changes |
| Creativity | 20% | **5** (could be read as 4) | Real paid-for problem. Two teammates (customer / owner) on separate tool servers; owner runs the shop by chat; free automatic follow-ups; restock list turns lost demand into sales |
| Customer thinking | 15% | **5** | Plain-language go-live note with real risks (live keys, 24-hour WhatsApp rule, data law, alerts, cost). Customer messages tested by the owner and simplified |
| Communication | 15% | **3 → 5 with the recording** | Concise README and SUBMISSION; the recording is the one gap |

**Weighted: 4.70 / 5 now, 5.0 once the recording is linked.** For a forward-deployed role, the two
heaviest areas are both 5.

## Still to do
1. Record the video and add the link to SUBMISSION.md.
2. Email your TSG contact the payment-link blocker from field note 1 (the brief rewards reporting
   blockers early).
3. After review, rotate the Chord key, the Paystack test key and the owner PIN.
