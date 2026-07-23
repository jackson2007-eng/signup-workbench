-- One-time migration: widens projects.kind's CHECK constraint to allow 'dailyservice' (the new
-- Daily Service Report module). SQLite can't ALTER a CHECK constraint in place, so this recreates
-- the table exactly as schema.sql now defines it and copies every row across unchanged. Run once
-- against each environment, then this file is a record only — worker/schema.sql is the source of
-- truth for the resulting shape.
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/migrations/0005_dailyservice_kind.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/migrations/0005_dailyservice_kind.sql

ALTER TABLE projects RENAME TO projects_old_kindcheck;

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id   INTEGER NOT NULL REFERENCES agencies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('resourcing','callcentre','dispatch','annualplan','vacationplan','dailyservice')),
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_agency_kind ON projects(agency_id, kind);

INSERT INTO projects (id, agency_id, kind, name, start_date, end_date, payload, created_at, updated_at)
SELECT id, agency_id, kind, name, start_date, end_date, payload, created_at, updated_at
FROM projects_old_kindcheck;

DROP TABLE projects_old_kindcheck;
