import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { Service } from "../src/service";

const svc = () => new Service(env.DB);
const uniq = (() => { let n = 0; return (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`; })();

describe("projects", () => {
  it("create is idempotent on slug", async () => {
    const s = svc();
    const a = await s.createProject({ name: "CoinStats Web!", description: "x" }, "t");
    const b = await s.createProject({ name: "coinstats web" }, "t");
    expect(a.slug).toBe("coinstats-web");
    expect(b.id).toBe(a.id);
    expect((await s.getProjects()).filter((p) => p.slug === "coinstats-web").length).toBe(1);
  });
  it("resolves by slug or id and reports counts", async () => {
    const s = svc();
    const name = uniq("p");
    const p = await s.createProject({ name }, "t");
    const bySlug = await s.getProject(name);
    const byId = await s.getProject(p.id);
    expect(bySlug.id).toBe(byId.id);
    expect(bySlug.initiatives).toEqual([]);
    await expect(s.getProject("nope")).rejects.toMatchObject({ status: 404 });
  });
  it("logs a created event", async () => {
    const s = svc();
    const p = await s.createProject({ name: uniq("p") }, "claude");
    const ev = await s.getEvents({ project: p.id });
    expect(ev[0]).toMatchObject({ kind: "created", actor: "claude", task_id: null });
  });
  it("update archives and logs changed fields", async () => {
    const s = svc();
    const p = await s.createProject({ name: uniq("p") }, "t");
    const u = await s.updateProject(p.id, { archived: true, description: "d" }, "web");
    expect(u.archived).toBe(1);
    expect((await s.getProjects()).find((x) => x.id === p.id)).toBeUndefined();
    expect((await s.getProjects({ includeArchived: true })).find((x) => x.id === p.id)).toBeDefined();
    expect((await s.getEvents({ project: p.id }))[0]).toMatchObject({ kind: "updated", data: { changed: ["description", "archived"] } });
  });
});

describe("initiatives", () => {
  it("creates under a project by slug and appears in getProject with zero counts", async () => {
    const s = svc();
    const name = uniq("p");
    await s.createProject({ name }, "t");
    const i = await s.createInitiative({ project: name, name: "Auth", description: "goal" }, "t");
    const p = await s.getProject(name);
    expect(p.initiatives[0]).toMatchObject({ id: i.id, status: "active", counts: { todo: 0, done: 0 } });
  });
  it("update sets completed_at when done and clears when reactivated", async () => {
    const s = svc();
    const name = uniq("p");
    await s.createProject({ name }, "t");
    const i = await s.createInitiative({ project: name, name: "A" }, "t");
    const d = await s.updateInitiative(i.id, { status: "done" }, "t");
    expect(d.completed_at).not.toBeNull();
    const a = await s.updateInitiative(i.id, { status: "active" }, "t");
    expect(a.completed_at).toBeNull();
    expect((await s.getEvents({ initiative: i.id })).filter((e) => e.kind === "status").length).toBe(2);
  });
  it("rejects unknown status", async () => {
    const s = svc();
    const name = uniq("p");
    await s.createProject({ name }, "t");
    const i = await s.createInitiative({ project: name, name: "A" }, "t");
    await expect(s.updateInitiative(i.id, { status: "weird" as any }, "t")).rejects.toMatchObject({ status: 400 });
  });
});

describe("tasks", () => {
  async function seed() {
    const s = svc();
    const name = uniq("p");
    await s.createProject({ name }, "t");
    const i = await s.createInitiative({ project: name, name: "I" }, "t");
    return { s, i, name };
  }
  it("creates a batch with types and default priority, ordered by priority then position", async () => {
    const { s, i } = await seed();
    const ts = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "bug" }, { title: "b", type: "feature", priority: 0 }] }, "claude");
    expect(ts.map((t) => t.title)).toEqual(["a", "b"]);
    expect(ts[0]).toMatchObject({ priority: 2, status: "todo", created_by: "claude", assignee: "" });
    const list = await s.getTasks({ initiative: i.id });
    expect(list.map((t) => t.title)).toEqual(["b", "a"]);
  });
  it("rejects a bad type and an empty title", async () => {
    const { s, i } = await seed();
    await expect(s.createTasks({ initiative: i.id, tasks: [{ title: "x", type: "epic" as any }] }, "t")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/tasks\[0\]\.type must be one of/) });
    await expect(s.createTasks({ initiative: i.id, tasks: [{ title: " ", type: "bug" }] }, "t")).rejects.toMatchObject({ status: 400 });
  });
  it("in_progress stamps assignee; blocked needs a reason; done sets completed_at", async () => {
    const { s, i } = await seed();
    const [t] = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "chore" }] }, "t");
    const ip = await s.updateTask(t.id, { status: "in_progress" }, "codex");
    expect(ip.assignee).toBe("codex");
    await expect(s.updateTask(t.id, { status: "blocked" }, "codex")).rejects.toMatchObject({ status: 400, message: "blocked requires a reason" });
    const bl = await s.updateTask(t.id, { status: "blocked", reason: "waiting on key" }, "codex");
    expect(bl.blocked_reason).toBe("waiting on key");
    const dn = await s.updateTask(t.id, { status: "done", note: "shipped" }, "codex");
    expect(dn.blocked_reason).toBe("");
    expect(dn.completed_at).not.toBeNull();
    const ev = await s.getEvents({ task: t.id });
    expect(ev.map((e) => e.kind)).toEqual(["note", "status", "status", "status", "created"]);
  });
  it("note alone logs an event without changing the task", async () => {
    const { s, i } = await seed();
    const [t] = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "chore" }] }, "t");
    const u = await s.updateTask(t.id, { note: "hi" }, "t");
    expect(u.status).toBe("todo");
    expect((await s.getEvents({ task: t.id }))[0]).toMatchObject({ kind: "note", data: { text: "hi" } });
  });
  it("moves between initiatives in the same project only", async () => {
    const { s, i, name } = await seed();
    const j = await s.createInitiative({ project: name, name: "J" }, "t");
    const other = uniq("q");
    await s.createProject({ name: other }, "t");
    const k = await s.createInitiative({ project: other, name: "K" }, "t");
    const [t] = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "chore" }] }, "t");
    const moved = await s.updateTask(t.id, { initiative: j.id }, "t");
    expect(moved.initiative_id).toBe(j.id);
    expect((await s.getEvents({ task: t.id }))[0].data).toMatchObject({ changed: ["initiative"], moved: { from: i.id, to: j.id } });
    await expect(s.updateTask(t.id, { initiative: k.id }, "t")).rejects.toMatchObject({ status: 400 });
  });
  it("getTasks filters by status and by project", async () => {
    const { s, i, name } = await seed();
    const [a, b] = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "bug" }, { title: "b", type: "bug" }] }, "t");
    await s.updateTask(b.id, { status: "done" }, "t");
    expect((await s.getTasks({ project: name, status: ["todo"] })).map((t) => t.id)).toEqual([a.id]);
    expect((await s.getTasks({ project: name })).map((t) => t.id)).toEqual([a.id, b.id]);
    await expect(s.getTasks({})).rejects.toMatchObject({ status: 400 });
  });
  it("stores a plan at creation and via update, and every object carries a url", async () => {
    const svc2 = new Service(env.DB, "https://track.example");
    const name = uniq("u");
    const p = await svc2.createProject({ name }, "t");
    expect(p.url).toBe(`https://track.example/#/p/${name}`);
    const i = await svc2.createInitiative({ project: name, name: "I" }, "t");
    expect(i.url).toBe(`${p.url}/i/${i.id}`);
    const [a, b] = await svc2.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "bug", plan: "1. look 2. fix" }, { title: "b", type: "bug" }] }, "t");
    expect(a.plan).toBe("1. look 2. fix");
    expect(a.url).toBe(`${i.url}/t/${a.id}`);
    const u = await svc2.updateTask(b.id, { plan: "step one", status: "in_progress" }, "codex");
    expect(u).toMatchObject({ plan: "step one", status: "in_progress", url: `${i.url}/t/${b.id}` });
    expect((await svc2.getEvents({ task: b.id }))[0].data).toMatchObject({ changed: ["plan"] });
    expect((await svc2.getTasks({ initiative: i.id }))[0].url).toContain("/t/");
    expect((await svc2.getProject(name)).initiatives[0].url).toBe(i.url);
    const s0 = svc();
    expect((await s0.getTask(a.id)).url).toBe(`/#/p/${name}/i/${i.id}/t/${a.id}`);
  });
  it("counts roll up per initiative in getProject and per project in getProjects", async () => {
    const { s, i, name } = await seed();
    const [a] = await s.createTasks({ initiative: i.id, tasks: [{ title: "a", type: "bug" }, { title: "b", type: "bug" }] }, "t");
    await s.updateTask(a.id, { status: "blocked", reason: "r" }, "t");
    const p = await s.getProject(name);
    expect(p.initiatives[0].counts).toMatchObject({ todo: 1, blocked: 1, done: 0 });
    const summary = (await s.getProjects()).find((x) => x.id === p.id)!;
    expect(summary).toMatchObject({ initiatives: 1, open_tasks: 2, blocked_tasks: 1 });
  });
});
