// Wire the Adire Lane backend + skill into a Chord teammate. Safe to re-run.
//   npm --prefix server run chord:setup [-- --skip-skill] [--skip-mcp] [--with-triggers]
// Every step that needs a scope outside the default integration profile reports a clear
// fallback (do it in the Chord app) instead of aborting the rest.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync as readText } from 'node:fs';
import { chord, ChordError, env, log, requestCount, warn } from './chord.ts';

const args = new Set(process.argv.slice(2));
const WS = env('CHORD_WORKSPACE_ID');
let TM = process.env.CHORD_TEAMMATE_ID?.trim() ?? '';
const ENV_FILE = new URL('../.env', import.meta.url).pathname;
const TEAMMATE_NAME = 'Adire Lane Sales';
const MCP_NAME = 'Adire Lane Commerce';
const EXPECTED_TOOLS = [
  'get_business_info', 'search_products', 'get_product_details', 'check_stock',
  'calculate_offer', 'create_pending_order', 'get_payment_status', 'request_human_handover',
  'notify_me_when_available', 'cancel_order',
];
const SKILL_DIR = new URL('../skill/adire-lane-sales/', import.meta.url).pathname;

type Teammate = { id: string; display_name?: string; workspace_id?: string; mcp_server_ids?: string[]; lifecycle_state?: string };
type McpServer = { id: string; name: string; url: string; enabled?: boolean };

const fallback = (step: string, err: unknown, manual: string) => {
  if (err instanceof ChordError && (err.status === 403 || err.status === 401)) {
    warn(step, `${err.message}\n    → Key lacks the scope. Manual fallback: ${manual}`);
    return;
  }
  throw err;
};

/** Find or create the dedicated teammate (created paused; activated at the end). Free: no model work. */
async function ensureTeammate(): Promise<Teammate> {
  const list = await chord<Teammate[]>('GET', `/v1/teammates?workspace_id=${encodeURIComponent(WS)}`);
  let tm = TM ? list.find((t) => t.id === TM) : list.find((t) => t.display_name === TEAMMATE_NAME);
  if (TM && !tm) throw new Error(`Teammate ${TM} not visible in workspace ${WS}. Visible: ${list.map((t) => `${t.id} (${t.display_name})`).join(', ') || 'none'}`);
  if (!tm) {
    tm = await chord<Teammate>('POST', '/v1/teammates', {
      email: 'adire-lane-sales@adirelane.example',
      first_name: 'Adire Lane',
      last_name: 'Sales',
      display_name: TEAMMATE_NAME,
      role: 'sales',
      persona: 'AI sales assistant for Adire Lane, a streetwear boutique in Yaba, Lagos. Follows the adire-lane-sales skill.',
      workspace_id: WS,
      escalation_policy: 'escalate_to_human',
      confidence_threshold: 0.5,
      start_paused: true,
      creation_request_id: 'adire-lane-sales-v1',
    }, { idempotent: true }); // creation_request_id makes the retry safe
    log('teammate', `created ${tm.id} (paused until setup finishes)`);
  }
  TM = tm.id;
  if (!process.env.CHORD_TEAMMATE_ID) {
    const text = readText(ENV_FILE, 'utf8');
    if (/^CHORD_TEAMMATE_ID=\s*$/m.test(text)) {
      writeFileSync(ENV_FILE, text.replace(/^CHORD_TEAMMATE_ID=\s*$/m, `CHORD_TEAMMATE_ID=${TM}`));
    } else if (!/^CHORD_TEAMMATE_ID=/m.test(text)) appendFileSync(ENV_FILE, `\nCHORD_TEAMMATE_ID=${TM}\n`);
    log('teammate', `saved CHORD_TEAMMATE_ID to .env`);
  }
  log('teammate', `${tm.display_name ?? tm.id} · ${tm.lifecycle_state ?? 'state?'} · MCP ids: ${JSON.stringify(tm.mcp_server_ids ?? [])}`);
  return tm;
}

