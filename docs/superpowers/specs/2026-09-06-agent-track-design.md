# agent-track — design spec

Date: 2026-09-06
Status: draft for review

## 1. What it is

agent-track is an open-source, self-hosted todo tracker for AI coding agents.
A user deploys one Cloudflare Worker to their own account. Agents (Claude Code,
Codex, Cursor, Gemini CLI, anything that speaks MCP) connect to it as a remote
MCP server and keep per-project task lists there: create tasks, mark them
in progress, blocked, or done, and leave notes. A human watches and edits the
same lists in a web UI served by the same Worker, live.

It replaces nothing inside the agent. Claude Code's built-in todo list is
ephemeral and private to one session. agent-track is for work that spans
sessions, involves more than one agent, or that a human wants to see and steer.

### Goals

- One-command deploy to the user's own Cloudflare account, free tier.
- MCP-only agent interface, so one server works across every MCP client.
- A skill (SKILL.md) that teaches the agent *when* and *how* to track work.
- A pleasant, fast UI: kanban per list, task drawer with notes and history.
- Zero runtime npm dependencies in the Worker. Small enough to audit in an hour.
- Portable install: `npx skills add`, Claude Code plugin, or manual MCP config.

### Non-goals (v1)

- Task dependencies, subtasks, due dates, recurring tasks.
- Multi-tenant accounts or per-user permissions. One token, one deployment.
- OAuth. claude.ai and Claude Desktop custom connectors need OAuth; they are
  out of scope for v1 (documented workaround: `mcp-remote`).
- A CLI. Everything goes through MCP or the UI.

## 2. Architecture

```
┌──────────────┐  MCP over HTTPS (POST /mcp, bearer)   ┌────────────────────────────┐
│ Claude Code  │ ─────────────────────────────────────▶ │ Cloudflare Worker          │
│ Codex, etc.  │                                        │  src/index.ts  (router)    │
└──────────────┘                                        │  src/mcp.ts    (JSON-RPC)  │
                                                        │  src/api.ts    (REST+SSE)  │
┌──────────────┐  GET /  (static)  + /api/* (bearer)    │  src/service.ts (rules)    │
│ Browser UI   │ ─────────────────────────────────────▶ │  src/db.ts     (D1 SQL)    │
│ public/      │ ◀───── SSE /api/events ─────────────── │  public/ (assets binding)  │
└──────────────┘                                        └─────────────┬──────────────┘
                                                                      │ D1 (SQLite)
                                                                      ▼
                                                         lists · tasks · events
```

