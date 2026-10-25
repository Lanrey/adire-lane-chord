# Adire Lane: a WhatsApp sales assistant on Chord

**Role:** Forward-deployed Engineering

**Problem.** Adire Lane is a one-person streetwear shop in Lagos that sells almost entirely through
WhatsApp. When the owner is asleep or busy, customers asking "do you have my size?" or "last price?"
go unanswered and buy elsewhere, and each missed chat is a lost ₦15,000–₦40,000 sale. The assistant
replies instantly, haggles only within the owner's minimum price, takes payment, keeps stock
accurate, and tells the owner each evening what sold and what customers wanted. **Left out on
purpose:** real money, a real WhatsApp number, refunds and deliveries, until a pilot proves it pays
for itself.

## Try it in the simulator ("Adire Lane Sales")

| Say | What happens |
|-----|--------------|
| "Do you have TS-104 in 3XL?" | Live stock for that exact size |
| "Last price? 10k" | Declined, counter of ₦14,500. The shop's rules decide, not the AI |
| "14,500, pickup. Ada, 08031234567" → "yes" → "skip" | Order placed, item held 30 min, Paystack test link from Chord |
| Pay with card 4084 0840 8408 4081 · CVV 408 · 12/30 | Payment checked with Paystack, stock taken off once, "Thank you! We've received your payment…" arrives in about 90s |
| "Eko Nights in XL? Tell me when it's back." | Restock list. When the owner restocks, the customer is messaged automatically |
| "I was debited twice!" | Handed to the owner with a summary |

## What's built

- **Sales teammate:** a Chord skill plus 10 tools on our hosted API (catalogue, stock, offers,
  orders, cancel, payment status, restock list, handover). Payment goes through Chord's Paystack
  connector, and stock is committed only when Paystack confirms the exact amount.
- **Automatic follow-ups:** payment received, payment failed, hold expiring, back in stock. These
  are free Chord scheduled messages, and the text is plain and friendly.
- **Owner teammate:** an 8pm brief with impact (after-hours sales, sales recovered by follow-ups,
  restock-list sales), plus changes by chat ("set XL to 5", "floor 14k") behind a PIN. It runs on a
  separate tool server that customers can't reach.

## Evidence

- A live Paystack test payment (verified, stock −1 once, customer told in 87s) and a live declined
  card (explained to the customer, no stock change).
- 73 automated tests: `cd server && npm test`.
- Field notes: [`docs/field-notes.md`](docs/field-notes.md). Go-live note:
  [`docs/go-live-note.md`](docs/go-live-note.md). Deliverables:
  [`SUBMISSION.md`](SUBMISSION.md). What's next: [`ROADMAP.md`](ROADMAP.md).
- Design: spec-driven, `specs/00`–`10` (rules → requirements → Chord research → design → tool
  contracts → tasks → iterations).

## Run it

```bash
# all commands from the repo root
cp .env.example .env                       # fill tokens: openssl rand -hex 24
npm --prefix server install && npm --prefix server test   # Node ≥ 23.6, no build step
npm --prefix server run dev                # local server
fly deploy                                 # backend (fly.toml), secrets via fly secrets set
npm --prefix server run chord:setup        # sales teammate: tools + skill
npm --prefix server run chord:owner        # owner teammate + 8pm schedule
npm --prefix server run chord:payments     # Paystack TEST key → Chord connector + webhook
npm --prefix server run demo:reset         # clean demo data before recording
npm --prefix server run chord:credits      # credit balance (free)
```

## How I used AI

- **Where:** Claude Code (Claude Opus) for research, specs, code, tests, setup scripts, live API
  debugging and first drafts of these documents. The agent itself runs entirely on Chord.
- **How:** in a spec-driven loop. Specs came first, then code and tests against them, then live
  checks on Chord with a credit guard. I made the product calls (problem, payments through Chord's
  Paystack connector, a dedicated teammate, hosting), tested as a customer in the simulator, and fed
  the problems I found back in. Nothing was accepted without passing tests and a live check.
- **Why:** to cover more ground in the timebox. Parallel reading of all 28 Chord doc pages and the
  API reference, fast iteration on undocumented behaviour. That left my time for problem choice,
  customer testing and judgment calls.