async function activate() {
  const tm = await chord<Teammate>('POST', `/v1/teammates/${encodeURIComponent(TM)}/lifecycle`, { action: 'activate' }, { idempotent: true });
  log('teammate', `lifecycle → ${tm.lifecycle_state}`);
}

async function setupMcp() {
  const url = env('PUBLIC_BASE_URL').replace(/\/+$/, '') + '/mcp';
  if (!url.startsWith('https://')) throw new Error(`PUBLIC_BASE_URL must be public HTTPS for Chord (got ${url})`);
  const token = env('MCP_TOKEN');
  const base = `/v1/workspaces/${encodeURIComponent(WS)}/mcp-servers`;

  const existing = (await chord<McpServer[]>('GET', base)).find((s) => s.name === MCP_NAME);
  let id: string;
  if (existing) {
    id = existing.id;
    await chord('PUT', `${base}/${id}`, { url, auth_type: 'bearer', auth_token: token });
    log('mcp', `updated ${id} → ${url}`);
  } else {
    const created = await chord<McpServer>('POST', base, { name: MCP_NAME, url, auth_type: 'bearer', auth_token: token, transport: 'streamable_http', enabled: false }, { idempotent: false });
    id = created.id;
    log('mcp', `registered ${id} (disabled) → ${url}`);
  }

  // Scope first, then enable (docs: an empty teammate list means "all servers").
  await chord('PUT', `/v1/teammates/${encodeURIComponent(TM)}`, { add_mcp_server_ids: [id] });
  log('mcp', `assigned ${id} to teammate ${TM}`);
  await chord('PUT', `${base}/${id}`, { enabled: true, enabled_tools: EXPECTED_TOOLS });
  log('mcp', `enabled with tool allowlist (${EXPECTED_TOOLS.length})`);

  const tools = await chord<{ name: string }[]>('POST', `${base}/${id}/tools`, undefined, { idempotent: true });
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  log('mcp', `discovered: ${names.join(', ')}`);
  if (missing.length) warn('mcp', `missing tools: ${missing.join(', ')}`);

  const health = await chord<{ status: string; latency_ms?: number; error?: string }>('POST', `${base}/${id}/health`, undefined, { idempotent: true });
  if (health.status !== 'ok') throw new Error(`MCP health probe returned ${JSON.stringify(health)} (HTTP 200 does not mean healthy)`);
  log('mcp', `health ok (${health.latency_ms ?? '?'} ms)`);
}

function readSkillFiles() {
  const files: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: relative(SKILL_DIR, full), content: readFileSync(full, 'utf8') });
    }
  };
  walk(SKILL_DIR);
  return files;
}

type Skill = { id?: string; skill_id?: string; name: string; version: number; published_version?: number };

async function setupSkill() {
  const files = readSkillFiles();
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const body = { name: 'adire-lane-sales', entrypoint: 'SKILL.md', files };
  const base = `/v1/teammates/${encodeURIComponent(TM)}/skills`;

  let current = await chord<{ enabled?: boolean; skills?: Skill[] }>('GET', base);
  if (!current.enabled) {
    // Skills are off on teammates that still use legacy playbooks; /migrate switches them on.
    current = await chord('POST', `${base}/migrate`, {}, { idempotent: true }); // "Repeating after success returns the current set"
    log('skill', `skills enabled on teammate (migrate) → enabled=${current.enabled}`);
  }
  let skill = current.skills?.find((s) => s.name === body.name);
  if (!skill) {
    skill = await chord<Skill>('POST', base, { ...body, idempotency_key: `create-${digest}` }, { idempotent: true });
    log('skill', `created draft (${files.length} files)`);
  } else {
    skill = await chord<Skill>('PUT', `${base}/${skill.id ?? skill.skill_id}/draft`, { ...body, expected_version: skill.version, idempotency_key: `draft-${digest}` });
    log('skill', `saved draft (${files.length} files)`);
  }
  const id = skill.id ?? skill.skill_id;
  const published = await chord<Skill>('POST', `${base}/${id}/publish`, { expected_version: skill.version, summary: `Publish ${digest}`, idempotency_key: `publish-${digest}` }, { idempotent: true });
  log('skill', `published revision ${published.published_version ?? '?'} — remember it must be *included* (default for new skills)`);
}