One Worker, one D1 database, one static folder. Both the MCP tools and the REST
API call the same `service.ts`, so behaviour and validation are identical
whichever door a change comes through.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/index.ts` | Route requests: `/mcp` → mcp, `/api/*` → api, else assets. Apply auth, CORS/Origin check, error → JSON. | mcp, api, auth |
| `src/auth.ts` | Constant-time bearer check against `env.API_TOKEN`. | Web Crypto |
| `src/mcp.ts` | JSON-RPC 2.0 over HTTP. Dual-era: MCP 2026-07-28 (stateless, `server/discover`) and legacy 2025-xx (`initialize`, `ping`). Maps `tools/call` to service functions. | service, tools |
| `src/tools.ts` | Tool definitions: name, description, JSON schema in/out. Single source for `tools/list` and for input validation. | — |
| `src/api.ts` | REST for the UI. Same operations as tools plus SSE change feed. | service |
| `src/service.ts` | Business rules: slugging, status transitions, actor stamping, event log, "ready" query. | db |
| `src/db.ts` | Thin typed D1 helpers and SQL. | D1 binding |
| `migrations/0001_init.sql` | Schema. | — |
| `public/index.html` | The UI. Vanilla JS, no build step. | REST + SSE |
| `skills/agent-track/SKILL.md` | Teaches agents when/how to use the tools. | MCP server |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin packaging. | env vars |

## 3. Data model

```sql
CREATE TABLE lists (
  id          TEXT PRIMARY KEY,          -- time-prefixed random id (base32), generated in Worker
  slug        TEXT NOT NULL UNIQUE,      -- "coinstats-web", derived from name
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  list_id        TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',  -- markdown, free text
  status         TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
  priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4), -- 0 = urgent
  blocked_reason TEXT NOT NULL DEFAULT '',
  assignee       TEXT NOT NULL DEFAULT '',  -- actor who moved it to in_progress
  position       REAL NOT NULL,             -- manual ordering within a status column
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX tasks_list_status ON tasks(list_id, status, position);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id    TEXT NOT NULL,
  task_id    TEXT,                          -- NULL for list-level events
  actor      TEXT NOT NULL,                 -- "claude-code", "codex", "web", ...
  kind       TEXT NOT NULL,                 -- created | status | updated | note | list_created ...
  data       TEXT NOT NULL DEFAULT '{}',    -- JSON: {from, to, reason} or {text} or changed fields
  created_at INTEGER NOT NULL
);
CREATE INDEX events_task ON events(task_id, id);
CREATE INDEX events_list ON events(list_id, id);
```

Rules enforced in `service.ts`:

- **Status transitions.** Any status may move to any other. Moving to
  `in_progress` sets `assignee = actor` if empty. Moving to `blocked` requires a
  non-empty `reason` (stored in `blocked_reason`). Moving to `done` or
  `cancelled` sets `completed_at`; moving away clears it. Leaving `blocked`
  clears `blocked_reason`.
- **Every write appends one event** and bumps `updated_at` on the task and the
  list. Notes are events of kind `note`, not a separate table; the task's
  `notes` field is the long-lived description, `note` events are the running log.
- **Ready** = `status = 'todo'` ordered by priority, then position. This is what
  an agent asks for when it wants the next thing to do.
- **Slug** = lowercase, `[a-z0-9-]`, from the given name. `ensure_list` is
  idempotent on slug, so agents never have to check whether a list exists.
- **Actor** comes from the tool argument `actor` if given, else from the MCP
  client name, else `"agent"`. UI writes use `"web"`.
- **Write budget.** D1 free tier allows 100k row writes a day. One task change
  is 3 row writes (task, list, event). Nothing else writes. No polling writes.

## 4. MCP interface

Endpoint: `POST /mcp`. Auth: `Authorization: Bearer <API_TOKEN>`. Returns
`application/json` (allowed by spec; no SSE needed for request/response tools).
`GET`/`DELETE /mcp` → 405. Unknown method → 404 + `-32601`.

Dual-era dispatch:

- Body has `_meta["io.modelcontextprotocol/protocolVersion"]` → modern
  (2026-07-28): stateless, `server/discover`, results carry `resultType`,
  `ttlMs`, `cacheScope`, `_meta.serverInfo`. Validate `MCP-Protocol-Version`
  header matches; mismatch → 400 + `-32020`.
- Method is `initialize` → legacy: reply with the client's requested version if
  it is one we support (`2025-11-25`, `2025-06-18`, `2025-03-26`), else our
  newest legacy. `notifications/initialized` → 202. `ping` → `{}`. Ignore any
  `Mcp-Session-Id`; never mint one. Missing `Accept` is tolerated.
- Origin: absent → allow; present and not the Worker's own origin or an
  allowlisted origin → 403.

Tools (deterministic order). All take optional `actor: string`.

| Tool | Input | Returns |
|---|---|---|
| `list_lists` | `{ include_archived? }` | lists with open/blocked/done counts |
| `ensure_list` | `{ name, description? }` | the list (created or existing by slug) |
| `list_tasks` | `{ list, status?: string[], ready?: boolean, limit? }` | tasks, ordered |
| `get_task` | `{ id }` | task + last 20 events |
| `add_tasks` | `{ list, tasks: [{ title, notes?, priority? }] }` | created tasks (batch, one D1 batch) |
| `update_task` | `{ id, title?, notes?, priority?, list? }` | task |
| `set_status` | `{ id, status, reason? }` | task. `reason` required for `blocked` |
| `add_note` | `{ id, text }` | the event |
| `get_history` | `{ list?, id?, limit? }` | events, newest first |

`list` arguments accept a slug or a list id. Tool results include
`structuredContent` matching an `outputSchema`, plus the same JSON as a text
block, per spec. Validation failures return `isError: true` with a plain
sentence the agent can act on ("blocked requires a reason").

The `server/discover` / `initialize` `instructions` field carries a two-line
usage hint so clients without the skill still behave sensibly.

## 5. REST API and live updates (UI only)

Same auth header. JSON in/out. Not part of the public contract; the UI is the
only consumer, but it is documented in `references/api.md` for tinkerers.

```
GET    /api/lists                          → lists + counts
POST   /api/lists                          {name, description}
PATCH  /api/lists/:id                      {name?, description?, archived?}
GET    /api/lists/:id/tasks                → tasks (all statuses)
POST   /api/lists/:id/tasks                {title, notes?, priority?}
PATCH  /api/tasks/:id                      {title?, notes?, priority?, status?, reason?, position?}
DELETE /api/tasks/:id                      (soft: status=cancelled)
POST   /api/tasks/:id/notes                {text}
GET    /api/tasks/:id/events               → history
GET    /api/events?list=:id               → SSE stream
GET    /api/health                         → {ok, version}  (no auth)
```

SSE: the Worker loops while the client is connected, every 3 s runs
`SELECT max(updated_at) FROM lists WHERE id=?` (one cheap D1 read), and emits
`event: change` with the watermark when it moves. The stream closes itself
after 20 minutes so it stays under the free-tier subrequest cap; `EventSource`
reconnects automatically. On `change` the UI refetches the list's tasks. If
`EventSource` fails twice, the UI falls back to polling `/api/lists/:id/tasks`
every 5 s.

## 6. Web UI

Single `public/index.html` plus `app.js` and `style.css`. No framework, no
build. Requirements:

- **Token gate.** First visit shows a token field; stored in `localStorage`,
  sent as bearer on every call. Wrong token → clear and re-prompt.
- **Layout.** Left sidebar: lists with open-task counts, archived toggle, new
  list. Main: four kanban columns (Todo, In progress, Blocked, Done) for the
  selected list; Cancelled folded into Done under a toggle. Cards show title,
  priority chip, assignee/actor badge, blocked reason inline.
- **Interactions.** Add task inline at top of Todo. Drag a card between columns
  (native HTML5 drag/drop) or use the status menu on the card. Blocking prompts
  for a reason. Click a card to open a right-hand drawer: editable title, notes
  (textarea, markdown rendered on blur), priority, running notes log, full
  history with actor and relative time.
- **Live.** Green dot when SSE is connected. Changes made by agents appear
  within about 3 s with a brief highlight on the changed card.
- **Look.** Clean, high-contrast, system font stack, light and dark via
  `prefers-color-scheme`. Keyboard: `n` new task, `/` filter, `Esc` closes drawer.
- Responsive down to a phone: columns stack vertically.

## 7. Skill

`skills/agent-track/SKILL.md` (target under 120 lines):

```yaml
---
name: agent-track
description: Tracks multi-step work in a shared, persistent todo board via the agent-track MCP server. Use when starting a task with more than a few steps, when work spans sessions or agents, when something becomes blocked, or when the user asks to see, add, or update tasks, todos, or the board.
---
```

Body covers, in this order:

1. **When to use vs the built-in todo list** (persistence, humans, blockers).
2. **Protocol.** At start: `ensure_list` with the project name (git root folder
   name unless the user names one), then `add_tasks` for the plan. Before
   working on a task: `set_status in_progress`. When stuck: `set_status
   blocked` with a concrete reason. When finished: `add_note` with a one-line
   outcome, then `set_status done`. New work discovered mid-task: `add_tasks`.
   At session end: `list_tasks ready` and tell the user what remains.
3. **Style rules.** Titles are imperative and specific. One task = one
   verifiable outcome. Do not mark done without verifying. Never delete; cancel
   with a note.
4. **Setup check.** If tools are missing, point the user to the README install
   steps; do not try to install anything.

`references/api.md` holds the REST contract. No scripts.

## 8. Packaging and install

Repo layout:

```
agent-track/
├── README.md                 # deploy button, two install paths, screenshots
├── LICENSE                   # MIT
├── worker/
│   ├── wrangler.jsonc        # d1 binding (no database_id → auto-provision), assets, secrets.required
│   ├── package.json          # scripts: dev, predeploy (migrations), deploy, test, typecheck
│   ├── .dev.vars.example     # API_TOKEN=
│   ├── migrations/0001_init.sql
│   ├── src/…                 # see §2
│   ├── public/…              # UI
│   └── test/…                # vitest + @cloudflare/vitest-pool-workers
├── skills/agent-track/
│   ├── SKILL.md
│   └── references/api.md
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── .mcp.json                 # {"agent-track": {"type":"http","url":"${AGENT_TRACK_URL}","headers":{"Authorization":"Bearer ${AGENT_TRACK_TOKEN}"}}}
└── docs/superpowers/…
```

Install path for a user, as the README will say:

1. **Deploy** (once): click the Deploy to Cloudflare button, or
   `git clone … && cd worker && npm install && npx wrangler login && npm run deploy`,
   then `openssl rand -hex 32 | npx wrangler secret put API_TOKEN`.
   `npm run deploy` runs migrations first; wrangler auto-creates the D1 database.
2. **Connect the agent:**
   - Claude Code: `claude mcp add --transport http --scope user agent-track https://<worker>.workers.dev/mcp --header "Authorization: Bearer <token>"` and `npx skills add <owner>/agent-track`.
   - Or as a plugin: export `AGENT_TRACK_URL` and `AGENT_TRACK_TOKEN`, then `claude plugin marketplace add <owner>/agent-track && claude plugin install agent-track@agent-track`.
   - Codex, Cursor, Gemini: one snippet each in the README.
3. **Open the UI** at the Worker URL and paste the token.

## 9. Error handling

- Auth failure → 401 JSON `{error:"unauthorized"}` on `/api/*`; on `/mcp` → 401
  with a JSON-RPC error body so clients show a clear message.
- Validation → 400 (REST) or `isError:true` (MCP) with one plain sentence.
- Unknown list/task → 404 / `isError`.
- D1 errors bubble as 500 with a generic message; details go to
  `console.error` (visible in Workers observability, which is enabled in config).
- The UI shows a toast for any non-2xx and keeps local state unchanged.

## 10. Testing

- **Unit** (vitest, workers pool, real D1 in Miniflare): service rules
  (transitions, blocked reason, assignee stamping, event log, ready ordering,
  slug idempotency).
- **MCP contract**: post raw JSON-RPC for both eras: `server/discover`,
  `tools/list` shape, `tools/call` success and `isError`, header mismatch →
  400/-32020, `initialize` → legacy handshake, GET → 405, bad Origin → 403,
  missing token → 401.
- **REST**: CRUD round trip and SSE emits a change after a write.
- **Manual acceptance**: register the dev server with `claude mcp add`, run a
  session that creates and completes tasks, watch them move in the UI.

## 11. Open questions resolved

- Interface: MCP only (user decision). REST exists for the UI, undocumented as public.
- UI auth: same bearer token pasted once; Cloudflare Access documented as optional.
- Scope: lean core. No dependencies or subtasks.
- Name: agent-track. Env vars `AGENT_TRACK_URL`, `AGENT_TRACK_TOKEN`.
- Stack: TypeScript Worker with zero runtime deps; wrangler, typescript, vitest as dev deps only.
