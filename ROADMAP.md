# Roadmap & product features

The living backlog for the Transit Operations Toolkit. Items move down the page as they ship.
Conventions: dates are when the item was added or shipped; "parked" means deliberately deferred, not rejected.
Design doctrine (flag-never-block, no PII, agency-generic language, no speculative backend) lives in [CLAUDE.md](CLAUDE.md) and applies to everything here.

## Modules live today

| Route | Module |
|---|---|
| `/resourcing` | Operator Signup Workbench — rules, demand, signup builder/optimizer, coverage, shift builder, packaging, suggestions, exception days, export |
| `/callcentre` | Call Centre Staffing — ACD upload → concurrency curve, Erlang C required-agents overlay, arrival-rate curve, composition & queues |
| `/dispatch` | Dispatch Desks — concurrent-incident load, dispatcher-ratio sizing, full parity with the operator workbench |
| `/annualplan` | Annual Service Plan — v1: total daily trips projected from prior-year history (day-of-week + statutory-holiday matched) + growth %, split across capacity/remainder providers by scheduled hours × productivity |

## Next up

### Daily Service Report (new module, `/dailyservice`) — added 2026-07-22, paused

Reviewed against a real 2026 DATS Daily Service Report export (44 pages) — a before/after-
service-day tracker per provider: budgeted (before-the-day) vs. actual (after-the-day)
hours, trips, AMB/non-AMB (WAM) passenger splits, escorts, trips/hr, cost/trip, attrition %,
wait-list carryover, same-day trips. Explicitly paused by the user in favor of building the
Annual Service Plan tool first (`/annualplan`, shipped 2026-07-22) — the annual plan's
per-day/per-provider projected-trips output is meant to hand off as the Daily Service
Report's budgeted baseline calendar, so building it second avoids rework. Pick this up once
that handoff (annual plan → daily budgeted baseline) is scoped. v1 of the annual plan is
total-trips-only (no AMB/WAM split) — the Daily Service Report will need that granularity
layered on, either in its own v1 or as a shared follow-up to the annual plan.

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

- **Annual Trip Forecaster** — project ridership forward from historical trips (Service Tracker history is the natural input): trend + seasonality by day type, registrant growth, scenario sliders (growth %, service changes). Now folded into `/annualplan`'s Projection tab (day-of-week + statutory-holiday matching + a single annual growth %) rather than a separate module.
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

**Tiers (added 2026-07-19)** — the free tier is a genuine planning tool, not a countdown demo; the paywall sits on automation and on taking work out of the browser, not on thinking:

- **Free — Individual/Explorer.** Full Rules tab (classification, breaks, limits, scheduling-algorithm sliders — no reason to gate settings). Demand tab, sketch mode only. Shift Builder fully manual (add shift, drag, nudge, duplicate, remove). Full Coverage scoring/chart, so the free tier shows real payoff, not a teaser. Usable solo, indefinitely, for real planning — not sample-data-only.
- **Premium — monthly/annual**, the existing fleet-size pricing table below. Everything in Free, plus: real demand-data upload, Signup Builder auto-generate, the full optimizer suite (Suggestions/Deep Optimize/Retime), Packaging tab, and — the actual trigger — **Save/Load project and Export**. Open question: bundle Call Centre/Dispatch into Premium, or sell as add-on modules once they have optimizer/Suggestions parity with the operator tool?
- **Enterprise — custom quote.** Real multi-user accounts (phase-2 accounts work below: D1 + KV + email-link auth) so more than one planner shares live project state instead of passing JSON files around, plus procurement paperwork (security questionnaires, insurance certs, W9) and hands-on onboarding. Note the honest tradeoff: accounts mean agency data leaves the browser and lives on our infrastructure — a real departure from "nothing leaves your browser," acceptable specifically at the tier where a customer expects and pays for infrastructure, not a free upgrade to build.

**Payment/licensing mechanics (stateless, fits the no-backend doctrine — Free/Premium only; Enterprise needs phase-2 accounts):**
1. Merchant-of-record (Lemon Squeezy or Paddle) for checkout, subscriptions, tax, and native license keys — customer billing data lives entirely with them.
2. One Worker route validates a license key against the provider's API and returns a ~7-day signed token cached in the browser; weekly re-validation, offline grace. No user database — only a signing secret in Worker env.
3. Gate lives entirely client-side (Free vs. Premium feature checks), same posture as the "everything ships to the browser regardless" reality already discussed — this is a monetization/conversion gate, not a code-secrecy measure.
4. Optional hard gate later: Worker withholds the app bundle without a valid token — real enforcement, still no customer DB. License keys become the entitlement behind phase-2 accounts when those arrive.

