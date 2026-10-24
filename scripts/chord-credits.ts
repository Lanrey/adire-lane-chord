// Free read of the credit position (specs/06 R-2.5).
import { chord, creditBalance, env, log } from './chord.ts';
import { readLedger, estimatedTurnCost } from './ledger.ts';

const WS = env('CHORD_WORKSPACE_ID');
const FLOOR = Number(process.env.CHORD_CREDIT_FLOOR ?? 30);
const balance = await creditBalance(WS);
const usage = await chord<{ debited_credits?: number; request_count?: number; total_tokens?: number }>('GET', '/v1/usage');
const ledger = readLedger();
log('credits', `balance ${balance ?? '?'} · debited ${usage.debited_credits ?? 0} · requests ${usage.request_count ?? 0} · tokens ${usage.total_tokens ?? 0}`);
log('credits', `reviewer floor ${FLOOR} → spendable now ${balance === null ? '?' : Math.max(0, balance - FLOOR).toFixed(2)} (~${balance === null ? '?' : Math.floor(Math.max(0, balance - FLOOR) / estimatedTurnCost())} turns at ${estimatedTurnCost().toFixed(2)}/turn)`);
for (const e of ledger) console.log(`  ${e.at}  cost ${e.cost ?? '?'}  tools [${e.tools.join(', ')}]  ${e.text.slice(0, 60)}`);
