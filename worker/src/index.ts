import { handleApi } from "./api";
import { isAuthorized, originAllowed } from "./auth";
import { handleMcp } from "./mcp";
import { HttpError, json } from "./util";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") {
        return json({ ok: true, version: env.APP_VERSION });
      }
      if (path === "/mcp") {
        if (!originAllowed(request)) return json({ error: "forbidden origin" }, 403);
        if (!isAuthorized(request, env.API_TOKEN)) {
          return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: send Authorization: Bearer <API_TOKEN>" } }, 401);
        }
        return await handleMcp(request, env);
      }
      if (path.startsWith("/api/")) {
        if (!originAllowed(request)) return json({ error: "forbidden origin" }, 403);
        // EventSource cannot set headers, so the SSE endpoint alone also accepts ?token=.
        if (!isAuthorized(request, env.API_TOKEN, path === "/api/events")) return json({ error: "unauthorized" }, 401);
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("unhandled", err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
