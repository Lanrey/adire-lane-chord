// One-command reset before a recording: re-seed orders/stock/waitlists on the live backend (free).
//   npm --prefix server run demo:reset
import { env, log } from './chord.ts';
const base = env('PUBLIC_BASE_URL').replace(/\/+$/, '');
const res = await fetch(`${base}/admin/reset-demo`, { method: 'POST', headers: { Authorization: `Bearer ${env('ADMIN_TOKEN')}` } });
if (!res.ok) throw new Error(`reset failed: HTTP ${res.status}`);
const health = await (await fetch(`${base}/healthz`)).json();
log('demo', `reset done · payment_mode=${(health as { payment_mode: string }).payment_mode} · open ${base}/admin and a NEW simulator conversation`);
