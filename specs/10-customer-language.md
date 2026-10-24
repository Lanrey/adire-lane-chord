# 10 — Customer-facing language and checkout fixes (iteration 6)

Trigger: the owner's own simulator test (thread `6adc3b0f…`, 2026-10-24 04:58–05:10). Requirement
from the account owner: **every customer message — success, failure or neutral — must be plain and
non-technical.**

## Problems seen → requirements

| # | Customer saw | Requirement |
|---|--------------|-------------|
| L-1 | "The fallback email was rejected, so I'll ask Olusola for his own email." | Paystack rejects `.example` emails. The fallback is now `receipts+<order>@<our host>`, a domain we control with no mailbox, so receipts don't reach third parties. The agent asks for an email at most once, kindly, with "or say skip". It never mentions fallbacks, rejections, tools or itself in the third person, and never guesses pronouns |
| L-2 | Counter-offers ₦16,000 → ₦17,000 → ₦16,000, with apologies | **Counter-offers never go up.** The counter is fixed per item: `roundUp500((floor + list) / 2)`, between floor and list. It doesn't depend on the customer's bid, so it's consistent across turns and still doesn't reveal the floor |
| L-3 | "XL is now sold out… AL-GV4G29 is not valid" about the customer's own held item | An item in the customer's pending order is **theirs**. The agent never re-checks stock for it or calls it sold out. `create_pending_order` says so in `next_step` |
| L-4 | Old order left "to lapse on its own" | New tool **`cancel_order(order_reference, customer_phone)`** cancels the customer's own unpaid order and frees the item at once. Switching items means cancel first, then create |
| L-5 | Two "payment confirmed" messages; the automatic one read like a log line ("1×", "(Africa/Lagos)", "(made-up address)") | Automatic messages are short and warm, with no codes except the order number, plain hours ("Mon–Sat, 10am–7pm") and size in words. If the agent already confirmed payment in chat (`get_payment_status` → paid), the automatic message is skipped |
| L-6 | Internal state in replies | Skill section "Talking to customers": tone rules plus examples for success, failure and neutral messages. Tool errors are translated, never quoted |

## Acceptance
- Tests: no customer-facing template contains `×`, `Africa/`, `made-up`, `SKU`, `WL-`, `tool`, `fallback` or a URL.
- Counter-offers for a series of rising bids never increase.
- `cancel_order` refuses another customer's order (phone mismatch) and paid orders.
- The live simulator re-run shows none of L-1..L-5.

## Status (2026-10-24, verified live)

| Req | State | Evidence |
|-----|-------|----------|
| L-1 email | ✅ | Paystack check: `…@adirelane.example` → "email must be a valid email", while `receipts+…@adire-lane-tsg.fly.dev` → link created. Live: customer said "skip" and got the link, with no mention of fallback |
| L-2 counter never rises | ✅ | Live: 11k → ₦17,000, 15.5k → ₦17,000 (was 16k → 17k → 16k). `pricing.test.ts` |
| L-3 held item is theirs | ✅ (skill + next_step) | Live: "make it 2XL" on an existing 2XL order → "no change needed", not "sold out" |
| L-4 cancel_order | ✅ | Live: switch to Eko Nights L → `cancel_order` → AL-MQQKDB `cancelled`, 2XL freed. `proactive.test.ts` |
| L-5 plain automatic messages, no duplicate | ✅ | New templates. Banned-token test. `get_payment_status`=paid suppresses the automatic duplicate |
| L-6 talking-to-customers rules | ✅ | Skill rev 6/7. Live replies contained no tool, code or fallback words |

Remaining nit (fixed in skill rev 7): the agent wrote "size L × 1". Quantities are now written as words.

## Traceability
`src/pricing.ts` (counter) · `src/tools.ts` (`cancel_order`, `next_step`, duplicate suppression) · `src/orders.ts`
(`cancelOwnOrder`) · `src/notify.ts` (templates) · `src/seed.ts` (`syncBusinessInfo`) ·
`skill/…/SKILL.md` ("Talking to customers") · tests: `pricing.test.ts`, `proactive.test.ts`.
