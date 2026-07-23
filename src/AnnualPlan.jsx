import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { ResponsiveContainer, ComposedChart, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { DAYS, NumField, Stat, parseSignupWorkbook } from "./App.jsx";
import { PhaseStrip } from "./CallCentre.jsx";
import { ANNUALPLAN_SAMPLE } from "./annualPlanSampleData.js";
import { useAccountProject, useSignupList, SaveStatus, AccountChip, SignupSwitcher } from "./useAccountProject.jsx";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

/* Annual Service Plan — projects next year's total daily trips from a prior year's history
   (matched by day-of-week position + growth %, with statutory holidays matched by name where
   possible) and splits that demand across providers: capacity providers (in-house, dedicated
   contractors — trips = scheduled hours × productivity) absorb what they can, then whatever's
   left falls to remainder providers (non-dedicated/taxi, priced per trip). v1 is deliberately
   "total trips" only — no ambulatory/wheelchair passenger-type split, no per-vehicle escort
   accounting; those can layer on once the core annual-plan-to-daily-report handoff is proven. */

const ink = "var(--chrome)", text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", demandAmber = "var(--demand-amber)", gapRed = "var(--gap-red)",
  bookoutViolet = "var(--bookout-violet)", sampleGray = "var(--sample-gray)";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const primaryBtn = { ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal };
const cardStyle = { background: card, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 14 };
const hTitle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 10 };
const PROVIDER_COLORS = [supplyTeal, demandAmber, bookoutViolet, "#B0455E", "#4C6EF5", "#2F9E44"];

const clone = (o) => JSON.parse(JSON.stringify(o));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------- date helpers (plain calendar-date math, UTC throughout so no local-tz drift) ---------- */
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y) => (isLeap(y) ? 366 : 365);
const isoForDoy = (y, doy) => { const d = new Date(Date.UTC(y, 0, 1)); d.setUTCDate(d.getUTCDate() + doy); return d.toISOString().slice(0, 10); };
const dowOfIso = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat, matches DAYS order
const monthOfIso = (iso) => +iso.slice(5, 7) - 1;
const dayOfYearIndex = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
};
const EXCEL_EPOCH = 25569;
const serialToISO = (serial) => new Date(Math.round((Math.floor(serial) - EXCEL_EPOCH) * 86400000)).toISOString().slice(0, 10);

/* ---------- projection engine ----------
   A target-year day that's a statutory holiday is matched by holiday NAME against every loaded
   historical year's same-named holiday (this year's Thanksgiving feeds next year's Thanksgiving).
   Every other (regular) day is matched, independently in every loaded historical year (up to
   MAX_HISTORY_YEARS), to the day in that year sharing its day-of-week whose relative position in
   the year (day-of-year ÷ year-length) is closest — so "day N of the year" doesn't have to line
   up across years of different length, but the weekday shape (weekday vs Sat vs Sun) always
   carries forward. That regular-day matcher explicitly skips any historical date that was itself
   a statutory holiday, so an ordinary day never gets predicted off a holiday's anomalous ridership.
   Both paths' per-year matches are then blended (see weightedPredict) into one predicted number,
   and growth % is applied on top of that blend. A day can be manually overridden (dayOverrides),
   which wins over the model but doesn't stop the model from still being computed — the table shows
   both so an override's effect is visible, not hidden. */
const MAX_HISTORY_YEARS = 5;
// The history template always offers "this year back MAX_HISTORY_YEARS" off the real calendar,
// not whatever year happens to be loaded/previewed — so it keeps moving forward on its own every
// year with no manual upkeep. Read once per page load; a tab left open across a New Year's
// rollover would need a refresh to pick up the new year, same as any other page.
const CURRENT_YEAR = new Date().getFullYear();

function yearsPresent(history) {
  return [...new Set(Object.keys(history).map((iso) => +iso.slice(0, 4)))].sort((a, b) => a - b);
}

// `excludeDates`: historical dates to skip as candidates — used to keep a *regular* target day
// from being matched against a historical date that was itself a statutory holiday (anomalously
// low/high ridership that has nothing to do with an ordinary day's pattern). Holiday-to-holiday
// matching happens separately, by name, in buildProjection — this exclusion only protects the
// non-holiday fallback matcher.
function matchInYear(targetIso, history, year, excludeDates) {
  const targetYear = +targetIso.slice(0, 4);
  const targetFrac = dayOfYearIndex(targetIso) / daysInYear(targetYear);
  const dow = dowOfIso(targetIso);
  let best = null, bestDist = Infinity;
  for (const iso of Object.keys(history)) {
    if (+iso.slice(0, 4) !== year || dowOfIso(iso) !== dow) continue;
    if (excludeDates && excludeDates.has(iso)) continue;
    const frac = dayOfYearIndex(iso) / daysInYear(year);
    const dist = Math.abs(frac - targetFrac);
    if (dist < bestDist) { bestDist = dist; best = iso; }
  }
  return best;
}

// Up to maxYears most-recently-loaded years, most-recent-first, each contributing at most one
// matched day (a year with no data for the matching weekday just contributes nothing).
function matchAllYears(targetIso, history, excludeDates, maxYears = MAX_HISTORY_YEARS) {
  const years = yearsPresent(history).slice(-maxYears).reverse();
  const out = [];
  for (const year of years) {
    const iso = matchInYear(targetIso, history, year, excludeDates);
    if (iso != null) out.push({ year, iso, value: history[iso] });
  }
  return out;
}

// Recency-weighted average — candidates are already most-recent-first, so the most recent gets
// weight n (n = candidate count) down to 1 for the oldest. Smooths out one-off spikes/dips while
// still leaning toward the latest trend; a single candidate just passes through unchanged.
function weightedPredict(candidates) {
  if (!candidates.length) return null;
  const n = candidates.length;
  let sum = 0, weightTotal = 0;
  candidates.forEach((c, i) => { const w = n - i; sum += c.value * w; weightTotal += w; });
  return sum / weightTotal;
}

// holidaysHistoryByYear: {year: [{date,name}]} for every loaded history year; holidaysPlan:
// [{date,name}] for planYear — both from date-holidays' getHolidays(), public holidays only.
function buildProjection(history, planYear, growthPct, holidaysHistoryByYear, holidaysPlan, dayOverrides) {
  const mult = 1 + (growthPct || 0) / 100;
  const planHolidayByDate = new Map(holidaysPlan.map((h) => [h.date, h.name]));
  const years = yearsPresent(history).slice(-MAX_HISTORY_YEARS).reverse();
  // Every historical date that was itself a statutory holiday in its own year — excluded from the
  // regular (non-holiday-target) matcher below so an ordinary day never gets predicted off a
  // holiday's anomalous ridership. Holidays still feed predictions, just only into other holidays
  // (matched by name, right below), never into a regular day's fallback match.
  const historyHolidayDates = new Set();
  for (const year of years) for (const h of (holidaysHistoryByYear[year] || [])) historyHolidayDates.add(h.date);
  const len = daysInYear(planYear);
  const out = {};
  const detail = {};
  for (let doy = 0; doy < len; doy++) {
    const iso = isoForDoy(planYear, doy);
    const holidayName = planHolidayByDate.get(iso);
    let candidates = null;
    if (holidayName) {
      candidates = [];
      for (const year of years) {
        const hist = (holidaysHistoryByYear[year] || []).find((h) => h.name === holidayName);
        if (hist && history[hist.date] != null) candidates.push({ year, iso: hist.date, value: history[hist.date] });
      }
      if (!candidates.length) candidates = null; // no year had this named holiday — fall back below
    }
    if (!candidates) candidates = matchAllYears(iso, history, historyHolidayDates);
    const predicted = weightedPredict(candidates);
    const withGrowth = predicted != null ? Math.round(predicted * mult) : 0;
    const override = dayOverrides ? dayOverrides[iso] : null;
    const finalVal = override != null ? override : withGrowth;
    out[iso] = finalVal;
    detail[iso] = { candidates, holidayName: holidayName || null, predicted: withGrowth, overridden: override != null };
  }
  return { projected: out, detail };
}

/* ---------- capacity split ----------
   Capacity providers (in-house, dedicated contractors) take trips in list order up to
   scheduled-hours × productivity for that day-of-week; whatever's left over falls to remainder
   providers (non-dedicated/taxi), split by their configured share, last one absorbing the rest.
   If NO remainder provider is configured, leftover demand shows as unaccommodated — a real signal,
   not silently dropped. */
