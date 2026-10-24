// Proactive customer updates via Chord scheduled MESSAGE tasks (specs/08 I-1, I-4).
// Free (no model run). Finds the customer's thread by the reference the agent quoted to them.
import type { DB } from './db.ts';
import { now } from './db.ts';
import type { ChordApi } from './chordApi.ts';
import { getOrderRow, orderItems, businessInfo } from './orders.ts';
import { formatNaira } from './money.ts';

type Thread = { id: string; teammate_id?: string; control_state?: string; channel_id?: string; metadata?: { partner_chat?: { sender_id?: string } }; channel_participant_id?: string };
export type NotifyKind = 'payment_received' | 'payment_failed' | 'hold_reminder' | 'restock';
export type NotifyResult = { status: 'sent' | 'skipped' | 'failed' | 'duplicate'; detail?: string; thread_id?: string };

const MAX_ATTEMPTS = 3;

export class Notifier {
  db: DB;
  api: ChordApi;
  constructor(db: DB, api: ChordApi) {
    this.db = db;
    this.api = api;
  }

  /** The thread where our teammate quoted `ref`, or null. */
  async findThread(ref: string): Promise<Thread | null> {
    const r = await this.api.request<{ threads?: Thread[]; items?: Thread[] }>('GET', `/v1/threads?workspace_id=${this.api.ws}&q=${encodeURIComponent(ref)}&limit=5`);
    const list = r.threads ?? r.items ?? [];
    const mine = list.find((t) => t.teammate_id === this.api.cfg.teammateId);
    if (!mine) return null;
    return await this.api.request<Thread>('GET', `/v1/threads/${encodeURIComponent(mine.id)}`);
  }

  async send(ref: string, kind: NotifyKind, body: string): Promise<NotifyResult> {
    const key = `${ref}:${kind}`;
    const prev = this.db.prepare('SELECT status, attempts FROM notification WHERE key = ?').get(key) as { status: string; attempts: number } | undefined;
    if (prev && (prev.status !== 'failed' || prev.attempts >= MAX_ATTEMPTS)) return { status: 'duplicate', detail: prev.status };
    const record = (status: 'sent' | 'skipped' | 'failed', detail: string, threadId?: string, taskId?: string) => {
      this.db.prepare(
        `INSERT INTO notification (key, ref, kind, thread_id, task_id, status, detail, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status, detail = excluded.detail, thread_id = COALESCE(excluded.thread_id, thread_id),
           task_id = COALESCE(excluded.task_id, task_id), attempts = attempts + 1, updated_at = excluded.updated_at`,
      ).run(key, ref, kind, threadId ?? null, taskId ?? null, status, detail, now());
      console.log(JSON.stringify({ evt: 'notify', ref, kind, status, detail }));
      return { status, detail, thread_id: threadId };
    };
    try {
      const thread = await this.findThread(ref);
      if (!thread) return record('failed', 'thread_not_found');
      // Never talk over a human (docs: scheduled sends go out even during a takeover).
      if (thread.control_state && thread.control_state !== 'agent_active') return record('skipped', `control_state=${thread.control_state}`, thread.id);
      const task = await this.api.request<{ id: string }>('POST', '/v1/scheduled-tasks', {
        task_type: 'MESSAGE',
        scheduled_at: new Date(now() + 5_000).toISOString(),
        workspace_id: this.api.cfg.workspaceId,
        teammate_id: this.api.cfg.teammateId,
        max_retries: 3,
        payload: { platform: 'DIRECT_LINE', conversation_id: thread.id, body },
      });
      return record('sent', 'queued', thread.id, task.id);
    } catch (err) {
      return record('failed', (err as Error).message.slice(0, 200));
    }
  }

  // ------------------------------------------------------------- message templates
  // specs/10: plain, warm, no codes except the order number, no links (WhatsApp link guard).

