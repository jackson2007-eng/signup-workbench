-- Paratransit Companion — D1 schema. Source of truth; re-apply via
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/schema.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,               -- base64, PBKDF2 output
  password_salt        TEXT NOT NULL,                -- base64, random per-user
  password_iterations  INTEGER NOT NULL DEFAULT 210000,
  contact_name         TEXT NOT NULL,
  contact_email        TEXT NOT NULL,
  agency               TEXT NOT NULL,
  request_message      TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','disabled')),
  is_admin             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at          TEXT,
  approved_by          INTEGER REFERENCES users(id)
);

-- One saved slot per (user, kind) — matches the app's current one-project-per-module model.
CREATE TABLE IF NOT EXISTS projects (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('resourcing','callcentre','dispatch','annualplan','vacationplan')),
  payload     TEXT NOT NULL,          -- opaque JSON string, exactly what buildPayload() produces
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind)
);
