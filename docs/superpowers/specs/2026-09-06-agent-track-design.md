# agent-track — design spec

Date: 2026-09-06
Status: revision 2, for review

## 1. What it is

agent-track is an open-source, self-hosted work tracker for AI coding agents.
A user deploys one Cloudflare Worker to their own account. Agents (Claude Code,
Codex, Cursor, Gemini CLI, anything that speaks MCP) connect to it as a remote
MCP server and keep their work there in three levels:

```
Project  (one per repo or product, e.g. "coinstats-web")
└── Initiative  (a chunk of work with a goal, e.g. "Migrate auth to passkeys")
    └── Task  (one verifiable step, typed: bug | feature | improvement | chore | research)
```

Agents create initiatives and tasks, move tasks through
`todo → in_progress → blocked → done`, and leave notes. A human watches and
edits the same board in a web UI served by the same Worker, live.

It replaces nothing inside the agent. Claude Code's built-in todo list is
ephemeral and private to one session. agent-track is for work that spans
sessions, involves more than one agent, or that a human wants to see and steer.

### Goals

- One-command deploy to the user's own Cloudflare account, free tier.
- MCP-only agent interface with the smallest possible tool set: eight tools,
  all plain get / create / update.
- A skill (SKILL.md) that teaches the agent *when* and *how* to track work.
- A pleasant, fast UI: projects → initiatives with progress → task kanban.
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
                                                 projects · initiatives · tasks · events
```

One Worker, one D1 database, one static folder. Both the MCP tools and the REST
API call the same `service.ts`, so behaviour and validation are identical
whichever door a change comes through.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/index.ts` | Route requests: `/mcp` → mcp, `/api/*` → api, else assets. Apply auth, Origin check, error → JSON. | mcp, api, auth |
| `src/auth.ts` | Constant-time bearer check against `env.API_TOKEN`. | Web Crypto |
| `src/mcp.ts` | JSON-RPC 2.0 over HTTP. Dual-era: MCP 2026-07-28 (stateless, `server/discover`) and legacy 2025-xx (`initialize`, `ping`). Maps `tools/call` to service functions. | service, tools |
| `src/tools.ts` | The eight tool definitions: name, description, JSON schema in/out. Single source for `tools/list` and for input validation. | — |
| `src/api.ts` | REST for the UI. Same operations as tools plus SSE change feed. | service |
| `src/service.ts` | Business rules: slugging, status transitions, actor stamping, event log, counts. | db |
| `src/db.ts` | Thin typed D1 helpers and SQL. | D1 binding |
| `migrations/0001_init.sql` | Schema. | — |
| `public/` | The UI. Vanilla JS, no build step. | REST + SSE |
| `skills/agent-track/SKILL.md` | Teaches agents when/how to use the tools. | MCP server |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin packaging. | env vars |

## 3. Data model

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,          -- time-prefixed random id (base32), generated in Worker
  slug        TEXT NOT NULL UNIQUE,      -- "coinstats-web", derived from name
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL           -- bumped on ANY change inside the project (SSE watermark)
);