  /** "your Adire Print tee (black, size 2XL)" — product name without the code-ish suffixes. */
  itemWords(ref: string): string {
    const o = getOrderRow(this.db, ref);
    if (!o) return 'your order';
    const parts = orderItems(this.db, o.id).map((i) => {
      const short = i.name.replace(/^Oversized (Graphic )?T-shirt\s*–\s*/i, '').replace(/\s*\((.*?)\)\s*$/, '');
      const kind = i.item_type === 'service' ? '' : /sneaker/i.test(i.name) ? ' sneakers' : ' tee';
      const attrs = JSON.parse(i.attributes_json || '{}') as Record<string, string>;
      const size = attrs.size ? `size ${attrs.size}` : '';
      const colour = attrs.colour ?? '';
      const detail = [colour, size].filter(Boolean).join(', ');
      const qty = i.quantity > 1 ? `${i.quantity} ` : '';
      return `${qty}${short}${kind}${detail ? ` (${detail})` : ''}`;
    });
    return `your ${parts.join(' and ')}`;
  }

  async paymentReceived(ref: string) {
    const o = getOrderRow(this.db, ref);
    if (!o) return { status: 'failed', detail: 'no order' } as NotifyResult;
    const info = businessInfo(this.db);
    const next = o.fulfilment_method === 'delivery'
      ? `We'll deliver it ${info.delivery_zones.find((z) => z.zone === o.delivery_zone)?.eta ?? 'soon'}.`
      : `You can pick it up at ${info.pickup_address}, ${info.opening_hours}.`;
    const r = await this.send(ref, 'payment_received', `Thank you! 🎉 We've received your payment of ${formatNaira(o.total)} for ${this.itemWords(ref)}. ${next} Your order number is ${ref}.`);
    if (r.status === 'sent') void this.rememberPurchase(ref, r.thread_id!);
    return r;
  }

  paymentFailed(ref: string, reason: string) {
    return this.send(ref, 'payment_failed', `Sorry, your payment for ${this.itemWords(ref)} didn't go through (${reason}). Don't worry, you haven't been charged and we're still holding it for you. Just reply "pay" and I'll send you a new payment link.`);
  }

  holdReminder(ref: string, minutesLeft: number) {
    const o = getOrderRow(this.db, ref);
    return this.send(ref, 'hold_reminder', `Hi! Just a reminder that we're holding ${this.itemWords(ref)}${o ? ` (${formatNaira(o.total)})` : ''} for about ${minutesLeft} more minutes. Reply "pay" if you'd like the payment link again.`);
  }

  restock(waitlistRef: string, productName: string, attrs: string) {
    const short = productName.replace(/^Oversized (Graphic )?T-shirt\s*–\s*/i, '').replace(/\s*\((.*?)\)\s*$/, '');
    return this.send(waitlistRef, 'restock', `Good news! 🎉 The ${short} in ${attrs} you asked about is back in stock. Reply "yes" and I'll hold one for you.`);
  }

  /** I-4: best-effort purchase memory so repeat customers get "same size as last time?". */
  async rememberPurchase(ref: string, threadId: string) {
    try {
      const o = getOrderRow(this.db, ref);
      if (!o) return;
      const thread = await this.api.request<Thread>('GET', `/v1/threads/${encodeURIComponent(threadId)}`);
      const customerId = thread.metadata?.partner_chat?.sender_id ?? thread.channel_participant_id;
      if (!customerId) return;
      const date = new Date(o.paid_at ?? now()).toISOString().slice(0, 10);
      for (const i of orderItems(this.db, o.id)) {
        await this.api.request('POST', `/v1/workspaces/${this.api.ws}/teammates/${this.api.tm}/memories`, {
          customer_id: customerId,
          content: `Bought ${i.name}, ${i.sku}, on ${date} for ${formatNaira(i.agreed_unit_price)} each (order ${ref})`,
          source: 'adire-lane-orders',
        });
      }
      console.log(JSON.stringify({ evt: 'memory_written', ref }));
    } catch (err) {
      console.error(JSON.stringify({ evt: 'memory_failed', ref, message: (err as Error).message }));
    }
  }
}
