// Local record of billable turns (specs/06 R-2.2). Gitignored.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type LedgerEntry = {
  at: string; message_id: string; session_id: string; thread_id: string | null; text: string;
  balance_before: number | null; balance_after: number | null; cost: number | null;
  tools: string[]; agent_invoked: boolean;
};

const FILE = new URL('../.chord-ledger.json', import.meta.url).pathname;

export function readLedger(): LedgerEntry[] {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as LedgerEntry[]) : [];
}

export function appendLedger(e: LedgerEntry): void {
  writeFileSync(FILE, JSON.stringify([...readLedger(), e], null, 2));
}

/** Average measured cost per turn, defaulting to 1 credit until measured. */
export function estimatedTurnCost(): number {
  const costs = readLedger().map((e) => e.cost).filter((c): c is number => typeof c === 'number' && c > 0);
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 1;
}