CREATE TABLE initiatives (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',   -- markdown: goal, context, links
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','done','cancelled')),
  position    REAL NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX initiatives_project ON initiatives(project_id, status, position);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- denormalised for project-wide queries
  initiative_id  TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',  -- markdown, free text
  type           TEXT NOT NULL
                 CHECK (type IN ('bug','feature','improvement','chore','research')),
  status         TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
  priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4), -- 0 = urgent, 4 = someday
  blocked_reason TEXT NOT NULL DEFAULT '',
  assignee       TEXT NOT NULL DEFAULT '',  -- actor who moved it to in_progress
  position       REAL NOT NULL,             -- manual ordering within a status column
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX tasks_initiative ON tasks(initiative_id, status, position);
CREATE INDEX tasks_project    ON tasks(project_id, status);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  initiative_id TEXT,
  task_id       TEXT,                       -- NULL for project/initiative-level events
  actor         TEXT NOT NULL,              -- "claude-code", "codex", "web", ...
  kind          TEXT NOT NULL,              -- created | status | updated | note
  data          TEXT NOT NULL DEFAULT '{}', -- JSON: {from,to,reason} | {text} | {changed:[...]}
  created_at    INTEGER NOT NULL
);
CREATE INDEX events_task    ON events(task_id, id);
CREATE INDEX events_project ON events(project_id, id);
```

Rules enforced in `service.ts`:

- **Task status.** Any status may move to any other. Moving to `in_progress`
  sets `assignee = actor` if empty. Moving to `blocked` requires a non-empty
  `reason` (stored in `blocked_reason`); leaving `blocked` clears it. Moving to
  `done` or `cancelled` sets `completed_at`; moving away clears it.
- **Initiative status** is explicit, not derived. Agents or humans mark an
  initiative `done`. The UI shows progress (done / total tasks) regardless.
- **Every write appends one event** and bumps `updated_at` on the row and on
  the project. The task `notes` field is the long-lived description; `note`
  events are the running log an agent appends to as it works.
- **Ready** = `status = 'todo'`, ordered by priority then position. Filter via
  `get_tasks` with `status: ["todo"]`.
- **Slug** = lowercase `[a-z0-9-]` from the project name. `create_project` is
  idempotent on slug, so agents never need to check whether a project exists.
- **Actor** comes from the tool argument `actor` if given, else from the MCP
  client name, else `"agent"`. UI writes use `"web"`.
- **Write budget.** D1 free tier allows 100k row writes a day. One task change
  is 3 row writes (task, project, event). Nothing else writes. No polling writes.

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
- Origin: absent → allow; present and not the Worker's own origin → 403.

### The eight tools

All accept an optional `actor: string`. `project` arguments accept a slug or
id. Listed in the order `tools/list` returns them.

| Tool | Input | Returns |
|---|---|---|
| `get_projects` | `{ include_archived? }` | projects with initiative and open-task counts |
| `create_project` | `{ name, description? }` | the project (created, or existing by slug) |
| `get_project` | `{ project }` | project + its initiatives, each with `{todo, in_progress, blocked, done}` counts |
| `create_initiative` | `{ project, name, description? }` | the initiative |
| `update_initiative` | `{ id, name?, description?, status? }` | the initiative |
| `get_tasks` | `{ initiative?, project?, status?: string[], limit? }` | tasks with notes, ordered by status → priority → position. One of `initiative` or `project` is required. |
| `create_tasks` | `{ initiative, tasks: [{ title, type, notes?, priority? }] }` | created tasks (one D1 batch) |
| `update_task` | `{ id, status?, reason?, note?, title?, notes?, type?, priority?, initiative? }` | the task |

`update_task` is the one write tool for tasks: change status (with `reason`
required when `status = "blocked"`), append a `note` to the log, edit fields,
or move it to another initiative, in a single call. This keeps the tool count
at eight while covering every agent action.

Tool results include `structuredContent` matching an `outputSchema`, plus the
same JSON as a text block, per spec. Validation failures return
`isError: true` with a plain sentence the agent can act on
("blocked requires a reason").

The `server/discover` / `initialize` `instructions` field carries a three-line
usage hint (project → initiative → tasks; mark in_progress before working;
done only after verifying) so clients without the skill still behave sensibly.

## 5. REST API and live updates (UI only)

Same auth header. JSON in/out. Not part of the public contract; the UI is the
only consumer, but it is documented in `references/api.md` for tinkerers.

```
GET    /api/projects                              → projects + counts
POST   /api/projects                              {name, description}
PATCH  /api/projects/:id                          {name?, description?, archived?}
GET    /api/projects/:id                          → project + initiatives + counts
POST   /api/projects/:id/initiatives              {name, description}
PATCH  /api/initiatives/:id                       {name?, description?, status?, position?}
GET    /api/initiatives/:id/tasks                 → tasks
POST   /api/initiatives/:id/tasks                 {title, type, notes?, priority?}
PATCH  /api/tasks/:id                             {title?, notes?, type?, priority?, status?, reason?, note?, position?, initiative_id?}
GET    /api/tasks/:id/events                      → history
GET    /api/events?project=:id                    → SSE stream
GET    /api/health                                → {ok, version}  (no auth)
```

SSE: the Worker loops while the client is connected, every 3 s runs
`SELECT updated_at FROM projects WHERE id=?` (one cheap D1 read), and emits
`event: change` with the watermark when it moves. The stream closes itself
after 20 minutes so it stays under the free-tier subrequest cap; `EventSource`
reconnects automatically. On `change` the UI refetches what is on screen. If
`EventSource` fails twice, the UI falls back to polling every 5 s.

## 6. Web UI

`public/index.html`, `app.js`, `style.css`. No framework, no build.

- **Token gate.** First visit shows a token field; stored in `localStorage`,
  sent as bearer on every call. 401 → clear and re-prompt.
- **Navigation.** Left sidebar: projects with open-task counts, archived
  toggle, new project. URL hash routes: `#/p/<slug>` and `#/p/<slug>/i/<id>`.
