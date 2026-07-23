import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { ResponsiveContainer, ComposedChart, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { DAYS, NumField, Stat } from "./App.jsx";
import { PhaseStrip } from "./CallCentre.jsx";
import { ANNUALPLAN_SAMPLE } from "./annualPlanSampleData.js";

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
   Each target-year day is matched to the historical day sharing its day-of-week whose relative
   position in the year (day-of-year ÷ year-length) is closest — so "day N of the year" doesn't
   have to line up across years of different length, but the weekday shape (weekday vs Sat vs
   Sun) always carries forward. Growth % is applied on top of whatever value gets matched. */
function matchByDow(targetIso, history) {
  const keys = Object.keys(history);
  if (!keys.length) return null;
  const dow = dowOfIso(targetIso);
  const targetYear = +targetIso.slice(0, 4);
  const targetFrac = dayOfYearIndex(targetIso) / daysInYear(targetYear);
  let best = null, bestDist = Infinity;
  for (const iso of keys) {
    if (dowOfIso(iso) !== dow) continue;
    const y = +iso.slice(0, 4);
    const frac = dayOfYearIndex(iso) / daysInYear(y);
    const dist = Math.abs(frac - targetFrac);
    if (dist < bestDist) { bestDist = dist; best = iso; }
  }
  return best;
}

// holidaysHistory/holidaysPlan: [{date, name}], from date-holidays' getHolidays(year), public only.
function buildProjection(history, planYear, growthPct, holidaysHistory, holidaysPlan) {
  const mult = 1 + (growthPct || 0) / 100;
  const histByName = new Map(holidaysHistory.map((h) => [h.name, h.date]));
  const planHolidayByDate = new Map(holidaysPlan.map((h) => [h.date, h.name]));
  const len = daysInYear(planYear);
  const out = {};
  const matchedFrom = {}; // for the tooltip: which historical date fed this projection
  for (let doy = 0; doy < len; doy++) {
    const iso = isoForDoy(planYear, doy);
    let srcIso = null, srcVal = null;
    const holidayName = planHolidayByDate.get(iso);
    if (holidayName) {
      const histDate = histByName.get(holidayName);
      if (histDate != null && history[histDate] != null) { srcIso = histDate; srcVal = history[histDate]; }
    }
    if (srcVal == null) {
      const m = matchByDow(iso, history);
      if (m != null) { srcIso = m; srcVal = history[m]; }
    }
    out[iso] = srcVal != null ? Math.round(srcVal * mult) : 0;
    matchedFrom[iso] = srcIso;
  }
  return { projected: out, matchedFrom };
}

/* ---------- capacity split ----------
   Capacity providers (in-house, dedicated contractors) take trips in list order up to
   scheduled-hours × productivity for that day-of-week; whatever's left over falls to remainder
   providers (non-dedicated/taxi), split by their configured share, last one absorbing the rest.
   If NO remainder provider is configured, leftover demand shows as unaccommodated — a real signal,
   not silently dropped. */
function splitDay(trips, dow, providers) {
  let remaining = Math.max(0, trips);
  const rows = [];
  for (const p of providers) {
    if (p.role !== "capacity") continue;
    const hours = (p.hoursByDow && p.hoursByDow[dow]) || 0;
    const productivity = (dow === 0 || dow === 6) ? (p.productivityWeekend || 0) : (p.productivityWeekday || 0);
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

function monthlyRollup(planYear, projected, providers) {
  const months = MONTHS.map((label) => ({ label, trips: 0, unaccommodated: 0, byProvider: {} }));
  for (const iso of Object.keys(projected)) {
    const mi = monthOfIso(iso);
    const dow = dowOfIso(iso);
    const trips = projected[iso];
    months[mi].trips += trips;
    const { rows, unaccommodated } = splitDay(trips, dow, providers);
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
function historyMonthlyTotals(history) {
  const months = MONTHS.map(() => 0);
  for (const iso of Object.keys(history)) months[monthOfIso(iso)] += history[iso];
  return months;
}

const nextId = () => "p" + Math.random().toString(36).slice(2, 9);

export default function AnnualPlan({ onHome }) {
  const [theme, setTheme] = useState(() => {
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
  const fileRef = useRef(null);
  const upRef = useRef(null);

  /* ---------- statutory holidays (lazy-loaded, same pattern as the operator module) ---------- */
  const [hdCtor, setHdCtor] = useState(null);
  const [hdCountries, setHdCountries] = useState({});
  const [hdRegions, setHdRegions] = useState({});
  const [hdLoading, setHdLoading] = useState(false);
  const hdImportStarted = useRef(false);
  useEffect(() => {
    if (tab !== "history" && tab !== "projection" || hdImportStarted.current) return;
    hdImportStarted.current = true;
    setHdLoading(true);
    import("date-holidays")
      .then((m) => { setHdCtor(() => m.default); setHdCountries(new m.default().getCountries()); setHdLoading(false); })
      .catch(() => setHdLoading(false));
  }, [tab]);
  useEffect(() => {
    if (!hdCtor) return;
    setHdRegions(new hdCtor(jurisdiction.country).getStates(jurisdiction.country) || {});
  }, [hdCtor, jurisdiction.country]);
  const holidaysFor = (year) => {
    if (!hdCtor) return [];
    const hd = new hdCtor(jurisdiction.country, jurisdiction.region || undefined);
    return hd.getHolidays(year).filter((h) => h.type === "public").map((h) => ({ date: h.date.slice(0, 10), name: h.name }));
  };
  const holidaysHistory = useMemo(() => holidaysFor(historyYear), [hdCtor, jurisdiction.country, jurisdiction.region, historyYear]);
  const holidaysPlan = useMemo(() => holidaysFor(planYear), [hdCtor, jurisdiction.country, jurisdiction.region, planYear]);

  /* ---------- derived: projection + split (pure functions of the state above) ---------- */
  const { projected } = useMemo(
    () => buildProjection(history, planYear, growthPct, holidaysHistory, holidaysPlan),
    [history, planYear, growthPct, holidaysHistory, holidaysPlan]
  );
  const rollup = useMemo(() => monthlyRollup(planYear, projected, providers), [planYear, projected, providers]);
  const historyMonthly = useMemo(() => historyMonthlyTotals(history), [history]);
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
  const historyAnnual = useMemo(() => Object.values(history).reduce((a, b) => a + b, 0), [history]);

  /* ---------- providers editing ---------- */
  const updateProvider = (id, patch) => setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const updateProviderHour = (id, dow, v) => setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, hoursByDow: p.hoursByDow.map((h, i) => (i === dow ? v : h)) } : p)));
  const addProvider = (role) => setProviders((ps) => [...ps, role === "capacity"
    ? { id: nextId(), name: "New capacity provider", role: "capacity", hoursByDow: [0, 0, 0, 0, 0, 0, 0], productivityWeekday: 2, productivityWeekend: 2, hourlyRate: 50 }
    : { id: nextId(), name: "New remainder provider", role: "remainder", share: 100, perTripRate: 24 }]);
  const removeProvider = (id) => setProviders((ps) => ps.filter((p) => p.id !== id));

  /* ---------- history upload/template/sample ---------- */
  const downloadTemplate = () => {
    const rows = [["Date", "Trips"]];
    for (let doy = 0; doy < daysInYear(historyYear); doy++) rows.push([isoForDoy(historyYear, doy), ""]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Daily Trips");
    XLSX.writeFile(wb, `annual-plan-history-${historyYear}-template.xlsx`);
  };
  const uploadHistory = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1);
        const out = {}; let parsed = 0, skipped = 0, years = new Set();
        for (const row of rows) {
          if (!row || row[0] == null || row[0] === "") continue;
          let iso = null;
          if (typeof row[0] === "number") iso = serialToISO(row[0]);
          else { const d = new Date(row[0]); if (!isNaN(d)) iso = d.toISOString().slice(0, 10); }
          const trips = Number(row[1]);
          if (!iso || !Number.isFinite(trips)) { skipped++; continue; }
          out[iso] = trips; parsed++; years.add(+iso.slice(0, 4));
        }
        if (!parsed) { alert("Could not find any valid Date/Trips rows in that file."); return; }
        setHistory(out);
        setHistoryYear(years.size === 1 ? [...years][0] : Math.max(...years));
        setHistorySource("uploaded");
        setUploadInfo(`Loaded ${parsed} day(s)${skipped ? `, skipped ${skipped} unreadable row(s)` : ""}.`);
      } catch (e) {
        alert("Could not read that file — check it matches the Date / Trips template.");
      }
    };
    if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };
  const useSample = () => {
    setHistory(clone(ANNUALPLAN_SAMPLE.history));
    setHistoryYear(ANNUALPLAN_SAMPLE.historyYear);
    setHistorySource("sample");
    setUploadInfo(null);
  };

  /* ---------- save / load project ---------- */
  const saveProject = () => {
    const payload = { kind: "annualplan", providers, history, historyYear, planYear, growthPct, jurisdiction, historySource };
    const blob = new Blob([JSON.stringify(payload, null, 0)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annual-service-plan-${planYear}.json`;
    a.click();
  };
  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (p.providers) setProviders(p.providers);
        if (p.history) setHistory(p.history);
        if (p.historyYear) setHistoryYear(p.historyYear);
        if (p.planYear) setPlanYear(p.planYear);
        if (p.growthPct != null) setGrowthPct(p.growthPct);
        if (p.jurisdiction) setJurisdiction(p.jurisdiction);
        setHistorySource(p.historySource || "uploaded");
      } catch (e) {
        alert("Could not read that project file.");
      }
    };
    rd.readAsText(file);
  };

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
            <button style={nudgeBtn} onClick={saveProject}>Save project</button>
            <button style={nudgeBtn} onClick={() => fileRef.current && fileRef.current.click()}>Load project</button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ""; }} />
            <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle light/dark mode"
              style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", padding: "5px 8px", background: "none", border: "1px solid var(--border-input)", borderRadius: 2, color: sampleGray, cursor: "pointer" }}>
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </button>
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
        ]} />

        {tab === "providers" && (
          <ProvidersTab {...{ providers, updateProvider, updateProviderHour, addProvider, removeProvider }} />
        )}
        {tab === "history" && (
          <HistoryTab {...{
            historyYear, setHistoryYear, planYear, setPlanYear, growthPct, setGrowthPct,
            jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, hdLoading,
            history, historyMonthly, historyAnnual, historySource, uploadInfo,
            downloadTemplate, uploadHistory, useSample, upRef,
          }} />
        )}
        {tab === "projection" && (
          <ProjectionTab {...{ planYear, growthPct, historyMonthly, rollup, annualTotals, historyAnnual, holidaysPlan }} />
        )}
        {tab === "split" && (
          <SplitTab {...{ planYear, providers, rollup, annualTotals, providerColor }} />
        )}
      </div>
    </div>
  );
}

/* ================= PROVIDERS ================= */
function ProvidersTab({ providers, updateProvider, updateProviderHour, addProvider, removeProvider }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Providers</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          <b>Capacity providers</b> (in-house / dedicated contractors) take trips up to scheduled hours × productivity for that day of week, in the order listed. <b>Remainder providers</b> (non-dedicated / taxi) absorb whatever's left, priced per trip. Add as many of each as you need.
        </div>
        {providers.map((p) => (
          <div key={p.id} style={{ border: "1px solid var(--border-light)", borderRadius: 2, padding: "10px 12px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <input value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 600, padding: "4px 8px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, minWidth: 220 }} />
              <span style={{ fontSize: 11, padding: "2px 8px", background: p.role === "capacity" ? "var(--tint-teal-b)" : "var(--tint-neutral-b)", border: "1px solid var(--border-light)", color: sampleGray, borderRadius: 2 }}>
                {p.role === "capacity" ? "capacity (hours × productivity)" : "remainder (per trip)"}
              </span>
              <button style={{ ...nudgeBtn, marginLeft: "auto", color: gapRed, borderColor: gapRed, padding: "3px 8px", fontSize: 12 }} onClick={() => removeProvider(p.id)}>remove</button>
            </div>
            {p.role === "capacity" ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, marginBottom: 8 }}>
                  {DOW_SHORT.map((d, i) => (
                    <label key={d} style={{ fontSize: 11, color: sampleGray, display: "flex", flexDirection: "column", gap: 3 }}>
                      {d} hrs/day
                      <NumField value={p.hoursByDow[i]} onCommit={(v) => updateProviderHour(p.id, i, Math.max(0, v))} />
                    </label>
                  ))}
                </div>
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
function HistoryTab({
  historyYear, setHistoryYear, planYear, setPlanYear, growthPct, setGrowthPct,
  jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, hdLoading,
  history, historyMonthly, historyAnnual, historySource, uploadInfo,
  downloadTemplate, uploadHistory, useSample, upRef,
}) {
  const chartData = MONTHS.map((label, i) => ({ month: label, trips: historyMonthly[i] }));
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Plan setup</div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>History year <NumField value={historyYear} onCommit={(v) => setHistoryYear(Math.round(v))} /></label>
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
          Growth is a single annual rate applied uniformly for now. Statutory holidays are matched by name between the two years where possible (e.g. this year's Labour Day feeds next year's Labour Day) — regular days match by closest same-weekday position instead.
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
            <button style={nudgeBtn} onClick={downloadTemplate}>Download template</button>
            <button style={nudgeBtn} onClick={() => upRef.current && upRef.current.click()}>Upload history</button>
            <input ref={upRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadHistory(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>
        {uploadInfo && <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", padding: "7px 11px", marginBottom: 8, fontSize: 12 }}>{uploadInfo}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label="Annual trips" value={historyAnnual.toLocaleString()} tone={supplyTeal} />
          <Stat label="Days loaded" value={Object.keys(history).length.toLocaleString()} />
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
          Template is one row per calendar date in {historyYear} — download it, fill in the Trips column from your own records, and upload it back.
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
          Each {planYear} day is matched to whichever historical day shares its day of week and sits closest to the same relative point in the year, then grown by {growthPct}%. Statutory holidays are matched by name first (this year's Thanksgiving feeds next year's Thanksgiving) before falling back to the same day-of-week rule.
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
