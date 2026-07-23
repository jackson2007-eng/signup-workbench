-- One-time migration: adds an optional logo to each agency (base64 image + mime type), served
-- back out through GET /api/agency-logo. This file is a record only once run — worker/schema.sql
-- is the source of truth for the resulting shape.
--   wrangler d1 execute paratransit-companion-db --local  --file=worker/migrations/0004_agency_logo.sql
--   wrangler d1 execute paratransit-companion-db --remote --file=worker/migrations/0004_agency_logo.sql

ALTER TABLE agencies ADD COLUMN logo_data TEXT;
ALTER TABLE agencies ADD COLUMN logo_mime TEXT;
