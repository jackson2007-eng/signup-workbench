-- One-time migration: introduces agencies as the data-sharing unit. projects moves from
-- per-user ownership to per-agency ownership; users gains agency_id. Run once against each
-- environment, then this file is a record only — worker/schema.sql is the source of truth for
-- the resulting shape.
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/migrations/0003_agencies.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/migrations/0003_agencies.sql

CREATE TABLE IF NOT EXISTS agencies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bootstrap agency for whatever approved user(s) already exist, named after the free-text
-- `agency` they entered at signup.
INSERT INTO agencies (name) VALUES ('Testing');

ALTER TABLE users ADD COLUMN agency_id INTEGER REFERENCES agencies(id);

UPDATE users SET agency_id = (SELECT id FROM agencies WHERE name = 'Testing')
WHERE status = 'approved' AND agency_id IS NULL;

ALTER TABLE projects RENAME TO projects_old_useridscoped;

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id   INTEGER NOT NULL REFERENCES agencies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('resourcing','callcentre','dispatch','annualplan','vacationplan')),
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_agency_kind ON projects(agency_id, kind);

INSERT INTO projects (agency_id, kind, name, start_date, end_date, payload, created_at, updated_at)
SELECT u.agency_id, p.kind, p.name, p.start_date, p.end_date, p.payload, p.created_at, p.updated_at
FROM projects_old_useridscoped p
JOIN users u ON u.id = p.user_id;

DROP TABLE projects_old_useridscoped;