function splitDay(trips, dow, providers, isHoliday) {
  let remaining = Math.max(0, trips);
  const rows = [];
  // Statutory holidays run a Sunday-level schedule for capacity providers, matching the
  // operator workbench's own holiday convention (a holiday's runsAs defaults to Sunday).
  const effDow = isHoliday ? 0 : dow;
  for (const p of providers) {
    if (p.role !== "capacity") continue;
    const hours = (p.hoursByDow && p.hoursByDow[effDow]) || 0;
    const productivity = (effDow === 0 || effDow === 6) ? (p.productivityWeekend || 0) : (p.productivityWeekday || 0);
    const capacity = hours * productivity;
    const served = Math.min(capacity, remaining);
    remaining -= served;
    rows.push({ id: p.id, name: p.name, role: "capacity", trips: served, capacity, hours, cost: hours * (p.hourlyRate || 0) });
  }
  const remainderProviders = providers.filter((p) => p.role === "remainder");
  remainderProviders.forEach((p, i) => {
    const isLast = i === remainderProviders.length - 1;
    const take = isLast ? remaining : Math.round(remaining * ((p.share ?? 100) / 100));
    remaining -= take;
    rows.push({ id: p.id, name: p.name, role: "remainder", trips: take, capacity: null, hours: null, cost: take * (p.perTripRate || 0) });
  });
  return { rows, unaccommodated: Math.max(0, remaining) };
}

function monthlyRollup(planYear, projected, providers, holidaysPlan) {
  const holidaySet = new Set((holidaysPlan || []).map((h) => h.date));
  const months = MONTHS.map((label) => ({ label, trips: 0, unaccommodated: 0, byProvider: {} }));
  for (const iso of Object.keys(projected)) {
    const mi = monthOfIso(iso);
    const dow = dowOfIso(iso);
    const trips = projected[iso];
    months[mi].trips += trips;
    const { rows, unaccommodated } = splitDay(trips, dow, providers, holidaySet.has(iso));
    months[mi].unaccommodated += unaccommodated;
    for (const r of rows) {
      if (!months[mi].byProvider[r.id]) months[mi].byProvider[r.id] = { name: r.name, trips: 0, hours: 0, cost: 0 };
      months[mi].byProvider[r.id].trips += r.trips;
      months[mi].byProvider[r.id].hours += r.hours || 0;
      months[mi].byProvider[r.id].cost += r.cost;
    }
  }
  return months;
}
// `year`: restrict to one loaded year's days — history can hold up to MAX_HISTORY_YEARS years at
// once now, and summing all of them into 12 buckets would silently conflate separate years.
function historyMonthlyTotals(history, year) {
  const months = MONTHS.map(() => 0);
  for (const iso of Object.keys(history)) {
    if (year != null && +iso.slice(0, 4) !== year) continue;
    months[monthOfIso(iso)] += history[iso];
  }
  return months;
}
function historyYearTotal(history, year) {
  let total = 0;
  for (const iso of Object.keys(history)) if (+iso.slice(0, 4) === year) total += history[iso];
  return total;
}

/* ---------- service hours from headcount ----------
   Optional alternate way to populate a capacity provider's hoursByDow: instead of typing 7 day
   totals directly, describe the workforce (full-time + part-time headcount, weekday vs weekend,
   an average shift length, and a single absence rate covering vacation/sick/leave/etc. all paid
   but not driving) and derive net scheduled hours per day-of-week from that. Mirrors the
   weekday/weekend split already used for productivity elsewhere on the provider card. */
const DEFAULT_HEADCOUNT = { ftWeekday: 20, ftWeekend: 12, ptWeekday: 5, ptWeekend: 3, shiftHours: 8, absenceRate: 12 };
function hoursByDowFromHeadcount(hc) {
  const eff = 1 - Math.max(0, Math.min(100, hc.absenceRate || 0)) / 100;
  const weekday = Math.max(0, (hc.ftWeekday || 0) + (hc.ptWeekday || 0)) * Math.max(0, hc.shiftHours || 0) * eff;
  const weekend = Math.max(0, (hc.ftWeekend || 0) + (hc.ptWeekend || 0)) * Math.max(0, hc.shiftHours || 0) * eff;
  return [weekend, weekday, weekday, weekday, weekday, weekday, weekend]; // Sun..Sat
}

// Third way to populate hoursByDow: sum a real uploaded signup board's per-shift hours
// (report-to-off minus break) by day of week — the actual scheduled pattern, absences and
// all, rather than an estimate. Reuses the operator workbench's own parser/template.
function hoursByDowFromBoard(segments) {
  const hours = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  for (const seg of segments) {
    const dur = Math.max(0, (seg.e - seg.s - (seg.b ? seg.b[1] - seg.b[0] : 0)) / 60);
    for (const day of seg.days || []) {
      const i = DAYS.indexOf(day);
      if (i >= 0) hours[i] += dur;
    }
  }
  return hours;
}

/* ---------- service hours from market share ----------
   Fourth way to populate hoursByDow: instead of hours as the input, set a target % of total daily
   demand this provider is meant to serve, and work backward through weekday/weekend productivity
   to the hours that requires — a sizing exercise ("if this provider carries X% of volume, how many
   vehicle-hours does that take") rather than a capacity check. Unlike the other three modes this
   stays a *live* derivation (see effectiveProviders in the main component) instead of a snapshot,
   since it depends on the demand curve — which changes for reasons unrelated to this provider's own
   fields (history uploads, growth %, day overrides) — not just this provider's own inputs. */
