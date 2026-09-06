# agent-track REST API

The web UI talks to the Worker over this JSON API. Agents should use the MCP tools instead; this is documented for scripts and tinkerers.

**Auth:** `Authorization: Bearer <API_TOKEN>` on every `/api/*` route except `/api/health`. The SSE route additionally accepts `?token=` because `EventSource` cannot set headers.

**Origin:** requests that carry an `Origin` header must match the Worker's own origin, else `403`.

**Errors:** `{ "error": "<one sentence>" }` with `400` (validation), `401`, `403`, `404`, `405`, `500`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ok, version}` |
| GET | `/api/projects?archived=1` | | `ProjectSummary[]` (`initiatives`, `open_tasks`, `blocked_tasks` counts) |
| POST | `/api/projects` | `{name, description?}` | `Project` (201; idempotent by slug) |
| GET | `/api/projects/:idOrSlug` | | `Project + initiatives[]` each with `counts{todo,in_progress,blocked,done,cancelled}` |
| PATCH | `/api/projects/:id` | `{name?, description?, archived?}` | `Project` |
| GET | `/api/projects/:idOrSlug/events?limit=50` | | `Event[]` newest first |
| POST | `/api/projects/:idOrSlug/initiatives` | `{name, description?}` | `Initiative` (201) |
| PATCH | `/api/initiatives/:id` | `{name?, description?, status?, position?}` | `Initiative` |
| GET | `/api/initiatives/:id/tasks` | | `Task[]` ordered by status, priority, position |
| GET | `/api/initiatives/:id/events?limit=50` | | `Event[]` |
| POST | `/api/initiatives/:id/tasks` | `{title, type, notes?, priority?}` | `Task` (201) |
| GET | `/api/tasks/:id` | | `Task` |
| PATCH | `/api/tasks/:id` | `{title?, notes?, type?, priority?, status?, reason?, note?, position?, initiative?}` | `Task` |
| DELETE | `/api/tasks/:id` | | `Task` (soft: status → `cancelled`) |
| GET | `/api/tasks/:id/events?limit=100` | | `Event[]` |
| GET | `/api/events?project=:idOrSlug&interval=3000` | | SSE stream |

## Objects

```jsonc
// Task
{ "id": "1m1ts46k7f87r4f3", "project_id": "…", "initiative_id": "…",
  "title": "Add WebAuthn registration endpoint", "notes": "markdown…",
  "type": "feature",              // bug | feature | improvement | chore | research
  "status": "in_progress",        // todo | in_progress | blocked | done | cancelled
  "priority": 1,                  // 0 urgent … 4 someday
  "blocked_reason": "", "assignee": "claude-code", "position": 1,
  "created_by": "claude-code", "created_at": 1788000000000, "updated_at": 1788000000000, "completed_at": null }

// Event
{ "id": 42, "project_id": "…", "initiative_id": "…", "task_id": "…",
  "actor": "web", "kind": "status",   // created | status | updated | note
  "data": { "from": "todo", "to": "blocked", "reason": "…" }, "created_at": 1788000000000 }
```

## SSE stream

```
event: hello
data: {"updated_at":1788000000000}

event: change
data: {"updated_at":1788000003000}

: keepalive

event: bye
data: {"reason":"max-age"}
```

The Worker checks the project's `updated_at` every `interval` ms (default 3000, minimum 50) and emits `change` when it moves. Streams end after 20 minutes; `EventSource` reconnects on its own. Every write inside a project bumps its `updated_at`, so one stream per project is enough.

## Rules the server enforces

- `blocked` requires a non-empty `reason`; leaving `blocked` clears it.
- Moving to `in_progress` sets `assignee` to the actor if it was empty.
- `done` and `cancelled` set `completed_at`; any other status clears it.
- A task can only move to an initiative in the same project.
- Every write appends exactly one event (plus one `note` event when `note` is given) and runs as a single atomic D1 batch.
