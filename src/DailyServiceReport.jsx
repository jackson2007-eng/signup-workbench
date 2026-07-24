import React, { useState, useMemo, useEffect } from "react";
import * as XLSX from "xlsx";
import { NumField, Stat } from "./App.jsx";
import { PhaseStrip } from "./CallCentre.jsx";
import {
  buildProjection, splitDay, avgTripsByDow, hoursByDowFromMarketShare,
  yearsPresent, dowOfIso, monthOfIso, MONTHS, DOW_SHORT, daysInYear, isoForDoy,
} from "./AnnualPlan.jsx";
import { DAILYSERVICE_SAMPLE } from "./dailyServiceSampleData.js";
import { useAccountProject, useSignupList, SaveStatus, AccountChip, SignupSwitcher } from "./useAccountProject.jsx";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

/* Daily Service Report — v1: a day-by-day, per-provider BUDGET calendar, imported from a saved
   Annual Plan signup. Reviewed against a real 2026 DATS Daily Service Report export, which is a
   before (budgeted) / after (actual) tracker per service day; v1 here is deliberately the
   budgeted half only — actuals entry is the natural v2 once this baseline exists, same
   "total-trips-first" sequencing this project has used throughout. Import is a snapshot, not a
   live link: Annual Plan is itself a working document that changes over the year, so this module
   holds a deliberate, re-importable copy rather than always-current coupling. */

