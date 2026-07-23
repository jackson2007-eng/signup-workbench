# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Paratransit Companion** (formerly "Transit Operations Toolkit") — a suite of planning tools for paratransit/microtransit agencies (resourcing, budget, operations), built on a shared coverage-scoring engine. Users are operations planners, not engineers — the UI is the product. Read [PROJECT_NOTES.md](PROJECT_NOTES.md) before touching engine code (`src/App.jsx`) — it documents the scoring metric, domain model, and several non-obvious design decisions that were already tried and reverted once.

Every tool module requires a signed-in, approved account (2026-07-23 pivot — see Architecture and ROADMAP.md's "Recently shipped"); the public `/` landing page stays open for marketing + requesting access. This is a real architecture departure from the project's original no-backend design — read the account-data note under Design doctrine before assuming "nothing leaves the browser" still applies everywhere.

## Commands

```
npm install       # install deps
npm run dev       # start dev server, frontend only, no /api/* (vite, default http://localhost:5173)
npm run dev:api   # start dev server WITH the Worker backend (accounts, project persistence) — use this whenever touching auth/API/persistence code
npm run build     # production build -> dist/
npm run preview   # build + run a local Wrangler dev server (Cloudflare Workers emulation)
npm run deploy    # build + wrangler deploy — this is how the live site actually updates
```

No test suite, linter, or type checker is configured. `npm run dev` alone has no backend (the plain frontend dev server, kept fast and free of the Cloudflare Vite plugin's macOS-13.5+ requirement — see the note below); if a page shows "Can't reach the API," that's expected there and `npm run dev:api` is what you want instead.

**Deployment is NOT git-triggered.** The site is hosted on Cloudflare Workers (`wrangler.jsonc`), and pushing to GitHub does nothing on its own — there is no CI/build hook connected. Someone must run `npm run deploy` locally (or in a pipeline, if one is ever added) after pushing for changes to actually go live. This has caused real confusion before (a push was mistaken for a deploy) — don't assume `git push` ships anything.

`npm run dev`'s Cloudflare Vite plugin needs a local Workers runtime (`workerd`) that requires macOS 13.5+; on older macOS it's conditionally skipped for `dev` (only loaded for `build`) in `vite.config.js` — see the comment there if this trips up local dev again.

## Design doctrine (do not violate)

- Algorithms are advisors, never autocrats. Tools *flag* rule violations, they never *block* edits — the scheduler always holds the pen.
- Generated output must always land as a fully editable board, same as an imported one.
- **No personal information in scheduling-domain data**: aggregate demand + shift structures only, no rider data, no operator names, in any module's own content (boards, demand curves, rosters). This is a deliberate procurement/security property — protect it. It does **not** extend to account data (see below) — that's a separate, newer category with its own, narrower rules.
- **Account data** (username, contact name, work email, agency, request message) is a real, intentional exception to "no personal information anywhere" — the 2026-07-23 accounts pivot means this specific, minimal set of fields now lives server-side in D1 by design. Collect only what `/request-access` already asks for, nothing more. Never expose it to a non-admin API response (`/api/admin/*` routes are the only place contact fields and pending-user lists may appear); `/api/me` and login responses return only `{username, isAdmin, agencyName}`. Each user's saved project payload (`projects.payload` in D1) is treated as an opaque JSON blob by the Worker — it's never parsed or inspected server-side, so the "no PII in scheduling-domain data" rule above is what actually protects it, not access control.
- **Saved data is scoped by agency, not by individual user** (agencies model, added shortly after the accounts pivot). `projects.agency_id` — not `user_id` — is what every project CRUD query binds, so every approved user at the same agency reads and writes the same set of saved signups. An admin creates agencies and links each user to one (required at approval time); a user with no `agency_id` yet gets a `403`, not a silent empty state. Don't reintroduce per-user project scoping — that's the exact thing this model replaced.
- Agency-specific values (shift types, rules, thresholds) live in editable data (Rules tab, project files), never hardcoded. UI language stays industry-generic ("extra board", not local slang).
- Real agency data belongs only in each account's own saved project (D1) or private project files (JSON) — never in this repo or the deployed bundle. The repo/deployed app ships synthetic sample data only (`src/sampleData.js` and its per-module siblings).

## Architecture

**Frontend**: `src/main.jsx` is the entry point and router (no library — `history.pushState`/`popstate`); it gates the five tool paths plus authed `/` behind a session check and hands them to `src/Shell.jsx`, the app-shell (icon rail + in-app tab strip + Home dashboard) that keeps every opened tool mounted so switching tabs never loses in-progress state. `src/Landing.jsx` is the public marketing page (signed-out `/`), `src/Auth.jsx` holds Sign in / Request access / Admin. Each of the five tool modules is still a large, mostly self-contained file — `src/App.jsx` (~6,200 lines, the original engine + Resourcing UI + shared exports the siblings import from), `src/CallCentre.jsx`, `src/Dispatch.jsx`, `src/AnnualPlan.jsx`, `src/VacationPlan.jsx` — each with its own `sampleData.js`-style synthetic dataset. `src/useAccountProject.jsx` is the shared load-on-mount/debounced-autosave hook every module uses to persist its project to the account backend, replacing the old download/upload-a-JSON-file flow (kept as a secondary "Export/Import backup JSON" feature). One external dependency beyond the core stack: `date-holidays` (statutory holiday lookup, offline/bundled data, dynamically `import()`-ed only when the Rules tab is opened so it doesn't bloat the main chunk).

**Backend**: `worker/index.js` is the Worker's `fetch` handler (`wrangler.jsonc`'s `main`) — routes `/api/*`, falls through to `env.ASSETS.fetch(request)` for everything else (the SPA, served as static assets same as before the pivot). `worker/auth.js` does PBKDF2 password hashing (100,000 iterations — Cloudflare's production runtime hard-caps it there; don't raise without checking that cap first) and opaque-token session management via KV. `worker/db.js` holds the D1 query helpers. `worker/schema.sql` is the D1 schema (`users`, `projects` tables). No ORM, no ROUTER library — deliberately matches the frontend's own no-framework, hand-rolled style.

### Scoring metric (the core idea everything else serves)

Weekly coverage score = Σ over all 5-minute slots of `min(demand share, supply share)`, where each share is that slot's portion of the week's total events/vehicle-slots. This is **scale-free** — a hand-sketched demand curve scores exactly as well as imported data — which is what makes sketch-first onboarding honest. Surplus above the demand shape earns zero (the `min()`). Do not reintroduce an absolute vehicle-requirement metric (e.g. events ÷ productivity) — an earlier version did this and was deliberately removed because the constant was unmeasurable and distorted the objective.

Hard constraints (minimum vehicles in service, fleet cap, sign-in stagger, 10-hour package cap, classification rules) are checked and flagged separately — they never get absorbed into the score.

### Domain model

- **Segment**: `{id, shift, run, type, daysOff, splitType, days[], s, e, b}` — times are minutes from midnight on a 5-minute grid (`T0=300`/05:00, `N=234` slots to 24:30; shifts may run past the grid). `b = [breakStart, breakEnd] | null`. A **package** = all segments sharing a `shift` number; day-variant rows (same shift, different times per day) are normal.
- **Extra board**: headcount reservation with no shape/coverage contribution. `designed runs = total signed − extra board`.
- **Shift types** are editable in Rules (shipped defaults: AM, NN, AX, NN10, AX10, BST, BX). `brk: true` means a break is *allowed*, not required.
- Packaging rules: min rest between shifts (10h default), max consecutive days (5), max report-time variance in a package (60 min default, checked three ways — weekday-internal, weekend-internal, and weekday-vs-weekend — via `glob.maxStartVarWeekday`/`maxStartVarWeekend`/`maxStartVarCross`), days-off contiguity. 8h types → 5-day weeks; 10h types → 4-day weeks (both 40 paid hours — this equivalence is why "cost mode" at the package level is meaningless; see PROJECT_NOTES.md §5).
- **Signup period & holidays** (`signupPeriod`, `holidays[]` state): a start/end calendar-date range plus a country/region jurisdiction, used to auto-detect statutory holidays via `date-holidays`. This is the *only* calendar-date concept in the app — the engine itself stays purely day-of-week; a holiday's `runsAs` field just says which existing weekday's board pattern it should follow (`"Sunday"`, etc.), or `"custom"` if it needs its own board. Each holiday can optionally carry `segs: []` — a tiny independent one-off shift list (`{id, type, s, e, b}`, no `days`/`shift`/`run`) editable inline in the **Coverage** tab (an "Exception days" tile row appears there once at least one holiday is set to "Custom schedule"; clicking a tile expands the shift editor in place — reuses `selectedHolidayId`/`selHoliday` state, no separate tab). One-off segments reuse `validateSeg`/`autofixSeg` (per-shift legality) but deliberately skip `packageInfo` (weekly-package rules don't apply to a single date) and have no coverage scoring.

### Board limits (`glob`, configured only in the Rules tab)

`max10` (10-hour package cap), `minVeh` (minimum vehicles in service within the service span, default 1), `maxFleet` (fleet cap), `maxPullout` (max sign-ins per 5-minute slot — the garage-bottleneck stagger cap), `shiftSeriesBase` (default 6000 — starting shift number for Auto-Build and Auto-package; both fall back to `Math.max(existing board shift numbers) + 1` if that's already higher, so the base never causes a collision). These are distinct constraints: `minVeh` flags when supply drops too low; `maxPullout` flags when too many shifts start in the same slot. Don't conflate them.

### Engine functions (all in `src/App.jsx`)

| Function | Role |
|---|---|
| `computeEngine` | Scores a supply against demand; returns per-day score/target/gaps/violations + weekScore |
| `buildSupply` | Segments → per-day vehicle counts (breaks netted out) |
| `validateSeg` / `packageInfo` | Classification and package-level rule checks; return issue strings, never block |
| `autofixSeg` | Smallest-legal-adjustment repair; `null` if infeasible |
| `generateBoard` | Package-native greedy builder — picks type × grid-start × break params × days-off pattern maximizing marginal score gain via prefix sums; forces 10-hour packages until `tenTarget` is met |
| `findSuggestions` | Ranked legal single moves (shift slides, break slides) that improve score, respecting stagger cap |
| `refinePerDay` | Live-greedy per-day time nudges within variance rules; threshold ~1e-6 (do not raise — see below) |
| `optimizeToConvergence` / `deepOptimize` | Alternates whole-move and per-day optimization until neither improves — local search, not global optimum |

Auto-Build tab is a single action: always fills the full `max10` 10-hour allowance from Rules before any 8-hour work (an earlier two-mode + 10-hour-sweep design was simplified away at the user's request — see PROJECT_NOTES.md §5 lesson 2 for the tradeoff this accepts).

**Performance idioms**: prefix sums for range gains/feasibility; per-day recomputation only for changed days; `evaluated` effort counters surfaced in the UI (users want visible proof of optimization effort).

### Lessons already paid for — don't relearn these

1. Every weekly package costs exactly 40 paid hours regardless of type (5×8=4×10) — package-level "cost" optimization is a non-problem; the real trade is coverage vs. operator-preferred 4-day weeks.
2. Greedy anomalies are real (constrained-first can beat free-choice) — the Auto-Build tab used to guard against this with a 10-hour sweep; that was removed for simplicity, so a bad `max10` count is the first thing to check if a generated board looks off.
3. Generated times must snap to the :00/:05 grid, or rule-window math ("after 7:01") produces ugly inherited offsets.
4. Sign-in stagger is a real constraint (garages saw 16–17 simultaneous sign-ins in one 5-min slot); it's enforced in generation, suggestions, refinement, and surfaced in the Coverage tab — don't relax the default cap (3) casually.
5. Imported rule spreadsheets can be self-contradictory (e.g. "break required" on a type whose spread equals its work time); validate rules against the real board, and when they disagree the tool flags rather than silently picking one.
6. `refinePerDay`'s near-zero threshold is deliberate: a prior 2e-4 threshold discarded ~97% of real improvements because per-day deltas are individually tiny but compound significantly across a board.
7. Scores from different metric eras are not comparable — only compare boards within the current metric.

### UI map (tabs)

RULES (classification, breaks, board limits, packaging rules, service span, signup period & holiday list) → DEMAND → AUTO-BUILD (single generate action, fills the 10-hour allowance from Rules) → COVERAGE (score/chart/violation banners, plus an inline "Exception days" section — tile row + shift editor — for any holiday set to "Custom schedule") → SHIFT BUILDER (Gantt-style editing, undo, KPI strip) → PACKAGING (signup-sheet grid view, auto-package, per-day refine) → SUGGESTIONS (ranked moves, deep optimize). Global: Save/Load project (JSON), Export board (xlsx, signup-tab layout + Exceptions sheet when a signup period is set).

Phase tabs (RULES/DEMAND/SHIFT BUILDER/COVERAGE) tint teal-with-checkmark when done and amber when pending, with the reason as a hover tooltip — purely informational, matching the "flag never block" doctrine; see the `hasVisitedCoverage` state variable and the `PHASES` array in the render body if extending this.

Styling: desktop-first, HASTUS-inspired, Barlow Condensed/Inter, flat panels; teal = supply, amber = demand, red = gaps/violations. Number inputs need explicit white background + dark text (an iOS white-on-white bug was already fixed once — don't reintroduce it).

The Signup Package banner + day paddles, the `.kpistrip`, and (on Shift Builder, when open) the selected-shift editor all use `position: sticky` so they stay pinned while scrolling, stacked via fixed pixel offsets `ENVELOPE_H`/`KPI_H` (top of file) rather than measured at runtime — this app has no dynamic-measurement precedent (no `ResizeObserver`/`useLayoutEffect` elsewhere) and is desktop-first with fixed-size content, so a hardcoded offset with a small buffer is more robust than runtime measurement. If you change the height of the envelope block or `.kpistrip`, bump these constants to match.

## Roadmap context (for scoping new work)

The living backlog is [ROADMAP.md](ROADMAP.md) — check it before scoping new work, and move items there when they ship or get parked. The account/backend infrastructure ROADMAP.md previously described as "parked until a second agency is real" (Service Tracker's phase 2) **shipped toolkit-wide 2026-07-23** — see ROADMAP.md's "Recently shipped" for what actually landed (username+password, not the email-link auth originally sketched there) and the superseded-note callouts left in place where the old plan is now stale. Don't take that document's Commercialization/tier framing (accounts as an Enterprise-only upsell) as still accurate without checking those notes first.
