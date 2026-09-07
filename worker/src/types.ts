export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskType = "bug" | "feature" | "improvement" | "chore" | "research";
export type InitiativeStatus = "active" | "done" | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
export const TASK_TYPES: readonly TaskType[] = ["bug", "feature", "improvement", "chore", "research"];
export const INITIATIVE_STATUSES: readonly InitiativeStatus[] = ["active", "done", "cancelled"];

export interface Project {
  id: string;
  slug: string;
  url: string;
  name: string;
  description: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface Initiative {
  id: string;
  project_id: string;
  project_slug: string;
  url: string;
  name: string;
  description: string;
  status: InitiativeStatus;
  position: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface Task {
  id: string;
  project_id: string;
  project_slug: string;
  initiative_id: string;
  url: string;
  title: string;
  notes: string;
  plan: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  blocked_reason: string;
  assignee: string;
  position: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type EventKind = "created" | "status" | "updated" | "note";

export interface Event {
  id: number;
  project_id: string;
  initiative_id: string | null;
  task_id: string | null;
  actor: string;
  kind: EventKind;
  data: Record<string, unknown>;
  created_at: number;
}

export interface StatusCounts {
  todo: number;
  in_progress: number;
  blocked: number;
  done: number;
  cancelled: number;
}

export type ProjectSummary = Project & { initiatives: number; open_tasks: number; blocked_tasks: number };
export type InitiativeSummary = Initiative & { counts: StatusCounts };
export type ProjectDetail = Project & { initiatives: InitiativeSummary[] };

export interface NewTask {
  title: string;
  type: TaskType;
  notes?: string;
  plan?: string;
  priority?: number;
}

export interface TaskUpdate {
  status?: TaskStatus;
  reason?: string;
  note?: string;
  title?: string;
  notes?: string;
  plan?: string;
  type?: TaskType;
  priority?: number;
  initiative?: string;
  position?: number;
}

export interface InitiativeUpdate {
  name?: string;
  description?: string;
  status?: InitiativeStatus;
  position?: number;
}

export interface ProjectUpdate {
  name?: string;
  description?: string;
  archived?: boolean;
}
