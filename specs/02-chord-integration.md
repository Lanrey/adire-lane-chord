# 02 — Chord integration spec (API research and terminology)

Source: https://api.chordhq.xyz/docs (mirrored at tsg-labs.github.io/docs), read
2026-10-23. The PRD §8 says not to assume endpoint names, so every endpoint below
was taken from the docs. Anything still **unverified against a live key** is
marked ⚠ and must be confirmed during setup (PRD §10, 00:00–00:30).

## Terminology map (PRD → Chord)

| PRD term | Chord term | Notes |
|----------|-----------|-------|
| "Chord agent / teammate" | **Teammate** (`tm-…`) | Has persona, skills, knowledge bundles, tool scope, MCP servers, channels, autonomy and confidence threshold |
| Business / tenant | **Tenant** (implied by the API key) → **Workspace** (`ws-…`) | We use one dev workspace |
| Sales instructions | **Skill** (SKILL.md entrypoint plus reference files) | Must be **published** and **included**. Drafts never reach live replies |
| Business tools | **Remote MCP server** (`mcp-…`), Streamable HTTP | Chord is the MCP client. Needs a public HTTPS URL. Private/loopback URLs are blocked |
| Conversation | **Thread** (`thread_id`) and **turns** | Keyed by `sender_id` + `session_id` within a workspace |
| Simulator session | **Partner external chat** conversation (`pconv_…`) | The TSG WhatsApp simulator (chat.tsglabs.dev) is a separate Chord Connect partner app that calls `/partner/v1/external-chat/messages` |
| Human handover | Built-in tool **`handover_to_human`** → thread `control_state` `agent_active → human_active` | Only offered on thread-bound turns (all external-chat turns qualify). Fires the `conversation.escalated` webhook and an escalation email |
| Escalation conditions | **Escalation triggers** = procedures tagged `escalation` | Stored escalation rules are switched off by default (`400 ESCALATION_RULES_DEPRECATED`). Triggers are the documented path, but skill teammates reject them (see Live verification), so we escalate from the skill |
| Payment connector | Built-in connector tool type `paystack` | **Not used.** We need payment tied atomically to stock reservation in our own backend (constitution §3–4) |

## How a simulator message reaches our backend

```
WhatsApp simulator (chat.tsglabs.dev)
   │  POST /partner/v1/external-chat/messages  (Chord Connect OAuth, simulator owns this)
   ▼
Chord teammate "Adire Lane Sales"
   │  reads published skill  adire-lane-sales/SKILL.md (+ references via cognition__skill_read_file)
   │  calls MCP tools over Streamable HTTP, Authorization: Bearer $MCP_TOKEN
   ▼
Our commerce backend  https://<public-host>/mcp      ← this repo (server/)
   │  SQLite (node:sqlite) – catalogue, offers, orders, payments, handovers
   ├─ /pay/:ref  → Paystack test checkout (if sk_test_ key) or labelled simulated checkout
   ├─ /webhooks/paystack  (HMAC-SHA512 verified)
   └─ /admin, /admin/*   (owner endpoints + dashboard, ADMIN_TOKEN)
```

We do **not** build a chat UI or message transport (PRD §12). The simulator is the
channel.

## Endpoints we call (setup only, `scripts/chord-setup.ts`)

| Step | Method & path | Scope | Notes |
|------|---------------|-------|-------|
| Verify key / find teammate | `GET /v1/teammates?workspace_id=` | `teammate:read` | Returns a bare array; fields are omitted when empty |
| Register MCP server | `POST /v1/workspaces/{ws}/mcp-servers` `{name,url,auth_type:"bearer",auth_token,transport:"streamable_http",enabled:false}` | `mcp:create` | `201` → `mcp-…`. `409` if the name collides |
| Scope to teammate | `PUT /v1/teammates/{tm}` `{add_mcp_server_ids:[id]}` | `teammate:update` | An empty list means *all* servers, not none |
| Enable + allowlist tools | `PUT /v1/workspaces/{ws}/mcp-servers/{id}` `{enabled:true, enabled_tools:[…]}` | `mcp:manage` | Discovery/health need the server **enabled** to send the bearer token |
| Discover tools | `POST …/mcp-servers/{id}/tools` (no body) | `mcp:read` | Returns the unfiltered remote list |
| Health | `POST …/mcp-servers/{id}/health` | `mcp:read` | **Check `status` even on HTTP 200** |
| Create skill | `POST /v1/teammates/{tm}/skills` `{name,entrypoint,files[],idempotency_key}` | `teammate:update` | Creates a draft only |
| Publish skill | `POST /v1/teammates/{tm}/skills/{id}/publish` `{expected_version,summary,idempotency_key}` | `teammate:update` | `version` is the CAS token. On `409`, reload |
| Escalation triggers | `POST /v1/procedures` `{title,text,tags:["escalation"],owner_id,workspace_id}` then `POST /v1/procedures/{id}/teammates/{tm}?expected_version=1` | `procedure:create/update` | Live immediately |
| Escalation email | `PUT /v1/teammates/{tm}/escalation-notifications` `{notify_to}` | `teammate:update` | Optional |
| Smoke test | `POST /v1/external-chat/messages` `{workspace_id,teammate_id,sender_id,session_id,text}` | `orchestrator:chat` | Inspect `steps[].tool_name/success` to prove a tool ran |