const text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", gapRed = "var(--gap-red)", sampleGray = "var(--sample-gray)";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const primaryBtn = { ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal };
const cardStyle = { background: card, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 14 };
const hTitle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 10 };
const thStyle = { textAlign: "left", padding: "5px 8px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 11.5, color: sampleGray, whiteSpace: "nowrap" };
const tdStyle = { padding: "3px 8px", whiteSpace: "nowrap" };

const clone = (o) => JSON.parse(JSON.stringify(o));

function effectiveProviders(providers, avgDemandByDow) {
  return providers.map((p) => (
    p.role === "capacity" && p.hoursMode === "share"
      ? { ...p, hoursByDow: hoursByDowFromMarketShare(avgDemandByDow, p.marketSharePct, p.productivityWeekday, p.productivityWeekend) }
      : p
  ));
}

// What needs to be scheduled the night before, to land on `delivered` trips after day-of
// attrition (no-shows/cancellations). Reviewed against the real 2026 DATS Monthly Trip/Cost
// Budget, which tracks this exact relationship as parallel "Start of Day" (night-before
// scheduled) vs "End of Day" (actual delivered) blocks — checked across COE and both Prestige
// vehicle types, on weekdays/weekends/a holiday, and every one came out to the same flat ~9%
// increase, applied to each provider's own delivered figure directly (not by re-running the
// capacity split on a bigger demand number). Computed live, not stored, so tuning the % doesn't
// require re-importing the budget — same reasoning as effectiveProviders above.
function scheduledTrips(delivered, attritionPct) {
  return delivered * (1 + (attritionPct || 0) / 100);
}

// A day (or a provider within a day) can carry an explicit uploaded `scheduledActual` figure —
// real observed night-before scheduling counts, which needn't match the flat attrition-rate
// estimate. When present it wins; otherwise the live computation above is the fallback, exactly
// as before uploads existed.
const dayScheduled = (row, attritionPct) => row.scheduledActual ?? scheduledTrips(row.trips, attritionPct);
const providerScheduled = (p, attritionPct) => p.scheduledActual ?? scheduledTrips(p.trips, attritionPct);

// Recomputes a full day-by-day-by-provider budget from a saved Annual Plan payload — the exact
// same computation Annual Plan's own Split/Budget tabs run (buildProjection -> splitDay per day),
// just materialized per day instead of rolled into months. holidaysHistoryByYear/holidaysPlan
// must already be resolved real lookups — the caller (importBudget below) awaits the
// date-holidays import inline before calling this, so there's no lazy-load staleness window.
function computeDays(planPayload, holidaysHistoryByYear, holidaysPlan) {
  const { history, planYear, growthPct, providers, dayOverrides } = planPayload;
  const { projected } = buildProjection(history, planYear, growthPct, holidaysHistoryByYear, holidaysPlan, dayOverrides || {});
  const avgDemandByDow = avgTripsByDow(projected);
  const effProviders = effectiveProviders(providers, avgDemandByDow);
  const holidaySet = new Set((holidaysPlan || []).map((h) => h.date));
  const holidayNameByDate = new Map((holidaysPlan || []).map((h) => [h.date, h.name]));
  const days = {};
  for (const iso of Object.keys(projected)) {
    const dow = dowOfIso(iso);
    const trips = projected[iso];
    const { rows, unaccommodated } = splitDay(trips, dow, effProviders, holidaySet.has(iso));
    const byProvider = {};
    for (const r of rows) byProvider[r.id] = { name: r.name, role: r.role, trips: r.trips, hours: r.hours, cost: r.cost };
    days[iso] = { dow, holidayName: holidayNameByDate.get(iso) || null, trips, unaccommodated, byProvider };
  }
  return days;
}

// Anchored on the real calendar year (not any loaded data), so the template's offered years keep
// advancing on their own every year with no manual upkeep — same reasoning as AnnualPlan's own
// history template.
const CURRENT_YEAR = new Date().getFullYear();
const EXCEL_EPOCH = 25569;
const serialToISO = (serial) => new Date(Math.round((Math.floor(serial) - EXCEL_EPOCH) * 86400000)).toISOString().slice(0, 10);

// Column layout for the actuals template/upload — mirrors the Daily Calendar table's own columns
// exactly (Holiday excluded: it's derived from date-holidays, not user data), so a downloaded
// template always round-trips through uploadActuals with no translation step.
function actualsColumns(providerIds, providerMeta) {
  const cols = [
    { header: "Total scheduled", field: "scheduledActual" },
    { header: "Total trips", field: "trips" },
    { header: "Unaccommodated", field: "unaccommodated" },
  ];
  for (const id of providerIds) {
    const name = providerMeta[id]?.name || id;
    cols.push({ header: `${name} scheduled`, providerId: id, field: "scheduledActual" });
    cols.push({ header: `${name} trips`, providerId: id, field: "trips" });
    cols.push({ header: `${name} hours`, providerId: id, field: "hours" });
    cols.push({ header: `${name} cost`, providerId: id, field: "cost" });
  }
  return cols;
}

// Blank fill-in workbook, one sheet per year — union of every year already loaded plus the
// current calendar year back MAX_TEMPLATE_YEARS, so the template is useful for backfilling
// history even before any of those years exist in `days` yet.
const MAX_TEMPLATE_YEARS = 5;
function downloadActualsTemplate(providerIds, providerMeta, days) {
  const cols = actualsColumns(providerIds, providerMeta);
  const offered = new Set(yearsPresent(days));
  for (let i = 0; i < MAX_TEMPLATE_YEARS; i++) offered.add(CURRENT_YEAR - i);
  const sortedYears = [...offered].sort((a, b) => b - a);
  const wb = XLSX.utils.book_new();
  for (const year of sortedYears) {
    const rows = [["Date", "Day", ...cols.map((c) => c.header)]];
    for (let doy = 0; doy < daysInYear(year); doy++) {
      const iso = isoForDoy(year, doy);
      rows.push([iso, DOW_SHORT[dowOfIso(iso)], ...cols.map(() => "")]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, String(year));
  }
  XLSX.writeFile(wb, `daily-service-actuals-${sortedYears[sortedYears.length - 1]}-${sortedYears[0]}-template.xlsx`);
}

// Parses every sheet in the uploaded workbook, matching columns by exact header text against the
// same labels downloadActualsTemplate writes (robust to reordered/extra columns since it looks
// each header up rather than assuming position). Blank cells are simply omitted from the day's
// update — they never clobber an existing value, so "fill in what you have" is safe. A day not
// already in `days` (a historical year never imported from Annual Plan) is created fresh from
// the upload alone; provider name/role for a brand-new day's entries come from `providerMeta`
// (today's configured providers — the only ones a template could have offered columns for).
function uploadActuals(file, providerIds, providerMeta, days, onDone) {
  const cols = actualsColumns(providerIds, providerMeta);
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
      const updates = {};
      let parsedDays = 0, skippedRows = 0, skippedValues = 0;
      const years = new Set();
      for (const sheetName of wb.SheetNames) {
        const allRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
        const headerRow = allRows[0] || [];
        const colIdxByHeader = new Map(headerRow.map((h, i) => [String(h).trim(), i]));
        for (const row of allRows.slice(1)) {
          if (!row || row[0] == null || row[0] === "") continue;
          let iso = null;
          if (typeof row[0] === "number") iso = serialToISO(row[0]);
          else { const d = new Date(row[0]); if (!isNaN(d)) iso = d.toISOString().slice(0, 10); }
          if (!iso) { skippedRows++; continue; }
          const upd = updates[iso] || (updates[iso] = { byProvider: {} });
          let any = false;
          for (const c of cols) {
            const idx = colIdxByHeader.get(c.header);
            if (idx == null) continue;
            const raw = row[idx];
            if (raw == null || raw === "") continue;
            const num = Number(raw);
            if (!Number.isFinite(num)) { skippedValues++; continue; }
            any = true;
            if (c.providerId) (upd.byProvider[c.providerId] || (upd.byProvider[c.providerId] = {}))[c.field] = num;
            else upd[c.field] = num;
          }
          if (any) { parsedDays++; years.add(+iso.slice(0, 4)); }
          else delete updates[iso];
        }
      }
      if (!parsedDays) { onDone({ error: "Could not find any recognizable Date + value rows in that file — check it matches the downloaded template's columns." }); return; }
      const merged = { ...days };
      for (const [iso, upd] of Object.entries(updates)) {
        const base = merged[iso] || { dow: dowOfIso(iso), holidayName: null, trips: 0, unaccommodated: 0, byProvider: {} };
        const nextDay = { ...base };
        if (upd.trips != null) nextDay.trips = upd.trips;
        if (upd.unaccommodated != null) nextDay.unaccommodated = upd.unaccommodated;
        if (upd.scheduledActual != null) nextDay.scheduledActual = upd.scheduledActual;
        const nextByProvider = { ...base.byProvider };
        for (const [pid, pu] of Object.entries(upd.byProvider)) {
          const baseP = nextByProvider[pid] || { name: providerMeta[pid]?.name || pid, role: providerMeta[pid]?.role || "capacity", trips: 0, hours: null, cost: 0 };
          nextByProvider[pid] = { ...baseP, ...pu };
        }
        nextDay.byProvider = nextByProvider;
        merged[iso] = nextDay;
      }
      const skippedNote = (skippedRows || skippedValues) ? `, skipped ${skippedRows} unreadable row(s) and ${skippedValues} unreadable value(s)` : "";
      onDone({ info: `Loaded actual data for ${parsedDays} day(s) across ${years.size} year(s)${skippedNote}.`, days: merged });
    } catch (e) {
      onDone({ error: "Could not read that file — check it matches the downloaded template's columns." });
    }
  };
  if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
}

