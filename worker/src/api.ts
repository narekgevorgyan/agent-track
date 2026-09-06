/** REST + SSE used by the web UI. Same rules as MCP: everything goes through Service. */
import { Service } from "./service";
import { HttpError, json, readJson } from "./util";

const WEB = "web";
const SSE_MAX_MS = 20 * 60 * 1000; // stream lifetime; EventSource reconnects
const SSE_KEEPALIVE_MS = 25 * 1000;

type Handler = (ctx: { req: Request; env: Env; svc: Service; params: Record<string, string>; url: URL }) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-z_]+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method, pattern, keys, handler });
}

const body = <T = Record<string, unknown>>(req: Request) => readJson<T>(req);

route("GET", "/api/projects", async ({ svc, url }) => json(await svc.getProjects({ includeArchived: url.searchParams.get("archived") === "1" })));
route("POST", "/api/projects", async ({ req, svc }) => {
  const b = await body<{ name: string; description?: string }>(req);
  return json(await svc.createProject(b, WEB), 201);
});
route("GET", "/api/projects/:ref", async ({ svc, params }) => json(await svc.getProject(params.ref)));
route("PATCH", "/api/projects/:id", async ({ req, svc, params }) => json(await svc.updateProject(params.id, await body(req), WEB)));
route("GET", "/api/projects/:ref/events", async ({ svc, params, url }) =>
  json(await svc.getEvents({ project: params.ref, limit: Number(url.searchParams.get("limit") ?? 50) })),
);
route("POST", "/api/projects/:ref/initiatives", async ({ req, svc, params }) => {
  const b = await body<{ name: string; description?: string }>(req);
  return json(await svc.createInitiative({ project: params.ref, ...b }, WEB), 201);
});
route("PATCH", "/api/initiatives/:id", async ({ req, svc, params }) => json(await svc.updateInitiative(params.id, await body(req), WEB)));
route("GET", "/api/initiatives/:id/tasks", async ({ svc, params }) => json(await svc.getTasks({ initiative: params.id, limit: 500 })));
route("GET", "/api/initiatives/:id/events", async ({ svc, params, url }) =>
  json(await svc.getEvents({ initiative: params.id, limit: Number(url.searchParams.get("limit") ?? 50) })),
);
route("POST", "/api/initiatives/:id/tasks", async ({ req, svc, params }) => {
  const b = await body<{ title: string; type: never; notes?: string; priority?: number }>(req);
  const [task] = await svc.createTasks({ initiative: params.id, tasks: [b] }, WEB);
  return json(task, 201);
});
route("GET", "/api/tasks/:id", async ({ svc, params }) => json(await svc.getTask(params.id)));
route("PATCH", "/api/tasks/:id", async ({ req, svc, params }) => {
  const b = await body<Record<string, unknown>>(req);
  if (b.initiative_id && !b.initiative) b.initiative = b.initiative_id;
  return json(await svc.updateTask(params.id, b, WEB));
});
route("DELETE", "/api/tasks/:id", async ({ svc, params }) => json(await svc.updateTask(params.id, { status: "cancelled", note: "cancelled from the web UI" }, WEB)));
route("GET", "/api/tasks/:id/events", async ({ svc, params, url }) =>
  json(await svc.getEvents({ task: params.id, limit: Number(url.searchParams.get("limit") ?? 100) })),
);
route("GET", "/api/events", async ({ svc, url, req }) => {
  const projectRef = url.searchParams.get("project");
  if (!projectRef) throw new HttpError(400, "project is required");
  const project = await svc.resolveProject(projectRef);
  const interval = Math.max(50, Number(url.searchParams.get("interval") ?? 3000) || 3000);
  return sse(svc, project.id, interval, req.signal);
});

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const svc = new Service(env.DB);
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return r.handler({ req: request, env, svc, params, url });
  }
  return json({ error: pathMatched ? "method not allowed" : "not found" }, pathMatched ? 405 : 404);
}

function sse(svc: Service, projectId: string, interval: number, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let last = await svc.projectVersion(projectId);
      send("hello", { updated_at: last });
      let sinceKeepalive = Date.now();
      try {
        while (!signal.aborted && Date.now() - started < SSE_MAX_MS) {
          await new Promise((r) => setTimeout(r, interval));
          if (signal.aborted) break;
          const v = await svc.projectVersion(projectId);
          if (v !== last) {
            last = v;
            send("change", { updated_at: v });
          } else if (Date.now() - sinceKeepalive > SSE_KEEPALIVE_MS) {
            controller.enqueue(enc.encode(": keepalive\n\n"));
            sinceKeepalive = Date.now();
          }
        }
        send("bye", { reason: signal.aborted ? "client" : "max-age" });
      } catch {
        // client went away
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
