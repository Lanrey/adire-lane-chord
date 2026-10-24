// Paystack/Chord failure reasons → words a customer understands.
export function humanReason(reason: string | undefined): string {
  const r = (reason ?? '').toLowerCase();
  if (/insufficient/.test(r)) return 'insufficient funds';
  if (/declin/.test(r)) return 'the bank declined it';
  if (/expired/.test(r)) return 'the card has expired';
  if (/timeout|timed out|abandon/.test(r)) return 'the payment timed out';
  return 'the payment provider declined it';
}