export default function DailyServiceReport({ onHome, user, logout }) {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { localStorage.setItem("theme", theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  const [tab, setTab] = useState("setup");
  const [source, setSource] = useState(() => clone(DAILYSERVICE_SAMPLE.source));
  const [days, setDays] = useState(() => clone(DAILYSERVICE_SAMPLE.days));
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  // Default 9% matches the real DATS budget's own "Percentage Increase on scheduling night
  // before" figure — a starting point, not a hardcoded assumption; editable per agency.
  const [attritionPct, setAttritionPct] = useState(9);

  const { items: annualPlanSignups } = useSignupList("annualplan");
  const [selectedPlanId, setSelectedPlanId] = useState("");

  const importBudget = async () => {
    if (!selectedPlanId) return;
    if (source && source.planId && !source.sample) {
      const ok = window.confirm(`This will replace the currently imported budget (from "${source.planName}") with a fresh import. Continue?`);
      if (!ok) return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch(`/api/projects/annualplan/${selectedPlanId}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data.payload) throw new Error("Could not load that Annual Plan signup.");
      const p = data.payload;
      // Awaited inline in this one-shot click handler, not a background lazy-load gated by tab
      // visibility — that gating was exactly the bug behind the market-share feature's holiday
      // discrepancy (numbers computed before the import resolved). A user-triggered import can
      // just wait for it.
      const HD = (await import("date-holidays")).default;
      const jurisdiction = p.jurisdiction || { country: "CA", region: "" };
      const holidaysFor = (year) => {
        const hd = new HD(jurisdiction.country, jurisdiction.region || undefined);
        return hd.getHolidays(year).filter((h) => h.type === "public").map((h) => ({ date: h.date.slice(0, 10), name: h.name }));
      };
      const historyYears = yearsPresent(p.history || {});
      const holidaysHistoryByYear = {};
      for (const y of historyYears) holidaysHistoryByYear[y] = holidaysFor(y);
      const holidaysPlan = holidaysFor(p.planYear);
      const newDays = computeDays(p, holidaysHistoryByYear, holidaysPlan);
      const plan = (annualPlanSignups || []).find((s) => s.id === Number(selectedPlanId));
      setDays(newDays);
      setSource({
        planId: Number(selectedPlanId), planName: plan ? plan.name : `Plan #${selectedPlanId}`,
        planYear: p.planYear, importedAt: new Date().toISOString(), sample: false,
      });
    } catch (e) {
      setImportError(e.message || "Could not import that plan.");
    } finally {
      setImporting(false);
    }
  };

  const annualTrips = useMemo(() => Object.values(days).reduce((s, d) => s + d.trips, 0), [days]);
  // Provider column order follows splitDay's own list order (capacity providers first, in list
  // order, then remainder providers) — reliable here because a single imported snapshot uses the
  // same provider list on every day, and object key insertion order is preserved for the
  // non-numeric ids this app uses.
  const providerIds = useMemo(() => {
    const firstIso = Object.keys(days)[0];
    return firstIso ? Object.keys(days[firstIso].byProvider || {}) : [];
  }, [days]);
  const providerMeta = useMemo(() => {
    const meta = {};
    for (const d of Object.values(days)) for (const [id, p] of Object.entries(d.byProvider || {})) meta[id] = { name: p.name, role: p.role };
    return meta;
  }, [days]);
  const yearsLoaded = useMemo(() => yearsPresent(days), [days]);

  const [actualsUploadInfo, setActualsUploadInfo] = useState(null);
  const [actualsUploadError, setActualsUploadError] = useState(null);
  const handleDownloadActualsTemplate = () => downloadActualsTemplate(providerIds, providerMeta, days);
  const handleUploadActuals = (file) => {
    setActualsUploadError(null);
    uploadActuals(file, providerIds, providerMeta, days, (result) => {
      if (result.error) { setActualsUploadError(result.error); return; }
      setDays(result.days);
      setActualsUploadInfo(result.info);
    });
  };

  const buildPayload = () => ({ kind: "dailyservice", source, days, attritionPct });
  const applyPayload = (p) => {
        if (p.source !== undefined) setSource(p.source);
        if (p.days) setDays(p.days);
        if (p.attritionPct != null) setAttritionPct(p.attritionPct);
  };
  const payloadJson = useMemo(() => JSON.stringify(buildPayload()), [source, days, attritionPct]);
  const { items: signups, create: createSignup, rename: renameSignup, remove: removeSignup } = useSignupList("dailyservice");
  const [projectId, setProjectId] = useState(null);
  useEffect(() => {
    if (!signups || projectId) return;
    if (signups.length) setProjectId(signups[0].id);
    else createSignup({ name: "My Daily Service Report" }).then(setProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signups]);
  const saveStatus = useAccountProject("dailyservice", projectId, payloadJson, applyPayload);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --supply-teal: #0F7B7A; --gap-red: #C0392B; --bookout-violet: #6C5B9E;
          --sample-gray: #5B6B75; --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #CBD5DA;
          --tint-neutral-b: #EEF4F5; --tint-teal-b: #EEF6F6; --tint-red: #FBEDEB; --tint-amber-b: #FBF3E9;
          --tint-weekend-b: #F0ECFA;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --supply-teal: #2FB3AC; --gap-red: #E27A70; --bookout-violet: #A594D1;
          --sample-gray: #8B9AA5; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D;
          --tint-neutral-b: #1C262B; --tint-teal-b: #172227; --tint-red: #2E1714; --tint-amber-b: #2A2115;
          --tint-weekend-b: #221C30;
        }
        body { background: var(--paper); }
        .dsrnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:var(--sample-gray); }
        .dsrnav.on { color:${text}; border-bottom-color:${supplyTeal}; }
        select { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onHome} style={{ ...nudgeBtn, fontSize: 12 }}>‹ Transit Operations Toolkit</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>DAILY SERVICE REPORT</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>{source.planYear} budgeted trips <b style={{ color: text, fontSize: 15 }}>{annualTrips.toLocaleString()}</b></div>
            <SignupSwitcher label="Report" projectId={projectId} items={signups} onSwitch={setProjectId}
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

        <PhaseStrip tab={tab} setTab={setTab} navClass="dsrnav" groups={[
          { phase: "PHASE 1 · SETUP", tabs: [{ key: "setup", label: "SETUP" }] },
          { phase: "PHASE 2 · REVIEW", tabs: [{ key: "calendar", label: "DAILY CALENDAR" }] },
        ]} />

        {tab === "setup" && (
          <SetupTab {...{
            source, annualPlanSignups, selectedPlanId, setSelectedPlanId, importBudget,
            importing, importError, providerIds, providerMeta, attritionPct, setAttritionPct,
            yearsLoaded, actualsUploadInfo, actualsUploadError,
            downloadActualsTemplate: handleDownloadActualsTemplate, uploadActuals: handleUploadActuals,
          }} />
        )}
        {tab === "calendar" && (
          <CalendarTab {...{ days, providerIds, providerMeta, attritionPct }} />
        )}
      </div>
    </div>
  );
}

