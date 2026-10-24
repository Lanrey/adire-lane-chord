# Submission: Adire Lane on Chord

**Role:** Forward-deployed Engineering

**Problem.** Adire Lane is a one-person streetwear shop in Lagos that sells almost entirely through
WhatsApp. When the owner is asleep or busy, customers asking "do you have my size?" or "last price?"
go unanswered and buy elsewhere, and each missed chat is a lost ₦15,000–₦40,000 sale. The assistant
replies instantly, haggles only within the owner's minimum price, takes payment, keeps stock
accurate, and tells the owner each evening what sold and what customers wanted. **Left out on
purpose:** real money, a real WhatsApp number, refunds and deliveries, until a pilot proves it pays
for itself.

| # | Deliverable | Where |
|---|-------------|-------|
| 1 | Role + problem | Above |
| 2 | Live agent | Chord teammate **"Adire Lane Sales"** in the WhatsApp simulator (backend always on at `adire-lane-tsg.fly.dev`). Owner teammate: **"Adire Lane Owner Brief"** |
| 3 | Code + README | This repo: `server/` (tools), `skill/` (Chord skill), `scripts/` (Chord setup), `specs/`, [README](README.md) |
| 4 | 3-minute recording | _<link>_. Script: [`docs/demo-script.md`](docs/demo-script.md) |
| 5 | Field notes | [`docs/field-notes.md`](docs/field-notes.md) (full log: [appendix](docs/field-notes-appendix.md)) |
| 6 | Go-live note | [`docs/go-live-note.md`](docs/go-live-note.md) |

**Try it:** "Do you have TS-104 in 3XL?" → "Last price? 10k" → "14,500, pickup, Ada 08031234567" →
"yes" → "skip". Pay with test card 4084 0840 8408 4081 / CVV 408 / 12/30, and the payment
confirmation arrives in the chat in about 90s. About 43 credits are left for review.
