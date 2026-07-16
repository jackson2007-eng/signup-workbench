# Roadmap & product features

The living backlog for the Transit Operations Toolkit. Items move down the page as they ship.
Conventions: dates are when the item was added or shipped; "parked" means deliberately deferred, not rejected.
Design doctrine (flag-never-block, no PII, agency-generic language, no speculative backend) lives in [CLAUDE.md](CLAUDE.md) and applies to everything here.

## Modules live today

| Route | Module |
|---|---|
| `/resourcing` | Operator Signup Workbench — rules, demand, signup builder/optimizer, coverage, shift builder, packaging, suggestions, exception days, export |
| `/callcentre` | Call Centre Staffing — ACD upload → concurrency curve, Erlang C required-agents overlay, arrival-rate curve, composition & queues |

## Next up

### Service Performance Tracker (new module, `/service`) — added 2026-07-15
A tracker for the daily service report agencies already keep in Excel (modelled on the DATS Daily Service Report): daily date × provider records of booked/delivered trips, hours, passengers, and optionally cost.

- **Phase 1 — file-based (build first):** downloadable template + xlsx upload, plus a quick daily-entry form. Derived KPIs, computed never typed: productivity (pax/hr, revenue-vs-paid hours explicit), attrition % (booked vs delivered), provider share of delivered trips, cost per trip/hour via a contractor-rates card. Views: day-of-week patterns, month-over-month trends, provider-mix stacked bars, threshold flags. History rides in project JSON. **Data model = flat rows from day one** (`{date, provider, booked, delivered, hours, passengers, cost}`) so later phases are plumbing, not redesign.
- **Killer feature:** "Calibrate signup tool from actuals" — sets `demandShare` and validates `avgCycleTime` in `/resourcing` from measured share-by-day-type and productivity (the two numbers behind the vehicle over-inflation problem).
- **Phase 1.5 — local persistence:** localStorage/IndexedDB so daily entry survives closing the tab, + export-history button. No backend.
- **Phase 2 — accounts (parked until a second agency is real):** Cloudflare D1 (records) + KV (sessions) + email-link auth on the existing Workers deploy. Daily-entry habit is what justifies accounts; signup/call-centre project saves can join later. Changes the security posture from "nothing leaves your browser" to "we store your operational data" — needs ToS/backup/support answers before building.

### Carried from earlier planning
- Compare & Publish module — scenario comparison, posting-format export, change memo.
- Certified-ceiling computation (LP/MILP) — premium-tier candidate.

## Signup workbench enhancements (parked)
- Editable stat-holiday template in the UI (currently a hardcoded constant applied via button).
- Growth % scaler on uploaded demand (size next signup for projected ridership).
- Max-% split-shift constraint in generation.
- Representative-day / multi-day demand profiling (build the curve from many days of data, not one export).

## Call centre enhancements (parked)
- Feed the Erlang required-agents curve into an auto-generator for agent shifts (mirror of the operator Signup Builder).
- Per-skill / per-queue staffing (bookings vs cancellations vs where's-my-ride).

## Ops / infra chores
- Connect a real domain (replace `transit-toolkit.jackson2007.workers.dev`).
- Delete the old obsolete worker.
- Rename the GitHub repo (signup-workbench → toolkit-wide name).

## Recently shipped
- 2026-07-15 — Signup Builder "Size to requirement": package count from capped weekly vehicle-hours ÷ 40.
- 2026-07-15 — Coverage "Requirement mode": demand-implied vehicle-hours water-filled under the fleet cap.
- 2026-07 — Stat-holiday template + auto-assignment to shifts; sign-in stagger strip; arrow-key run navigation; coverage click-to-filter-runs.
- 2026-07 — Call Centre Staffing module (ACD parser, Erlang C overlay, arrivals, composition/queues).
- Earlier — see git history and CLAUDE.md.
