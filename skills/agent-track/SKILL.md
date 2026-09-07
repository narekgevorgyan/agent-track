---
name: agent-track
description: Tracks projects, initiatives and typed tasks on a shared, persistent board through the agent-track MCP server. Use when starting work with more than a few steps, when work spans sessions or agents, when something becomes blocked, or when the user asks to see, plan, add, or update tasks, initiatives, todos, or the board.
license: MIT
compatibility: Requires the agent-track MCP server to be connected (tools named get_projects, create_project, get_project, create_initiative, update_initiative, get_tasks, create_tasks, update_task).
---

# agent-track

A persistent board shared between you and the humans you work with:

```
Project (one per repo)  →  Initiative (a goal)  →  Task (one verifiable step, typed)
```

Task types: `bug` · `feature` · `improvement` · `chore` · `research`
Task statuses: `todo` → `in_progress` → `blocked` / `done` / `cancelled`

## When to use it

Use agent-track instead of the built-in session todo list when any of these hold:

- The work has more than a few steps or will outlive this session.
- A human wants to follow or steer progress (they watch the web board live).
- More than one agent may touch the work.
- Something can get blocked and someone else must unblock it.

Keep using the built-in todo list for short, single-session checklists nobody else needs to see.

## Protocol

1. **Find or create the project.** Name it after the repo folder unless the user names it.
   ```json
   create_project {"name": "coinstats-web"}
   ```
   `create_project` is idempotent: calling it again returns the existing project.

2. **Look before you plan.** `get_project {"project": "coinstats-web"}` returns the initiatives with task counts. Reuse an initiative that matches the goal; otherwise create one and put the goal and context in `description`.
   ```json
   create_initiative {"project": "coinstats-web", "name": "Migrate auth to passkeys", "description": "Replace password login with WebAuthn. Keep OTP fallback."}
   ```

3. **Write the plan as tasks, in one call.** Each task is one verifiable outcome with an honest type.
   ```json
   create_tasks {"initiative": "<id>", "tasks": [
     {"title": "Add WebAuthn registration endpoint", "type": "feature", "priority": 1},
     {"title": "Fix session cookie not cleared on logout", "type": "bug", "priority": 0},
     {"title": "Research iOS passkey autofill quirks", "type": "research"}
   ]}
   ```

4. **Before working on a task, write its plan and mark it in progress in one call.** The plan is short and concrete: numbered steps, files you will touch, how you will verify. Humans read it on the board before you start; this also stamps you as assignee.
   ```json
   update_task {"id": "<id>", "status": "in_progress", "plan": "1. Add POST /auth/passkeys/register in src/auth.ts\n2. Store credential in `passkeys` table (migration 0007)\n3. Verify: curl returns 201, vitest auth.test.ts green"}
   ```
   You may also pass `plan` inside `create_tasks` items when you already know the approach.

5. **While working**, leave short notes when you learn something that matters.
   ```json
   update_task {"id": "<id>", "note": "Endpoint returns 201; verified with curl."}
   ```

6. **When stuck**, block it with a concrete reason a human can act on. Then move on to the next `todo` task rather than waiting.
   ```json
   update_task {"id": "<id>", "status": "blocked", "reason": "Need staging cookie domain from infra"}
   ```

7. **When finished and verified**, mark done with a one-line outcome. Verify first: run the tests, open the page, check the output.
   ```json
   update_task {"id": "<id>", "status": "done", "note": "Shipped in PR #412; tests green."}
   ```

8. **Discovered work** goes on the board immediately as new tasks, not in your head.

   **Share links.** Every project, initiative and task result has a `url`. After creating an initiative or tasks, or when you block something, show the user the url so they can open it in the browser:
   > Board: https://your-worker.workers.dev/#/p/coinstats-web/i/1m1ts3h1eweeh66j

9. **When every task in an initiative is done**, close it:
   ```json
   update_initiative {"id": "<id>", "status": "done"}
   ```

10. **At the end of a session**, list what remains and tell the user:
    ```json
    get_tasks {"project": "coinstats-web", "status": ["todo", "in_progress", "blocked"]}
    ```

## Style rules

- Titles are imperative and specific: "Add retry to price fetcher", not "price fetcher".
- One task = one outcome someone can check. Split anything that needs "and".
- Pick the type honestly. A regression is a `bug` even if the fix is a feature-sized change.
- Priority 0 is urgent, 2 is normal (default), 4 is someday.
- Never mark done on hope. If you could not verify, add a note saying what is unverified and leave it `in_progress`.
- Revise the plan when reality diverges: `update_task {"id", "plan": "..."}` replaces it; the change is logged.
- Never delete. Cancel with a note explaining why.
- Pass `actor` only when you are acting on behalf of a named agent or person; otherwise the server records your MCP client name.

## If the tools are missing

Do not try to install or configure anything. Tell the user:

> The agent-track MCP server is not connected. Follow the Connect section in the agent-track README (`claude mcp add --transport http agent-track <url>/mcp --header "Authorization: Bearer <token>"`).

Then fall back to the built-in todo list for this session.

See `references/api.md` for the REST API the web UI uses.
