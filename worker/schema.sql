-- Paratransit Companion — D1 schema. Source of truth; re-apply via
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/schema.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/schema.sql

-- An agency is the data-sharing unit: every user belongs to one (once approved), and saved
-- signups belong to the agency, not the individual user, so teammates at the same agency see
-- and edit each other's work.
-- logo_data is a base64-encoded image (capped at ~300KB decoded, enforced by the Worker on
-- upload), served back out through GET /api/agency-logo rather than embedded in JSON responses
-- like /api/me — keeps the common per-request payload small and lets the browser cache the image.
CREATE TABLE IF NOT EXISTS agencies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  logo_data   TEXT,
  logo_mime   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,               -- base64, PBKDF2 output
  password_salt        TEXT NOT NULL,                -- base64, random per-user
  password_iterations  INTEGER NOT NULL DEFAULT 210000,
  contact_name         TEXT NOT NULL,
  contact_email        TEXT NOT NULL,
  agency               TEXT NOT NULL,               -- free text the requester typed at signup; NOT the same as agency_id below (admin context only)
  request_message      TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','disabled')),
  is_admin             INTEGER NOT NULL DEFAULT 0,
  agency_id            INTEGER REFERENCES agencies(id), -- null while pending; set by the Worker at approval time, never null once approved
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at          TEXT,
  approved_by          INTEGER REFERENCES users(id)
);

-- Many named, datable signups per (agency, kind) — an agency's team can save and reopen
-- multiple signups per module (e.g. "Fall 2026" vs "Spring 2027" in Resourcing), shared by every
-- user at that agency. start_date/end_date are just identifying metadata for the list/switcher
-- UI, independent of any date-range concept a module's own payload might carry internally (e.g.
-- Resourcing's signupPeriod). payload is nullable: a freshly-created signup has no payload until
-- its first autosave.
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id   INTEGER NOT NULL REFERENCES agencies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('resourcing','callcentre','dispatch','annualplan','vacationplan','dailyservice')),
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  payload     TEXT,                  -- opaque JSON string, exactly what buildPayload() produces
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_agency_kind ON projects(agency_id, kind);
