import { INITIATIVE_STATUSES, TASK_STATUSES, TASK_TYPES } from "./types";

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  minimum?: number;
  maximum?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const actor: Record<string, JsonSchema> = {
  actor: { type: "string", description: "Who is acting, e.g. 'claude-code'. Optional; defaults to the MCP client name." },
};
const str = (description: string): JsonSchema => ({ type: "string", description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties: { ...properties, ...actor },
  required,
  additionalProperties: false,
});

/** Every tool returns `{ data: <result> }` as structuredContent, and the same JSON as text. */
const OUTPUT: JsonSchema = { type: "object", properties: { data: {} }, required: ["data"] };

export const TOOLS: readonly ToolDef[] = [
  {
    name: "get_projects",
    description: "List projects with counts of active initiatives, open tasks and blocked tasks.",
    inputSchema: obj({ include_archived: { type: "boolean", description: "Include archived projects" } }),
    outputSchema: OUTPUT,
  },
  {
    name: "create_project",
    description: "Create a project, or return the existing one with the same name (idempotent by slug). Use the repo folder name unless the user names the project.",
    inputSchema: obj({ name: str("Project name, usually the repo folder name"), description: str("Optional description") }, ["name"]),
    outputSchema: OUTPUT,
  },
  {
    name: "get_project",
    description: "Get a project with its initiatives; each initiative carries task counts by status (todo, in_progress, blocked, done, cancelled).",
    inputSchema: obj({ project: str("Project slug or id") }, ["project"]),
    outputSchema: OUTPUT,
  },
  {
    name: "create_initiative",
    description: "Create an initiative (a goal-sized chunk of work) in a project. Put the goal and context in description.",
    inputSchema: obj(
      { project: str("Project slug or id"), name: str("Initiative name"), description: str("Goal, context, links (markdown)") },
      ["project", "name"],
    ),
    outputSchema: OUTPUT,
  },
  {
    name: "update_initiative",
    description: "Rename, describe, or set the status of an initiative (active | done | cancelled).",
    inputSchema: obj(
      {
        id: str("Initiative id"),
        name: str("New name"),
        description: str("New description (markdown)"),
        status: { type: "string", enum: INITIATIVE_STATUSES, description: "active | done | cancelled" },
      },
      ["id"],
    ),
    outputSchema: OUTPUT,
  },
  {
    name: "get_tasks",
    description:
      "List tasks for an initiative or a whole project, optionally filtered by status. Ordered todo, in_progress, blocked, done, cancelled; then by priority (0 = urgent). Pass status: [\"todo\"] to get what is ready to work on.",
    inputSchema: obj({
      initiative: str("Initiative id"),
      project: str("Project slug or id (used when initiative is omitted)"),
      status: { type: "array", items: { type: "string", enum: TASK_STATUSES }, description: "Only these statuses" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max tasks (default 200)" },
    }),
    outputSchema: OUTPUT,
  },
  {
    name: "create_tasks",
    description: "Create one or more tasks in an initiative. Each task needs an imperative title and a type: bug | feature | improvement | chore | research.",
    inputSchema: obj(
      {
        initiative: str("Initiative id"),
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: str("Imperative, specific, one verifiable outcome"),
              type: { type: "string", enum: TASK_TYPES, description: "bug | feature | improvement | chore | research" },
              notes: str("Details, acceptance criteria (markdown)"),
              priority: { type: "integer", minimum: 0, maximum: 4, description: "0 = urgent … 4 = someday (default 2)" },
            },
            required: ["title", "type"],
            additionalProperties: false,
          },
        },
      },
      ["initiative", "tasks"],
    ),
    outputSchema: OUTPUT,
  },
  {
    name: "update_task",
    description:
      "Update a task in one call: set status (todo | in_progress | blocked | done | cancelled; blocked requires reason), append a progress note, edit title/notes/type/priority, or move it to another initiative.",
    inputSchema: obj(
      {
        id: str("Task id"),
        status: { type: "string", enum: TASK_STATUSES, description: "New status" },
        reason: str("Why it is blocked (required with status = blocked)"),
        note: str("Progress note appended to the task log"),
        title: str("New title"),
        notes: str("New long-form notes (markdown), replaces existing"),
        type: { type: "string", enum: TASK_TYPES, description: "New type" },
        priority: { type: "integer", minimum: 0, maximum: 4, description: "New priority" },
        initiative: str("Move to this initiative id (same project)"),
      },
      ["id"],
    ),
    outputSchema: OUTPUT,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * Minimal JSON-schema validator covering the subset used above.
 * Returns an error sentence, or null when valid.
 */
export function validateArgs(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
    const v = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (v[key] === undefined || v[key] === null) return `${path === "arguments" ? "" : path + "."}${key} is required`;
    }
    for (const [key, val] of Object.entries(v)) {
      const sub = schema.properties?.[key];
      const p = path === "arguments" ? key : `${path}.${key}`;
      if (!sub) {
        if (schema.additionalProperties === false) return `${p} is not a known field`;
        continue;
      }
      if (val === undefined || val === null) continue;
      const err = validateArgs(sub, val, p);
      if (err) return err;
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must have at least ${schema.minItems} item(s)`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateArgs(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
    return null;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
    return null;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? null : `${path} must be true or false`;
  }
  return null;
}
