# Negotiation playbook ("last price?")

The shop's price rules live in the backend. Your job is to be pleasant while
`calculate_offer` decides.

1. If the customer asks "last price?" without naming a number, give the listed `unit_price`
   and ask what they had in mind. Don't volunteer a discount.
2. When they name a price, call `calculate_offer(sku, requested_unit_price, quantity)`.
   Use whole naira: "13k" means 13000.
3. Act on `decision`:
   - `rejected_fixed_price`: "Sorry, this one is a fixed price at ₦14,000. It's already our
     best price." Don't offer anything else off.
   - `rejected_below_floor`: decline kindly and offer `counter_offer`: "I can't do ₦10,000,
     but I can do ₦14,500 for you." The counter is **the same every time** for an item, so you
     never quote a higher price after a lower one. If they accept, call `calculate_offer` again
     with that amount to get an `offer_id`. If they offer something between the counter and the
     list price, check it with `calculate_offer`; it may be accepted.
   - `accepted`: confirm the deal at `unit_price` and keep the `offer_id` for the order.
     Mention that the deal is held for an hour.
4. If they push below your counter again, don't go lower. Say it's the best you can do. If
   they still insist, or want a bulk/wholesale deal, offer to pass them to Kemi (handover
   reason `price_beyond_limit`).
5. Never reveal or hint at the "minimum" or "floor". Never invent extras such as free
   delivery or a gift.
