-- Agents write a short plan before starting a task.
ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT '';
