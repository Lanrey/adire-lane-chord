// Billable end-to-end check through POST /v1/external-chat/messages (specs/06 R-2).
//   npm --prefix server run chord:smoke -- "message 1" ["message 2" …] [--yes] [--session <id>]
// Guards: refuses to dip below CHORD_CREDIT_FLOOR (default 30), default 1 turn,
// >3 turns need --yes, every send carries a message_id so retries are never charged twice.
import { randomUUID } from 'node:crypto';
import { chord, creditBalance, env, log, warn } from './chord.ts';
import { appendLedger, estimatedTurnCost } from './ledger.ts';

type Step = { title?: string; tool_name?: string; success?: boolean; latency_ms?: number; instruction?: string; result?: string; structured?: unknown; structured_type?: string };
type ChatResponse = { thread_id: string | null; reply: string | null; agent_invoked: boolean; reason: string | null; steps: Step[] | null; recommended_action?: string };

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const valueOf = (n: string) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
const valueIdx = new Set(['--session', '--sender'].map((n) => argv.indexOf(n)).filter((i) => i >= 0).map((i) => i + 1));
const session = valueOf('--session') ?? randomUUID();
const sender = valueOf('--sender') ?? 'smoke-test-customer';
const turns = argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const messages = turns.length ? turns : ['Hi, do you have TS-104 in 3XL?'];
const WS = env('CHORD_WORKSPACE_ID');
const TM = env('CHORD_TEAMMATE_ID');
const FLOOR = Number(process.env.CHORD_CREDIT_FLOOR ?? 30);

if (messages.length > 3 && !flag('--yes')) {
  warn('budget', `${messages.length} turns requested; re-run with --yes to confirm.`);
  process.exit(2);
}

let balance = await creditBalance(WS);
const est = estimatedTurnCost();
log('budget', `balance ${balance ?? '?'} credits · est ${est.toFixed(2)}/turn · projected ${(est * messages.length).toFixed(2)} · floor ${FLOOR}`);

for (const text of messages) {
  if (balance !== null && balance - est < FLOOR) {
    warn('budget', `Stopping: sending would take the balance below the ${FLOOR}-credit reviewer reserve.`);
    break;
  }
  const messageId = randomUUID();
  const before = balance;
  const r = await chord<ChatResponse>('POST', '/v1/external-chat/messages', {
    workspace_id: WS, teammate_id: TM, sender_id: sender, session_id: session,
    message_id: messageId, display_name: 'Smoke Test', text,
  }, { idempotent: true }); // message_id dedupes retries (R-1.5)
  balance = await creditBalance(WS);
  const cost = before !== null && balance !== null ? +(before - balance).toFixed(4) : null;
  const tools = (r.steps ?? []).map((s) => `${s.tool_name ?? s.title}${s.success === false ? '✗' : ''}`);
  appendLedger({ at: new Date().toISOString(), message_id: messageId, session_id: session, thread_id: r.thread_id, text, balance_before: before, balance_after: balance, cost, tools, agent_invoked: r.agent_invoked });

  console.log(`\n> ${text}`);
  console.log(`< ${r.reply ?? `(no reply: ${r.reason})`}`);
  for (const s of r.steps ?? []) {
    console.log(`   · ${s.tool_name ?? s.title} ${s.success === false ? '✗' : '✓'} ${s.latency_ms ?? ''}ms`);
    if (flag('--verbose') && !s.tool_name?.startsWith('mcp__')) {
      console.log(`       instruction: ${String(s.instruction ?? '').slice(0, 600)}`);
      console.log(`       result: ${String(s.result ?? '').slice(0, 600)}`);
      if (s.structured) console.log(`       structured(${s.structured_type}): ${JSON.stringify(s.structured).slice(0, 600)}`);
    }
  }
  if (r.recommended_action) console.log(`   recommended_action: ${r.recommended_action}`);
  console.log(`   thread ${r.thread_id} · cost ${cost ?? '?'} · balance ${balance ?? '?'}`);
}
log('session', `${session} · sender ${sender}  (pass --session ${session} --sender ${sender} to continue)`);