/* ================= SETUP ================= */
function SetupTab({ source, annualPlanSignups, selectedPlanId, setSelectedPlanId, importBudget, importing, importError, providerIds, providerMeta, attritionPct, setAttritionPct, yearsLoaded, downloadActualsTemplate, uploadActuals, actualsUploadInfo, actualsUploadError }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Night-before attrition rate</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          Mirrors a common paratransit scheduling practice: schedule more trips the night before
          than are actually expected to happen, to offset day-of attrition (cancellations,
          no-shows). The Daily Calendar's "Scheduled" figures are each day's delivered trips
          scaled up by this rate, computed live — change it any time without re-importing the
          budget. A day with its own uploaded scheduled count (see "Import actual day-by-day
          data" below) shows that real figure instead of this estimate.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          Night-before attrition rate (%)
          <NumField value={attritionPct} step={0.5} onCommit={(v) => setAttritionPct(Math.max(0, v))} />
        </label>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Import from Annual Plan</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          Pick one of your saved Annual Plan signups and import its budget — a snapshot, not a
          live link, so it only updates when you import again. Re-importing replaces the whole
          calendar with a fresh copy of that plan's current numbers.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 2, fontSize: 13 }}>
            <option value="">Choose an Annual Plan signup…</option>
            {annualPlanSignups === null && <option disabled>Loading your signups…</option>}
            {annualPlanSignups && annualPlanSignups.length === 0 && <option disabled>No saved Annual Plan signups yet</option>}
            {annualPlanSignups && annualPlanSignups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button style={primaryBtn} disabled={!selectedPlanId || importing} onClick={importBudget}>
            {importing ? "Importing…" : "Import budget"}
          </button>
        </div>
        {importError && (
          <div style={{ fontSize: 12, color: gapRed, background: "var(--tint-red, #F6E4E1)", border: "1px solid var(--border-light)", padding: "6px 10px", marginTop: 10 }}>
            {importError}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Import actual day-by-day data</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          Download a fill-in template with the exact columns the Daily Calendar shows — Total
          scheduled, Total trips, Unaccommodated, and each provider's Scheduled/Trips/Hours/Cost —
          one sheet per year. Fill in whatever real numbers you have (leave the rest blank) and
          upload it back: matching dates merge into the calendar, filling in or overwriting just
          the values you provided; a date from a year never imported from Annual Plan is created
          fresh. There's no year limit — this builds up a permanent day-by-day archive over time.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={nudgeBtn} disabled={!providerIds.length} onClick={downloadActualsTemplate}>
            Download template
          </button>
          <label style={{ ...primaryBtn, display: "inline-block" }}>
            Upload actuals
            <input type="file" accept=".xlsx,.csv" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files[0]; if (f) uploadActuals(f); e.target.value = ""; }} />
          </label>
        </div>
        {!providerIds.length && (
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
            Import a budget from Annual Plan above first — the template's provider columns come
            from your configured providers.
          </div>
        )}
        {actualsUploadInfo && (
          <div style={{ fontSize: 12, color: supplyTeal, background: "var(--tint-teal-b)", border: "1px solid var(--border-light)", padding: "6px 10px", marginTop: 10 }}>
            {actualsUploadInfo}
          </div>
        )}
        {actualsUploadError && (
          <div style={{ fontSize: 12, color: gapRed, background: "var(--tint-red, #F6E4E1)", border: "1px solid var(--border-light)", padding: "6px 10px", marginTop: 10 }}>
            {actualsUploadError}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Currently imported</div>
        {source.sample && (
          <div style={{ fontSize: 12, color: sampleGray, background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", padding: "6px 10px", marginBottom: 12 }}>
            Showing sample data — import a real Annual Plan signup above to replace it.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <Stat label="Source plan" value={source.planName || "—"} />
          <Stat label="Plan year" value={source.planYear || "—"} />
          <Stat label="Imported" value={source.sample ? "Sample data" : (source.importedAt ? new Date(source.importedAt).toLocaleString() : "—")} />
          <Stat label="Years loaded" value={yearsLoaded.length ? yearsLoaded.join(", ") : "—"}
            sub={yearsLoaded.length > 1 ? "includes uploaded actual data" : undefined} />
        </div>
        {providerIds.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {providerIds.map((id) => (
              <span key={id} style={{ fontSize: 11.5, padding: "3px 9px", background: "var(--tint-teal-b)", border: "1px solid var(--border-light)", color: supplyTeal, fontWeight: 600 }}>
                {providerMeta[id]?.name || id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= DAILY CALENDAR ================= */
const chipBtn = (on) => ({
  fontSize: 11.5, padding: "3px 9px", cursor: "pointer", border: "1px solid var(--border-light)",
  background: on ? "var(--tint-teal-b)" : "transparent", color: on ? supplyTeal : sampleGray,
  fontWeight: 600, borderRadius: 2,
});

function CalendarTab({ days, providerIds, providerMeta, attritionPct }) {
  const availableYears = useMemo(() => yearsPresent(days), [days]);
  const [selectedYear, setSelectedYear] = useState(() => availableYears[availableYears.length - 1] || new Date().getFullYear());
  useEffect(() => {
    if (availableYears.length && !availableYears.includes(selectedYear)) setSelectedYear(availableYears[availableYears.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableYears]);
  const [selectedMonths, setSelectedMonths] = useState(() => new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
  const toggleMonth = (mi) => setSelectedMonths((s) => { const n = new Set(s); n.has(mi) ? n.delete(mi) : n.add(mi); return n; });

  // Two logical column groups mirroring the real sheet's parallel Start-of-Day/End-of-Day
  // blocks — "scheduled" (night-before) vs "trips" (day-of delivered). One shared visibility
  // map backs both the quick group-toggles and the fine-grained per-column checkboxes below, so
  // there's a single source of truth rather than two competing filter systems.
  const schedKeys = useMemo(() => ["schedTotal", ...providerIds.map((id) => `sched:${id}`)], [providerIds]);
  const tripsKeys = useMemo(() => ["tripsTotal", "unaccom", ...providerIds.flatMap((id) => [`trips:${id}`, `hrs:${id}`, `cost:${id}`])], [providerIds]);
  const [visibleCols, setVisibleCols] = useState(() => {
    const v = { holiday: true };
    for (const k of schedKeys) v[k] = true;
    for (const k of tripsKeys) v[k] = true;
    return v;
  });
  useEffect(() => {
    // New providers (e.g. a fresh import) default to visible; never clobbers a choice already made.
    setVisibleCols((v) => {
      const next = { ...v };
      let changed = false;
      for (const k of [...schedKeys, ...tripsKeys]) if (!(k in next)) { next[k] = true; changed = true; }
      return changed ? next : v;
    });
  }, [schedKeys, tripsKeys]);
  const setCol = (k, val) => setVisibleCols((v) => ({ ...v, [k]: val }));
  const setGroup = (keys, val) => setVisibleCols((v) => { const n = { ...v }; for (const k of keys) n[k] = val; return n; });
  const schedAnyOn = schedKeys.some((k) => visibleCols[k]);
  const tripsAnyOn = tripsKeys.some((k) => visibleCols[k]);
  const schedAllOn = schedKeys.every((k) => visibleCols[k]);
  const tripsAllOn = tripsKeys.every((k) => visibleCols[k]);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const dayRows = useMemo(() => (
    Object.keys(days)
      .filter((iso) => iso.slice(0, 4) === String(selectedYear))
      .sort()
      .map((iso) => ({ iso, month: monthOfIso(iso), ...days[iso] }))
      .filter((r) => selectedMonths.has(r.month))
  ), [days, selectedYear, selectedMonths]);

  const metricColCount = [...schedKeys, ...tripsKeys].filter((k) => visibleCols[k]).length;
  const colCount = 2 + (visibleCols.holiday ? 1 : 0) + metricColCount;

  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>{selectedYear} day-by-day budget</div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginBottom: 10, lineHeight: 1.5 }}>
          Every day of the imported plan, split across providers exactly as Annual Plan's own
          Split/Budget tabs compute it — capacity providers take trips up to scheduled hours ×
          productivity in list order, remainder providers absorb what's left. Unaccommodated
          demand is flagged, never hidden. "Scheduled" columns are each delivered figure scaled
          up by the {attritionPct}% night-before attrition rate set on the Setup tab, unless a
          day has its own uploaded scheduled count, which is shown instead. Weekend rows are
          shaded violet to set them apart from weekdays.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
            <span style={{ color: sampleGray }}>Year</span>
            <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))} style={{ padding: "3px 5px", borderRadius: 2, fontSize: 12 }}>
              {availableYears.length ? availableYears.map((y) => <option key={y} value={y}>{y}</option>) : <option value={selectedYear}>{selectedYear}</option>}
            </select>
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, color: sampleGray, marginRight: 2 }}>Months</span>
            {MONTHS.map((label, mi) => (
              <span key={label} onClick={() => toggleMonth(mi)} style={chipBtn(selectedMonths.has(mi))}>{label}</span>
            ))}
            <span onClick={() => setSelectedMonths(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))} style={{ fontSize: 11, color: supplyTeal, cursor: "pointer", marginLeft: 4, textDecoration: "underline" }}>All</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer" }}>
              <input type="checkbox" checked={schedAllOn} onChange={(e) => { if (!e.target.checked && !tripsAnyOn) return; setGroup(schedKeys, e.target.checked); }} />
              Scheduled (night-before)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer" }}>
              <input type="checkbox" checked={tripsAllOn} onChange={(e) => { if (!e.target.checked && !schedAnyOn) return; setGroup(tripsKeys, e.target.checked); }} />
              Trips (day-of)
            </label>
          </div>

          <button onClick={() => setCustomizeOpen((o) => !o)} style={{ ...nudgeBtn, fontSize: 11, padding: "3px 8px", marginLeft: "auto" }}>
            {customizeOpen ? "Hide column list ▴" : "Customize columns ▾"}
          </button>
        </div>

        {customizeOpen && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 10, padding: "8px 10px", border: "1px dashed var(--border-light)" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: sampleGray, marginBottom: 4 }}>HOLIDAY</div>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer" }}>
                <input type="checkbox" checked={!!visibleCols.holiday} onChange={(e) => setCol("holiday", e.target.checked)} /> Holiday name
              </label>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: sampleGray, marginBottom: 4 }}>SCHEDULED (NIGHT-BEFORE)</div>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer", marginBottom: 2 }}>
                <input type="checkbox" checked={!!visibleCols.schedTotal} onChange={(e) => setCol("schedTotal", e.target.checked)} /> Total scheduled
              </label>
              {providerIds.map((id) => (
                <label key={id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer", marginBottom: 2 }}>
                  <input type="checkbox" checked={!!visibleCols[`sched:${id}`]} onChange={(e) => setCol(`sched:${id}`, e.target.checked)} /> {providerMeta[id]?.name} scheduled
                </label>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: sampleGray, marginBottom: 4 }}>TRIPS (DAY-OF)</div>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer", marginBottom: 2 }}>
                <input type="checkbox" checked={!!visibleCols.tripsTotal} onChange={(e) => setCol("tripsTotal", e.target.checked)} /> Total trips
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer", marginBottom: 2 }}>
                <input type="checkbox" checked={!!visibleCols.unaccom} onChange={(e) => setCol("unaccom", e.target.checked)} /> Unaccommodated
              </label>
              {providerIds.map((id) => (
                <div key={id} style={{ marginBottom: 2 }}>
                  {["trips", "hrs", "cost"].map((suf) => (
                    <label key={suf} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer" }}>
                      <input type="checkbox" checked={!!visibleCols[`${suf === "trips" ? "trips" : suf}:${id}`]} onChange={(e) => setCol(`${suf}:${id}`, e.target.checked)} />
                      {providerMeta[id]?.name} {suf === "trips" ? "trips" : suf === "hrs" ? "hrs" : "cost"}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto", maxHeight: 620, overflowY: "auto", border: "1px solid var(--border-light)" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--border)", background: card, position: "sticky", top: 0, zIndex: 1 }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Day</th>
                {visibleCols.holiday && <th style={thStyle}>Holiday</th>}
                {visibleCols.schedTotal && <th style={{ ...thStyle, textAlign: "right" }}>Total scheduled</th>}
                {visibleCols.tripsTotal && <th style={{ ...thStyle, textAlign: "right" }}>Total trips</th>}
                {visibleCols.unaccom && <th style={{ ...thStyle, textAlign: "right", color: gapRed }}>Unaccommodated</th>}
                {providerIds.map((id) => (
                  <React.Fragment key={id}>
                    {visibleCols[`sched:${id}`] && <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} scheduled</th>}
                    {visibleCols[`trips:${id}`] && <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} trips</th>}
                    {visibleCols[`hrs:${id}`] && <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} hrs</th>}
                    {visibleCols[`cost:${id}`] && <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} cost</th>}
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((label, mi) => selectedMonths.has(mi) && (
                <React.Fragment key={label}>
                  <tr>
                    <td colSpan={colCount} style={{ background: "var(--tint-neutral-b)", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 12.5, padding: "5px 8px", position: "sticky", top: 27, zIndex: 1 }}>
                      {label} {selectedYear}
                    </td>
                  </tr>
                  {dayRows.filter((r) => r.month === mi).map((r) => {
                    const weekend = r.dow === 0 || r.dow === 6;
                    return (
                      <tr key={r.iso} style={{ borderBottom: "1px solid var(--border-light)", background: weekend ? "var(--tint-weekend-b)" : undefined }}>
                        <td style={tdStyle}>{r.iso}</td>
                        <td style={tdStyle}>{DOW_SHORT[r.dow]}</td>
                        {visibleCols.holiday && <td style={{ ...tdStyle, color: r.holidayName ? gapRed : sampleGray }}>{r.holidayName || ""}</td>}
                        {visibleCols.schedTotal && <td style={{ ...tdStyle, textAlign: "right", color: supplyTeal }}>{Math.round(dayScheduled(r, attritionPct)).toLocaleString()}</td>}
                        {visibleCols.tripsTotal && <td style={{ ...tdStyle, textAlign: "right" }}>{Math.round(r.trips).toLocaleString()}</td>}
                        {visibleCols.unaccom && <td style={{ ...tdStyle, textAlign: "right", color: r.unaccommodated > 0 ? gapRed : sampleGray }}>{r.unaccommodated > 0 ? Math.round(r.unaccommodated).toLocaleString() : "—"}</td>}
                        {providerIds.map((id) => {
                          const p = r.byProvider[id];
                          return (
                            <React.Fragment key={id}>
                              {visibleCols[`sched:${id}`] && <td style={{ ...tdStyle, textAlign: "right", color: supplyTeal }}>{p ? Math.round(providerScheduled(p, attritionPct)).toLocaleString() : "—"}</td>}
                              {visibleCols[`trips:${id}`] && <td style={{ ...tdStyle, textAlign: "right" }}>{p ? Math.round(p.trips).toLocaleString() : "—"}</td>}
                              {visibleCols[`hrs:${id}`] && <td style={{ ...tdStyle, textAlign: "right", color: sampleGray }}>{p && p.hours != null ? Math.round(p.hours).toLocaleString() : "—"}</td>}
                              {visibleCols[`cost:${id}`] && <td style={{ ...tdStyle, textAlign: "right", color: sampleGray }}>{p ? `$${Math.round(p.cost).toLocaleString()}` : "—"}</td>}
                            </React.Fragment>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
