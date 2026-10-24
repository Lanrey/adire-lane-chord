// AT-10 handover (FR-10)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts';
import { listHandovers, openHandover } from '../src/handover.ts';

test('AT-10 handover is recorded with reason, summary and conversation state', () => {
  const db = freshDb();
  const r = openHandover(db, { reason_category: 'payment_dispute', summary: 'Customer says she was debited twice for AL-ABC123.', customer_phone: '08031234567', order_reference: 'AL-ABC123' });
  assert.match(r.handover_id, /^HO-[0-9A-F]{8}$/);
  assert.match(r.next_step, /handover_to_human/);
  const [h] = listHandovers(db) as { reason_category: string; status: string; customer_phone: string }[];
  assert.equal(h.reason_category, 'payment_dispute');
  assert.equal(h.status, 'open');
  const conv = db.prepare('SELECT status, handover_reason FROM conversation WHERE customer_phone = ?').get('+2348031234567')!;
  assert.equal(conv.status, 'handover');
});
