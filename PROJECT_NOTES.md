# PROJECT NOTES — Signup Workbench

Reference document for anyone (human or Claude) working on this codebase. It captures what the tool is, how it works, why key decisions were made, and what remains to build. Read this before changing the engine code.

---

## 1. What this tool is

A **scheduler's workbench** for designing paratransit/microtransit operator signups (shift bids). The user is an operations planner. The workflow it supports, end to end:

1. Define demand (sketch it by feel, or use imported 5-minute pickup/dropoff counts)
2. Set the signup envelope (total signed shifts; extra-board size; designed runs = difference)
3. Auto-build a board of weekly shift packages, or load/edit an existing one
4. Tweak visually against live scoring, rules validation, and helper suggestions
5. Package legality checks (days off, rest, consecutive days, report-time variance)
6. Export the board in signup-sheet layout (xlsx); save/load whole projects as JSON

**Design doctrine (do not violate):**
- The product is the visual workbench; algorithms are advisors, never autocrats. The scheduler holds the pen. Tools *flag* rule violations, they never *block* edits.
- Generated output must always land as a fully editable board, same as an import.
- No personal information anywhere: aggregate demand + shift structures only. No rider data, no operator names in the tool. This is a deliberate procurement/security advantage — protect it.
- Agency-generic: all agency specifics live in editable data (Rules tab, project files), never in code. Language in the UI must stay industry-generic ("extra board", not local slang).
- Real data lives in **project files** (Save/Load project, JSON), never in the repo or the deployed bundle. The deployed app ships synthetic sample data only.

**Commercial context:** built first for one agency's internal use (Edmonton DATS — their data appears ONLY in private project files, never in this repo), with intent to commercialize as SaaS for paratransit/microtransit agencies. Entry pricing should clear agency procurement thresholds. Future paid tiers parked for later: hosted multi-tenant accounts, operator bidding, certified-optimal solving.

---

## 2. The scoring metric (the heart of everything)

**Weekly coverage score = Σ over all 5-minute slots of min(demand share, supply share).**

- Demand share of slot = that slot's PU+DO events ÷ total weekly events.
- Supply share of slot = vehicles on road that slot ÷ total weekly vehicle-slots.
- Per-day score: same formula with within-day shares.
- Range 0–100%. 100% is unreachable in principle (fixed shift lengths can't trace a spiky curve) — the score is for **comparing boards**, not grading against perfection.

**Why this metric (history matters here):**
- An earlier version derived a vehicle *requirement* from events ÷ (2 × productivity). Productivity was an unmeasurable constant that turned out to control where the objective "had teeth" — too much load for an assumed number. It was removed deliberately.
- The shape-overlap metric is **scale-free**: a sketched demand curve works exactly as well as imported data. This is what makes sketch-first onboarding honest, and it's a differentiator — don't reintroduce absolute-requirement assumptions casually.
- Surplus above the demand pattern earns zero (the `min()`). Proportional day-shares are a *diagnostic*, not an objective — the score handles allocation automatically.
- The chart's "demand-aligned target" line = the day's own vehicle-hours redistributed to follow the demand shape. It is not a requirement; it's a mirror.

**Hard constraints, separate from the score:** minimum vehicles in service (`minVeh`, within the service span — renamed from an earlier "coverage floor" to avoid confusion with the unrelated sign-in stagger constraint below), fleet cap (max vehicles simultaneously in service), sign-in stagger (max sign-ins per 5-min slot — garages bottleneck), the 10-hour package cap, and all classification/packaging rules. Constraints are checked and flagged; the score never absorbs them.

---

## 3. Domain model

- **Segment**: `{id, shift, run, type, daysOff, splitType, days[], s, e, b}` — times in minutes from midnight (grid: T0=300 i.e. 05:00, N=234 five-minute slots to 24:30; shifts may end past the grid, e.g. 24:45=1485). `b = [breakStart, breakEnd] | null`. A segment is one weekly time pattern; a **package** (signable weekly shift) = all segments sharing a `shift` number. Day-variant rows (same shift, different times on different days) are normal and match real signup sheets.
- **Extra board** (a.k.a. spareboard/relief): headcount reservation with NO shape and NO coverage contribution; deployed via in-period mini-signups outside this tool's scope. Envelope: designed runs = total signed − extra board.
- **Supplemental runs** (part-time boards): add real coverage, toggleable in supply. Long-term intent: fold them into the board as regular segments with their own hour caps, retiring the toggle.
- **Shift types** (editable in Rules; these are the shipped defaults): AM, NN (8h straights), AX (8h split), NN10 (10h STRAIGHT — no scheduled break), AX10 (10h split), BST (8h straight evening), BX (8h split late). Key semantics: `brk: true` means a break is **ALLOWED, not required** — "Float Break" shifts have operationally real but unscheduled breaks and must not be flagged for lacking one.
- **Packaging rules**: min rest between shifts (default 10h), max consecutive working days (5), max report-time variation within a package (60 min), consecutive days-off blocks. 8h types → 5-day weeks; 10h types → 4-day weeks (both = 40 paid hours — this equality matters, see §5).
- **Seniority desirability order** (for future bid-attractiveness features): NN10 → AM 8h → AX10 → AX 8h → BST → BX. Straight work and 3-day weekends are prized; splits keep the bus during breaks (no garage return).
- **Signup period & statutory holidays**: a start/end calendar-date range plus jurisdiction (country/region), used to auto-detect public holidays. This is the only place calendar dates enter the app — the engine and every other tab stay day-of-week only. A holiday's `runsAs` is either an existing weekday name (reuses that day's board pattern — the fast default) or `"custom"`, which unlocks a tiny independent one-off shift list (`segs: []`, shape `{id, type, s, e, b}`) editable inline in the Coverage tab (an "Exception days" tile row appears there for any custom-schedule holiday; clicking one expands the shift editor in place, no separate tab): same per-shift legality checks as the main board, but no weekly-package rules and no coverage score, since a one-off date isn't a recurring week.