const TRIGGERS = [
  'The customer asks to speak to a human, the owner Kemi, or customer care.',
  'The customer complains about an order, a delivery, product quality, or service.',
  'The customer asks for a refund, return, or exchange.',
  'The customer disputes a payment, says they were debited without the order being marked paid, or says they paid twice.',
  'The customer insists on a price below the counter-offer the shop tool returned, or asks for a bulk or wholesale price.',
  'The customer mentions a lawyer, the police, a regulator, or threatens to post a bad review.',
];

async function setupTriggers() {
  const skills = await chord<{ enabled?: boolean }>('GET', `/v1/teammates/${encodeURIComponent(TM)}/skills`);
  if (skills.enabled) {
    warn('triggers', 'Skipped: teammate uses skill files, which cannot take procedures (409 ABORTED). Handover is driven by the skill + handover_to_human.');
  } else await createTriggers();
  if (process.env.ESCALATION_EMAIL) {
    await chord('PUT', `/v1/teammates/${encodeURIComponent(TM)}/escalation-notifications`, { notify_to: process.env.ESCALATION_EMAIL, workspace_id: WS });
    log('triggers', `escalation email → ${process.env.ESCALATION_EMAIL}`);
  }
}

async function createTriggers() {
  type Proc = { id: string; text?: string; version?: number; teammate_ids?: string[] };
  // workspace_id lists workspace-scoped + tenant-shared procedures (what the teammate can see).
  const existing = await chord<Proc[]>('GET', `/v1/procedures?workspace_id=${encodeURIComponent(WS)}&tags=escalation&page_size=100`);
  for (const text of TRIGGERS) {
    let p = existing.find((e) => e.text === text);
    if (!p) {
      // NOTE: sending owner_id here returns 500 INTERNAL (field note F-9), so create unowned, then attach.
      p = await chord<Proc>('POST', '/v1/procedures', { title: `Adire Lane handover: ${text.slice(13, 60)}`, text, tags: ['escalation'], workspace_id: WS });
      log('triggers', `created: ${text}`);
    }
    if (p.teammate_ids?.includes(TM)) continue;
    await chord('POST', `/v1/procedures/${p.id}/teammates/${encodeURIComponent(TM)}?expected_version=${p.version ?? 1}`);
    log('triggers', `attached to teammate: ${text}`);
  }
}

await ensureTeammate();
if (!args.has('--skip-mcp')) {
  try { await setupMcp(); } catch (e) { fallback('mcp', e, 'Teammate settings → Tools → Add tool → MCP server: URL $PUBLIC_BASE_URL/mcp, bearer $MCP_TOKEN'); }
}
if (!args.has('--skip-skill')) {
  try { await setupSkill(); } catch (e) { fallback('skill', e, 'Teammate → Skills → upload skill/adire-lane-sales as a folder/ZIP → Review and publish'); }
}
if (args.has('--with-triggers')) {
  try { await setupTriggers(); } catch (e) {
    // Skill-file teammates reject procedure attachment (409 ABORTED, field note F-10): the skill's
    // handover section + built-in handover_to_human cover escalation instead.
    if (e instanceof ChordError && e.status === 409 && /skill files/i.test(JSON.stringify(e.body))) warn('triggers', 'Skipped: teammate uses skill files, which cannot take procedures. Handover is driven by the skill.');
    else fallback('triggers', e, 'Skip: the skill already instructs handover; triggers are belt-and-braces');
  }
}
if (!args.has('--keep-paused')) {
  try { await activate(); } catch (e) { fallback('teammate', e, 'Activate the teammate in the Chord app'); }
}
log('done', `${requestCount} API calls, 0 credits (management calls are not billable). Next: npm --prefix server run chord:smoke`);