Skill limits that affect the design: entrypoints can be `.md`/`.txt`; references can be
`.md/.txt/.json/.yaml/.csv`; packages are ≤64 files and 256 KiB; included entrypoints share a
64,000-character budget. → SKILL.md stays short and detail goes into `references/`.

## MCP server contract we must satisfy

- Streamable HTTP, `POST /mcp`, JSON-RPC. We run in **stateless** mode (a new transport per
  request, `sessionIdGenerator: undefined`) and answer with JSON (`enableJsonResponse`).
  Chord accepts JSON or SSE.
- `auth_type: "bearer"` → Chord sends `Authorization: Bearer <auth_token>`. We compare it
  in constant time against `MCP_TOKEN`.
- Tool names must be stable. They are allowlisted by exact name in `enabled_tools`.
- Tool results: JSON in a `text` content block plus `structuredContent`. Business failures
  return `ok:false` (not `isError`), so the model can explain them (CR-10).

## Known unknowns / risks (⚠ verify live)

1. ⚠ **External-customer tool restrictions.** The partner chat doc says simulator chats
   "retain the external-customer tool restrictions". It does not say whether workspace
   MCP tools count as restricted. *Check:* send a simulator message that must call
   `search_products` and look at the thread's steps. *Fallback:* test through
   `POST /v1/external-chat/messages` and record this in the field notes.
2. ⚠ Is the workspace MCP setting enabled? The doc says "ask its administrator if it was
   switched off".
3. ⚠ Our API key's scopes. `mcp:*`, `procedure:*` and `teammate:update` are outside the
   default integration profiles. If any are missing, do that step in the Chord app UI
   (Teammate settings → Tools; Skills panel upload) and record it in the field notes.
4. ⚠ Does the teammate pass the simulator's customer phone into tool arguments? It can't
   read hidden context, so the skill asks the customer for a phone number. That number
   is our conversation key.
5. ⚠ Credit budget is 50 credits. Iterate on tool logic with automated tests, not the model.

## Live verification (iteration 2, 2026-10-23)

Each ⚠ above has been resolved against the live API with the integration key:

| Risk | Outcome |
|------|---------|
| ⚠1 MCP tools on external chats | **Works** on `/v1/external-chat/messages` (tool steps `mcp__Adire_Lane_Commerce__*`). Simulator path still to confirm |
| ⚠2 Workspace MCP setting | Enabled. Registration, discovery and health all OK (17–21 ms) |
| ⚠3 Key scopes | Sufficient for teammate create/update/lifecycle, MCP CRUD/probes, skills, procedures, credits and usage reads |
| ⚠4 Customer phone in tool args | The skill asks for it. The model passes it through correctly |
| ⚠5 Credits | Measured ~0.11/turn. See `06-rate-limits-and-credits.md` |

Contract corrections discovered live (also in `docs/field-notes.md`):
- `POST /v1/procedures` with `owner_id` → `500 INTERNAL`. Create without it, then attach.
- Teammates using **skills reject procedures** (`409 ABORTED`), so escalation triggers are not
  available. Escalation is driven by the skill + `handover_to_human` (verified: thread → `human_active`).
- API-created teammates start with `skills.enabled: false`. `POST …/skills/migrate` enables them.
- MCP tools with **nested-object inputs failed validation 5/5**, so tool contracts are flat (spec 04 T-7).
- A new `session_id` for the same `sender_id` reused the existing thread.
- Handover turns return `reply: null, thread_id: null, steps: []` but are billed. Read the thread instead.

Live identifiers (non-secret): workspace `ws-0dc5a492-ee1a-4217-aa38-f8430e472d35`,
teammate "Adire Lane Sales" `4906e7fa-9170-45e4-983a-ed7398d87cd7`,
MCP server `mcp-2b26ab4b-d47f-46c8-b6f6-ddc48fbf8ce5` → `https://adire-lane-tsg.fly.dev/mcp`.
- **Outbound payment-link guard (undocumented):** on WhatsApp/simulator delivery, replies containing a
  payment link that didn't come from Chord's booking tools are blocked. MCP-returned links are not
  trusted. The API path and thread history don't show the block. See field note 4. Constitution §7
  is unaffected; constitution §3 (trusted payment events) still holds via the admin test event.
- **Payments (live 2026-10-24):** the Paystack connector session needs `paystack_secret_key` +
  `webhook_secret`. The agent's built-in tool is `initialize_transaction`, which returns a
  `checkout.paystack.com` link that passes the link guard. Default thresholds were changed:
  `initialize_transaction` confirmation > ₦100k, `process_refund` human approval for any amount.
  Confirmation comes from verifying with Paystack directly (spec 03 D11).
