import { describe, it, expect } from "vitest";
import { req } from "./helpers";

const MODERN = "2026-07-28";

function modern(method: string, params: Record<string, unknown> = {}, id = 1, headers: Record<string, string> = {}) {
  const name: Record<string, string> = typeof params.name === "string" ? { "Mcp-Name": params.name } : {};
  return req("/mcp", {
    method: "POST",
    headers: { "MCP-Protocol-Version": MODERN, "Mcp-Method": method, ...name, ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
        },
      },
    }),
  });
}

function legacy(method: string, params: Record<string, unknown> = {}, id: number | null = 1) {
  return req("/mcp", {
    method: "POST",
    headers: { "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
}

const J = async (r: Promise<Response>): Promise<any> => (await r).json();
const call = (name: string, args: Record<string, unknown>) => J(modern("tools/call", { name, arguments: args }));
const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

describe("mcp modern", () => {
  it("server/discover", async () => {
    const r = await modern("server/discover");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.result).toMatchObject({ resultType: "complete", supportedVersions: [MODERN], capabilities: { tools: {} } });
    expect(j.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("agent-track");
    expect(j.result.instructions).toMatch(/create_project/);
    expect(j.result.instructions).toMatch(/url/);
  });

  it("tools/list has 8 tools in stable order with schemas", async () => {
    const j = await J(modern("tools/list"));
    expect(j.result.tools.map((t: any) => t.name)).toEqual([
      "get_projects", "create_project", "get_project", "create_initiative", "update_initiative", "get_tasks", "create_tasks", "update_task",
    ]);
    expect(j.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
    for (const t of j.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("tools/call round trip; actor defaults to clientInfo.name", async () => {
    const name = uniq("Demo");
    const c = await call("create_project", { name });
    expect(c.result.isError).toBe(false);
    expect(c.result.structuredContent.data.slug).toBe(name.toLowerCase());
    const i = await call("create_initiative", { project: name.toLowerCase(), name: "I" });
    expect(i.result.structuredContent.data.created_by).toBe("test-client");
    expect(i.result.structuredContent.data.url).toBe(`https://track.test/#/p/${name.toLowerCase()}/i/${i.result.structuredContent.data.id}`);
    const t = await call("create_tasks", { initiative: i.result.structuredContent.data.id, tasks: [{ title: "x", type: "bug", plan: "1. a" }] });
    expect(JSON.parse(t.result.content[0].text).data[0]).toMatchObject({ type: "bug", plan: "1. a" });
    expect(t.result.structuredContent.data[0].url).toMatch(/^https:\/\/track\.test\/#\/p\/.+\/i\/.+\/t\/.+$/);
    const u = await call("update_task", { id: t.result.structuredContent.data[0].id, status: "in_progress", plan: "1. b", actor: "codex" });
    expect(u.result.structuredContent.data).toMatchObject({ status: "in_progress", assignee: "codex", plan: "1. b" });
    const p = await call("get_project", { project: name });
    expect(p.result.structuredContent.data.initiatives[0].counts.in_progress).toBe(1);
    const list = await call("get_tasks", { project: name, status: ["in_progress"] });
    expect(list.result.structuredContent.data.length).toBe(1);
  });

  it("validation → isError with a sentence", async () => {
    const j = await call("create_tasks", { initiative: "nope", tasks: [{ title: "x", type: "epic" }] });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toMatch(/tasks\[0\]\.type must be one of/);
    const k = await call("create_tasks", { initiative: "nope", tasks: [{ title: "x", type: "bug" }] });
    expect(k.result.isError).toBe(true);
    expect(k.result.content[0].text).toMatch(/not found/);
    const m = await call("update_task", { id: "x", bogus: 1 });
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0].text).toMatch(/bogus is not a known field/);
  });

  it("unknown tool → -32602; unknown method → 404/-32601", async () => {
    const r1 = await modern("tools/call", { name: "nope", arguments: {} });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).error.code).toBe(-32602);
    const r = await modern("resources/list");
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.code).toBe(-32601);
  });

  it("header/body version mismatch → 400/-32020; unsupported → 400/-32022", async () => {
    const r = await modern("tools/list", {}, 1, { "MCP-Protocol-Version": "2025-11-25" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32020);
    const r2 = await req("/mcp", {
      method: "POST",
      headers: { "MCP-Protocol-Version": "2099-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
    });
    expect(r2.status).toBe(400);
    const j2: any = await r2.json();
    expect(j2.error.code).toBe(-32022);
    expect(j2.error.data.supported).toEqual([MODERN]);
  });

  it("GET/DELETE → 405; bad JSON → -32700", async () => {
    expect((await req("/mcp")).status).toBe(405);
    expect((await req("/mcp", { method: "DELETE" })).status).toBe(405);
    const r = await req("/mcp", { method: "POST", body: "{nope" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32700);
  });
});

describe("mcp legacy", () => {
  it("initialize echoes a supported version; unknown falls back to newest legacy", async () => {
    const j = await J(legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } }));
    expect(j.result.protocolVersion).toBe("2025-06-18");
    expect(j.result.serverInfo.name).toBe("agent-track");
    expect(j.result.capabilities.tools).toBeDefined();
    const k = await J(legacy("initialize", { protocolVersion: "2024-01-01", capabilities: {}, clientInfo: { name: "old", version: "1" } }));
    expect(k.result.protocolVersion).toBe("2025-11-25");
  });

  it("notifications/initialized → 202; ping → {}", async () => {
    expect((await legacy("notifications/initialized", {}, null)).status).toBe(202);
    expect((await J(legacy("ping"))).result).toEqual({});
  });

  it("legacy tools/list has no resultType and tools/call works with default actor", async () => {
    const j = await J(legacy("tools/list"));
    expect(j.result.resultType).toBeUndefined();
    expect(j.result.tools.length).toBe(8);
    const c = await J(legacy("tools/call", { name: "create_project", arguments: { name: uniq("L") } }));
    expect(c.result.isError).toBe(false);
    const p = await J(legacy("tools/call", { name: "get_projects", arguments: {} }));
    expect(p.result.isError).toBe(false);
  });
});
