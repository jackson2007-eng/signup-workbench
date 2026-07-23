import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { NumField, Stat } from "./App.jsx";
import { PhaseStrip } from "./CallCentre.jsx";
import { VACATIONPLAN_SAMPLE } from "./vacationSampleData.js";
import { useAccountProject, useSignupList, SaveStatus, AccountChip, SignupSwitcher } from "./useAccountProject.jsx";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

/* Vacation Signup Planner — reviewed against a real DATS operator vacation sign-up sheet
   (seniority-ordered bidding: each operator has a vacation entitlement in whole weeks, each
   week of the vacation year carries a maximum number of operators who can be off at once, and
   operators claim weeks in seniority order until their entitlement is used up). That sheet
   contains real names/badge numbers — never reproduced here; this module works entirely with
   an anonymous seniority-ordered roster (label + weeks entitled only).

   v1 scope (confirmed): auto-balance allocation — each operator, in roster order, claims
   their entitled week-count from whichever eligible weeks currently have the most remaining
   room, rather than simulating literal turn-by-turn preference picks. Weekly caps are fully
   editable per week, with a "suggest from headcount" helper (self-contained — a headcount +
   base/reduced % pair typed here, not a live cross-module link to Annual Plan). The intent is
   for the resulting per-week vacation headcount to feed Annual Plan's in-house hoursByDow as a
   weekly override in a later pass, once this mechanism is validated on its own. */

const text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", demandAmber = "var(--demand-amber)", gapRed = "var(--gap-red)",
  sampleGray = "var(--sample-gray)";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const cardStyle = { background: card, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 14 };
const hTitle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 10 };

const clone = (o) => JSON.parse(JSON.stringify(o));
const nextId = () => "op" + Math.random().toString(36).slice(2, 9);

