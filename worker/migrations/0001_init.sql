-- agent-track schema. Timestamps are unix milliseconds.
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE initiatives (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  position     REAL NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX initiatives_project ON initiatives(project_id, status, position);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  initiative_id  TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','chore','research')),
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
  priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  blocked_reason TEXT NOT NULL DEFAULT '',
  assignee       TEXT NOT NULL DEFAULT '',
  position       REAL NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX tasks_initiative ON tasks(initiative_id, status, position);
CREATE INDEX tasks_project ON tasks(project_id, status);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  initiative_id TEXT,
  task_id       TEXT,
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX events_task ON events(task_id, id);
CREATE INDEX events_project ON events(project_id, id);
