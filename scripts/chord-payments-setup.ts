// specs/07 P-1 + P-6: connect Paystack (TEST key) to the workspace and register our booking webhook.
//   PAYSTACK_SECRET_KEY=sk_test_… CHORD_WEBHOOK_SECRET=whsec_… npm --prefix server run chord:payments
// Management calls only (0 credits). The Paystack key is sent to Chord and never written to disk.
import { chord, ChordError, env, log, warn } from './chord.ts';

const WS = env('CHORD_WORKSPACE_ID');
const TM = env('CHORD_TEAMMATE_ID');
const key = env('PAYSTACK_SECRET_KEY');
if (!key.startsWith('sk_test_')) throw new Error('Refusing: PAYSTACK_SECRET_KEY must be a TEST key (sk_test_…).');
const hookSecret = env('CHORD_WEBHOOK_SECRET');
const hookUrl = env('PUBLIC_BASE_URL').replace(/\/+$/, '') + '/webhooks/chord';
const EVENTS = ['booking.confirmed', 'booking.payment_failed', 'booking.payment_mismatch', 'booking.payment_late', 'conversation.escalated'];
const ws = encodeURIComponent(WS);

// 1. Paystack connector session (form field verified live: paystack_secret_key)
type Session = { public_id?: string; id?: string; status?: string };
const sessions = await chord<Session[]>('GET', `/v1/workspaces/${ws}/connectors/paystack/sessions`);
let session = sessions[0];
if (session) log('paystack', `already connected (${session.public_id ?? session.id})`);
else {
  // Fields verified live: paystack_secret_key + webhook_secret (400s name one missing field at a time).
  // Paystack signs webhooks (x-paystack-signature, HMAC-SHA512) with the account secret key itself,
  // so the webhook secret Chord needs to verify them is that same key.
  session = await chord<Session>('POST', `/v1/workspaces/${ws}/connectors/paystack/sessions`,
    { paystack_secret_key: key, webhook_secret: key, teammate_id: TM }, { idempotent: false });
  log('paystack', `connected (${session.public_id ?? session.id})`);
}
const sid = session.public_id ?? session.id;
if (sid) {
  try {
    const t = await chord<Record<string, unknown>>('POST', `/v1/workspaces/${ws}/connectors/paystack/sessions/${sid}/test`, undefined, { idempotent: true });
    log('paystack', `health: ${JSON.stringify(t).slice(0, 200)}`);
  } catch (e) { warn('paystack', `session test failed: ${(e as Error).message}`); }
}

// 2. Tool scope: connector tools are the intersection of workspace-enabled connectors and the teammate scope.
const scope = await chord<{ enabled_tool_types: string[]; unscoped: boolean }>('GET', `/v1/teammates/${encodeURIComponent(TM)}/tools`);
log('tools', `teammate scope: ${JSON.stringify(scope)} (unscoped=true → all workspace connectors, incl. bookings/paystack)`);
const connectors = await chord<{ type: string; enabled: boolean }[]>('GET', `/v1/workspaces/${ws}/connectors`);
log('tools', `workspace connectors enabled: ${connectors.filter((c) => c.enabled).map((c) => c.type).join(', ') || 'none'}`);

// 3. Webhook registration (dedupe by URL)
type Hook = { id: string; url: string; events: string[] };
const hooks = await chord<Hook[]>('GET', '/v1/webhooks');
let hook = hooks.find((h) => h.url === hookUrl);
if (!hook) {
  hook = await chord<Hook>('POST', '/v1/webhooks', { url: hookUrl, events: EVENTS, secret: hookSecret }, { idempotent: false });
  log('webhook', `registered ${hook.id} → ${hookUrl}`);
} else log('webhook', `already registered ${hook.id}`);
try {
  await chord('POST', `/v1/webhooks/${hook.id}/test`, undefined, { idempotent: true });
  log('webhook', 'test delivery sent — check `fly logs | grep chord_webhook` for outcome ignored_event_type');
} catch (e) {
  if (e instanceof ChordError) warn('webhook', e.message); else throw e;
}
log('done', 'Next: fly secrets set PAYMENT_MODE=chord … (see README), then republish the skill');
