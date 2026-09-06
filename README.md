# agent-track

A self-hosted work tracker for AI coding agents. One Cloudflare Worker, one free D1 database, one web board.

```
Project (one per repo)  →  Initiative (a goal)  →  Task (one verifiable step)
                                                    bug · feature · improvement · chore · research
                                                    todo → in_progress → blocked / done / cancelled
```

Agents (Claude Code, Codex, Cursor, Gemini CLI, anything that speaks MCP) connect to it as a remote MCP server and keep their plans there across sessions. You watch and edit the same board live in the browser: drag cards between columns, block a task with a reason, leave a note the agent will read.

- **Eight MCP tools**, all plain get / create / update. Nothing to learn.
- **Zero runtime dependencies.** The Worker is ~900 lines of TypeScript you can read in an hour.
- **Free tier friendly.** One task change costs three D1 row writes. Live updates use one server-sent-events connection per open tab, not polling.
- **Portable install.** `npx skills add`, a Claude Code plugin, or a one-line MCP config.

## Deploy (once, to your own Cloudflare account)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/narekgevorgyan/agent-track/tree/main/worker)

The button clones the repo into your GitHub, creates the D1 database, asks you for an `API_TOKEN`, and deploys. Or do it by hand:

```bash
git clone https://github.com/narekgevorgyan/agent-track
cd agent-track/worker
npm install
npx wrangler login
echo "API_TOKEN=$(openssl rand -hex 32)" > .secrets   # keep this file; it is git-ignored
npm run deploy -- --secrets-file .secrets                # creates the D1 database, deploys, applies migrations
```

The first deploy needs the secret up front because `wrangler.jsonc` declares `API_TOKEN` as required. Later deploys are just `npm run deploy`. Rotate the token any time with `npx wrangler secret put API_TOKEN`.

Open the Worker URL (`https://agent-track.<your-subdomain>.workers.dev`), paste the token, done.

## Connect your agent

Replace `<url>` with your Worker URL and `<token>` with the value you gave `API_TOKEN`.

**Claude Code** (MCP server + skill):

```bash
claude mcp add --transport http --scope user agent-track <url>/mcp --header "Authorization: Bearer <token>"
npx skills add narekgevorgyan/agent-track
```

**Claude Code, as a plugin** (registers the MCP server and the skill together; reads the URL and token from your environment):

```bash
export AGENT_TRACK_URL=<url>/mcp
export AGENT_TRACK_TOKEN=<token>
claude plugin marketplace add narekgevorgyan/agent-track
claude plugin install agent-track@agent-track
```

**Codex CLI:**

```bash
export AGENT_TRACK_TOKEN=<token>
codex mcp add agent-track --url <url>/mcp --bearer-token-env-var AGENT_TRACK_TOKEN
npx skills add narekgevorgyan/agent-track -a codex
```

**Cursor** (`.cursor/mcp.json`):

```json
{ "mcpServers": { "agent-track": { "url": "<url>/mcp", "headers": { "Authorization": "Bearer ${env:AGENT_TRACK_TOKEN}" } } } }
```

**Gemini CLI:**

```bash
gemini mcp add --transport http --header "Authorization: Bearer <token>" agent-track <url>/mcp
```

Claude Desktop and claude.ai custom connectors only support OAuth or no auth; use [`mcp-remote`](https://github.com/geelen/mcp-remote) with a header there.

## What the agent does with it

The bundled skill tells the agent to create a project named after the repo, put the goal into an initiative, write the plan as typed tasks in one call, mark each task in progress before touching it, block with a concrete reason instead of stalling, leave notes as it learns things, mark done only after verifying, and list what is left at the end of a session. You can also just ask: "put this on the board", "what is blocked?", "mark the cookie bug done".

## The eight tools

| Tool | What it does |
|---|---|
| `get_projects` | List projects with active-initiative, open-task and blocked-task counts |
| `create_project` | Create, or return the existing project with the same name (idempotent by slug) |
| `get_project` | Project + its initiatives, each with task counts by status |
| `create_initiative` | New goal-sized chunk of work in a project |
| `update_initiative` | Rename, describe, or set `active` / `done` / `cancelled` |
| `get_tasks` | Tasks for an initiative or a whole project, filtered by status, ordered by status then priority |
| `create_tasks` | One or more tasks, each with a title and a type |
| `update_task` | Status (blocked needs a reason), note, title, notes, type, priority, or move to another initiative |

Every write records who did it (the MCP client name, an explicit `actor`, or `web`) in a history you can read per task.

## Security notes

- The token is compared in constant time and is the only credential. Rotate it with `wrangler secret put API_TOKEN`; the old one stops working immediately.
- Requests that carry an `Origin` header must match the Worker's own origin, so a malicious page cannot drive your board from the browser.
- The UI keeps the token in `localStorage` of your browser only.
- Want a login screen? In the Cloudflare dashboard open the Worker → **Access** → "Protect this Worker behind Access", then add a second Access application for `<host>/api/*` and `<host>/mcp` with a **Bypass** policy so agents keep using the bearer token.

## Free-tier budget

D1 free tier: 100k row writes and 5M row reads per day. One task update writes 3 rows (task, project watermark, event). An open board tab makes one read every 3 seconds over its SSE stream. Both are far below the limits for personal and small-team use.

## Development

```bash
cd worker
cp .dev.vars.example .dev.vars     # sets API_TOKEN=change-me for local dev
npm run dev                        # http://localhost:8787
npm test                           # vitest inside workerd with a real D1
npm run typecheck
```

Layout:

```
worker/src/index.ts     routing, auth gate, Origin check
worker/src/mcp.ts       MCP over Streamable HTTP, both the 2026-07-28 spec and the legacy initialize handshake
worker/src/tools.ts     the eight tool schemas + a small validator
worker/src/api.ts       REST + SSE used by the UI
worker/src/service.ts   every rule: transitions, blocked reasons, assignees, history, counts
worker/src/db.ts        typed D1 helpers
worker/public/          the board (vanilla HTML/CSS/JS, no build)
skills/agent-track/     SKILL.md + references/api.md
.claude-plugin/         plugin + marketplace manifests; .mcp.json registers the server
```

## License

MIT
