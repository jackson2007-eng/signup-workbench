-- One-time migration: projects goes from one-row-per-(user,kind) to many named, datable rows
-- per (user,kind). Run once against each environment, then this file is a record only —
-- worker/schema.sql is the source of truth for the resulting shape.
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/migrations/0002_multi_signup.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/migrations/0002_multi_signup.sql

ALTER TABLE projects RENAME TO projects_old_single;

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('resourcing','callcentre','dispatch','annualplan','vacationplan')),
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_user_kind ON projects(user_id, kind);

INSERT INTO projects (user_id, kind, name, payload, created_at, updated_at)
SELECT user_id, kind,
  CASE kind
    WHEN 'resourcing'   THEN 'My Signup'
    WHEN 'callcentre'   THEN 'My Schedule'
    WHEN 'dispatch'     THEN 'My Schedule'
    WHEN 'annualplan'   THEN 'My Plan'
    WHEN 'vacationplan' THEN 'My Vacation Plan'
  END,
  payload, updated_at, updated_at
FROM projects_old_single;

DROP TABLE projects_old_single;
