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

## Idea stage — planning & administration modules (added 2026-07-15)

- **Annual Trip Forecaster** — project ridership forward from historical trips (Service Tracker history is the natural input): trend + seasonality by day type, registrant growth, scenario sliders (growth %, service changes). Output feeds the signup tool's demand scaling and the annual plan below.
- **Annual Service Plan & Budget tool** — turn a trip forecast into planned service hours and dollars for the year: forecast trips ÷ target productivity = vehicle-hours, × rates (city hourly cost, contractor rates, taxi per-trip) = budget, split by provider share. Works hand-in-hand with the Service Tracker: the plan sets the monthly/daily budget line, the tracker's actuals plot against it (plan-vs-actual variance is the report every manager asks for).
- **Employee Performance Tracking** — per-operator/agent metrics (on-time, productivity, absences, incidents). ⚠ First module that would hold *personal* data — breaks the current "no PII anywhere" doctrine that the toolkit's procurement story leans on. Needs a deliberate decision: employee IDs only, local-only storage, or accept the posture change (likely pairs with the phase-2 accounts work, not before).
- **Customer Complaints & Concerns** — log, categorize, and trend complaints/commendations (by type, provider, route/area, day), track resolution status and response times, feed a monthly summary. Same PII caution as above (customer names/contacts) — categorized aggregate trending can be built PII-light; case management cannot.

## Signup workbench enhancements (parked)
- Editable stat-holiday template in the UI (currently a hardcoded constant applied via button).
- Growth % scaler on uploaded demand (size next signup for projected ridership).
- Max-% split-shift constraint in generation.
- Representative-day / multi-day demand profiling (build the curve from many days of data, not one export).

## Call centre enhancements (parked)
- Feed the Erlang required-agents curve into an auto-generator for agent shifts (mirror of the operator Signup Builder).
- Per-skill / per-queue staffing (bookings vs cancellations vs where's-my-ride).

## Commercialization (added 2026-07-16)

**Go-to-market: operator signup workbench first.** Addressable market ≈ 400–800 North-American agencies large enough to run structured signups (20+ vehicles, seniority/union bids, 2–4 signups/yr), plus paratransit contractors (Transdev/MV-class divisions). No direct competitor in the niche — incumbent suites are six-figure and fixed-route-first; the status quo is Excel. Value anchor: one weekly package ≈ $80–100k/yr loaded labor; demand-calibrated sizing that finds ±1–2 packages pays for the tool ~20× on the first bid.

**Pricing (price to procurement thresholds, not to value)** — flat annual, unlimited planners, keep every tier under typical purchase-card/sole-source limits ($5–10k) to avoid RFPs:

| Tier | Fleet | Price/yr |
|---|---|---|
| Small | < 25 vehicles | $1,800 |
| Standard | 25–75 | $4,800 |
| Large | 75+ | $9,600 |

**Revenue expectations (honest):** Yr 1: 3–8 agencies ($15–40k ARR, own network + one CTAA/TRB demand-response conference). Yr 2–3: 20–40 ($100–200k, references + validated-against-real-data case study). Mature niche standard: 100–200 ($500k–1M). Caveats: 3–12-month gov sales cycles, hands-on first customers, "solo tool" objection (answered by the no-data-stored architecture).

**Payment/licensing plan (stateless, fits the no-backend doctrine):**
1. Merchant-of-record (Lemon Squeezy or Paddle) for checkout, subscriptions, tax, and native license keys — customer billing data lives entirely with them.
2. One Worker route validates a license key against the provider's API and returns a ~7-day signed token cached in the browser; weekly re-validation, offline grace. No user database — only a signing secret in Worker env.
3. **Trial = demo mode, not a countdown:** everything free and fully interactive on the shipped sample data; upload demand/signup, save/load project, and export gated behind the license. Maps the paywall onto the value line (playing free, operating paid) and stays procurement-friendly.
4. Optional hard gate later: Worker withholds the app bundle without a valid token — real enforcement, still no customer DB. License keys become the entitlement behind phase-2 accounts when those arrive.

## Ops / infra chores
- Connect a real domain (replace `transit-toolkit.jackson2007.workers.dev`).
- Delete the old obsolete worker.
- Rename the GitHub repo (signup-workbench → toolkit-wide name).

## Recently shipped
- 2026-07-16/17 — Requirement-lines rework (water-fill under fleet cap + deployment-pattern line, then folded into Size-to-requirement after cleanup); demand-data integrity (persistent pasted-totals detection + ÷6 repair, cycle-time plausibility guard, pin-known-productivity calibration); occupancy target fixed to cycle-only window; Gap tooltip shows true shortfall; pull-out/pull-in staging drawn violet; prev/next step navigation; reclassification chips on flagged shifts; drag-in-place from full board; "Flagged first" + end-time sorts.
- 2026-07-15 — Signup Builder "Size to requirement": package count from capped weekly vehicle-hours ÷ 40.
- 2026-07-15 — Coverage "Requirement mode": demand-implied vehicle-hours water-filled under the fleet cap.
- 2026-07 — Stat-holiday template + auto-assignment to shifts; sign-in stagger strip; arrow-key run navigation; coverage click-to-filter-runs.
- 2026-07 — Call Centre Staffing module (ACD parser, Erlang C overlay, arrivals, composition/queues).
- Earlier — see git history and CLAUDE.md.
