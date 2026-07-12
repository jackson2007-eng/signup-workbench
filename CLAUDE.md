# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A scheduler's workbench (Vite + React SPA) for designing paratransit/microtransit operator signups (shift bids). Users are operations planners, not engineers — the UI is the product. Read [PROJECT_NOTES.md](PROJECT_NOTES.md) before touching engine code (`src/App.jsx`) — it documents the scoring metric, domain model, and several non-obvious design decisions that were already tried and reverted once.

## Commands

```
npm install       # install deps
npm run dev       # start dev server (vite, default http://localhost:5173)
npm run build     # production build -> dist/
npm run preview   # preview the production build locally
```

No test suite, linter, or type checker is configured. There is no backend: the app is a static bundle, and all data enters/exits at runtime via Save/Load project (JSON) and Export board (xlsx) — nothing is persisted server-side.

## Design doctrine (do not violate)

- Algorithms are advisors, never autocrats. Tools *flag* rule violations, they never *block* edits — the scheduler always holds the pen.
- Generated output must always land as a fully editable board, same as an imported one.
- No personal information anywhere: aggregate demand + shift structures only, no rider data, no operator names. This is a deliberate procurement/security property — protect it.
- Agency-specific values (shift types, rules, thresholds) live in editable data (Rules tab, project files), never hardcoded. UI language stays industry-generic ("extra board", not local slang).
- Real agency data belongs only in private project files (JSON), never in this repo or the deployed bundle. The repo/deployed app ships synthetic sample data only (`src/sampleData.js`).

## Architecture

The entire app — engine, UI, and state — lives in `src/App.jsx` (~2,200 lines); `src/sampleData.js` holds the shipped synthetic demand/board, `src/main.jsx` is the React entry point. There is no routing or backend; state is held in React and round-trips through project-file JSON.

### Scoring metric (the core idea everything else serves)

Weekly coverage score = Σ over all 5-minute slots of `min(demand share, supply share)`, where each share is that slot's portion of the week's total events/vehicle-slots. This is **scale-free** — a hand-sketched demand curve scores exactly as well as imported data — which is what makes sketch-first onboarding honest. Surplus above the demand shape earns zero (the `min()`). Do not reintroduce an absolute vehicle-requirement metric (e.g. events ÷ productivity) — an earlier version did this and was deliberately removed because the constant was unmeasurable and distorted the objective.

Hard constraints (minimum vehicles in service, fleet cap, sign-in stagger, 10-hour package cap, classification rules) are checked and flagged separately — they never get absorbed into the score.

### Domain model

- **Segment**: `{id, shift, run, type, daysOff, splitType, days[], s, e, b}` — times are minutes from midnight on a 5-minute grid (`T0=300`/05:00, `N=234` slots to 24:30; shifts may run past the grid). `b = [breakStart, breakEnd] | null`. A **package** = all segments sharing a `shift` number; day-variant rows (same shift, different times per day) are normal.
- **Extra board**: headcount reservation with no shape/coverage contribution. `designed runs = total signed − extra board`.
- **Shift types** are editable in Rules (shipped defaults: AM, NN, AX, NN10, AX10, BST, BX). `brk: true` means a break is *allowed*, not required.
- Packaging rules: min rest between shifts (10h default), max consecutive days (5), max report-time variance in a package (60 min), days-off contiguity. 8h types → 5-day weeks; 10h types → 4-day weeks (both 40 paid hours — this equivalence is why "cost mode" at the package level is meaningless; see PROJECT_NOTES.md §5).

### Board limits (`glob`, configured only in the Rules tab)

`max10` (10-hour package cap), `minVeh` (minimum vehicles in service within the service span, default 1), `maxFleet` (fleet cap), `maxPullout` (max sign-ins per 5-minute slot — the garage-bottleneck stagger cap). These are distinct constraints: `minVeh` flags when supply drops too low; `maxPullout` flags when too many shifts start in the same slot. Don't conflate them.

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

Sweep (Auto-Build tab) builds a full board at every 10-hour target and ranks results, because greedy is myopic and forced structure can beat free choice.

**Performance idioms**: prefix sums for range gains/feasibility; per-day recomputation only for changed days; `evaluated` effort counters surfaced in the UI (users want visible proof of optimization effort).

### Lessons already paid for — don't relearn these

1. Every weekly package costs exactly 40 paid hours regardless of type (5×8=4×10) — package-level "cost" optimization is a non-problem; the real trade is coverage vs. operator-preferred 4-day weeks.
2. Greedy anomalies are real (constrained-first can beat free-choice) — fix with search breadth (the sweep), not hand-tuned policy.
3. Generated times must snap to the :00/:05 grid, or rule-window math ("after 7:01") produces ugly inherited offsets.
4. Sign-in stagger is a real constraint (garages saw 16–17 simultaneous sign-ins in one 5-min slot); it's enforced in generation, suggestions, refinement, and surfaced in the Coverage tab — don't relax the default cap (3) casually.
5. Imported rule spreadsheets can be self-contradictory (e.g. "break required" on a type whose spread equals its work time); validate rules against the real board, and when they disagree the tool flags rather than silently picking one.
6. `refinePerDay`'s near-zero threshold is deliberate: a prior 2e-4 threshold discarded ~97% of real improvements because per-day deltas are individually tiny but compound significantly across a board.
7. Scores from different metric eras are not comparable — only compare boards within the current metric.

### UI map (tabs)

RULES (classification, breaks, board limits, packaging rules, service span) → DEMAND → AUTO-BUILD (incl. 10-hour sweep) → COVERAGE (score/chart/violation banners) → BOARD DESIGNER (Gantt-style editing, undo, KPI strip) → PACKAGING (signup-sheet grid view, auto-package, per-day refine) → SUGGESTIONS (ranked moves, deep optimize). Global: Save/Load project (JSON), Export board (xlsx, signup-tab layout).

Styling: desktop-first, HASTUS-inspired, Barlow Condensed/Inter, flat panels; teal = supply, amber = demand, red = gaps/violations. Number inputs need explicit white background + dark text (an iOS white-on-white bug was already fixed once — don't reintroduce it).

## Roadmap context (for scoping new work)

1. Compare & Publish module (scenario comparison, posting-format export, change memo) is next.
2. Then: certified-ceiling computation (LP/MILP, premium-tier candidate), a real file-import panel, Gantt edge-drag, per-day sketch overrides.
3. SaaS/multi-tenant accounts are explicitly parked until a second agency is real — don't add backend/auth infrastructure speculatively.
