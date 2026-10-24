# Roadmap

**Rule for sequencing:** prove that one shop pays for itself before adding scale, markets or
compliance. Each row gives what we'd build, how, and why it waits.

## 1. Go live for Adire Lane (2–4 weeks)

| Next | How | Why it waits |
|------|-----|--------------|
| Real WhatsApp number | Chord WhatsApp connector (`rent` + `assign`); re-test follow-ups and the link guard | Costs money; the brief requires the simulator |
| Message templates | Meta-approved templates for follow-ups after the 24-hour window | Needs a verified business account plus Meta review |
| Live payments | Live Paystack key in Chord; refunds stay owner-approved; daily settlement check | Needs the owner's verified Paystack; the brief forbids live keys |
| Owner identity instead of a chat PIN | Bind the owner's WhatsApp number to the owner teammate | Needs a real number and Chord passing a verified sender to tools |
| Data deletion (NDPA 2023) | One button: delete orders, memories and conversations for a customer | No real customer data exists yet |
| Delivery booking | Tool to book Kwik/GIG after payment; tracking link as a follow-up | Not the bottleneck the shop described; each courier is a separate contract |

## 2. Many shops in Nigeria and West Africa (1–3 months)

| Next | How | Why it waits |
|------|-----|--------------|
| Self-serve onboarding | One Chord workspace per shop, template skill, credit pool per shop for spend caps | Needs one shop's numbers first to price it |
| Catalogue from a photo | Chord `menu/extract` turns a price-list photo into items the owner confirms by chat | Seed data was enough for one shop |
| Photos and voice notes in | Chord vision and transcription | Adds cost per message; not in the simulator |
| Pidgin, Yoruba, Hausa, Igbo | Language reference files in the skill | Needs native-speaker review |
| Price-floor coaching | Weekly suggestion from missed offers, one tap to apply | Needs weeks of real demand data |

## 3. Global

| Area | How | Why it waits |
|------|-----|--------------|
| Payments | Same "confirm only on a verified exact amount, once" logic behind Paystack, Flutterwave, Stripe, M-Pesa, UPI, Pix. Prefer Chord connectors so links pass the WhatsApp guard | Each provider behaves differently (Paystack reports declines as "abandoned"); only Paystack is a Chord connector today |
| Money and tax | Generalise minor units per currency; VAT/GST per country | NGN-only pilot; tax mistakes are costly |
| Time and language | Per-shop timezone and hours (Lagos is hard-coded today); per-market tone and haggling norms | Haggling is a feature in Lagos and a bug in most EU retail |
| Privacy | NDPA, POPIA, GDPR, LGPD: consent, retention, deletion, regional hosting | Legal review per market |
| Scale | Postgres; deploy next to Chord's region; queued sweeper; alerting | One shop fits one SQLite file |
| Channels and catalogues | Instagram DM, Telegram, web chat via Chord; Shopify/Woo/Instagram Shop sync via tools | WhatsApp is where this shop sells; adapters pay off only with many shops |

## Gates

- **1 → 2:** for 4 weeks at Adire Lane:
  - at least 20% of sales after hours;
  - at least 10% of sales recovered by follow-ups or the restock list;
  - fewer than 15% of chats handed to the owner;
  - no overselling;
  - Chord credits under 2% of revenue.
- **2 → 3:** 10 paying shops, under 1 support hour per shop per week, and a second payment
  provider passing the same tests.
