import { all, batch, first, stmt } from "./db";
import {
  INITIATIVE_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  type Event,
  type EventKind,
  type Initiative,
  type InitiativeStatus,
  type InitiativeSummary,
  type InitiativeUpdate,
  type NewTask,
  type Project,
  type ProjectDetail,
  type ProjectSummary,
  type ProjectUpdate,
  type StatusCounts,
  type Task,
  type TaskStatus,
  type TaskType,
  type TaskUpdate,
} from "./types";
import { HttpError, newId, now, slugify } from "./util";

const OPEN = "('todo','in_progress','blocked')";
const STATUS_RANK = "CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 ELSE 4 END";

function emptyCounts(): StatusCounts {
  return { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 };
}

function cleanText(value: unknown, field: string, { required = false, max = 4000 } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = value.trim();
  if (required && !s) throw new HttpError(400, `${field} must not be empty`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function priorityOf(value: unknown): number {
  if (value === undefined || value === null) return 2;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) {
    throw new HttpError(400, "priority must be an integer from 0 (urgent) to 4 (someday)");
  }
  return value;
}

/**
 * All business rules live here. Every mutation:
 *  - runs as one D1 batch (atomic),
 *  - appends one event,
 *  - bumps projects.updated_at (the SSE watermark).
 */
export class Service {
  /** `baseUrl` is the public origin (from the request); links are relative when empty. */
  constructor(private db: D1Database, private baseUrl = "") {}

  private projectUrl(slug: string) { return `${this.baseUrl}/#/p/${encodeURIComponent(slug)}`; }
  private initiativeUrl(slug: string, id: string) { return `${this.projectUrl(slug)}/i/${id}`; }
  private taskUrl(slug: string, initiativeId: string, id: string) { return `${this.initiativeUrl(slug, initiativeId)}/t/${id}`; }
  private projOut<T extends Omit<Project, "url">>(p: T): T & { url: string } { return { ...p, url: this.projectUrl(p.slug) }; }
  private initOut<T extends Omit<Initiative, "url">>(i: T): T & { url: string } { return { ...i, url: this.initiativeUrl(i.project_slug, i.id) }; }
  private taskOut<T extends Omit<Task, "url">>(t: T): T & { url: string } { return { ...t, url: this.taskUrl(t.project_slug, t.initiative_id, t.id) }; }

  // ---------- projects ----------

  async createProject(input: { name: string; description?: string }, actor: string): Promise<Project> {
    const name = cleanText(input.name, "name", { required: true, max: 200 })!;
    const description = cleanText(input.description, "description") ?? "";
    const slug = slugify(name);
    const existing = await first<Omit<Project, "url">>(this.db, "SELECT * FROM projects WHERE slug = ?", slug);
    if (existing) return this.projOut(existing);
    const ts = now();
    const project: Project = this.projOut({ id: newId(), slug, name, description, archived: 0, created_at: ts, updated_at: ts });
    await batch(this.db, [
      stmt(
        this.db,
        "INSERT INTO projects (id, slug, name, description, archived, created_at, updated_at) VALUES (?,?,?,?,0,?,?)",
        project.id,
        slug,
        name,
        description,
        ts,
        ts,
      ),
      this.eventStmt({ project_id: project.id, actor, kind: "created", data: { name }, ts }),
    ]);
    return project;
  }

  async getProjects(opts: { includeArchived?: boolean } = {}): Promise<ProjectSummary[]> {
    const where = opts.includeArchived ? "" : "WHERE p.archived = 0";
    const rows = await all<Omit<ProjectSummary, "url">>(
      this.db,
      `SELECT p.*,
        (SELECT COUNT(*) FROM initiatives i WHERE i.project_id = p.id AND i.status = 'active') AS initiatives,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ${OPEN}) AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blocked_tasks
       FROM projects p ${where} ORDER BY p.updated_at DESC`,
    );
    return rows.map((p) => this.projOut(p));
  }

  /** Resolve a project by id or slug. */
  async resolveProject(ref: string): Promise<Project> {
    const r = cleanText(ref, "project", { required: true, max: 200 })!;
    const p =
      (await first<Omit<Project, "url">>(this.db, "SELECT * FROM projects WHERE id = ?", r)) ??
      (await first<Omit<Project, "url">>(this.db, "SELECT * FROM projects WHERE slug = ?", r.toLowerCase()));
    if (!p) throw new HttpError(404, `project '${r}' not found`);
    return this.projOut(p);
  }

  async getProject(ref: string): Promise<ProjectDetail> {
    const p = await this.resolveProject(ref);
    const initiatives = await all<Omit<Initiative, "url" | "project_slug">>(
      this.db,
      "SELECT * FROM initiatives WHERE project_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, position",
      p.id,
    );
    const rows = await all<{ initiative_id: string; status: TaskStatus; n: number }>(
      this.db,
      "SELECT initiative_id, status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY initiative_id, status",
      p.id,
    );
    const counts = new Map<string, StatusCounts>();
    for (const r of rows) {
      const c = counts.get(r.initiative_id) ?? emptyCounts();
      c[r.status] = r.n;
      counts.set(r.initiative_id, c);
    }
    return {
      ...p,
      initiatives: initiatives.map((i): InitiativeSummary => this.initOut({ ...i, project_slug: p.slug, counts: counts.get(i.id) ?? emptyCounts() })),
    };
  }

  async updateProject(id: string, patch: ProjectUpdate, actor: string): Promise<Project> {
    const row = await first<Omit<Project, "url">>(this.db, "SELECT * FROM projects WHERE id = ?", id);
    if (!row) throw new HttpError(404, `project '${id}' not found`);
    const p = this.projOut(row);
    const changed: string[] = [];
    const name = cleanText(patch.name, "name", { max: 200 });
    if (name !== undefined && name !== p.name) {
      if (!name) throw new HttpError(400, "name must not be empty");
      p.name = name;
      changed.push("name");
    }
    const description = cleanText(patch.description, "description");
    if (description !== undefined && description !== p.description) {
      p.description = description;
      changed.push("description");
    }
    if (patch.archived !== undefined) {
      const a = patch.archived ? 1 : 0;
      if (a !== p.archived) {
        p.archived = a;
        changed.push("archived");
      }
    }
    if (changed.length === 0) return p;
    const ts = now();
    p.updated_at = ts;
    await batch(this.db, [
      stmt(
        this.db,
        "UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?",
        p.name,
        p.description,
        p.archived,
        ts,
        id,
      ),
      this.eventStmt({ project_id: id, actor, kind: "updated", data: { changed }, ts }),
    ]);
    return p;
  }

  // ---------- initiatives ----------

  async createInitiative(input: { project: string; name: string; description?: string }, actor: string): Promise<Initiative> {
    const p = await this.resolveProject(input.project);
    const name = cleanText(input.name, "name", { required: true, max: 200 })!;
    const description = cleanText(input.description, "description", { max: 20000 }) ?? "";
    const pos = await first<{ m: number | null }>(this.db, "SELECT MAX(position) AS m FROM initiatives WHERE project_id = ?", p.id);
    const ts = now();
    const initiative: Initiative = this.initOut({
      id: newId(),
      project_id: p.id,
      project_slug: p.slug,
      name,
      description,
      status: "active",
      position: (pos?.m ?? 0) + 1,
      created_by: actor,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    });
    await batch(this.db, [
      stmt(
        this.db,
        "INSERT INTO initiatives (id, project_id, name, description, status, position, created_by, created_at, updated_at) VALUES (?,?,?,?,'active',?,?,?,?)",
        initiative.id,
        p.id,
        name,
        description,
        initiative.position,
        actor,
        ts,
        ts,
      ),
      this.touchStmt(p.id, ts),
      this.eventStmt({ project_id: p.id, initiative_id: initiative.id, actor, kind: "created", data: { name }, ts }),
    ]);
    return initiative;
  }

  async getInitiative(id: string): Promise<Initiative> {
    const i = await first<Omit<Initiative, "url">>(
      this.db,
      "SELECT i.*, p.slug AS project_slug FROM initiatives i JOIN projects p ON p.id = i.project_id WHERE i.id = ?",
      cleanText(id, "initiative", { required: true })!,
    );
    if (!i) throw new HttpError(404, `initiative '${id}' not found`);
    return this.initOut(i);
  }

  async updateInitiative(id: string, patch: InitiativeUpdate, actor: string): Promise<Initiative> {
    const i = await this.getInitiative(id);
    const ts = now();
    const stmts: D1PreparedStatement[] = [];
    const changed: string[] = [];

    const name = cleanText(patch.name, "name", { max: 200 });
    if (name !== undefined && name !== i.name) {
      if (!name) throw new HttpError(400, "name must not be empty");
      i.name = name;
      changed.push("name");
    }
    const description = cleanText(patch.description, "description", { max: 20000 });
    if (description !== undefined && description !== i.description) {
      i.description = description;
      changed.push("description");
    }
    if (patch.position !== undefined) {
      if (typeof patch.position !== "number" || !Number.isFinite(patch.position)) throw new HttpError(400, "position must be a number");
      if (patch.position !== i.position) {
        i.position = patch.position;
        changed.push("position");
      }
    }
    if (patch.status !== undefined) {
      const status = oneOf<InitiativeStatus>(patch.status, INITIATIVE_STATUSES, "status");
      if (status !== i.status) {
        stmts.push(this.eventStmt({ project_id: i.project_id, initiative_id: i.id, actor, kind: "status", data: { from: i.status, to: status }, ts }));
        i.status = status;
        i.completed_at = status === "active" ? null : ts;
      }
    }
    if (changed.length > 0) {
      stmts.push(this.eventStmt({ project_id: i.project_id, initiative_id: i.id, actor, kind: "updated", data: { changed }, ts }));
    }
    if (stmts.length === 0) return i;

    i.updated_at = ts;
    stmts.unshift(
      stmt(
        this.db,
        "UPDATE initiatives SET name = ?, description = ?, status = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?",
        i.name,
        i.description,
        i.status,
        i.position,
        ts,
        i.completed_at,
        i.id,
      ),
      this.touchStmt(i.project_id, ts),
    );
    await batch(this.db, stmts);
    return i;
  }

  // ---------- tasks ----------

  async createTasks(input: { initiative: string; tasks: NewTask[] }, actor: string): Promise<Task[]> {
    const i = await this.getInitiative(input.initiative);
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new HttpError(400, "tasks must be a non-empty array");
    if (input.tasks.length > 100) throw new HttpError(400, "at most 100 tasks per call");

    const pos = await first<{ m: number | null }>(this.db, "SELECT MAX(position) AS m FROM tasks WHERE initiative_id = ?", i.id);
    let position = pos?.m ?? 0;
    const ts = now();
    const tasks: Task[] = input.tasks.map((t, idx) => {
      const field = `tasks[${idx}]`;
      const title = cleanText(t?.title, `${field}.title`, { required: true, max: 500 })!;
      const type = oneOf<TaskType>(t?.type, TASK_TYPES, `${field}.type`);
      const notes = cleanText(t?.notes, `${field}.notes`, { max: 20000 }) ?? "";
      const plan = cleanText(t?.plan, `${field}.plan`, { max: 20000 }) ?? "";
      const priority = priorityOf(t?.priority);
      position += 1;
      return this.taskOut({
        id: newId(),
        project_id: i.project_id,
        project_slug: i.project_slug,
        initiative_id: i.id,
        title,
        notes,
        plan,
        type,
        status: "todo",
        priority,
        blocked_reason: "",
        assignee: "",
        position,
        created_by: actor,
        created_at: ts,
        updated_at: ts,
        completed_at: null,
      });
    });

    const stmts: D1PreparedStatement[] = [];
    for (const t of tasks) {
      stmts.push(
        stmt(
          this.db,
          "INSERT INTO tasks (id, project_id, initiative_id, title, notes, plan, type, status, priority, blocked_reason, assignee, position, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'todo',?,'','',?,?,?,?)",
          t.id,
          t.project_id,
          t.initiative_id,
          t.title,
          t.notes,
          t.plan,
          t.type,
          t.priority,
          t.position,
          actor,
          ts,
          ts,
        ),
        this.eventStmt({ project_id: t.project_id, initiative_id: t.initiative_id, task_id: t.id, actor, kind: "created", data: { title: t.title, type: t.type }, ts }),
      );
    }
    stmts.push(this.touchStmt(i.project_id, ts));
    await batch(this.db, stmts);
    return tasks;
  }

  async getTask(id: string): Promise<Task> {
    const t = await first<Omit<Task, "url">>(
      this.db,
      "SELECT t.*, p.slug AS project_slug FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
      cleanText(id, "id", { required: true })!,
    );
    if (!t) throw new HttpError(404, `task '${id}' not found`);
    return this.taskOut(t);
  }

  async getTasks(opts: { initiative?: string; project?: string; status?: string[]; limit?: number }): Promise<Task[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.initiative) {
      const i = await this.getInitiative(opts.initiative);
      where.push("t.initiative_id = ?");
      params.push(i.id);
    } else if (opts.project) {
      const p = await this.resolveProject(opts.project);
      where.push("t.project_id = ?");
      params.push(p.id);
    } else {
      throw new HttpError(400, "initiative or project is required");
    }
    if (opts.status && opts.status.length > 0) {
      const statuses = opts.status.map((s) => oneOf<TaskStatus>(s, TASK_STATUSES, "status"));
      where.push(`t.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    let limit = 200;
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500) throw new HttpError(400, "limit must be an integer from 1 to 500");
      limit = opts.limit;
    }
    params.push(limit);
    const rows = await all<Omit<Task, "url">>(
      this.db,
      `SELECT t.*, p.slug AS project_slug FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where.join(" AND ")} ORDER BY ${STATUS_RANK.replaceAll("status", "t.status")}, t.priority, t.position LIMIT ?`,
      ...params,
    );
    return rows.map((t) => this.taskOut(t));
  }

  async updateTask(id: string, patch: TaskUpdate, actor: string): Promise<Task> {
    const t = await this.getTask(id);
    const ts = now();
    const stmts: D1PreparedStatement[] = [];
    const changed: string[] = [];
    let moved: { from: string; to: string } | undefined;
    const base = { project_id: t.project_id, initiative_id: t.initiative_id, task_id: t.id, actor, ts };

    const title = cleanText(patch.title, "title", { max: 500 });
    if (title !== undefined && title !== t.title) {
      if (!title) throw new HttpError(400, "title must not be empty");
      t.title = title;
      changed.push("title");
    }
    const notes = cleanText(patch.notes, "notes", { max: 20000 });
    if (notes !== undefined && notes !== t.notes) {
      t.notes = notes;
      changed.push("notes");
    }
    const plan = cleanText(patch.plan, "plan", { max: 20000 });
    if (plan !== undefined && plan !== t.plan) {
      t.plan = plan;
      changed.push("plan");
    }
    if (patch.type !== undefined) {
      const type = oneOf<TaskType>(patch.type, TASK_TYPES, "type");
      if (type !== t.type) {
        t.type = type;
        changed.push("type");
      }
    }
    if (patch.priority !== undefined) {
      const priority = priorityOf(patch.priority);
      if (priority !== t.priority) {
        t.priority = priority;
        changed.push("priority");
      }
    }
    if (patch.position !== undefined) {
      if (typeof patch.position !== "number" || !Number.isFinite(patch.position)) throw new HttpError(400, "position must be a number");
      if (patch.position !== t.position) {
        t.position = patch.position;
        changed.push("position");
      }
    }
    if (patch.initiative !== undefined) {
      const target = await this.getInitiative(patch.initiative);
      if (target.project_id !== t.project_id) throw new HttpError(400, "cannot move a task to an initiative in another project");
      if (target.id !== t.initiative_id) {
        changed.push("initiative");
        moved = { from: t.initiative_id, to: target.id };
        t.initiative_id = target.id;
        t.url = this.taskUrl(t.project_slug, target.id, t.id);
        base.initiative_id = target.id;
      }
    }
    if (patch.status !== undefined) {
      const status = oneOf<TaskStatus>(patch.status, TASK_STATUSES, "status");
      const reason = cleanText(patch.reason, "reason", { max: 2000 });
      if (status === "blocked" && !reason) throw new HttpError(400, "blocked requires a reason");
      if (status !== t.status || (status === "blocked" && reason !== t.blocked_reason)) {
        const data: Record<string, unknown> = { from: t.status, to: status };
        if (status === "blocked") data.reason = reason;
        stmts.push(this.eventStmt({ ...base, kind: "status", data, ts }));
        if (status === "in_progress" && !t.assignee) t.assignee = actor;
        t.blocked_reason = status === "blocked" ? reason! : "";
        t.completed_at = status === "done" || status === "cancelled" ? ts : null;
        t.status = status;
      }
    }
    if (changed.length > 0) {
      stmts.push(this.eventStmt({ ...base, kind: "updated", data: moved ? { changed, moved } : { changed }, ts }));
    }
    const note = cleanText(patch.note, "note", { max: 20000 });
    if (note) {
      stmts.push(this.eventStmt({ ...base, kind: "note", data: { text: note }, ts }));
    }
    if (stmts.length === 0) return t;

    t.updated_at = ts;
    stmts.unshift(
      stmt(
        this.db,
        "UPDATE tasks SET initiative_id = ?, title = ?, notes = ?, plan = ?, type = ?, status = ?, priority = ?, blocked_reason = ?, assignee = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?",
        t.initiative_id,
        t.title,
        t.notes,
        t.plan,
        t.type,
        t.status,
        t.priority,
        t.blocked_reason,
        t.assignee,
        t.position,
        ts,
        t.completed_at,
        t.id,
      ),
      this.touchStmt(t.project_id, ts),
    );
    await batch(this.db, stmts);
    return t;
  }

  // ---------- events ----------

  async getEvents(opts: { project?: string; initiative?: string; task?: string; limit?: number }): Promise<Event[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.task) {
      where.push("task_id = ?");
      params.push(opts.task);
    } else if (opts.initiative) {
      where.push("initiative_id = ?");
      params.push(opts.initiative);
    } else if (opts.project) {
      const p = await this.resolveProject(opts.project);
      where.push("project_id = ?");
      params.push(p.id);
    } else {
      throw new HttpError(400, "project, initiative or task is required");
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    params.push(limit);
    const rows = await all<Omit<Event, "data"> & { data: string }>(
      this.db,
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      ...params,
    );
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  /** Project watermark for the SSE feed. */
  async projectVersion(projectId: string): Promise<number | null> {
    const r = await first<{ updated_at: number }>(this.db, "SELECT updated_at FROM projects WHERE id = ?", projectId);
    return r?.updated_at ?? null;
  }

  // ---------- helpers ----------

  private touchStmt(projectId: string, ts: number): D1PreparedStatement {
    return stmt(this.db, "UPDATE projects SET updated_at = ? WHERE id = ?", ts, projectId);
  }

  private eventStmt(e: {
    project_id: string;
    initiative_id?: string | null;
    task_id?: string | null;
    actor: string;
    kind: EventKind;
    data: Record<string, unknown>;
    ts: number;
  }): D1PreparedStatement {
    return stmt(
      this.db,
      "INSERT INTO events (project_id, initiative_id, task_id, actor, kind, data, created_at) VALUES (?,?,?,?,?,?,?)",
      e.project_id,
      e.initiative_id ?? null,
      e.task_id ?? null,
      e.actor,
      e.kind,
      JSON.stringify(e.data),
      e.ts,
    );
  }
}