- **Project page.** Initiatives as cards: name, one-line description, progress
  bar (done / total), counts by status, blocked badge if any task is blocked.
  Done initiatives folded under a toggle. New initiative inline.
- **Initiative page.** Four kanban columns (Todo, In progress, Blocked, Done;
  Cancelled folded into Done). Cards: type chip (colour per type), priority
  chip, title, assignee badge, blocked reason inline. Add task inline at top of
  Todo with a type picker. Drag between columns (native HTML5 drag/drop) or use
  the status menu; blocking prompts for a reason. Click a card → right drawer:
  editable title, type, priority, notes (markdown rendered on blur), initiative
  selector to move it, running notes log, full history with actor and relative
  time.
- **Live.** Green dot when SSE is connected. Agent changes appear within about
  3 s with a brief highlight on the changed card.
- **Look.** Clean, high-contrast, system font stack, light and dark via
  `prefers-color-scheme`. Keyboard: `n` new task, `/` filter, `Esc` closes
  drawer. Responsive: columns stack on a phone.

## 7. Skill

`skills/agent-track/SKILL.md` (target under 120 lines):

```yaml
---
name: agent-track
description: Tracks projects, initiatives and typed tasks on a shared, persistent board through the agent-track MCP server. Use when starting work with more than a few steps, when work spans sessions or agents, when something becomes blocked, or when the user asks to see, plan, add, or update tasks, initiatives, todos, or the board.
---
```

Body covers, in this order:

1. **When to use vs the built-in todo list** (persistence, humans, blockers).
2. **Protocol.** At start: `create_project` with the repo folder name (unless
   the user names one), `get_project` to see existing initiatives, then either
   pick one or `create_initiative` with the goal in `description`, then
   `create_tasks` for the plan, each with a type. Before working on a task:
   `update_task {status: in_progress}`. When stuck: `status: blocked` with a
   concrete `reason`. When finished: `update_task {status: done, note: "<one-line outcome>"}`.
   New work discovered mid-task: `create_tasks`. When all tasks of an
   initiative are done and verified: `update_initiative {status: done}`.
   At session end: `get_tasks {project, status: ["todo","blocked"]}` and tell
   the user what remains.
3. **Style rules.** Titles are imperative and specific. One task = one
   verifiable outcome. Pick the type honestly (a bug is a bug). Do not mark
   done without verifying. Never delete; cancel with a note.
4. **Setup check.** If the tools are missing, point the user to the README
   install steps; do not try to install anything.

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
- Unknown project/initiative/task → 404 / `isError`.
- D1 errors bubble as 500 with a generic message; details go to
  `console.error` (visible in Workers observability, which is enabled in config).
- The UI shows a toast for any non-2xx and keeps local state unchanged.

## 10. Testing

- **Unit** (vitest, workers pool, real D1 in Miniflare): service rules
  (transitions, blocked reason, assignee stamping, event log, counts, slug
  idempotency, moving a task between initiatives).
- **MCP contract**: post raw JSON-RPC for both eras: `server/discover`,
  `tools/list` shape (eight tools, stable order), `tools/call` success and
  `isError`, header mismatch → 400/-32020, `initialize` → legacy handshake,
  GET → 405, bad Origin → 403, missing token → 401.
- **REST**: CRUD round trip and SSE emits a change after a write.
- **Manual acceptance**: register the dev server with `claude mcp add`, run a
  session that creates an initiative with tasks and completes them, watch them
  move in the UI.

## 11. Decisions log

- Structure: project → initiatives → typed tasks (revision 2, user request).
- Interface: MCP only, eight tools, get/create/update shape. REST exists for the UI only.
- UI auth: same bearer token pasted once; Cloudflare Access documented as optional.
- Scope: no dependencies or subtasks.
- Name: agent-track. Env vars `AGENT_TRACK_URL`, `AGENT_TRACK_TOKEN`.
- Stack: TypeScript Worker with zero runtime deps; wrangler, typescript, vitest as dev deps only.
