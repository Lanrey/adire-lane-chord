# Submission: Adire Lane on Chord

**Role:** Forward-deployed Engineering

**Problem statement.** Kemi, the owner of Adire Lane, tries to turn every WhatsApp enquiry into a
paid order. But messages go unanswered at night and while she's busy, because she sells alone and
spends her day answering "how much?", "do you have it in 3XL?" and "last price?" and checking bank
alerts by hand. As a result, customers buy elsewhere, and each missed chat is a lost
₦15,000–₦40,000 sale.

**Summary.** Adire Lane is a one-person streetwear shop in Yaba, Lagos, and its owner, Kemi, sells
almost entirely through WhatsApp. Our agent replies to her customers instantly, day and night, using
live prices and stock. It haggles only down to her minimum price and takes stock off only when
Paystack confirms the payment. That's worth paying for because each unanswered chat is a
₦15,000–₦40,000 sale lost to a faster seller, and every hour Kemi spends on repeat questions and bank
alerts is an hour not spent running the shop. We deliberately left out real money, a real WhatsApp
number, refunds and deliveries until a pilot shows the agent pays for itself.

| # | Deliverable | Where |
|---|-------------|-------|
| 1 | Role + problem | Above |
| 2 | Live agent | Chord teammate **"Adire Lane Sales"** in the WhatsApp simulator (backend always on at `adire-lane-tsg.fly.dev`). Owner teammate: **"Adire Lane Owner Brief"** |
| 3 | Code + README | [github.com/Lanrey/adire-lane-chord](https://github.com/Lanrey/adire-lane-chord) (private; share access with your TSG contact): `server/` (tools), `skill/` (Chord skill), `scripts/` (Chord setup), `specs/`, [README](README.md) |
| 4 | 3-minute recording | _<link>_. Script: [`docs/demo-script.md`](docs/demo-script.md) |
| 5 | Field notes | [`docs/field-notes.md`](docs/field-notes.md) (full log: [appendix](docs/field-notes-appendix.md)) |
| 6 | Go-live note | [`docs/go-live-note.md`](docs/go-live-note.md) |

**Try it:** "Do you have TS-104 in 3XL?" → "Last price? 10k" → "14,500, pickup, Ada 08031234567" →
"yes" → "skip". Pay with test card 4084 0840 8408 4081 / CVV 408 / 12/30, and the payment
confirmation arrives in the chat in about 90s. About 43 credits are left for review.
