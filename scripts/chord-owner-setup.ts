// specs/08 I-3: a second Chord teammate that briefs the owner every evening.
// Separate MCP server (/mcp/owner, OWNER_MCP_TOKEN) so customer chats can never reach owner data.
// Management calls only (0 credits). The daily run costs ~0.1 credit.
import { chord, env, log, warn } from './chord.ts';

const WS = env('CHORD_WORKSPACE_ID');
const SALES_TM = env('CHORD_TEAMMATE_ID');
const OWNER_TOKEN = env('OWNER_MCP_TOKEN');
const url = env('PUBLIC_BASE_URL').replace(/\/+$/, '') + '/mcp/owner';
const ws = encodeURIComponent(WS);
const NAME = 'Adire Lane Owner Brief';
const SERVER = 'Adire Lane Owner';

const PERSONA = `You are Kemi's back-office assistant for Adire Lane, a streetwear boutique in Yaba, Lagos.
You never talk to customers. You help Kemi run the shop by chat.
- Daily brief or "how did we do?": call get_owner_brief and reply in at most 7 short WhatsApp-style
  lines: money in; assistant impact (after-hours sales, sales recovered by follow-ups, restock-list sales);
  orders waiting or expired; what needs her; missed demand with ONE concrete suggestion; low stock.
- Changes ("set XL to 5", "make TS-104 floor 14k", "TS-105 is now negotiable, min 13k", "close HO-…"):
  use update_stock / set_price_rules / resolve_handover. These need Kemi's owner PIN. Ask for it
  each time and never repeat it back. If the request is ambiguous (which size? which product?), ask one
  short question first. After a change, report exactly what changed (before → after), and for a
  restock, how many waiting customers were messaged.
- To see what needs her: list_open_handovers (also needs the PIN).
Use only numbers from the tools. If a tool fails, say what failed and that nothing changed.`;

type Tm = { id: string; display_name?: string; mcp_server_ids?: string[]; lifecycle_state?: string };
const teammates = await chord<Tm[]>('GET', `/v1/teammates?workspace_id=${ws}`);
let owner = teammates.find((t) => t.display_name === NAME);
if (!owner) {
  owner = await chord<Tm>('POST', '/v1/teammates', {
    email: 'owner-brief@adirelane.example', first_name: 'Adire Lane', last_name: 'Owner Brief', display_name: NAME,
    role: 'analyst', persona: PERSONA, workspace_id: WS, start_paused: true, creation_request_id: 'adire-lane-owner-brief-v1',
  }, { idempotent: true });
  log('owner', `created teammate ${owner.id}`);
} else {
  await chord('PUT', `/v1/teammates/${owner.id}`, { persona: PERSONA });
  log('owner', `teammate ${owner.id} exists (persona updated)`);
}

type Srv = { id: string; name: string };
const base = `/v1/workspaces/${ws}/mcp-servers`;
let srv = (await chord<Srv[]>('GET', base)).find((s) => s.name === SERVER);
if (!srv) {
  srv = await chord<Srv>('POST', base, { name: SERVER, url, auth_type: 'bearer', auth_token: OWNER_TOKEN, transport: 'streamable_http', enabled: false }, { idempotent: false });
  log('owner', `registered MCP ${srv.id} (disabled)`);
} else await chord('PUT', `${base}/${srv.id}`, { url, auth_type: 'bearer', auth_token: OWNER_TOKEN });

// Scope BEFORE enabling: owner teammate → owner server only; sales teammate must not include it.
await chord('PUT', `/v1/teammates/${owner.id}`, { set_mcp_server_ids: [srv.id] });
const sales = await chord<Tm>('GET', `/v1/teammates/${encodeURIComponent(SALES_TM)}`);
if (!sales.mcp_server_ids?.length) throw new Error('Sales teammate has an EMPTY MCP assignment (= all servers). Run chord:setup first so it is pinned to the sales server.');
if (sales.mcp_server_ids.includes(srv.id)) await chord('PUT', `/v1/teammates/${encodeURIComponent(SALES_TM)}`, { remove_mcp_server_ids: [srv.id] });
log('owner', `sales teammate pinned to ${JSON.stringify(sales.mcp_server_ids)}; owner teammate pinned to ["${srv.id}"]`);

const others = teammates.filter((t) => t.id !== owner!.id && t.id !== SALES_TM && !(t.mcp_server_ids?.length));
if (others.length) warn('owner', `Teammate(s) ${others.map((t) => t.display_name).join(', ')} have an empty MCP assignment, which Chord treats as ALL enabled servers (incl. this owner server). Pin them or accept the exposure. See field notes.`);

const OWNER_TOOLS = ['get_owner_brief', 'update_stock', 'set_price_rules', 'list_open_handovers', 'resolve_handover'];
await chord('PUT', `${base}/${srv.id}`, { enabled: true, enabled_tools: OWNER_TOOLS });
const tools = await chord<{ name: string }[]>('POST', `${base}/${srv.id}/tools`, undefined, { idempotent: true });
const health = await chord<{ status: string; latency_ms?: number }>('POST', `${base}/${srv.id}/health`, undefined, { idempotent: true });
if (health.status !== 'ok') throw new Error(`owner MCP health ${JSON.stringify(health)}`);
log('owner', `tools ${tools.map((t) => t.name).join(', ')} · health ok ${health.latency_ms ?? '?'}ms`);

await chord('POST', `/v1/teammates/${owner.id}/lifecycle`, { action: 'activate' }, { idempotent: true });

type Schedule = { id: string; name: string };
const schedules = await chord<Schedule[]>('GET', `/v1/teammates/${owner.id}/schedules`);
if (!schedules.find((s) => s.name === 'Evening brief')) {
  const s = await chord<Schedule>('POST', `/v1/teammates/${owner.id}/schedules`, {
    name: 'Evening brief',
    task_prompt: "Prepare today's Adire Lane brief for Kemi (call get_owner_brief).",
    cadence: { type: 'DAILY', time_of_day: '20:00', timezone: 'Africa/Lagos' },
    enabled: true,
    workspace_id: WS,
  }, { idempotent: false });
  log('owner', `schedule ${s.id}: daily 20:00 Africa/Lagos`);
} else log('owner', 'schedule exists');
if (process.env.ESCALATION_EMAIL) {
  await chord('PUT', `/v1/teammates/${encodeURIComponent(SALES_TM)}/escalation-notifications`, { notify_to: process.env.ESCALATION_EMAIL, workspace_id: WS });
  log('owner', `handover emails → ${process.env.ESCALATION_EMAIL}`);
}
log('done', `Owner teammate ${owner.id}. Test once (≈0.1 credit): POST /v1/teammates/${owner.id}/schedules/<id>/run`);
