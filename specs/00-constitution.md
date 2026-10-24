# 00 — Constitution (non-negotiable principles)

These rules come from the PRD (§8, §9, §12) and the TSG Labs brief. Every spec,
task and line of code in this repo must satisfy them. If a later spec conflicts
with this file, this file wins.

1. **The backend is the source of truth.** Prices, stock, delivery fees, order
   totals and payment state live only in the commerce backend. The Chord teammate
   reads them through tools and never states them from memory.
2. **The model cannot set a price.** `create_pending_order` takes no price field.
   A discounted price can only enter an order through an `offer_id` the backend
   issued after validating it against the seller's rules.
3. **Payment state changes only on a trusted event.** That means a verified Paystack
   webhook or verify call, the clearly labelled simulated checkout, or an
   admin-token test event. A customer saying "I've paid" changes nothing.
4. **Stock is committed exactly once.** Stock is decremented in the same database
   transaction that moves an order to `paid`, and that move is guarded by an
   idempotency key and the order's current state.
5. **Availability is checked per variant, twice.** Once when the agent quotes and
   again inside the transaction that reserves stock.
6. **Escalate rather than guess.** If a request is ambiguous, out of policy, a
   complaint, a dispute, or anything the tools can't answer, it goes to a human
   with a recorded reason.
7. **Secrets stay server-side.** Chord API keys, the MCP bearer token, the admin
   token and Paystack keys come from the environment only. They are never placed
   in skill files, tool output or logs.
8. **Collect the minimum.** We collect name, phone, and a delivery address only
   when the order is for delivery. Logs carry order references, not customer details.
9. **Small and honest beats big and broken.** Anything out of scope is listed
   explicitly in `01-requirements.md` §Out of scope and in the go-live note.
