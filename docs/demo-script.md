# 3-minute recording script

**Setup (off camera):**
- `npm --prefix server run demo:reset` (clears orders and restores seed stock).
- Open the simulator on the left and `/admin` on the right (paste `ADMIN_TOKEN`).
- Use a fresh simulator conversation.
- Cost: about 10 turns ≈ 1 credit.

| Time | Do | Say (one line) |
|------|----|----------------|
| 0:00–0:20 | Show the README "Problem" section | "A one-person boutique loses night-time WhatsApp sales and hours of 'last price?'. This agent closes the sale within the owner's rules." |
| 0:20–0:45 | Type `Do you have TS-104 in 3XL?` | "Live stock for that exact size, from our tool, not the model's memory." |
| 0:45–1:10 | `Last price? 10k` → `ok 14,500, pickup. Ada Obi 08031234567` | "The backend rejects anything below Kemi's floor and counters. The model can't invent a price." |
| 1:10–1:35 | `yes` → "skip" (email) → order AL-… + link. Point at `/admin`: order *pending*, stock unchanged | "The item is held, not sold. Stock only moves on a trusted payment." |
| 1:35–2:00 | Open the **checkout.paystack.com** link (issued by Chord's Paystack tool) → card 4084 0840 8408 4081, exp 12/30, CVV 408 (PIN 1234 / OTP 123456 if asked). Within about 90s **"Thank you! 🎉 We've received your payment…"** appears in the chat | **The tool does its job:** order paid, stock −1 exactly once, and the customer is told automatically, for free. |
| 2:00–2:25 | `Eko Nights in XL? only XL, tell me when it's back` → `WL-…`. On `/admin` raise XL stock to 3 → **"back in stock"** arrives | "Lost demand becomes a follow-up sale." |
| 2:25–2:45 | `I was debited twice, I want my money back` | "Disputes go to a human, with a reason recorded." |
| 2:45–3:00 | Chat with **Owner Brief**: "How did we do today?" (impact line), then "set Eko Nights XL to 3" → it asks for the PIN → done | "Kemi runs the shop by chat: briefs with impact numbers, and changes behind a PIN. Customers can never reach these tools." |

## Acceptance coverage (PRD AT-01..AT-10)

| AT | Live via Chord | Automated test |
|----|----------------|----------------|
| 01 exact code · 02 ambiguous · 03 out of stock | ✅ 2026-10-23 | `catalogue.test.ts` |
| 04 fixed price · 05 floor | ✅ | `pricing.test.ts` |
| 06 order · 07 false claim · 08 confirmation | ✅ AL-46779K, AL-9B8F86 (simulated); **AL-LG8CBJ via Chord + Paystack test card** | `orders.test.ts`, `payments.test.ts`, `chord-webhook.test.ts` |
| 09 duplicate confirmation | ✅ double submit, one payment row | `payments.test.ts`, `chord-webhook.test.ts` |
| 10 handover | ✅ HO-FB4422C3, thread `human_active` | `handover.test.ts`, `mcp.test.ts` |
| Proactive, waitlist, memory, owner brief | ✅ 2026-10-24 (0 credits for follow-ups) | `proactive.test.ts` |