## AI-assisted schedule import (Premium, parked — added 2026-07-19)

Removes the real friction in switching to the tool: today, an agency with an existing
roster/schedule in whatever format they already use has to manually re-key it into the
signup template (`parseSignupWorkbook`) or the demand template (`parseDemandWorkbook`) —
real work that costs adoption. The ask: upload *whatever document they already have* — any
spreadsheet layout, no fixed columns — and have it auto-populate the board.

**How it fits the existing architecture:** the app already tries multiple known formats
before giving up (Call Centre's `uploadCalls` tries a raw ACD export via
`deriveActiveCalls`, then falls back to the simple template via `parseSimpleCalls`). This
extends that same idea to arbitrary layouts, which deterministic column-matching can't
handle — a genuine AI extraction problem, not an exotic one. Shape: a new Worker route holds
an LLM API key server-side (never in the browser bundle), takes the uploaded file's content,
and returns structured JSON matching the board schema (`{shift, run, type, daysOff, days[],
s, e, b}`). Per the app's flag-never-block doctrine, the result lands as a **draft the user
reviews and confirms** before it touches real state — reuse the Signup Builder's existing
"Changes since upload" diff panel pattern for the review step, just fed from an AI-extracted
board instead of a generated one.

**Tradeoffs on record, not to be glossed over when this gets built:**
1. First feature that sends real operational data off the browser — not PII (schedules
   aren't the personal data the no-PII doctrine protects), but a real, honest departure from
   "nothing leaves your browser," which is currently a stated sales differentiator. Needs
   careful wording to customers, distinct from the phase-2-accounts tradeoff already noted
   above.
2. Costs money per use (LLM tokens) — fits naturally as a Premium-gated feature economically
   (same instinct as gating Save/Export), but needs real per-account usage limits, not just a
   feature flag, or a single customer's large uploads have no cost ceiling.
3. Won't be perfect on messy real-world documents (merged cells, inconsistent time formats,
   agency shorthand) — the review-before-commit step is load-bearing for trust, not optional
   polish.

**Depends on:** the Free/Premium/Enterprise tier system (`src/tier.jsx`, dark-launched
2026-07-19) actually going live — this is a Premium-tier feature, gated the same way as
Save/Export/Auto-Build once enforcement is turned on. Needs its own scoping pass (provider
choice, cost/rate-limit design, review-UI details) before implementation starts.

## Mobile strategy (added 2026-07-19)

Phone is a feeder/discovery surface, not a second editing environment. Real scheduling work
(Shift Builder drag-editing, Signup Builder, optimizer runs) stays desktop-only for the
foreseeable future — the dense HASTUS-inspired panels and Gantt-style drag interactions
aren't a good fit for touch, and building a parallel mobile-editing experience isn't worth
the effort until there's real demand for it. Landing and other marketing-facing surfaces
should stay reasonably responsive (mostly already true — Landing.jsx is a simple card
layout, not the dense module UI) so someone can get a sense of what the tool does from a
phone before switching to desktop to actually use it. Standing rule: don't invest in
touch-friendly editing for the scheduling modules without a specific reason to revisit this.

## Analytics strategy (added 2026-07-19)

- **Marketing-site traffic (approved, low effort):** Cloudflare Web Analytics on the public
  site (Landing + pricing page once it exists) — cookieless, aggregate-only, no consent
  banner needed since it doesn't track individuals across sites. Answers "which channel
  brought this visitor" and "does the pricing page convert" without touching the "nothing
  leaves your browser" story the modules themselves rely on.
- **In-app usage telemetry (deliberately deferred, not a default yes):** tracking which tabs
  or features agencies actually use inside the scheduling tools would mean the app starts
  phoning home — a real architecture departure, same category as the AI-import tradeoff
  above, not a small add-on to bolt on reflexively. At current revenue expectations
  (3–8 agencies in year one, per Commercialization), direct conversation with customers
  covers this need better than a telemetry pipeline would. Revisit if/when customer count
  makes personal conversation stop scaling.
- **Usage dashboard:** follows from the above — premature infrastructure for a customer
  count that doesn't need it yet. Parked alongside phase-2 accounts, not scheduled.

## Module parity initiative (added 2026-07-20, SHIPPED 2026-07-20 — deferrals noted below)