function avgTripsByDow(projected) {
  const sums = [0, 0, 0, 0, 0, 0, 0], counts = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  for (const iso of Object.keys(projected)) {
    const d = dowOfIso(iso);
    sums[d] += projected[iso];
    counts[d]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}
function hoursByDowFromMarketShare(avgDemandByDow, sharePct, productivityWeekday, productivityWeekend) {
  return avgDemandByDow.map((avg, d) => {
    const productivity = (d === 0 || d === 6) ? productivityWeekend : productivityWeekday;
    return productivity > 0 ? (avg * (sharePct || 0) / 100) / productivity : 0;
  });
}

const nextId = () => "p" + Math.random().toString(36).slice(2, 9);

// Shared with other modules that need to reproduce this module's own demand-projection and
// capacity-split math exactly (e.g. Daily Service Report deriving a per-day budget from a saved
// Annual Plan) — real cross-module reuse for logic this central, same pattern as this file's own
// import of parseSignupWorkbook/DAYS from App.jsx, rather than each module re-deriving it.
export {
  MONTHS, DOW_SHORT, daysInYear, isoForDoy, dowOfIso, monthOfIso, yearsPresent,
  buildProjection, splitDay, avgTripsByDow, hoursByDowFromMarketShare,
};

export default function AnnualPlan({ onHome, user, logout }) {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { localStorage.setItem("theme", theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  const [tab, setTab] = useState("providers");
  const [providers, setProviders] = useState(() => clone(ANNUALPLAN_SAMPLE.providers));
  const [history, setHistory] = useState(() => clone(ANNUALPLAN_SAMPLE.history));
  const [historyYear, setHistoryYear] = useState(ANNUALPLAN_SAMPLE.historyYear);
  const [planYear, setPlanYear] = useState(ANNUALPLAN_SAMPLE.planYear);
  const [growthPct, setGrowthPct] = useState(ANNUALPLAN_SAMPLE.growthPct);
  const [jurisdiction, setJurisdiction] = useState(() => clone(ANNUALPLAN_SAMPLE.jurisdiction));
  const [historySource, setHistorySource] = useState("sample"); // "sample" | "uploaded"
  const [uploadInfo, setUploadInfo] = useState(null);
  const [dayOverrides, setDayOverrides] = useState(() => clone(ANNUALPLAN_SAMPLE.dayOverrides || {}));
  const upRef = useRef(null);

  /* ---------- statutory holidays (lazy-loaded, same pattern as the operator module) ---------- */
  const [hdCtor, setHdCtor] = useState(null);
  const [hdCountries, setHdCountries] = useState({});
  const [hdRegions, setHdRegions] = useState({});
  const [hdLoading, setHdLoading] = useState(false);
  const hdImportStarted = useRef(false);
  useEffect(() => {
    // Loaded unconditionally on mount rather than gated to the History/Projection tabs: holiday
    // suppression now also feeds live Providers-tab numbers (market-share hours mode), and Split/
    // Budget both consume holiday-aware `projected` too — so every tab needs this, not just two.
    if (hdImportStarted.current) return;
    hdImportStarted.current = true;
    setHdLoading(true);
    import("date-holidays")
      .then((m) => { setHdCtor(() => m.default); setHdCountries(new m.default().getCountries()); setHdLoading(false); })
      .catch(() => setHdLoading(false));
  }, []);
  useEffect(() => {
    if (!hdCtor) return;
    setHdRegions(new hdCtor(jurisdiction.country).getStates(jurisdiction.country) || {});
  }, [hdCtor, jurisdiction.country]);
  const holidaysFor = (year) => {
    if (!hdCtor) return [];
    const hd = new hdCtor(jurisdiction.country, jurisdiction.region || undefined);
    return hd.getHolidays(year).filter((h) => h.type === "public").map((h) => ({ date: h.date.slice(0, 10), name: h.name }));
  };
  // One year's holidays for every loaded history year (not just historyYear) — buildProjection
  // needs all of them to blend a holiday's value across every year it's available in.
  const historyYears = useMemo(() => yearsPresent(history), [history]);
  const holidaysHistoryByYear = useMemo(() => {
    const out = {};
    for (const y of historyYears) out[y] = holidaysFor(y);
    return out;
  }, [hdCtor, jurisdiction.country, jurisdiction.region, historyYears]);
  const holidaysPlan = useMemo(() => holidaysFor(planYear), [hdCtor, jurisdiction.country, jurisdiction.region, planYear]);

  /* ---------- derived: projection + split (pure functions of the state above) ---------- */
  const { projected, detail: projectionDetail } = useMemo(
    () => buildProjection(history, planYear, growthPct, holidaysHistoryByYear, holidaysPlan, dayOverrides),
    [history, planYear, growthPct, holidaysHistoryByYear, holidaysPlan, dayOverrides]
  );
  // Market-share providers' hoursByDow is derived live from the demand curve (see
  // hoursByDowFromMarketShare) rather than stored as authoritative state — effectiveProviders is
  // what actually feeds the split/rollup engine below; raw `providers` (persisted, edited by the
  // Providers tab) never carries computed hours for a share-mode provider.
  const avgDemandByDow = useMemo(() => avgTripsByDow(projected), [projected]);
  const effectiveProviders = useMemo(() => providers.map((p) => (
    p.role === "capacity" && p.hoursMode === "share"
      ? { ...p, hoursByDow: hoursByDowFromMarketShare(avgDemandByDow, p.marketSharePct, p.productivityWeekday, p.productivityWeekend) }
      : p
  )), [providers, avgDemandByDow]);
  const rollup = useMemo(() => monthlyRollup(planYear, projected, effectiveProviders, holidaysPlan), [planYear, projected, effectiveProviders, holidaysPlan]);
  const historyMonthly = useMemo(() => historyMonthlyTotals(history, historyYear), [history, historyYear]);
  const annualTotals = useMemo(() => {
    const totals = { trips: 0, unaccommodated: 0, byProvider: {} };
    for (const m of rollup) {
      totals.trips += m.trips; totals.unaccommodated += m.unaccommodated;
      for (const [id, v] of Object.entries(m.byProvider)) {
        if (!totals.byProvider[id]) totals.byProvider[id] = { name: v.name, trips: 0, hours: 0, cost: 0 };
        totals.byProvider[id].trips += v.trips; totals.byProvider[id].hours += v.hours; totals.byProvider[id].cost += v.cost;
      }
    }
    return totals;
  }, [rollup]);
  const historyAnnual = useMemo(() => historyYearTotal(history, historyYear), [history, historyYear]);

  /* ---------- providers editing ---------- */
  const updateProvider = (id, patch) => setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const updateProviderHour = (id, dow, v) => setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, hoursByDow: p.hoursByDow.map((h, i) => (i === dow ? v : h)) } : p)));
  const setHoursMode = (id, mode) => setProviders((ps) => ps.map((p) => {
    if (p.id !== id) return p;
    if (mode === "headcount") {
      const headcount = p.headcount || DEFAULT_HEADCOUNT;
      return { ...p, hoursMode: mode, headcount, hoursByDow: hoursByDowFromHeadcount(headcount) };
    }
    if (mode === "share") return { ...p, hoursMode: mode, marketSharePct: p.marketSharePct ?? 50 };
    return { ...p, hoursMode: mode };
  }));
  // hoursByDow isn't written here for share mode — effectiveProviders (above) always recomputes it
  // live from the current demand curve, so there's nothing to snapshot.
  const setMarketShare = (id, pct) => setProviders((ps) => ps.map((p) => (
    p.id === id ? { ...p, marketSharePct: Math.max(0, Math.min(100, pct)) } : p
  )));
  const updateProviderHeadcount = (id, patch) => setProviders((ps) => ps.map((p) => {
    if (p.id !== id) return p;
    const headcount = { ...(p.headcount || DEFAULT_HEADCOUNT), ...patch };
    return { ...p, headcount, hoursByDow: hoursByDowFromHeadcount(headcount) };
  }));
  const importProviderBoard = (id, file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: "array" });
        const res = parseSignupWorkbook(wb);
        if (!res.ok) { alert(res.error || "Could not read that signup board."); return; }
        const hoursByDow = hoursByDowFromBoard(res.segments);
        setProviders((ps) => ps.map((p) => (p.id === id
          ? { ...p, hoursMode: "imported", hoursByDow, importInfo: `${res.summary.shifts} shift(s) from ${file.name}` }
          : p)));
      } catch (e) {
        alert("Could not read that file — check it matches the Signup Builder's export/template format.");
      }
    };
    rd.readAsArrayBuffer(file);
  };
  // Pulls a Resourcing module signup's live board directly from the account — no export/upload
  // round trip. Same target shape as the xlsx path above (hoursByDowFromBoard), since a saved
  // signup's payload.board is exactly parseSignupWorkbook's segments shape (see App.jsx buildPayload).
  const importProviderFromSignup = async (id, resourcingProjectId, signupName) => {
    if (!resourcingProjectId) return;
    try {
      const res = await fetch(`/api/projects/resourcing/${resourcingProjectId}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data.payload || !data.payload.board) { alert("Could not load that signup's board."); return; }
      const board = data.payload.board;
      const hoursByDow = hoursByDowFromBoard(board);
      const shiftCount = new Set(board.map((sg) => sg.shift)).size;
      setProviders((ps) => ps.map((p) => (p.id === id
        ? { ...p, hoursMode: "imported", hoursByDow, importInfo: `${shiftCount} shift(s) from "${signupName}" (Resourcing signup)` }
        : p)));
    } catch (e) {
      alert("Could not reach the server to load that signup.");
    }
  };
  const addProvider = (role) => setProviders((ps) => [...ps, role === "capacity"
    ? { id: nextId(), name: "New capacity provider", role: "capacity", hoursByDow: [0, 0, 0, 0, 0, 0, 0], productivityWeekday: 2, productivityWeekend: 2, hourlyRate: 50 }
    : { id: nextId(), name: "New remainder provider", role: "remainder", share: 100, perTripRate: 24 }]);
  const removeProvider = (id) => setProviders((ps) => ps.filter((p) => p.id !== id));
  // List order is meaningful, not cosmetic: splitDay (see engine above) walks capacity providers
  // in this order for the waterfall (each takes up to its own capacity before the next gets a
  // shot at what's left) and remainder providers in this order for their % share, with the last
  // one absorbing whatever's left over — so reordering here changes real numbers on Split/Budget.
  const reorderProviders = (dragId, dropId) => setProviders((ps) => {
    const fromIdx = ps.findIndex((p) => p.id === dragId);
    const toIdx = ps.findIndex((p) => p.id === dropId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return ps;
    const next = [...ps];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    return next;
  });

  /* ---------- history upload/template/sample ---------- */
  // One sheet per year (CURRENT_YEAR down to CURRENT_YEAR-(MAX_HISTORY_YEARS-1)), each its own
  // blank Date/Trips table named for that year — lets a whole multi-year history be filled in and
  // uploaded as a single file instead of one upload pass per year. Any sheet can be left blank
  // (or deleted) for a year you don't have data for; uploadHistory below skips ungrouped rows.
  // Anchored on the real calendar year, not historyYear (which only drives the chart/stat preview
  // below), so the offered years keep advancing on their own every year with no manual upkeep.
  const downloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    for (let i = 0; i < MAX_HISTORY_YEARS; i++) {
      const year = CURRENT_YEAR - i;
      const rows = [["Date", "Trips"]];
      for (let doy = 0; doy < daysInYear(year); doy++) rows.push([isoForDoy(year, doy), ""]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, String(year));
    }
    XLSX.writeFile(wb, `annual-plan-history-${CURRENT_YEAR - MAX_HISTORY_YEARS + 1}-${CURRENT_YEAR}-template.xlsx`);
  };
  // Merges into existing history rather than replacing it, so a second (third, fourth…) file
  // upload adds another year instead of wiping out what's already loaded — up to MAX_HISTORY_YEARS
  // years are kept, oldest dropped first once a newer one pushes past the cap. Reads every sheet
  // in the workbook (not just the first) so the multi-year template's one-sheet-per-year layout
  // uploads in a single pass; a plain single-sheet file (or a .csv, which has no sheet concept)
  // still works exactly as before.
  const uploadHistory = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
        const out = {}; let parsed = 0, skipped = 0, years = new Set();
        for (const sheetName of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 }).slice(1);
          for (const row of rows) {
            if (!row || row[0] == null || row[0] === "") continue;
            let iso = null;
            if (typeof row[0] === "number") iso = serialToISO(row[0]);
            else { const d = new Date(row[0]); if (!isNaN(d)) iso = d.toISOString().slice(0, 10); }
            if (!iso) { skipped++; continue; }
            // A blank Trips cell means "not filled in yet" (common for a year's sheet you're only
            // partway through, or left blank entirely) — not an error, so it's silently skipped
            // rather than counted against the file.
            if (row[1] == null || row[1] === "") continue;
            const trips = Number(row[1]);
            if (!Number.isFinite(trips)) { skipped++; continue; }
            out[iso] = trips; parsed++; years.add(+iso.slice(0, 4));
          }
        }
        if (!parsed) { alert("Could not find any valid Date/Trips rows in that file."); return; }
        const merged = { ...history, ...out };
        const keepYears = new Set(yearsPresent(merged).slice(-MAX_HISTORY_YEARS));
        const capped = {};
        for (const [iso, v] of Object.entries(merged)) if (keepYears.has(+iso.slice(0, 4))) capped[iso] = v;
        setHistory(capped);
        // Prefer the most recent *surviving* uploaded year for the preview/template-anchor year —
        // an uploaded year that's older than the app's other MAX_HISTORY_YEARS years gets evicted
        // by the cap above in this same pass, and previewing an evicted year would show "0 trips"
        // for a year that isn't actually loaded.
        const uploadedYearsKept = [...years].filter((y) => keepYears.has(y));
        const droppedYears = [...years].filter((y) => !keepYears.has(y)).sort((a, b) => a - b);
        setHistoryYear(uploadedYearsKept.length ? Math.max(...uploadedYearsKept) : Math.max(...keepYears));
        setHistorySource("uploaded");
        setUploadInfo(`Loaded ${parsed} day(s) across ${years.size} year(s)${skipped ? `, skipped ${skipped} unreadable row(s)` : ""} — up to the ${MAX_HISTORY_YEARS} most recent years are kept.${droppedYears.length ? ` ${droppedYears.join(", ")} ${droppedYears.length === 1 ? "was" : "were"} older than the other loaded years and got dropped by that cap.` : ""}`);
      } catch (e) {
        alert("Could not read that file — check it matches the Date / Trips template.");
      }
    };
    if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };
  // Drops one loaded year's worth of history entries — lets the user manage which years feed the
  // model without re-uploading everything else. If the removed year was the one previewed in the
  // chart/template download, fall back to whichever loaded year is now most recent.
  const removeHistoryYear = (year) => {
    const remainingYears = yearsPresent(history).filter((y) => y !== year);
    setHistory((h) => {
      const out = {};
      for (const [iso, v] of Object.entries(h)) if (+iso.slice(0, 4) !== year) out[iso] = v;
      return out;
    });
    if (historyYear === year) setHistoryYear(remainingYears.length ? remainingYears[remainingYears.length - 1] : new Date().getUTCFullYear());
  };
  const useSample = () => {
    setHistory(clone(ANNUALPLAN_SAMPLE.history));
    setHistoryYear(ANNUALPLAN_SAMPLE.historyYear);
    setHistorySource("sample");
    setUploadInfo(null);
  };

  const buildPayload = () => ({ kind: "annualplan", providers, history, historyYear, planYear, growthPct, jurisdiction, historySource, dayOverrides });
  const applyPayload = (p) => {
        if (p.providers) setProviders(p.providers);
        if (p.history) setHistory(p.history);
        if (p.historyYear) setHistoryYear(p.historyYear);
        if (p.planYear) setPlanYear(p.planYear);
        if (p.growthPct != null) setGrowthPct(p.growthPct);
        if (p.jurisdiction) setJurisdiction(p.jurisdiction);
        setHistorySource(p.historySource || "uploaded");
        setDayOverrides(p.dayOverrides || {});
  };
  const payloadJson = useMemo(() => JSON.stringify(buildPayload()), [
    providers, history, historyYear, planYear, growthPct, jurisdiction, historySource, dayOverrides,
  ]);
  const { items: signups, create: createSignup, rename: renameSignup, remove: removeSignup } = useSignupList("annualplan");
  // Read-only: lets Providers offer "import from a saved Resourcing signup" alongside the
  // existing xlsx upload, without any backend change (project reads are already agency-scoped,
  // not scoped to the module that issued the request — see CLAUDE.md).
  const { items: resourcingSignups } = useSignupList("resourcing");
  const [projectId, setProjectId] = useState(null);
  useEffect(() => {
    if (!signups || projectId) return;
    if (signups.length) setProjectId(signups[0].id);
    else createSignup({ name: "My Plan" }).then(setProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signups]);
  const saveStatus = useAccountProject("annualplan", projectId, payloadJson, applyPayload);

  const providerColor = (id) => PROVIDER_COLORS[providers.findIndex((p) => p.id === id) % PROVIDER_COLORS.length];

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --supply-teal: #0F7B7A; --gap-red: #C0392B; --bookout-violet: #6C5B9E;
          --sample-gray: #5B6B75; --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #CBD5DA;
          --tint-neutral-b: #EEF4F5; --tint-teal-b: #EEF6F6; --tint-red: #FBEDEB;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --supply-teal: #2FB3AC; --gap-red: #E27A70; --bookout-violet: #A594D1;
          --sample-gray: #8B9AA5; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D;
          --tint-neutral-b: #1C262B; --tint-teal-b: #172227; --tint-red: #2E1714;
        }
        body { background: var(--paper); }
        .apnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:var(--sample-gray); }
        .apnav.on { color:${text}; border-bottom-color:${supplyTeal}; }
        input[type=text], input[type=number] { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
        select { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onHome} style={{ ...nudgeBtn, fontSize: 12 }}>‹ Transit Operations Toolkit</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>ANNUAL SERVICE PLAN</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>Projected {planYear} trips <b style={{ color: text, fontSize: 15 }}>{annualTotals.trips.toLocaleString()}</b></div>
            <SignupSwitcher label="Plan" projectId={projectId} items={signups} onSwitch={setProjectId}
              onCreate={async (vals) => setProjectId(await createSignup(vals))}
              onRename={renameSignup}
              onDelete={(id) => { removeSignup(id); if (id === projectId) setProjectId(null); }} />
            <SaveStatus status={saveStatus} />
            <AccountChip user={user} logout={logout} />
            {DARK_MODE_ENABLED && (
              <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle light/dark mode"
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", padding: "5px 8px", background: "none", border: "1px solid var(--border-input)", borderRadius: 2, color: sampleGray, cursor: "pointer" }}>
                {theme === "dark" ? "☀ Light" : "☾ Dark"}
              </button>
            )}
          </div>
        </div>

        <PhaseStrip tab={tab} setTab={setTab} navClass="apnav" groups={[
          { phase: "PHASE 1 · SETUP", tabs: [
            { key: "providers", label: "PROVIDERS" },
            { key: "history", label: "HISTORY", done: historySource === "uploaded", reason: "Still using the sample history — upload your real prior-year trips" },
          ]},
          { phase: "PHASE 2 · PROJECT", tabs: [
            { key: "projection", label: "PROJECTION" },
          ]},
          { phase: "PHASE 3 · REVIEW", tabs: [
            { key: "split", label: "CAPACITY & SPLIT" },
          ]},
          { phase: "PHASE 4 · BUDGET", tabs: [
            { key: "budget", label: "BUDGET" },
          ]},
        ]} />

        {tab === "providers" && (
          <ProvidersTab {...{ providers, updateProvider, updateProviderHour, addProvider, removeProvider, reorderProviders, setHoursMode, updateProviderHeadcount, importProviderBoard, importProviderFromSignup, resourcingSignups, avgDemandByDow, setMarketShare }} />
        )}
        {tab === "history" && (
          <HistoryTab {...{
            historyYear, setHistoryYear, planYear, setPlanYear, growthPct, setGrowthPct,
            jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, hdLoading,
            history, historyYears, historyMonthly, historyAnnual, historySource, uploadInfo,
            downloadTemplate, uploadHistory, useSample, upRef, removeHistoryYear,
            holidaysPlan, projected, projectionDetail, dayOverrides, setDayOverrides,
          }} />
        )}
        {tab === "projection" && (
          <ProjectionTab {...{ planYear, growthPct, historyMonthly, rollup, annualTotals, historyAnnual, holidaysPlan }} />
        )}
        {tab === "split" && (
          <SplitTab {...{ planYear, providers, rollup, annualTotals, providerColor }} />
        )}
        {tab === "budget" && (
          <BudgetTab {...{ planYear, providers, rollup, annualTotals, providerColor }} />
        )}
      </div>
    </div>
  );
}

/* ================= PROVIDERS ================= */
const modeBtn = (active) => ({
  fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, padding: "4px 10px",
  border: `1px solid ${active ? supplyTeal : "var(--border-input)"}`, borderRadius: 2, cursor: "pointer",
  background: active ? supplyTeal : card, color: active ? "#fff" : text,
});
function ProvidersTab({ providers, updateProvider, updateProviderHour, addProvider, removeProvider, reorderProviders, setHoursMode, updateProviderHeadcount, importProviderBoard, importProviderFromSignup, resourcingSignups, avgDemandByDow, setMarketShare }) {
  // Drag-and-drop reorder, native HTML5 DnD (no library — same "keep it simple" pattern this app
  // uses elsewhere). dragId is the provider being dragged; overId is whichever card the pointer is
  // currently over, used only for the drop-target highlight — the actual move happens in onDrop.
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  // Informational only (this app flags, never blocks) — a total over 100% just means the share
  // targets are more ambitious than the demand can literally cover once the waterfall runs;
  // Split/Budget will show the real outcome.
  const totalSharePct = providers.filter((p) => p.role === "capacity" && p.hoursMode === "share")
    .reduce((sum, p) => sum + (p.marketSharePct || 0), 0);
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Providers</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          <b>Capacity providers</b> (in-house / dedicated contractors) take trips up to scheduled hours × productivity for that day of week, in the order listed — hours can be set directly, computed from headcount or an uploaded signup board, or from a target <b>market share</b> of daily demand (worked backward through productivity into the hours that share requires). <b>Remainder providers</b> (non-dedicated / taxi) absorb whatever's left, priced per trip — in list order, the last one takes whatever the others didn't claim. Drag the ⠿ handle to reorder; Split and Budget reflect the new order immediately. Add as many of each as you need.
        </div>
        {totalSharePct > 100 && (
          <div style={{ fontSize: 12, color: gapRed, background: "var(--tint-red, #F6E4E1)", border: "1px solid var(--border-light)", padding: "6px 10px", marginBottom: 12 }}>
            Market-share targets across your capacity providers add up to {Math.round(totalSharePct)}% — more than the demand can fully support. Actual trips served (Split/Budget) will fall short of these targets once the capacity waterfall runs.
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id}
            onDragOver={(e) => { if (!dragId || dragId === p.id) return; e.preventDefault(); setOverId(p.id); }}
            onDragLeave={() => setOverId((o) => (o === p.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== p.id) reorderProviders(dragId, p.id); setDragId(null); setOverId(null); }}
            style={{
              border: `1px solid ${overId === p.id ? supplyTeal : "var(--border-light)"}`, borderRadius: 2, padding: "10px 12px", marginBottom: 10,
              opacity: dragId === p.id ? 0.4 : 1, background: card,
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <span title="Drag to reorder" draggable
                onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                style={{ cursor: "grab", color: sampleGray, fontSize: 16, lineHeight: 1, userSelect: "none" }}>⠿</span>
              <input value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 600, padding: "4px 8px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, minWidth: 220 }} />
              <span style={{ fontSize: 11, padding: "2px 8px", background: p.role === "capacity" ? "var(--tint-teal-b)" : "var(--tint-neutral-b)", border: "1px solid var(--border-light)", color: sampleGray, borderRadius: 2 }}>
                {p.role === "capacity" ? "capacity (hours × productivity)" : "remainder (per trip)"}
              </span>
              <button style={{ ...nudgeBtn, marginLeft: "auto", color: gapRed, borderColor: gapRed, padding: "3px 8px", fontSize: 12 }} onClick={() => removeProvider(p.id)}>remove</button>
            </div>
            {p.role === "capacity" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: sampleGray }}>Scheduled hours:</span>
                  <button style={modeBtn((p.hoursMode || "manual") === "manual")} onClick={() => setHoursMode(p.id, "manual")}>Enter directly</button>
                  <button style={modeBtn(p.hoursMode === "headcount")} onClick={() => setHoursMode(p.id, "headcount")}>Compute from headcount</button>
                  <button style={modeBtn(p.hoursMode === "share")} onClick={() => setHoursMode(p.id, "share")}>Set market share</button>
                  <select value="" onChange={(e) => {
                      if (!e.target.value) return;
                      const s = (resourcingSignups || []).find((s) => s.id === Number(e.target.value));
                      if (s) importProviderFromSignup(p.id, s.id, s.name);
                    }}
                    style={{ ...modeBtn(p.hoursMode === "imported"), maxWidth: 220 }}>
                    <option value="">Import from signup board…</option>
                    {resourcingSignups === null && <option disabled>Loading your signups…</option>}
                    {resourcingSignups && resourcingSignups.length === 0 && <option disabled>No saved Resourcing signups yet</option>}
                    {resourcingSignups && resourcingSignups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: sampleGray }}>or</span>
                  <button style={{ ...nudgeBtn, fontSize: 12, padding: "4px 10px" }} onClick={() => document.getElementById("board-upload-" + p.id).click()}>Upload a file…</button>
                  <input id={"board-upload-" + p.id} type="file" accept=".xlsx" style={{ display: "none" }}
                    onChange={(e) => { if (e.target.files && e.target.files[0]) importProviderBoard(p.id, e.target.files[0]); e.target.value = ""; }} />
                </div>
                {p.hoursMode === "headcount" ? (
                  <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", borderRadius: 2, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, marginBottom: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Full-time — weekdays
                        <NumField value={p.headcount.ftWeekday} onCommit={(v) => updateProviderHeadcount(p.id, { ftWeekday: Math.max(0, v) })} /></label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Full-time — weekends
                        <NumField value={p.headcount.ftWeekend} onCommit={(v) => updateProviderHeadcount(p.id, { ftWeekend: Math.max(0, v) })} /></label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Part-time — weekdays
                        <NumField value={p.headcount.ptWeekday} onCommit={(v) => updateProviderHeadcount(p.id, { ptWeekday: Math.max(0, v) })} /></label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Part-time — weekends
                        <NumField value={p.headcount.ptWeekend} onCommit={(v) => updateProviderHeadcount(p.id, { ptWeekend: Math.max(0, v) })} /></label>
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Avg shift length (hrs)
                        <NumField value={p.headcount.shiftHours} step={0.5} onCommit={(v) => updateProviderHeadcount(p.id, { shiftHours: Math.max(0, v) })} /></label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Absence rate (%)
                        <NumField value={p.headcount.absenceRate} step={0.5} onCommit={(v) => updateProviderHeadcount(p.id, { absenceRate: Math.max(0, Math.min(100, v)) })} /></label>
                      <span style={{ fontSize: 11.5, color: sampleGray }}>Paid hours lost to vacation, sick, LTD, leave, etc. — reduces headcount × shift length down to net scheduled hours.</span>
                    </div>
                    <div style={{ fontSize: 12, color: text, marginTop: 8, fontWeight: 600 }}>
                      → Weekday {Math.round(p.hoursByDow[1]).toLocaleString()} hrs/day · Weekend {Math.round(p.hoursByDow[0]).toLocaleString()} hrs/day
                    </div>
                  </div>
                ) : p.hoursMode === "share" ? (
                  <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", borderRadius: 2, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>Target share of daily demand (%)
                        <NumField value={p.marketSharePct ?? 50} step={1} onCommit={(v) => setMarketShare(p.id, v)} /></label>
                    </div>
                    <div style={{ fontSize: 12.5, color: sampleGray }}>
                      Hours below are worked backward from this share of the average day's projected demand, through weekday/weekend productivity — and update automatically whenever history, growth %, or productivity change, no re-entry needed. Actual trips served (Split/Budget) still depend on this provider's position in the capacity list above.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, marginTop: 8 }}>
                      {DOW_SHORT.map((d, i) => (
                        <div key={d} style={{ fontSize: 11, color: sampleGray }}>
                          {d} <div style={{ fontSize: 13, color: text, fontWeight: 600 }}>
                            {Math.round(hoursByDowFromMarketShare(avgDemandByDow, p.marketSharePct, p.productivityWeekday, p.productivityWeekend)[i]).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : p.hoursMode === "imported" ? (
                  <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", borderRadius: 2, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ fontSize: 12.5, color: sampleGray }}>
                      {p.importInfo || "Imported from a signup board."} Weekday/weekend hours below are the sum of that board's scheduled shift hours (report-to-off minus break) by day of week — import again to refresh from a newer board.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, marginTop: 8 }}>
                      {DOW_SHORT.map((d, i) => (
                        <div key={d} style={{ fontSize: 11, color: sampleGray }}>
                          {d} <div style={{ fontSize: 13, color: text, fontWeight: 600 }}>{Math.round(p.hoursByDow[i]).toLocaleString()}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, marginBottom: 8 }}>
                    {DOW_SHORT.map((d, i) => (
                      <label key={d} style={{ fontSize: 11, color: sampleGray, display: "flex", flexDirection: "column", gap: 3 }}>
                        {d} hrs/day
                        <NumField value={p.hoursByDow[i]} onCommit={(v) => updateProviderHour(p.id, i, Math.max(0, v))} />
                      </label>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Weekday productivity (trips/hr)
                    <NumField value={p.productivityWeekday} step={0.05} onCommit={(v) => updateProvider(p.id, { productivityWeekday: Math.max(0, v) })} /></label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Weekend productivity (trips/hr)
                    <NumField value={p.productivityWeekend} step={0.05} onCommit={(v) => updateProvider(p.id, { productivityWeekend: Math.max(0, v) })} /></label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Hourly rate ($)
                    <NumField value={p.hourlyRate} step={0.5} onCommit={(v) => updateProvider(p.id, { hourlyRate: Math.max(0, v) })} /></label>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Share of remainder (%)
                  <NumField value={p.share ?? 100} onCommit={(v) => updateProvider(p.id, { share: Math.max(0, Math.min(100, v)) })} /></label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Per-trip rate ($)
                  <NumField value={p.perTripRate} step={0.5} onCommit={(v) => updateProvider(p.id, { perTripRate: Math.max(0, v) })} /></label>
                <span style={{ fontSize: 11.5, color: sampleGray, alignSelf: "center" }}>The last remainder provider in the list always absorbs whatever share isn't spoken for.</span>
              </div>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button style={nudgeBtn} onClick={() => addProvider("capacity")}>+ Add capacity provider</button>
          <button style={nudgeBtn} onClick={() => addProvider("remainder")}>+ Add remainder provider</button>
        </div>
      </div>
    </div>
  );
}

/* ================= HISTORY ================= */
const COUNTRY_PRESETS = ["CA", "US", "GB", "AU"];
const thStyle = { textAlign: "left", padding: "5px 8px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 11.5, color: sampleGray, whiteSpace: "nowrap" };
const tdStyle = { padding: "3px 8px", whiteSpace: "nowrap" };
const yearChip = (active) => ({
  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "3px 5px 3px 10px",
  border: `1px solid ${active ? supplyTeal : "var(--border-input)"}`, borderRadius: 999, cursor: "pointer",
  background: active ? "var(--tint-teal-b)" : card, color: active ? supplyTeal : text,
});

// Small text input specifically for the override column: unlike NumField it has a real "empty"
// state (no override set), not just a number — typing clears back to blank removes the override.
function OverrideField({ value, onCommit }) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(value == null ? "" : String(value)); }, [value]);
  return (
    <input type="text" inputMode="numeric" value={txt} placeholder="—"
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const raw = e.target.value;
        setTxt(raw);
        if (raw.trim() === "") { onCommit(null); return; }
        const v = parseFloat(raw);
        if (!isNaN(v)) onCommit(v);
      }}
      onBlur={() => {
        focused.current = false;
        if (txt.trim() === "") return;
        const v = parseFloat(txt);
        setTxt(isNaN(v) ? "" : String(Math.round(v)));
      }}
      style={{ width: 64, padding: "3px 5px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, fontSize: 12, textAlign: "right" }} />
  );
}

function HistoryTab({
  historyYear, setHistoryYear, planYear, setPlanYear, growthPct, setGrowthPct,
  jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, hdLoading,
  history, historyYears, historyMonthly, historyAnnual, historySource, uploadInfo,
  downloadTemplate, uploadHistory, useSample, upRef, removeHistoryYear,
  holidaysPlan, projected, projectionDetail, dayOverrides, setDayOverrides,
}) {
  const chartData = MONTHS.map((label, i) => ({ month: label, trips: historyMonthly[i] }));
  const displayYears = historyYears.slice(-MAX_HISTORY_YEARS).reverse(); // most recent first

  const holidayByDate = useMemo(() => new Map(holidaysPlan.map((h) => [h.date, h.name])), [holidaysPlan]);
  const forecastRows = useMemo(() => {
    const len = daysInYear(planYear);
    const rows = [];
    for (let doy = 0; doy < len; doy++) {
      const iso = isoForDoy(planYear, doy);
      const d = projectionDetail[iso] || { candidates: [], predicted: 0, overridden: false };
      rows.push({
        iso, dow: dowOfIso(iso), month: monthOfIso(iso),
        holidayName: holidayByDate.get(iso) || null,
        candidates: d.candidates || [], predicted: d.predicted, overridden: d.overridden,
        final: projected[iso] ?? d.predicted,
      });
    }
    return rows;
  }, [planYear, projectionDetail, projected, holidayByDate]);

  const setOverride = (iso, v) => setDayOverrides((o) => {
    if (v == null) { const rest = { ...o }; delete rest[iso]; return rest; }
    return { ...o, [iso]: Math.max(0, Math.round(v)) };
  });
  const overrideCount = Object.keys(dayOverrides).length;

  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Plan setup</div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Preview year <NumField value={historyYear} onCommit={(v) => setHistoryYear(Math.round(v))} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Plan year <NumField value={planYear} onCommit={(v) => setPlanYear(Math.round(v))} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Growth (%) <NumField value={growthPct} step={0.5} onCommit={(v) => setGrowthPct(v)} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Country
            <select value={jurisdiction.country} onChange={(e) => setJurisdiction((j) => ({ ...j, country: e.target.value, region: "" }))}
              style={{ padding: "5px 6px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, fontSize: 13 }}>
              {(Object.keys(hdCountries).length ? Object.keys(hdCountries) : COUNTRY_PRESETS).map((c) => (
                <option key={c} value={c}>{hdCountries[c] || c}</option>
              ))}
            </select>
          </label>
          {Object.keys(hdRegions).length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Province / state
              <select value={jurisdiction.region} onChange={(e) => setJurisdiction((j) => ({ ...j, region: e.target.value }))}
                style={{ padding: "5px 6px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, fontSize: 13 }}>
                <option value="">(none)</option>
                {Object.entries(hdRegions).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
          )}
          {hdLoading && <span style={{ fontSize: 12, color: sampleGray, alignSelf: "center" }}>Loading holiday calendars…</span>}
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
          Up to {MAX_HISTORY_YEARS} years of history can be loaded at once (see below) — each {planYear} day is blended from whichever of those years it matches, weighted toward the most recent, then grown by this Growth % on top. Statutory holidays are matched by name across years where possible; regular days match by closest same-weekday position instead.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={hTitle}>{historyYear} daily trips (history)</div>
          <span style={{ fontSize: 11, padding: "2px 8px", background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", color: sampleGray }}>
            {historySource === "uploaded" ? "Uploaded" : "Sample data"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button style={nudgeBtn} onClick={useSample}>Use sample</button>
            <button style={nudgeBtn} onClick={downloadTemplate}>Download {CURRENT_YEAR - MAX_HISTORY_YEARS + 1}–{CURRENT_YEAR} template</button>
            <button style={nudgeBtn} onClick={() => upRef.current && upRef.current.click()}>Upload history</button>
            <input ref={upRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadHistory(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>
        {uploadInfo && <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", padding: "7px 11px", marginBottom: 8, fontSize: 12 }}>{uploadInfo}</div>}
        {displayYears.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: sampleGray, alignSelf: "center", marginRight: 2 }}>Loaded years:</span>
            {displayYears.map((y) => (
              <span key={y} style={yearChip(y === historyYear)} onClick={() => setHistoryYear(y)}>
                {y}
                <span title={`Remove ${y}`} style={{ color: gapRed, fontWeight: 700, lineHeight: 1 }}
                  onClick={(e) => { e.stopPropagation(); removeHistoryYear(y); }}>×</span>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label={`${historyYear} annual trips`} value={historyAnnual.toLocaleString()} tone={supplyTeal} />
          <Stat label="Days loaded (all years)" value={Object.keys(history).length.toLocaleString()} />
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 4, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, border: "1px solid var(--border-light)" }} formatter={(v) => v.toLocaleString()} />
            <Bar dataKey="trips" name="Trips" fill={demandAmber} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
          The template has one sheet per year ({CURRENT_YEAR - MAX_HISTORY_YEARS + 1}–{CURRENT_YEAR}, always the current year back {MAX_HISTORY_YEARS}, one row per calendar date each) — fill in whichever years you have real records for, leave the rest blank, and upload the whole workbook back in one pass. Re-uploading adds to what's already loaded rather than replacing it, so separate single-year files work too.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={hTitle}>{planYear} day-by-day forecast</div>
          {overrideCount > 0 && (
            <>
              <span style={{ fontSize: 11, padding: "2px 8px", background: "var(--tint-teal-b)", border: "1px solid var(--border-light)", color: supplyTeal, fontWeight: 600 }}>
                {overrideCount} day{overrideCount === 1 ? "" : "s"} overridden
              </span>
              <button style={{ ...nudgeBtn, fontSize: 11.5, padding: "3px 8px" }} onClick={() => setDayOverrides({})}>Clear all overrides</button>
            </>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginBottom: 10, lineHeight: 1.5 }}>
          Every {planYear} day matched against each loaded history year (shown per-year below), blended into Predicted (recent years weighted more, then grown {growthPct}%). Statutory holidays get their own column. Type in Override to set a day's Final total by hand — clear the field to go back to the model.
        </div>
        <div style={{ overflowX: "auto", maxHeight: 560, overflowY: "auto", border: "1px solid var(--border-light)" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--border)", background: card, position: "sticky", top: 0, zIndex: 1 }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Day</th>
                <th style={thStyle}>Holiday</th>
                {displayYears.map((y) => <th key={y} style={{ ...thStyle, textAlign: "right" }}>{y}</th>)}
                <th style={{ ...thStyle, textAlign: "right" }}>Predicted</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Override</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Final</th>
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((label, mi) => (
                <React.Fragment key={label}>
                  <tr>
                    <td colSpan={6 + displayYears.length} style={{ background: "var(--tint-neutral-b)", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 12.5, padding: "5px 8px", position: "sticky", top: 27, zIndex: 1 }}>
                      {label} {planYear}
                    </td>
                  </tr>
                  {forecastRows.filter((r) => r.month === mi).map((r) => (
                    <tr key={r.iso} style={{ borderBottom: "1px solid var(--border-light)" }}>
                      <td style={tdStyle}>{r.iso}</td>
                      <td style={tdStyle}>{DOW_SHORT[r.dow]}</td>
                      <td style={{ ...tdStyle, color: r.holidayName ? gapRed : sampleGray }}>{r.holidayName || ""}</td>
                      {displayYears.map((y) => {
                        const c = r.candidates.find((cand) => cand.year === y);
                        return <td key={y} style={{ ...tdStyle, textAlign: "right", color: sampleGray }}>{c ? Math.round(c.value).toLocaleString() : "—"}</td>;
                      })}
                      <td style={{ ...tdStyle, textAlign: "right" }}>{r.predicted.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: "right", padding: "2px 8px" }}>
                        <OverrideField value={dayOverrides[r.iso] ?? null} onCommit={(v) => setOverride(r.iso, v)} />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700, color: r.overridden ? supplyTeal : text }}>{r.final.toLocaleString()}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= PROJECTION ================= */
function ProjectionTab({ planYear, growthPct, historyMonthly, rollup, annualTotals, historyAnnual, holidaysPlan }) {
  const chartData = MONTHS.map((label, i) => ({ month: label, history: historyMonthly[i], projected: rollup[i].trips }));
  const delta = historyAnnual > 0 ? ((annualTotals.trips - historyAnnual) / historyAnnual) * 100 : 0;
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>{planYear} projected trips vs. history</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label={`${planYear} projected annual trips`} value={annualTotals.trips.toLocaleString()} tone={supplyTeal} />
          <Stat label="vs. history" value={`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`} sub={`growth input: ${growthPct}%`} tone={delta >= 0 ? supplyTeal : gapRed} />
          <Stat label="Statutory holidays matched" value={`${holidaysPlan.length}`} />
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, border: "1px solid var(--border-light)" }} formatter={(v) => v.toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="history" name="History" fill="var(--sample-gray)" radius={[2, 2, 0, 0]} opacity={0.55} isAnimationActive={false} />
            <Bar dataKey="projected" name="Projected" fill={supplyTeal} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8, lineHeight: 1.6 }}>
          Each {planYear} day is matched, in every loaded history year, to whichever day shares its day of week and sits closest to the same relative point in that year — those matches are blended (recent years weighted more) then grown by {growthPct}%. Statutory holidays are matched by name across years first (this year's Thanksgiving feeds next year's Thanksgiving) before falling back to the same day-of-week rule. See the History tab's day-by-day table for the full breakdown per day, including any manual overrides.
        </div>
      </div>
    </div>
  );
}

/* ================= CAPACITY & SPLIT ================= */
function SplitTab({ planYear, providers, rollup, annualTotals, providerColor }) {
  const chartData = MONTHS.map((label, i) => {
    const row = { month: label };
    for (const p of providers) row[p.id] = Math.round(rollup[i].byProvider[p.id]?.trips || 0);
    row.unaccommodated = Math.round(rollup[i].unaccommodated);
    return row;
  });
  const grandCost = Object.values(annualTotals.byProvider).reduce((a, v) => a + v.cost, 0);
  return (
    <div>
      {annualTotals.unaccommodated > 0.5 && (
        <div style={{ background: "var(--tint-red, #F6E4E1)", border: `1px solid ${gapRed}`, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, color: gapRed }}>
          <b>{Math.round(annualTotals.unaccommodated).toLocaleString()} trips/year unaccommodated</b> — no remainder provider is configured (or configured shares don't reach 100%) to absorb demand left over after capacity providers. Add a remainder provider in PROVIDERS, or raise capacity hours/productivity.
        </div>
      )}
      <div style={cardStyle}>
        <div style={hTitle}>{planYear} trips by provider, by month</div>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, border: "1px solid var(--border-light)" }} formatter={(v) => v.toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {providers.map((p) => (
              <Bar key={p.id} dataKey={p.id} name={p.name} stackId="s" fill={providerColor(p.id)} isAnimationActive={false} />
            ))}
            {annualTotals.unaccommodated > 0.5 && <Bar dataKey="unaccommodated" name="Unaccommodated" stackId="s" fill={gapRed} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Annual summary</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: sampleGray, textAlign: "left" }}>
              <th style={{ padding: "5px 8px" }}>Provider</th><th style={{ padding: "5px 8px" }}>Trips</th><th style={{ padding: "5px 8px" }}>Share</th><th style={{ padding: "5px 8px" }}>Hours</th><th style={{ padding: "5px 8px" }}>Cost</th><th style={{ padding: "5px 8px" }}>Cost/trip</th>
            </tr></thead>
            <tbody>
              {providers.map((p) => {
                const v = annualTotals.byProvider[p.id] || { trips: 0, hours: 0, cost: 0 };
                const share = annualTotals.trips > 0 ? (v.trips / annualTotals.trips) * 100 : 0;
                return (
                  <tr key={p.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={{ padding: "5px 8px" }}><span style={{ display: "inline-block", width: 9, height: 9, background: providerColor(p.id), marginRight: 6, borderRadius: 2 }} />{p.name}</td>
                    <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{Math.round(v.trips).toLocaleString()}</td>
                    <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{share.toFixed(1)}%</td>
                    <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{p.role === "capacity" ? Math.round(v.hours).toLocaleString() : "—"}</td>
                    <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>${Math.round(v.cost).toLocaleString()}</td>
                    <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{v.trips > 0 ? `$${(v.cost / v.trips).toFixed(2)}` : "—"}</td>
                  </tr>
                );
              })}
              {annualTotals.unaccommodated > 0.5 && (
                <tr style={{ borderTop: "1px solid var(--border-light)", color: gapRed }}>
                  <td style={{ padding: "5px 8px" }}>Unaccommodated</td>
                  <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{Math.round(annualTotals.unaccommodated).toLocaleString()}</td>
                  <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{annualTotals.trips > 0 ? ((annualTotals.unaccommodated / annualTotals.trips) * 100).toFixed(1) : "0.0"}%</td>
                  <td style={{ padding: "5px 8px" }}>—</td><td style={{ padding: "5px 8px" }}>—</td><td style={{ padding: "5px 8px" }}>—</td>
                </tr>
              )}
              <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
                <td style={{ padding: "5px 8px" }}>Total</td>
                <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{Math.round(annualTotals.trips).toLocaleString()}</td>
                <td style={{ padding: "5px 8px" }}>100%</td>
                <td style={{ padding: "5px 8px" }}>—</td>
                <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>${Math.round(grandCost).toLocaleString()}</td>
                <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}>{annualTotals.trips > 0 ? `$${(grandCost / annualTotals.trips).toFixed(2)}` : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
          Capacity providers cost = scheduled hours × hourly rate (what you actually pay for scheduled service, whether or not every hour is fully utilized). Remainder providers cost = trips served × per-trip rate.
        </div>
      </div>
    </div>
  );
}

/* ================= BUDGET ================= */
// Same underlying data as SplitTab (rollup/annualTotals), transposed into the shape an operating
// budget actually gets reviewed in: providers down the side, Jan-Dec + Total across the top. v1
// keeps one blended rate per provider (no Ambulatory/WAM/escort sub-split) — see ROADMAP.md.
function BudgetTab({ planYear, providers, rollup, annualTotals, providerColor }) {
  const capacityProviders = providers.filter((p) => p.role === "capacity");
  const remainderProviders = providers.filter((p) => p.role === "remainder");
  const monthCost = (i) => providers.reduce((a, p) => a + (rollup[i].byProvider[p.id]?.cost || 0), 0);
  const roleMonthCost = (i, role) => providers.filter((p) => p.role === role).reduce((a, p) => a + (rollup[i].byProvider[p.id]?.cost || 0), 0);
  const annualRoleCost = (role) => providers.filter((p) => p.role === role).reduce((a, p) => a + (annualTotals.byProvider[p.id]?.cost || 0), 0);
  const grandCost = Object.values(annualTotals.byProvider).reduce((a, v) => a + v.cost, 0);

  const chartData = MONTHS.map((label, i) => {
    const row = { month: label };
    for (const p of providers) row[p.id] = Math.round(rollup[i].byProvider[p.id]?.cost || 0);
    return row;
  });

  const money = (v) => `$${Math.round(v).toLocaleString()}`;
  const thStyle = { padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const tdStyle = { padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>{planYear} operating cost by provider, by month</div>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, border: "1px solid var(--border-light)" }} formatter={(v) => `$${v.toLocaleString()}`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {providers.map((p) => (
              <Bar key={p.id} dataKey={p.id} name={p.name} stackId="s" fill={providerColor(p.id)} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>{planYear} budget</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 980 }}>
            <thead>
              <tr style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: sampleGray }}>
                <th style={{ padding: "5px 8px", textAlign: "left" }}>&nbsp;</th>
                {MONTHS.map((m) => <th key={m} style={thStyle}>{m}</th>)}
                <th style={thStyle}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: "1px solid var(--border-light)", color: sampleGray }}>
                <td style={{ padding: "5px 8px" }}>Total trips</td>
                {rollup.map((r, i) => <td key={i} style={tdStyle}>{Math.round(r.trips).toLocaleString()}</td>)}
                <td style={tdStyle}>{Math.round(annualTotals.trips).toLocaleString()}</td>
              </tr>

              {providers.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                  <td style={{ padding: "5px 8px" }}>
                    <span style={{ display: "inline-block", width: 9, height: 9, background: providerColor(p.id), marginRight: 6, borderRadius: 2 }} />
                    {p.name}
                  </td>
                  {rollup.map((r, i) => <td key={i} style={tdStyle}>{money(r.byProvider[p.id]?.cost || 0)}</td>)}
                  <td style={tdStyle}>{money(annualTotals.byProvider[p.id]?.cost || 0)}</td>
                </tr>
              ))}

              {annualTotals.unaccommodated > 0.5 && (
                <tr style={{ borderTop: "1px solid var(--border-light)", color: gapRed }}>
                  <td style={{ padding: "5px 8px" }}>Unaccommodated (no provider cost)</td>
                  {rollup.map((r, i) => <td key={i} style={tdStyle}>{Math.round(r.unaccommodated).toLocaleString()}</td>)}
                  <td style={tdStyle}>{Math.round(annualTotals.unaccommodated).toLocaleString()}</td>
                </tr>
              )}

              {capacityProviders.length > 0 && (
                <tr style={{ borderTop: "1px solid var(--border-light)", color: sampleGray }}>
                  <td style={{ padding: "5px 8px" }}>Capacity providers</td>
                  {MONTHS.map((_, i) => <td key={i} style={tdStyle}>{money(roleMonthCost(i, "capacity"))}</td>)}
                  <td style={tdStyle}>{money(annualRoleCost("capacity"))}</td>
                </tr>
              )}
              {remainderProviders.length > 0 && (
                <tr style={{ color: sampleGray }}>
                  <td style={{ padding: "5px 8px" }}>Contractor cost</td>
                  {MONTHS.map((_, i) => <td key={i} style={tdStyle}>{money(roleMonthCost(i, "remainder"))}</td>)}
                  <td style={tdStyle}>{money(annualRoleCost("remainder"))}</td>
                </tr>
              )}

              <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
                <td style={{ padding: "5px 8px" }}>Total DATS Operational Cost</td>
                {MONTHS.map((_, i) => <td key={i} style={tdStyle}>{money(monthCost(i))}</td>)}
                <td style={tdStyle}>{money(grandCost)}</td>
              </tr>
              <tr>
                <td style={{ padding: "5px 8px" }}>Cost / trip</td>
                {rollup.map((r, i) => <td key={i} style={tdStyle}>{r.trips > 0 ? `$${(monthCost(i) / r.trips).toFixed(2)}` : "—"}</td>)}
                <td style={tdStyle}>{annualTotals.trips > 0 ? `$${(grandCost / annualTotals.trips).toFixed(2)}` : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
          Each provider's monthly cost follows its rate from the Providers tab — hourly × scheduled hours for capacity providers, per-trip × trips served for remainder providers — rolled up by month. One blended rate per provider; no passenger-type (ambulatory/WAM) sub-split in this pass.
        </div>
      </div>
    </div>
  );
}