---

## 4. Engine components (all in src/App.jsx)

- `computeEngine(DEM, ftCov, includePT, minVeh, spans, maxFleet)` — scores a supply against demand; returns per-day {score, target, gaps, floorViol, fleetViol, shares} and weekScore.
- `buildSupply(board)` — segments → per-day vehicle counts (breaks netted out).
- `validateSeg(seg, rules, glob)` — classification rules; returns issue strings. Flags, never blocks. Also reused (unmodified) for one-off holiday shifts — see §3.
- `packageInfo(segs, rules, glob)` — package-level checks (day counts, days-off contiguity, rest, consecutive days, start variance). Weekly-package-only; deliberately not used for one-off holiday shifts.
- `autofixSeg(seg, rules, glob)` — smallest-legal-adjustment repair; returns null if the type's windows can't accommodate (UI then suggests retype or rule change).
- `generateBoard(tenTarget, nPackages, ...)` — **package-native greedy builder**: each placement picks (type × 5-min-grid start × break length 30–240 in 30s × break offset × consecutive days-off pattern) maximizing marginal gain via per-day prefix sums (O(1) per candidate-day). Forces 10-hour packages while `used10 < tenTarget`. Respects fleet cap, minimum-vehicle bonus, stagger cap + soft stagger penalty (0.15/existing start). Generates packages, not runs, so output is packageable **by construction**.
- `findSuggestions(board, eng, ...)` — ranked legal single moves (whole-shift slides ±5..60, break slides ±15..90) improving the week score; respects stagger; returns top-12 with `.evaluated` count.
- `refinePerDay(board, ...)` — per-day nudges within the start-variance rule, splitting day-variant rows; **live greedy** (applies immediately, re-validating variance/stagger/fleet against current state), threshold near-zero (1e-6). History: an earlier version used a 2e-4 threshold and discarded ~97% of real improvements — per-day deltas are individually tiny (~0.001–0.03 pts) but compound to 1.5–2 pts. Do not raise the threshold again.
- `optimizeToConvergence` / `deepOptimize` — alternate whole-move convergence and per-day refinement until neither improves. Convergence claim (word it exactly this way in UI): "no remaining single adjustment of any explored type improves the score." This is LOCAL search, not a global-optimum guarantee.
- Auto-Build (tab): single action, calls `generateBoard(glob.max10, ...)` — always fills the full 10-hour allowance from Rules before any 8-hour work. Simplified from an earlier two-mode + 10-hour-sweep design (see §5.2 history) at the user's explicit request, trading away the sweep's protection against greedy anomalies for a simpler, more predictable tab.

**Performance idioms:** prefix sums for range gains/feasibility; per-day term recomputation only for changed days (slides preserve total hours, so week-share denominators are constant); effort counters (`evaluated`) surfaced in UI everywhere — users explicitly want proof of optimization effort.