Bring Call Centre and Dispatch up to the operator workbench's feature depth, with language
and mechanics adapted to each domain (agents/calls, dispatchers/incident load — never
operator/vehicle wording). Full audit performed 2026-07-20; gaps confirmed:
schedule import/baseline/Compare, Retime, Suggestions tab (deep optimize + per-day refine),
Optimization monitor, Size-to-requirement, Packaging (grid + auto-package + rule checking —
note their Rules-tab package settings are currently DECORATIVE, never checked), part-time
(Call Centre only; Dispatch has it), week strip/duplicate/day-variant editing, phase strip.
Reverse gap: siblings have redo; operator module doesn't.

Scope decisions (user, 2026-07-20): full Packaging tab in both siblings; NO holidays/
exception days for now; phase strip yes but NO guided tour. (2026-07-21: the operator
  module's guided tour was removed entirely — single-agency focus for now, no onboarding
  needed. TOUR_STEPS/TourOverlay and all data-tour anchors deleted; recoverable from git
  history if a future multi-agency rollout wants it back.)

- **Phase 1 — Schedule import + baseline + Compare** (template download, parser, upload,
  promote, diff view; "agent schedule"/"dispatcher schedule" language).
- **Phase 2 — Optimizer parity**: Retime card, Suggestions tab, Deep optimize,
  Size-to-requirement (Call Centre sizes from the Erlang requirement, Dispatch from the
  dispatcher-ratio requirement). SHIPPED except the background Optimization monitor —
  deferred (large embedded time-sliced loop in App.jsx; port in its own pass).
- **Phase 3 — Rules substance**: part-time for Call Centre; wire package rules into real
  flagging in both. SHIPPED — CC has the full ptRules/ptEnabled/ptCount machinery (Rules
  card, Build-tab count, generation, persistence); packageInfo issues now flag in both
  siblings' Packaging tab and Schedule gantt.
- **Phase 4 — Full Packaging tab** both siblings (grid, auto-package, per-day refine).
  SHIPPED as a shared PackagingTab exported from CallCentre.jsx.
- **Phase 5 — Editing depth + chrome**: phase strip SHIPPED (shared PhaseStrip, Setup →
  Build → Review → Handoff, done/pending tints). Redo exists in all three modules
  (the earlier deferral note was stale). Optimization monitor SHIPPED to both siblings
  2026-07-21 (shared useOptimizerMonitor hook + OptimizerMonitorCard in CallCentre.jsx:
  retime/generate modes, ruin-and-recreate search, stability-discounted accept gate,
  stop-polish with fit-each-day, live sparkline, load-best). STILL DEFERRED: the
  operator-style week-strip/3-state package editor in the siblings.
- **Follow-up (2026-07-21, SHIPPED)**: removed the "Pull-out/pull-in staging" area/legend
  from Call Centre + Dispatch Coverage charts (new `showStaging` prop on the shared
  CoverageChart, defaults true so the operator module is unchanged) — it's a vehicle-
  deadhead concept (physical staging before/after service) that doesn't map to agents or
  dispatchers, neither of which have deadhead settings at all.
- **Follow-up (2026-07-20, SHIPPED, then REMOVED 2026-07-21)**: Guided setup wizard in
  both siblings — a shared 4-step SetupWizard (demand pattern, service hours, headcount,
  shift kinds) pre-filling Rules/hours/counts/part-time/demand and landing on BUILD. Pulled
  entirely (SetupWizard component, applyWizard handlers, header button) alongside the
  operator module's guided tour — single-agency (Edmonton) focus for now, no onboarding
  needed anywhere in the toolkit. Recoverable from git history if a later multi-agency
  rollout wants it back; the operator-module adaptation (trips/fleet mapping instead of
  staff peaks) that was on deck is moot until then.
- **Follow-up (2026-07-20, SHIPPED)**: type reconciliation in both siblings — uploaded
  schedules whose type codes aren't in Rules previously passed through Retime/optimizers
  silently untouched (root cause of a real user report). Now: shared `reconcileTypes`
  engine helper auto-matches unknown codes to existing rule windows (tightest fit, all
  shifts must fit) or builds a classification from the observed times (windows ±1h,
  grid-snapped, modal work value); runs automatically at schedule upload, and a Rules-tab
  banner + "Auto-match & build rules" button handles already-loaded projects. Retime card
  warns when unrecognized codes are present. 2026-07-21: the operator module now has the
  same Rules-tab banner + button, so all three modules are aligned.
