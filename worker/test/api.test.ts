import { describe, it, expect } from "vitest";
import { api, patch, req } from "./helpers";

const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

describe("health", () => {
  it("GET /api/health is public", async () => {
    const r = await req("/api/health", {}, null);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, version: "0.1.0" });
  });
});

describe("auth", () => {
  it("rejects /api without token", async () => {
    expect((await req("/api/projects", {}, null)).status).toBe(401);
  });
  it("rejects wrong token", async () => {
    expect((await req("/api/projects", {}, "nope")).status).toBe(401);
  });
  it("rejects /mcp without token with a JSON-RPC error body", async () => {
    const r = await req("/mcp", { method: "POST", body: "{}" }, null);
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.code).toBe(-32001);
  });
  it("403 on foreign Origin", async () => {
    const r = await req("/api/projects", { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("allows same Origin", async () => {
    const r = await req("/api/projects", { headers: { Origin: "https://track.test" } });
    expect(r.status).toBe(200);
  });
  it("query token only works on /api/events", async () => {
    expect((await req("/api/projects?token=test-token", {}, null)).status).toBe(401);
    const p = await api("/api/projects", { name: uniq("Q") });
    const r = await req(`/api/events?project=${p.id}&token=test-token`, {}, null);
    expect(r.status).toBe(200);
    await r.body!.cancel();
  });
});

describe("rest", () => {
  it("full round trip", async () => {
    const p = await api("/api/projects", { name: uniq("R") });
    const i = await api(`/api/projects/${p.id}/initiatives`, { name: "I", description: "d" });
    const t = await api(`/api/initiatives/${i.id}/tasks`, { title: "t", type: "feature" });
    const u = await patch(`/api/tasks/${t.id}`, { status: "blocked", reason: "r" });
    expect(u.blocked_reason).toBe("r");
    const full = await api(`/api/projects/${p.slug}`);
    expect(full.initiatives[0].counts.blocked).toBe(1);
    const ev = await api(`/api/tasks/${t.id}/events`);
    expect(ev.length).toBe(2);
    const all = await api(`/api/projects`);
    expect(all.find((x: any) => x.id === p.id).blocked_tasks).toBe(1);
    expect((await req(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked" }) })).status).toBe(400);
    expect((await req(`/api/tasks/nope`, { method: "PATCH", body: "{}" })).status).toBe(404);
    const del = await req(`/api/tasks/${t.id}`, { method: "DELETE" });
    expect(((await del.json()) as any).status).toBe("cancelled");
    expect((await req(`/api/nothing`)).status).toBe(404);
    expect((await req(`/api/projects/${p.id}`, { method: "DELETE" })).status).toBe(405);
  });

  it("web actor is recorded", async () => {
    const p = await api("/api/projects", { name: uniq("W") });
    expect((await api(`/api/projects/${p.id}/events`))[0].actor).toBe("web");
  });

  it("SSE emits hello then change after a write", async () => {
    const p = await api("/api/projects", { name: uniq("S") });
    const r = await req(`/api/events?project=${p.id}&interval=50`);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (s: string) => {
      while (!buf.includes(s)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("closed before " + s);
        buf += dec.decode(value);
      }
    };
    await readUntil("event: hello");
    await api(`/api/projects/${p.id}/initiatives`, { name: "I" });
    await readUntil("event: change");
    await reader.cancel();
  });
});