/* ---------- date helpers (plain calendar-date math, UTC throughout) ---------- */
const addDaysISO = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtShort = (iso) => `${MONTH_SHORT[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const rangesOverlap = (aStart, aEnd, bStart, bEnd) => bStart && bEnd && aStart <= bEnd && aEnd >= bStart;

function buildWeeks(yearStart, count) {
  const weeks = [];
  for (let i = 0; i < count; i++) {
    const start = addDaysISO(yearStart, i * 7);
    weeks.push({ index: i, start, end: addDaysISO(start, 6) });
  }
  return weeks;
}

function suggestCaps(weeks, params, reducedIdx) {
  return weeks.map((w) => {
    const pct = reducedIdx.has(w.index) ? params.reducedPct : params.basePct;
    return Math.max(0, Math.floor(((params.headcount || 0) * (pct || 0)) / 100));
  });
}

/* ---------- allocation engine ----------
   Seniority-order greedy "auto-balance": each operator, in roster order, claims their
   entitled week-count from whichever eligible weeks currently have the MOST remaining room —
   spreads picks across the year instead of clustering, and is deliberately simpler than
   simulating literal turn-by-turn preference bidding (v1 scope). Never blocks: an operator who
   can't get all their weeks is flagged with a shortfall count, not silently dropped. */
function allocateVacation(operators, weeks, caps) {
  const remaining = weeks.map((w) => Math.max(0, caps[w.index] || 0));
  const perOperator = [];
  for (const op of operators) {
    const need = Math.max(0, Math.round(op.weeksEntitled || 0));
    const picks = [];
    for (let n = 0; n < need; n++) {
      let best = -1;
      for (let w = 0; w < remaining.length; w++) {
        if (remaining[w] > 0 && (best === -1 || remaining[w] > remaining[best])) best = w;
      }
      if (best === -1) break;
      remaining[best] -= 1;
      picks.push(best);
    }
    picks.sort((a, b) => a - b);
    perOperator.push({ id: op.id, label: op.label, weeksEntitled: need, assigned: picks, shortfall: need - picks.length });
  }
  const perWeek = weeks.map((w) => ({ index: w.index, cap: Math.max(0, caps[w.index] || 0), filled: Math.max(0, caps[w.index] || 0) - remaining[w.index] }));
  const totalDemand = operators.reduce((s, o) => s + Math.max(0, Math.round(o.weeksEntitled || 0)), 0);
  const totalCapacity = caps.reduce((s, c) => s + Math.max(0, c || 0), 0);
  const totalFilled = perWeek.reduce((s, w) => s + w.filled, 0);
  const totalShortfall = perOperator.reduce((s, o) => s + o.shortfall, 0);
  const shortOperators = perOperator.filter((o) => o.shortfall > 0).length;
  return { perOperator, perWeek, totalDemand, totalCapacity, totalFilled, totalShortfall, shortOperators };
}

export default function VacationPlan({ onHome, user, logout }) {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { localStorage.setItem("theme", theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  const [tab, setTab] = useState("roster");
  const [operators, setOperators] = useState(() => clone(VACATIONPLAN_SAMPLE.operators));
  const [yearStart, setYearStart] = useState(VACATIONPLAN_SAMPLE.yearStart);
  const [weekCount, setWeekCount] = useState(VACATIONPLAN_SAMPLE.weekCount);
  const [caps, setCaps] = useState(() => clone(VACATIONPLAN_SAMPLE.caps));
  const [suggestParams, setSuggestParams] = useState(() => clone(VACATIONPLAN_SAMPLE.suggestParams));
  const [summerStart, setSummerStart] = useState(VACATIONPLAN_SAMPLE.summerStart);
  const [summerEnd, setSummerEnd] = useState(VACATIONPLAN_SAMPLE.summerEnd);
  const [jurisdiction, setJurisdiction] = useState(() => clone(VACATIONPLAN_SAMPLE.jurisdiction));
  const fileRef = useRef(null);
  const rosterUpRef = useRef(null);

  /* ---------- statutory holidays (lazy-loaded, same pattern as Annual Plan) ---------- */
  const [hdCtor, setHdCtor] = useState(null);
  const [hdCountries, setHdCountries] = useState({});
  const [hdRegions, setHdRegions] = useState({});
  const hdImportStarted = useRef(false);
  useEffect(() => {
    if (tab !== "caps" || hdImportStarted.current) return;
    hdImportStarted.current = true;
    import("date-holidays")
      .then((m) => { setHdCtor(() => m.default); setHdCountries(new m.default().getCountries()); })
      .catch(() => {});
  }, [tab]);
  useEffect(() => {
    if (!hdCtor) return;
    setHdRegions(new hdCtor(jurisdiction.country).getStates(jurisdiction.country) || {});
  }, [hdCtor, jurisdiction.country]);

  const weeks = useMemo(() => buildWeeks(yearStart, weekCount), [yearStart, weekCount]);

  const holidayWeekIdx = useMemo(() => {
    if (!hdCtor) return new Set();
    const years = new Set([+yearStart.slice(0, 4), +addDaysISO(yearStart, (weekCount - 1) * 7).slice(0, 4)]);
    const hd = new hdCtor(jurisdiction.country, jurisdiction.region || undefined);
    const dates = new Set();
    for (const y of years) for (const h of hd.getHolidays(y)) if (h.type === "public") dates.add(h.date.slice(0, 10));
    const idx = new Set();
    for (const w of weeks) for (const d of dates) if (d >= w.start && d <= w.end) { idx.add(w.index); break; }
    return idx;
  }, [hdCtor, jurisdiction.country, jurisdiction.region, weeks, yearStart, weekCount]);

  const summerWeekIdx = useMemo(() => new Set(weeks.filter((w) => rangesOverlap(w.start, w.end, summerStart, summerEnd)).map((w) => w.index)), [weeks, summerStart, summerEnd]);
  const reducedWeekIdx = useMemo(() => new Set([...holidayWeekIdx, ...summerWeekIdx]), [holidayWeekIdx, summerWeekIdx]);

  const allocation = useMemo(() => allocateVacation(operators, weeks, caps), [operators, weeks, caps]);

  /* ---------- roster editing ---------- */
  const updateOperator = (id, patch) => setOperators((ops) => ops.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const removeOperator = (id) => setOperators((ops) => ops.filter((o) => o.id !== id));
  const addOperator = () => setOperators((ops) => [...ops, { id: nextId(), label: `Operator ${ops.length + 1}`, weeksEntitled: 4 }]);
  const [bulkCount, setBulkCount] = useState(5);
  const [bulkWeeks, setBulkWeeks] = useState(4);
  const bulkAdd = () => setOperators((ops) => {
    const add = [];
    for (let i = 0; i < Math.max(0, Math.round(bulkCount)); i++) add.push({ id: nextId(), label: `Operator ${ops.length + add.length + 1}`, weeksEntitled: Math.max(0, bulkWeeks) });
    return [...ops, ...add];
  });
  const downloadRosterTemplate = () => {
    const rows = [["Label", "Weeks Entitled"], ...operators.map((o) => [o.label, o.weeksEntitled])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Roster");
    XLSX.writeFile(wb, "vacation-roster-template.xlsx");
  };
  const uploadRoster = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1);
        const out = [];
        for (const row of rows) {
          if (!row || row[0] == null || row[0] === "") continue;
          const weeksEntitled = Number(row[1]);
          out.push({ id: nextId(), label: String(row[0]), weeksEntitled: Number.isFinite(weeksEntitled) ? weeksEntitled : 0 });
        }
        if (!out.length) { alert("Could not find any usable rows in that file."); return; }
        setOperators(out);
      } catch (e) {
        alert("Could not read that file — check it matches the template.");
      }
    };
    rd.readAsArrayBuffer(file);
  };

  /* ---------- weekly caps editing ---------- */
  const updateCap = (index, v) => setCaps((cs) => cs.map((c, i) => (i === index ? Math.max(0, v) : c)));
  const setWeekCountClamped = (v) => {
    const n = Math.max(1, Math.min(53, Math.round(v)));
    setWeekCount(n);
    setCaps((cs) => { const out = cs.slice(0, n); while (out.length < n) out.push(0); return out; });
  };
  const applySuggestedCaps = () => setCaps(suggestCaps(weeks, suggestParams, reducedWeekIdx));

  /* ---------- save / load project ---------- */
  const buildPayload = () => ({ kind: "vacationplan", operators, yearStart, weekCount, caps, suggestParams, summerStart, summerEnd, jurisdiction });
  const saveProject = () => {
    const blob = new Blob([JSON.stringify(buildPayload(), null, 0)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vacation-signup-plan.json";
    a.click();
  };
  const applyPayload = (p) => {
        if (p.operators) setOperators(p.operators);
        if (p.yearStart) setYearStart(p.yearStart);
        if (p.weekCount) setWeekCount(p.weekCount);
        if (p.caps) setCaps(p.caps);
        if (p.suggestParams) setSuggestParams(p.suggestParams);
        if (p.summerStart) setSummerStart(p.summerStart);
        if (p.summerEnd) setSummerEnd(p.summerEnd);
        if (p.jurisdiction) setJurisdiction(p.jurisdiction);
  };
  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        applyPayload(JSON.parse(rd.result));
      } catch (e) {
        alert("Could not read that project file.");
      }
    };
    rd.readAsText(file);
  };
  const payloadJson = useMemo(() => JSON.stringify(buildPayload()), [
    operators, yearStart, weekCount, caps, suggestParams, summerStart, summerEnd, jurisdiction,
  ]);
  const { items: signups, create: createSignup, rename: renameSignup, remove: removeSignup } = useSignupList("vacationplan");
  const [projectId, setProjectId] = useState(null);
  useEffect(() => {
    if (!signups || projectId) return;
    if (signups.length) setProjectId(signups[0].id);
    else createSignup({ name: "My Vacation Plan" }).then(setProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signups]);
  const saveStatus = useAccountProject("vacationplan", projectId, payloadJson, applyPayload);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --supply-teal: #0F7B7A; --gap-red: #C0392B; --bookout-violet: #6C5B9E;
          --sample-gray: #5B6B75; --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #CBD5DA;
          --tint-neutral-b: #EEF4F5; --tint-teal-b: #EEF6F6; --tint-red: #FBEDEB; --tint-amber-b: #FBF3E9;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --supply-teal: #2FB3AC; --gap-red: #E27A70; --bookout-violet: #A594D1;
          --sample-gray: #8B9AA5; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D;
          --tint-neutral-b: #1C262B; --tint-teal-b: #172227; --tint-red: #2E1714; --tint-amber-b: #2A2115;
        }
        body { background: var(--paper); }
        .vpnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:var(--sample-gray); }
        .vpnav.on { color:${text}; border-bottom-color:${supplyTeal}; }
        input[type=text], input[type=number], input[type=date] { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
        select { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
        table.vp { border-collapse: collapse; width: 100%; }
        table.vp th { padding: 5px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--sample-gray); text-align: left; border-bottom: 1px solid var(--border); }
        table.vp td { padding: 5px 8px; border-bottom: 1px solid var(--border-light); font-size: 13px; }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onHome} style={{ ...nudgeBtn, fontSize: 12 }}>‹ Transit Operations Toolkit</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>VACATION SIGNUP PLANNER</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>Demand <b style={{ color: text, fontSize: 15 }}>{allocation.totalDemand.toLocaleString()}</b> wks vs. capacity <b style={{ color: text, fontSize: 15 }}>{allocation.totalCapacity.toLocaleString()}</b> wks</div>
            <SignupSwitcher label="Signup" projectId={projectId} items={signups} onSwitch={setProjectId}
              onCreate={async (vals) => setProjectId(await createSignup(vals))}
              onRename={renameSignup}
              onDelete={(id) => { removeSignup(id); if (id === projectId) setProjectId(null); }} />
            <SaveStatus status={saveStatus} />
            <AccountChip user={user} logout={logout} />
            <button style={nudgeBtn} onClick={saveProject}>Export backup JSON</button>
            <button style={nudgeBtn} onClick={() => fileRef.current && fileRef.current.click()}>Import backup JSON</button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ""; }} />
            {DARK_MODE_ENABLED && (
              <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle light/dark mode"
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", padding: "5px 8px", background: "none", border: "1px solid var(--border-input)", borderRadius: 2, color: sampleGray, cursor: "pointer" }}>
                {theme === "dark" ? "☀ Light" : "☾ Dark"}
              </button>
            )}
          </div>
        </div>

        <PhaseStrip tab={tab} setTab={setTab} navClass="vpnav" groups={[
          { phase: "PHASE 1 · SETUP", tabs: [
            { key: "roster", label: "ROSTER" },
            { key: "caps", label: "WEEKLY CAPS" },
          ]},
          { phase: "PHASE 2 · REVIEW", tabs: [
            { key: "allocation", label: "ALLOCATION" },
          ]},
        ]} />

        {tab === "roster" && (
          <RosterTab {...{ operators, updateOperator, removeOperator, addOperator, bulkCount, setBulkCount, bulkWeeks, setBulkWeeks, bulkAdd, downloadRosterTemplate, uploadRoster, rosterUpRef }} />
        )}
        {tab === "caps" && (
          <CapsTab {...{
            yearStart, setYearStart, weekCount, setWeekCountClamped, weeks, caps, updateCap,
            suggestParams, setSuggestParams, applySuggestedCaps, summerStart, setSummerStart, summerEnd, setSummerEnd,
            jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, holidayWeekIdx, summerWeekIdx,
          }} />
        )}
        {tab === "allocation" && (
          <AllocationTab {...{ weeks, allocation, reducedWeekIdx }} />
        )}
      </div>
    </div>
  );
}

/* ================= ROSTER ================= */
function RosterTab({ operators, updateOperator, removeOperator, addOperator, bulkCount, setBulkCount, bulkWeeks, setBulkWeeks, bulkAdd, downloadRosterTemplate, uploadRoster, rosterUpRef }) {
  const totalWeeks = operators.reduce((s, o) => s + (o.weeksEntitled || 0), 0);
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Roster</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          Seniority order — row order is pick order (top = most senior). No names or badge numbers needed; label is just for your own reference. Add operators one at a time or in bulk, or upload a roster file.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label="Operators" value={operators.length.toLocaleString()} />
          <Stat label="Total weeks entitled" value={totalWeeks.toLocaleString()} tone={supplyTeal} />
        </div>
        <div style={{ overflowX: "auto", marginBottom: 10 }}>
          <table className="vp">
            <thead><tr><th style={{ width: 50 }}>Rank</th><th>Label</th><th style={{ width: 140 }}>Weeks entitled</th><th style={{ width: 70 }}></th></tr></thead>
            <tbody>
              {operators.map((o, i) => (
                <tr key={o.id}>
                  <td style={{ color: sampleGray }}>{i + 1}</td>
                  <td>
                    <input value={o.label} onChange={(e) => updateOperator(o.id, { label: e.target.value })}
                      style={{ width: "100%", padding: "3px 6px", border: "1px solid var(--border-input)", borderRadius: 2, background: card, color: text, fontSize: 13 }} />
                  </td>
                  <td><NumField value={o.weeksEntitled} onCommit={(v) => updateOperator(o.id, { weeksEntitled: Math.max(0, v) })} /></td>
                  <td><button style={{ ...nudgeBtn, color: gapRed, borderColor: gapRed, padding: "3px 8px", fontSize: 11 }} onClick={() => removeOperator(o.id)}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button style={nudgeBtn} onClick={addOperator}>+ Add operator</button>
          <span style={{ fontSize: 12, color: sampleGray, marginLeft: 8 }}>or add</span>
          <NumField value={bulkCount} onCommit={setBulkCount} />
          <span style={{ fontSize: 12, color: sampleGray }}>operators with</span>
          <NumField value={bulkWeeks} onCommit={setBulkWeeks} />
          <span style={{ fontSize: 12, color: sampleGray }}>weeks each</span>
          <button style={nudgeBtn} onClick={bulkAdd}>Add</button>
          <span style={{ marginLeft: "auto" }} />
          <button style={nudgeBtn} onClick={downloadRosterTemplate}>Download template</button>
          <button style={nudgeBtn} onClick={() => rosterUpRef.current && rosterUpRef.current.click()}>Upload roster</button>
          <input ref={rosterUpRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
            onChange={(e) => { if (e.target.files && e.target.files[0]) uploadRoster(e.target.files[0]); e.target.value = ""; }} />
        </div>
      </div>
    </div>
  );
}

/* ================= WEEKLY CAPS ================= */
const COUNTRY_PRESETS = ["CA", "US", "GB", "AU"];
function CapsTab({
  yearStart, setYearStart, weekCount, setWeekCountClamped, weeks, caps, updateCap,
  suggestParams, setSuggestParams, applySuggestedCaps, summerStart, setSummerStart, summerEnd, setSummerEnd,
  jurisdiction, setJurisdiction, hdCountries, hdRegions, hdCtor, holidayWeekIdx, summerWeekIdx,
}) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Vacation year</div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Year start
            <input type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} style={{ padding: "5px 6px", borderRadius: 2, fontSize: 13 }} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Weeks <NumField value={weekCount} onCommit={setWeekCountClamped} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Country
            <select value={jurisdiction.country} onChange={(e) => setJurisdiction((j) => ({ ...j, country: e.target.value, region: "" }))}
              style={{ padding: "5px 6px", borderRadius: 2, fontSize: 13 }}>
              {(Object.keys(hdCountries).length ? Object.keys(hdCountries) : COUNTRY_PRESETS).map((c) => <option key={c} value={c}>{hdCountries[c] || c}</option>)}
            </select>
          </label>
          {Object.keys(hdRegions).length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Province / state
              <select value={jurisdiction.region} onChange={(e) => setJurisdiction((j) => ({ ...j, region: e.target.value }))} style={{ padding: "5px 6px", borderRadius: 2, fontSize: 13 }}>
                <option value="">(none)</option>
                {Object.entries(hdRegions).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
          )}
          {!hdCtor && <span style={{ fontSize: 12, color: sampleGray }}>Loading holiday calendars…</span>}
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
          Weeks run consecutively from the start date. Statutory-holiday weeks are auto-detected from the jurisdiction above; mark your own summer prime-time window below.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Suggest caps from headcount</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, alignItems: "center", marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Headcount
            <NumField value={suggestParams.headcount} onCommit={(v) => setSuggestParams((p) => ({ ...p, headcount: Math.max(0, v) }))} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Baseline max off (%)
            <NumField value={suggestParams.basePct} step={0.5} onCommit={(v) => setSuggestParams((p) => ({ ...p, basePct: Math.max(0, Math.min(100, v)) }))} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Reduced max off (%)
            <NumField value={suggestParams.reducedPct} step={0.5} onCommit={(v) => setSuggestParams((p) => ({ ...p, reducedPct: Math.max(0, Math.min(100, v)) }))} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Summer start
            <input type="date" value={summerStart} onChange={(e) => setSummerStart(e.target.value)} style={{ padding: "5px 6px", borderRadius: 2, fontSize: 13 }} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>Summer end
            <input type="date" value={summerEnd} onChange={(e) => setSummerEnd(e.target.value)} style={{ padding: "5px 6px", borderRadius: 2, fontSize: 13 }} /></label>
          <button style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={applySuggestedCaps}>Suggest caps</button>
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray }}>
          Reduced % applies to statutory-holiday weeks and any week overlapping the summer window above. Every week stays individually editable below — this just fills a starting point.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Weekly caps</div>
        <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto" }}>
          <table className="vp">
            <thead><tr><th style={{ width: 50 }}>Wk</th><th style={{ width: 160 }}>Dates</th><th>Tags</th><th style={{ width: 100 }}>Cap</th></tr></thead>
            <tbody>
              {weeks.map((w) => {
                const isHoliday = holidayWeekIdx.has(w.index);
                const isSummer = summerWeekIdx.has(w.index);
                return (
                  <tr key={w.index}>
                    <td style={{ color: sampleGray }}>{w.index + 1}</td>
                    <td>{fmtShort(w.start)} – {fmtShort(w.end)}</td>
                    <td>
                      {isHoliday && <span style={{ fontSize: 10, padding: "2px 6px", background: "var(--tint-red)", color: gapRed, borderRadius: 2, marginRight: 4 }}>Stat holiday</span>}
                      {isSummer && <span style={{ fontSize: 10, padding: "2px 6px", background: "var(--tint-amber-b)", color: demandAmber, borderRadius: 2 }}>Summer prime</span>}
                    </td>
                    <td><NumField value={caps[w.index] || 0} onCommit={(v) => updateCap(w.index, v)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= ALLOCATION ================= */
function AllocationTab({ weeks, allocation, reducedWeekIdx }) {
  const chartData = weeks.map((w) => {
    const row = allocation.perWeek[w.index];
    return { week: `${fmtShort(w.start)}`, filled: row.filled, remaining: Math.max(0, row.cap - row.filled), cap: row.cap };
  });
  const utilization = allocation.totalCapacity > 0 ? (allocation.totalFilled / allocation.totalCapacity) * 100 : 0;
  return (
    <div>
      {allocation.totalShortfall > 0 && (
        <div style={{ background: "var(--tint-red)", border: `1px solid ${gapRed}`, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, color: gapRed }}>
          <b>{allocation.totalShortfall.toLocaleString()} week(s) unassigned</b> across {allocation.shortOperators.toLocaleString()} operator(s) — weekly capacity ran out before every entitled week could be placed. Raise caps on under-filled weeks, or review the roster.
        </div>
      )}
      <div style={cardStyle}>
        <div style={hTitle}>Weekly fill vs. cap</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label="Total demand" value={`${allocation.totalDemand.toLocaleString()} wks`} />
          <Stat label="Total capacity" value={`${allocation.totalCapacity.toLocaleString()} wks`} tone={supplyTeal} />
          <Stat label="Utilization" value={`${utilization.toFixed(1)}%`} tone={utilization > 95 ? gapRed : supplyTeal} />
          <Stat label="Unassigned weeks" value={allocation.totalShortfall.toLocaleString()} tone={allocation.totalShortfall > 0 ? gapRed : undefined} />
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} interval={3} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, border: "1px solid var(--border-light)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="filled" name="Filled" stackId="s" fill={supplyTeal} isAnimationActive={false} />
            <Bar dataKey="remaining" name="Open" stackId="s" fill="var(--tint-teal-b)" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>By operator</div>
        <div style={{ overflowX: "auto" }}>
          <table className="vp">
            <thead><tr><th style={{ width: 50 }}>Rank</th><th>Label</th><th style={{ width: 90 }}>Entitled</th><th>Assigned weeks</th><th style={{ width: 90 }}>Shortfall</th></tr></thead>
            <tbody>
              {allocation.perOperator.map((o, i) => (
                <tr key={o.id}>
                  <td style={{ color: sampleGray }}>{i + 1}</td>
                  <td>{o.label}</td>
                  <td>{o.weeksEntitled}</td>
                  <td>{o.assigned.map((w) => w + 1).join(", ") || "—"}</td>
                  <td style={{ color: o.shortfall > 0 ? gapRed : sampleGray, fontWeight: o.shortfall > 0 ? 700 : 400 }}>{o.shortfall || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