- **Follow-up (2026-07-20, SHIPPED)**: operator-style sketch experience in both siblings'
  Demand tabs (day-keyed sketch/peaks, Split-the-week modes, Start-from presets, per-group
  peak inputs, persisted in project files) and click-to-rename type codes in both siblings'
  classification tables (board/baseline/color remap, undo history cleared).

Tier/pricing note: ALL gating work is parked on the `tier-scaffolding` branch (pushed to
GitHub) per 2026-07-20 decision to hold off on pricing. main is clean of it; merge that
branch when pricing resumes.

## Ops / infra chores
- Connect a real domain (replace `transit-toolkit.jackson2007.workers.dev`).
- Delete the old obsolete worker.
- Rename the GitHub repo (signup-workbench → toolkit-wide name).

## Recently shipped
- 2026-07-22 — Annual Service Plan module (`/annualplan`, v1: total trips only). Reviewed
  against real 2026 DATS Daily Service Report + Monthly Trip/Cost Budget exports. Providers
  tab (editable capacity providers — scheduled hours/day × weekday/weekend productivity ×
  hourly rate — and remainder providers — % share × per-trip rate, ordered waterfall, last
  remainder always absorbs the rest, unaccommodated demand surfaced rather than dropped).
  History tab (sample/template/upload a prior year of daily trips). Projection tab (each
  plan-year day matched to the historical day sharing its day-of-week and closest relative
  position in the year, holidays matched by name first, then grown by a single annual %).
  Capacity & Split tab (stacked monthly chart + annual summary table: trips/hours/cost/
  cost-per-trip by provider). Explicitly deferred: AMB/WAM passenger splits, escorts,
  monthly-varying growth, multi-year blended history — see Daily Service Report above for
  why total-trips-first was the right v1 scope. Fixed a real bug found in live verification:
  Recharts' bar entry animation could stall indefinitely (bars computed correct geometry but
  never painted) — `isAnimationActive={false}` set on every Bar in the module.
- 2026-07-22 — Annual Service Plan: service-hours-from-headcount + real-board import + holiday
  hours fix. Reviewed a real DATS "service hours" tab (weekly operator-headcount vs.
  scheduled-hours-requirement deficit check) and a "signup hours" tab (calendar rollup of a
  real board's per-weekday hours into monthly totals) from the same source workbook already
  used for the module's v1. Neither tab's exact mechanics were worth replicating (both are
  messier than what Capacity & Split already computes automatically day-by-day), but two real
  gaps were: capacity providers had no way to *derive* hoursByDow from anything, only type it
  by hand; and statutory holidays weren't reducing in-house capacity the way Projection
  already reduces projected trips on those dates. Fixed both. Providers tab: each capacity
  provider now has three ways to set scheduled hours — Enter directly (unchanged), Compute
  from headcount (FT/PT counts × weekday/weekend × avg shift length × a single absence-rate %,
  mirrors the existing weekday/weekend productivity split pattern), or Import from signup
  board (uploads a real board via the operator workbench's own `parseSignupWorkbook` parser/
  template and sums actual scheduled shift hours — report-to-off minus break — by day of
  week). Capacity & Split: statutory holidays (from the same holiday list Projection already
  loads) now use each capacity provider's Sunday-level hoursByDow for that date instead of the
  normal same-weekday value, matching the operator workbench's own holiday convention (a
  holiday's `runsAs` defaults to Sunday) — verified live, In-house hours dropped from 207,580
  to 205,740/yr with the 11 holidays the sample data matches.
- 2026-07-16/17 — Requirement-lines rework (water-fill under fleet cap + deployment-pattern line, then folded into Size-to-requirement after cleanup); demand-data integrity (persistent pasted-totals detection + ÷6 repair, cycle-time plausibility guard, pin-known-productivity calibration); occupancy target fixed to cycle-only window; Gap tooltip shows true shortfall; pull-out/pull-in staging drawn violet; prev/next step navigation; reclassification chips on flagged shifts; drag-in-place from full board; "Flagged first" + end-time sorts.
- 2026-07-15 — Signup Builder "Size to requirement": package count from capped weekly vehicle-hours ÷ 40.
- 2026-07-15 — Coverage "Requirement mode": demand-implied vehicle-hours water-filled under the fleet cap.
- 2026-07 — Stat-holiday template + auto-assignment to shifts; sign-in stagger strip; arrow-key run navigation; coverage click-to-filter-runs.
- 2026-07 — Call Centre Staffing module (ACD parser, Erlang C overlay, arrivals, composition/queues).
- Earlier — see git history and CLAUDE.md.
