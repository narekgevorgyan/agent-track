/**
 * MCP over Streamable HTTP, hand-rolled (no SDK), dual-era:
 *  - modern  (2026-07-28): stateless, per-request _meta, server/discover, resultType on results
 *  - legacy  (2025-03-26 … 2025-11-25): initialize handshake, ping, no resultType
 * Only tools are exposed. Responses are plain application/json (allowed by spec).
 */
import { Service } from "./service";
import { TOOLS, validateArgs } from "./tools";
import { HttpError, json } from "./util";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const SERVER_INFO = { name: "agent-track", version: "0.2.0" };
/** Condensed skill. Clients load this at connection time, so agents follow the protocol even without SKILL.md installed. */
const INSTRUCTIONS = `agent-track is a persistent, shared work board: Project (one per repo) → Initiative (a goal) → Task (one verifiable step, typed bug | feature | improvement | chore | research; status todo | in_progress | blocked | done | cancelled). Humans watch it live in a browser.

Use it instead of the session todo list whenever work has more than a few steps, spans sessions or agents, could get blocked, or the user asks about tasks, todos, initiatives or the board.

Protocol:
1. create_project {name: <repo folder name>} — idempotent, returns the existing project.
2. get_project {project} to see initiatives; reuse one that fits, else create_initiative {project, name, description: goal + context}.
3. create_tasks {initiative, tasks: [{title, type, priority?, notes?, plan?}]} — write the whole plan in one call. Titles are imperative and specific; one task = one verifiable outcome.
4. Before touching a task: update_task {id, plan: "numbered steps, files, how to verify", status: "in_progress"} in one call. The plan is shown to the human; keep it short and concrete.
5. While working: update_task {id, note} for findings that matter.
6. Stuck: update_task {id, status: "blocked", reason} with a reason a human can act on, then move to the next todo task.
7. Verified done (tests run, output checked): update_task {id, status: "done", note: one-line outcome}. Never mark done on hope.
8. Discovered work → create_tasks immediately. All tasks done → update_initiative {id, status: "done"}.
9. Session end: get_tasks {project, status: ["todo","in_progress","blocked"]} and tell the user what remains.

Every project, initiative and task result includes a url. After creating or updating, show the user the relevant url so they can open it in the browser. Never delete; cancel with a note. Install the full skill with: npx skills add narekgevorgyan/agent-track`;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }) as const;
const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method not allowed; POST JSON-RPC to this endpoint" }, 405, { allow: "POST" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "parse error: body must be JSON"), 400);
  }
  if (Array.isArray(body)) {
    // Batching was removed in 2026-07-28; legacy clients rarely use it. Keep it simple.
    return json(rpcError(null, -32600, "batch requests are not supported"), 400);
  }
  if (typeof body !== "object" || body === null) {
    return json(rpcError(null, -32600, "invalid request"), 400);
  }
  const req = body as RpcRequest;
  const svc = new Service(env.DB, new URL(request.url).origin);
  const meta = (req.params?._meta ?? null) as Record<string, unknown> | null;
  const modern = !!meta && typeof meta[META_VERSION] === "string";
  return modern ? handleModern(request, req, meta!, svc) : handleLegacy(req, svc);
}

// ---------- modern (2026-07-28) ----------

async function handleModern(request: Request, req: RpcRequest, meta: Record<string, unknown>, svc: Service): Promise<Response> {
  const bodyVersion = meta[META_VERSION] as string;
  if (bodyVersion !== MODERN_VERSION) {
    return json(rpcError(req.id, -32022, `unsupported protocol version ${bodyVersion}`, { supported: [MODERN_VERSION] }), 400);
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && headerVersion !== bodyVersion) {
    return json(rpcError(req.id, -32020, "MCP-Protocol-Version header does not match _meta protocolVersion"), 400);
  }
  const method = req.method ?? "";
  const clientName = ((meta[META_CLIENT_INFO] as { name?: string } | undefined)?.name ?? "").trim();
  const base = { resultType: "complete", _meta: { [META_SERVER_INFO]: SERVER_INFO } };

  // Notifications carry no id → 202 with empty body.
  if (req.id === undefined && method.startsWith("notifications/")) return new Response(null, { status: 202 });

  switch (method) {
    case "server/discover":
      return json(
        rpcResult(req.id, {
          ...base,
          supportedVersions: [MODERN_VERSION],
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: "public",
        }),
      );
    case "tools/list":
      return json(rpcResult(req.id, { ...base, tools: TOOLS, ttlMs: 300_000, cacheScope: "public" }));
    case "tools/call": {
      const r = await callTool(req, clientName, svc);
      if ("error" in r) return json(r, r.error.code === -32602 ? 400 : 500);
      return json(rpcResult(req.id, { ...base, ...r.result }));
    }
    default:
      return json(rpcError(req.id, -32601, `method not found: ${method}`), 404);
  }
}