---

## 5. Non-obvious lessons already paid for (don't relearn)

1. **Every weekly package costs 40 paid hours** (5×8 = 4×10), so "cost mode" at package level is meaningless — the real trade is coverage vs. four-day weeks operators value.
2. **Greedy anomalies are real**: constrained-first can beat free-choice — an earlier build ("value mode") plus a 10-hour sweep existed specifically to search around this. That sweep was removed at the user's explicit request in favor of always filling the 10-hour allowance from Rules, a deliberate simplicity-over-optimality tradeoff — if board quality complaints trace back to a bad 10-hour count, this is the first place to look.
3. **Generated times must land on the :00/:05 clock grid** — rule windows like "after 7:01" must be snapped up, or every start inherits ugly offsets.
4. **Sign-in stagger matters**: real boards showed 16–17 simultaneous sign-ins in one 5-minute slot; garages can't do that. Cap is a rule (default 3) enforced in generation, suggestions, refinement, and a Coverage-tab banner.
5. **Rules imported from spreadsheets can be self-contradictory** (NN10/BST once had "break required" with spread == work). Validate rules against the real board and the agency's classification sheet; when board and sheet disagree, the tool flags and the human adjudicates.
6. **Variance is efficiency**: uniform times across a package's days left ~1.8 weekly points on the table on a 100-package board. Per-day refinement is not cosmetic.
7. Scores across different metrics/eras are not comparable; compare only within the current metric.

---

## 6. UI map (tabs)

RULES (classification table, breaks, board limits, packaging rules, service span, signup period & holiday list, reset to defaults) · DEMAND (sketch/upload/sample toggle, provenance badge in header, template download + upload) · AUTO-BUILD (single generate action, fills the 10-hour allowance from Rules) · COVERAGE (score, target chart, floor/fleet/stagger banners, gaps, share table, explainer, plus an inline "Exception days" tile row + shift editor for any holiday set to "Custom schedule") · BOARD DESIGNER (Gantt, tap-to-edit nudges, add/duplicate/remove/retype, day chips, Fix violations / Fix all flags, undo, KPI strip) · PACKAGING (grid = signup-sheet view, auto-package for loose runs, Refine day-to-day times) · SUGGESTIONS (ranked moves, Deep optimize, waste finder).

Global: Save/Load project (full state JSON), Export board (xlsx in signup-tab layout + summary sheet). Styling: desktop-first, HASTUS-inspired, Barlow Condensed/Inter, flat panels, teal=supply, amber=demand, red=gaps/violations. Number inputs need explicit white background + dark text (white-on-white iOS bug already fixed once).

---

## 7. Roadmap (agreed, in order)

0. **Shipped**: signup period + jurisdiction, statutory-holiday auto-detection (`date-holidays`), per-holiday "runs as an existing weekday" or a fully custom one-off shift board (inline "Exception days" section on the Coverage tab, not a separate tab), a real demand-import panel (downloadable xlsx template + upload/parse flow for 5-minute pickup/dropoff counts), getting-started checklist + per-tab status indicators.
1. **Next**: Compare & Publish module — scenario management (incumbent vs drafts, side-by-side scores/mix/10h usage), posting-format export, blank signed-board template, auto-drafted change memo from the board diff.
2. **Hardening**: certified ceiling computation (LP/MILP — the honest "how good could any legal board be"; premium-tier candidate), Gantt edge-drag on desktop, per-day sketch overrides, break-length moves in the suggestion engine.
3. **SaaS layer (only when a second agency is real)**: accounts + per-tenant storage (the project-file schema IS the data model), then optional operator bidding tier. Adjacent product idea parked: driver training/compliance platform.

## 8. Deployment

Vite + React; deps: react, react-dom, recharts, xlsx, date-holidays. Hosted on **Cloudflare Workers** (`wrangler.jsonc`), not Pages/Netlify/GitHub Pages as originally sketched in the README. Deployment is **not** git-triggered — pushing to GitHub only updates the repo; someone must run `npm run deploy` (wraps `vite build` + `wrangler deploy`) locally to actually ship. This was a real source of confusion once (a push was mistaken for a deploy) — don't assume otherwise. No server, no storage: the site is a shell; data arrives via Load project at runtime. Keep it that way until the SaaS layer is a deliberate decision.