// ---------- legacy (initialize handshake) ----------

async function handleLegacy(req: RpcRequest, svc: Service): Promise<Response> {
  const method = req.method ?? "";
  if (req.id === undefined) {
    // Notification (e.g. notifications/initialized). Nothing to do: we are stateless.
    return new Response(null, { status: 202 });
  }
  switch (method) {
    case "initialize": {
      const requested = String(req.params?.protocolVersion ?? "");
      const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
      return json(
        rpcResult(req.id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case "ping":
      return json(rpcResult(req.id, {}));
    case "tools/list":
      return json(rpcResult(req.id, { tools: TOOLS }));
    case "tools/call": {
      const r = await callTool(req, "", svc);
      if ("error" in r) return json(r, 200);
      return json(rpcResult(req.id, r.result));
    }
    default:
      return json(rpcError(req.id, -32601, `method not found: ${method}`), 200);
  }
}

// ---------- tools/call ----------

type CallOutcome =
  | { result: { content: { type: "text"; text: string }[]; structuredContent?: { data: unknown }; isError: boolean } }
  | ReturnType<typeof rpcError>;

async function callTool(req: RpcRequest, clientName: string, svc: Service): Promise<CallOutcome> {
  const name = String(req.params?.name ?? "");
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(req.id, -32602, `unknown tool: ${name}`);
  const rawArgs = (req.params?.arguments ?? {}) as Record<string, unknown>;
  const args = { ...rawArgs };
  delete args._meta;

  const invalid = validateArgs(tool.inputSchema, args);
  if (invalid) return { result: toolError(invalid) };

  const actor = (typeof args.actor === "string" && args.actor.trim()) || clientName || "agent";
  try {
    const data = await runTool(name, args, actor, svc);
    return { result: { content: [{ type: "text", text: JSON.stringify({ data }) }], structuredContent: { data }, isError: false } };
  } catch (err) {
    if (err instanceof HttpError) return { result: toolError(err.message) };
    console.error("tool failed", name, err);
    return rpcError(req.id, -32603, "internal error while running tool");
  }
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function runTool(name: string, a: Record<string, unknown>, actor: string, svc: Service): Promise<unknown> {
  switch (name) {
    case "get_projects":
      return svc.getProjects({ includeArchived: a.include_archived === true });
    case "create_project":
      return svc.createProject({ name: a.name as string, description: a.description as string | undefined }, actor);
    case "get_project":
      return svc.getProject(a.project as string);
    case "create_initiative":
      return svc.createInitiative({ project: a.project as string, name: a.name as string, description: a.description as string | undefined }, actor);
    case "update_initiative":
      return svc.updateInitiative(a.id as string, { name: a.name as never, description: a.description as never, status: a.status as never }, actor);
    case "get_tasks":
      return svc.getTasks({ initiative: a.initiative as never, project: a.project as never, status: a.status as never, limit: a.limit as never });
    case "create_tasks":
      return svc.createTasks({ initiative: a.initiative as string, tasks: a.tasks as never }, actor);
    case "update_task":
      return svc.updateTask(
        a.id as string,
        {
          status: a.status as never,
          reason: a.reason as never,
          note: a.note as never,
          title: a.title as never,
          notes: a.notes as never,
          plan: a.plan as never,
          type: a.type as never,
          priority: a.priority as never,
          initiative: a.initiative as never,
        },
        actor,
      );
    default:
      throw new HttpError(400, `unknown tool: ${name}`);
  }
}
