import React, { useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  T0, T1, N, SLOT, DAYS, WEEKEND_DAYS, fmt, parseHM, cloneSeg,
  buildSupply, computeEngine, generateBoard, validateSeg, autofixSeg,
  TimeField, NumField, Nudge, Stat, CoverageChart, Sketcher, ActualCurve,
} from "./App.jsx";
import { CALL_SAMPLE } from "./callSampleData.js";

/* Call Centre Staffing — a lean sibling of the operator workbench. It reuses the shared coverage
   engine (imported above), scoring agents-on-shift against an Active-calls curve. Vehicle-specific
   knobs are neutralized in glob, so the engine reduces to plain scale-free coverage. */

const ink = "#182430", paper = "#F4F6F7", card = "#FFFFFF",
  supplyTeal = "#0F7B7A", demandAmber = "#D98324", gapRed = "#C0392B",
  sampleGray = "#5B6B75", targetInk = "#233746";
const DEFAULT_TCOLOR = "#4B5D67";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: "#fff", border: "1px solid #CBD5DA", color: ink, cursor: "pointer", borderRadius: 2 };
const primaryBtn = { ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal };
const cardStyle = { background: card, border: "1px solid #E2E8EA", padding: "14px 16px", marginBottom: 14 };
const hTitle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 10 };
const DOW = { Sunday: "SU", Monday: "MO", Tuesday: "TU", Wednesday: "WE", Thursday: "TH", Friday: "FR", Saturday: "SA" };

const clone = (o) => JSON.parse(JSON.stringify(o));

// 42 control points (05:00→25:30, every 30 min) → per-slot curve, scaled so the peak = `peak`.
function sketchToCalls(raw, peak) {
  const arr = new Array(N); let mx = 0;
  for (let i = 0; i < N; i++) {
    const t = SLOT(i);
    const k = Math.min(40, Math.max(0, Math.floor((t - 300) / 30)));
    const f = (t - (300 + k * 30)) / 30;
    const v = Math.max(0, raw[k] * (1 - f) + raw[k + 1] * f);
    arr[i] = v; if (v > mx) mx = v;
  }
  const scale = mx > 0 ? peak / mx : 0;
  return arr.map((v) => Math.round(v * scale * 100) / 100);
}
const DEFAULT_SKETCH = [6, 8, 10, 16, 26, 40, 55, 70, 82, 90, 92, 88, 80, 74, 72, 76, 84, 92, 96, 92, 82, 70, 58, 46, 36, 28, 22, 17, 13, 10, 8, 6, 5, 4, 3, 2, 2, 1, 1, 1, 0, 0];

const hdrIndex = (H, ...names) => {
  const low = H.map((h) => String(h == null ? "" : h).trim().toLowerCase());
  for (const n of names) { const i = low.indexOf(n.toLowerCase()); if (i >= 0) return i; }
  return -1;
};
const EXCEL_EPOCH = 25569; // days from Excel's 1899-12-30 serial epoch to the Unix epoch
const serialToWeekday = (serial) => new Date(Math.round((Math.floor(serial) - EXCEL_EPOCH) * 86400000)).getUTCDay();

// Derive an Active-calls concurrency curve from a raw ACD call-record export (one row per handled
// call, with Excel-serial Call Start Time / Call End Time). For each interval we count calls in
// progress (start ≤ t < end), then average each weekday across the distinct dates it appears, so
// the result is a typical week — not a total. Inbound calls only (customer demand); outbound is the
// agents' own activity, not workload. Returns { calls, info } or null if the rows aren't ACD records.
function deriveActiveCalls(rows) {
  if (!rows || !rows.length) return null;
  const H = rows[0];
  const cs = hdrIndex(H, "Call Start Time", "Start Time");
  const ce = hdrIndex(H, "Call End Time", "End Time");
  if (cs < 0 || ce < 0) return null;
  const ct = hdrIndex(H, "Call Type");
  const acc = {}, dates = {};
  for (const d of DAYS) { acc[d] = new Array(N).fill(0); dates[d] = new Set(); }
  let used = 0, outbound = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const s = row[cs], e = row[ce];
    if (typeof s !== "number" || typeof e !== "number") continue;
    if (ct >= 0 && !/inbound/i.test(String(row[ct] || ""))) { outbound++; continue; }
    const dateSerial = Math.floor(s);
    const d = DAYS[serialToWeekday(s)];
    const startMin = Math.round((s - dateSerial) * 1440);
    let endMin = Math.round((e - dateSerial) * 1440);
    if (endMin <= startMin) endMin = startMin + 1;
    const a = Math.floor((startMin - T0) / 5), z = Math.ceil((endMin - T0) / 5);
    if (z <= 0 || a >= N) continue;
    for (let i = Math.max(0, a); i < Math.min(N, z); i++) acc[d][i]++;
    dates[d].add(dateSerial);
    used++;
  }
  if (used === 0) return null;
  const calls = {};
  let minDates = Infinity, maxDates = 0;
  for (const d of DAYS) {
    const nd = dates[d].size || 1;
    if (dates[d].size) { minDates = Math.min(minDates, nd); maxDates = Math.max(maxDates, nd); }
    calls[d] = acc[d].map((v) => Math.round((v / nd) * 100) / 100);
  }
  const span = minDates === maxDates ? `${maxDates}` : `${minDates}–${maxDates}`;
  return { calls, info: `Derived active-call curve from ${used.toLocaleString()} inbound calls (${outbound.toLocaleString()} outbound excluded), averaged over ${span} day(s) per weekday.` };
}

// Simple Day / Time / Active-calls template → per-slot curve (one value per interval).
function parseSimpleCalls(rows) {
  if (!rows || !rows.length) return null;
  const H = rows[0];
  const di = hdrIndex(H, "Day", "Weekday");
  const ti = H.map((h) => String(h || "").toLowerCase()).findIndex((h) => h.startsWith("time") || h.startsWith("interval"));
  const ai = H.map((h) => String(h || "").toLowerCase()).findIndex((h) => h.includes("active") || h.includes("call"));
  if (di < 0 || ti < 0 || ai < 0) return null;
  const dayKey = {}; for (const d of DAYS) { dayKey[d.toLowerCase()] = d; dayKey[d.slice(0, 3).toLowerCase()] = d; }
  const calls = {}; for (const d of DAYS) calls[d] = new Array(N).fill(0);
  let used = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const d = dayKey[String(row[di] || "").trim().toLowerCase()];
    let raw = row[ti];
    const t = typeof raw === "number" && raw < 1 ? Math.round(raw * 1440) : parseHM(String(raw || "").trim());
    const v = Number(row[ai]);
    if (!d || t == null || !Number.isFinite(v)) continue;
    const i = Math.round((t - T0) / 5);
    if (i >= 0 && i < N) { calls[d][i] = v; used++; }
  }
  return used ? { calls, info: `Loaded ${used.toLocaleString()} interval values from the template.` } : null;
}

const NAV = [
  { key: "rules", label: "RULES" },
  { key: "demand", label: "DEMAND" },
  { key: "build", label: "BUILD" },
  { key: "coverage", label: "COVERAGE" },
  { key: "schedule", label: "SCHEDULE" },
];

export default function CallCentre({ onHome }) {
  const [board, setBoard] = useState(() => CALL_SAMPLE.board.map(cloneSeg));
  const [rules, setRules] = useState(() => clone(CALL_SAMPLE.rules));
  const [glob, setGlob] = useState(() => clone(CALL_SAMPLE.global));
  const [spans, setSpans] = useState(() => clone(CALL_SAMPLE.spans));
  const [calls, setCalls] = useState(() => clone(CALL_SAMPLE.calls));
  const [demSource, setDemSource] = useState("sample");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [typeColors, setTypeColors] = useState(() => ({ ...CALL_SAMPLE.typeColors }));
  const [tab, setTab] = useState("coverage");
  const [day, setDay] = useState("Monday");
  const [selId, setSelId] = useState(null);
  const [nAgents, setNAgents] = useState(24);
  const [buildResult, setBuildResult] = useState(null);
  const [sketchRaw, setSketchRaw] = useState(() => [...DEFAULT_SKETCH]);
  const [peakCalls, setPeakCalls] = useState(34);
  const [hist, setHist] = useState([]);
  const [future, setFuture] = useState([]);
  const fileRef = useRef(null);

  const nextId = useRef(Math.max(0, ...CALL_SAMPLE.board.map((s) => s.id || 0)) + 1);
  const tColor = (t) => typeColors[t] || DEFAULT_TCOLOR;

  const DEM = calls;
  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(
    () => computeEngine(DEM, ftCov, false, glob.minVeh, spans, 0, 0, 0, 0, 0, glob),
    [DEM, ftCov, glob, spans]
  );
  const P = eng.perDay[day];

  const distinctShifts = new Set(board.map((s) => s.shift)).size;
  const flagCount = board.reduce((n, s) => n + (validateSeg(s, rules, glob).length ? 1 : 0), 0);

  const commit = (fn) => {
    setHist((h) => [...h.slice(-40), board]);
    setFuture([]);
    setBoard(fn(board));
  };
  const undo = () => {
    if (!hist.length) return;
    setFuture((f) => [board, ...f]);
    setBoard(hist[hist.length - 1]);
    setHist((h) => h.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setHist((h) => [...h, board]);
    setBoard(future[0]);
    setFuture((f) => f.slice(1));
  };

  /* ---------- generate ---------- */
  const generate = () => {
    const r = generateBoard(0, Math.max(1, Math.round(nAgents)), rules, glob, DEM, spans, glob.minVeh, false, null, glob.shiftSeriesBase);
    const segs = r.segs.map((s) => ({ ...cloneSeg(s), id: nextId.current++ }));
    setHist((h) => [...h.slice(-40), board]); setFuture([]);
    setBoard(segs);
    setBuildResult({ packages: r.packages, mix: r.mix, paidHours: r.paidHours, evaluated: r.evaluated });
    setSelId(null);
  };

  /* ---------- demand load ---------- */
  const applySketch = () => {
    const wk = sketchToCalls(sketchRaw, peakCalls);
    const c = {};
    for (const d of DAYS) {
      const f = d === "Saturday" ? 0.5 : d === "Sunday" ? 0.45 : 1;
      c[d] = wk.map((v) => Math.round(v * f * 100) / 100);
    }
    setCalls(c); setDemSource("sketched"); setUploadInfo(null);
  };
  const useSample = () => { setCalls(clone(CALL_SAMPLE.calls)); setDemSource("sample"); setUploadInfo(null); };

  const uploadCalls = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
        // Scan every sheet for a raw ACD call-record export first (Call Start/End Time), then fall
        // back to the simple Day/Time/Active-calls template. No names or PII are retained — only the
        // aggregate active-calls curve.
        let result = null;
        for (const sn of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, raw: true });
          result = deriveActiveCalls(rows) || parseSimpleCalls(rows);
          if (result) break;
        }
        if (!result) throw new Error("no usable data");
        setCalls(result.calls); setDemSource("uploaded"); setUploadInfo(result.info);
      } catch (e) {
        alert("Could not read that call-data file. Upload a raw ACD call export (with Call Start Time / Call End Time), or the simple template (Day, Time, Active calls).");
      }
    };
    if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };
  const downloadTemplate = () => {
    const rows = [["Day", "Time", "Active calls"], ["Monday", "08:00", 12], ["Monday", "08:05", 13], ["Monday", "10:15", 34], ["Saturday", "10:00", 17]];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, "Active calls");
    XLSX.writeFile(wb, "call-data-template.xlsx");
  };

  /* ---------- export / project ---------- */
  const exportSchedule = () => {
    const header = ["Shift", "Type", "Days Off", "Days Worked", "Report Time", "Break", "End"];
    const rows = [header];
    const byShift = new Map();
    for (const sg of board) { if (!byShift.has(sg.shift)) byShift.set(sg.shift, []); byShift.get(sg.shift).push(sg); }
    for (const sh of [...byShift.keys()].sort((a, b) => a - b)) {
      const segs = byShift.get(sh).sort((a, b) => DAYS.indexOf(a.days[0]) - DAYS.indexOf(b.days[0]));
      segs.forEach((sg, idx) => rows.push([
        sg.shift, idx === 0 ? sg.type : "", idx === 0 ? sg.daysOff : "",
        " " + sg.days.map((d) => DOW[d]).join(" ") + " ",
        fmt(sg.s), sg.b ? `${fmt(sg.b[0])}–${fmt(sg.b[1])}` : "", fmt(sg.e),
      ]));
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 22 }, { wch: 11 }, { wch: 13 }, { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Agent Schedule");
    XLSX.writeFile(wb, "agent-schedule.xlsx");
  };
  const saveProject = () => {
    const blob = new Blob([JSON.stringify({ kind: "callcentre", board, rules, glob, spans, calls, demSource, typeColors }, null, 0)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "callcentre-project.json"; a.click();
  };
  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (!p || !Array.isArray(p.board)) throw new Error("bad");
        setBoard(p.board.map(cloneSeg));
        if (p.rules) setRules(p.rules);
        if (p.glob) setGlob(p.glob);
        if (p.spans) setSpans(p.spans);
        if (p.calls) { setCalls(p.calls); setDemSource(p.demSource || "uploaded"); }
        if (p.typeColors) setTypeColors(p.typeColors);
        setHist([]); setFuture([]); setSelId(null); setBuildResult(null);
      } catch (e) { alert("Could not read that Call Centre project file."); }
    };
    rd.readAsText(file);
  };

  /* ---------- shift editing ---------- */
  const selSeg = selId != null ? board.find((s) => s.id === selId) : null;
  const selIssues = selSeg ? validateSeg(selSeg, rules, glob) : [];
  const patchSel = (patch) => commit((b) => b.map((s) => (s.id === selId ? { ...cloneSeg(s), ...patch } : s)));
  const addShift = () => {
    const t = Object.keys(rules)[0];
    const R = rules[t];
    const s = Math.round(R.s[0] / 5) * 5, work = R.work, e = s + (R.brk ? work + 30 : work);
    const seg = { id: nextId.current++, shift: (glob.shiftSeriesBase || 7000) + board.length, run: "N" + (board.length + 1), type: t, daysOff: "SU-SA", splitType: R.brk ? "Split Break" : "Straight", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], s, e, b: R.brk ? [s + 240, s + 270] : null };
    commit((b) => [...b, seg]); setSelId(seg.id);
  };
  const dupSel = () => { if (!selSeg) return; const c = { ...cloneSeg(selSeg), id: nextId.current++ }; commit((b) => [...b, c]); setSelId(c.id); };
  const removeSel = () => { if (!selSeg) return; commit((b) => b.filter((s) => s.id !== selId)); setSelId(null); };
  const fixSel = () => { if (!selSeg) return; const f = autofixSeg(selSeg, rules, glob); if (f) commit((b) => b.map((s) => (s.id === selId ? f : s))); };
  const toggleDay = (d) => {
    if (!selSeg) return;
    const has = selSeg.days.includes(d);
    if (has && selSeg.days.length === 1) return;
    const days = has ? selSeg.days.filter((x) => x !== d) : [...selSeg.days, d].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    patchSel({ days, daysOff: DAYS.filter((x) => !days.includes(x)).map((x) => DOW[x]).join("-") });
  };
  const toggleBreak = () => { if (!selSeg) return; patchSel({ b: selSeg.b ? null : [selSeg.s + 240, selSeg.s + 270], splitType: selSeg.b ? "Straight" : "Split Break" }); };

  const pct = (m) => ((Math.min(m, T1) - T0) / (T1 - T0)) * 100;

  /* ---------- rules editing ---------- */
  const setRule = (t, field, idx, val) => setRules((rs) => {
    const R = { ...rs[t] };
    if (Array.isArray(R[field])) { const a = [...R[field]]; a[idx] = val; R[field] = a; }
    else R[field] = val;
    return { ...rs, [t]: R };
  });

  const weekPct = (eng.weekScore * 100).toFixed(1);

  return (
    <div style={{ minHeight: "100vh", background: paper, color: ink, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .ccnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:#5B6B75; }
        .ccnav.on { color:${ink}; border-bottom-color:${supplyTeal}; }
        .ccrow { display:flex; align-items:center; height:30px; border-bottom:1px solid #F0F4F5; cursor:pointer; }
        .ccrow:hover { background:#F7FAFA; }
        input[type=text], input[type=number] { background:#fff; color:${ink}; }
        table.rt th { font-size:11px; color:#5B6B75; text-align:left; font-weight:600; padding:4px 8px; }
        table.rt td { padding:3px 8px; }
      `}</style>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 20px 60px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 0 10px", borderBottom: `3px solid ${ink}`, flexWrap: "wrap" }}>
          <div onClick={onHome} style={{ cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: ".1em", color: sampleGray }}>‹ TRANSIT OPERATIONS TOOLKIT</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>CALL CENTRE STAFFING</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>Weekly coverage <b style={{ color: ink, fontSize: 15 }}>{weekPct}%</b></div>
            <button style={primaryBtn} onClick={exportSchedule}>Export Schedule</button>
            <button style={nudgeBtn} onClick={saveProject}>Save project</button>
            <button style={nudgeBtn} onClick={() => fileRef.current && fileRef.current.click()}>Load project</button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>

        {/* nav */}
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8EA", marginBottom: 16, flexWrap: "wrap" }}>
          {NAV.map((n) => (
            <div key={n.key} className={"ccnav" + (tab === n.key ? " on" : "")} onClick={() => setTab(n.key)}>{n.label}</div>
          ))}
        </div>

        {/* day paddles (shared by demand/coverage/schedule) */}
        {tab !== "rules" && tab !== "build" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 14 }}>
            {DAYS.map((d) => {
              const p = eng.perDay[d];
              const on = d === day;
              return (
                <div key={d} onClick={() => setDay(d)} style={{ cursor: "pointer", textAlign: "center", padding: "6px 4px", background: on ? ink : card, color: on ? "#fff" : ink, border: "1px solid #E2E8EA" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 13 }}>{d.slice(0, 3).toUpperCase()}</div>
                  <div style={{ fontSize: 10, opacity: .8 }}>cov {(p.dayScore * 100).toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "rules" && <RulesTab {...{ rules, setRule, glob, setGlob, spans, setSpans, tColor }} />}
        {tab === "demand" && <DemandTab {...{ day, calls, demSource, uploadInfo, sketchRaw, setSketchRaw, peakCalls, setPeakCalls, applySketch, useSample, uploadCalls, downloadTemplate, P }} />}
        {tab === "build" && <BuildTab {...{ nAgents, setNAgents, generate, buildResult, distinctShifts, flagCount, tColor }} />}
        {tab === "coverage" && (
          <div>
            {P.floorViol.length > 0 && (
              <div style={{ background: "#FBEDEB", border: `1px solid ${gapRed}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
                <b>Minimum agents ({day}):</b>{" "}
                {P.floorViol.map((v, i) => (
                  <span key={i}>{fmt(SLOT(v.from))}–{fmt(SLOT(v.to) + 5)} drops to {v.min} (floor {glob.minVeh}){i < P.floorViol.length - 1 ? "; " : ""}</span>
                ))}
                <span> — fewer agents scheduled than the floor while the line is open.</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <Stat label={`${day} coverage`} value={`${(P.dayScore * 100).toFixed(1)}%`} tone={supplyTeal} />
              <Stat label="Week coverage" value={`${weekPct}%`} tone={targetInk} />
              <Stat label="Agents on (peak)" value={P.peakSup} tone={supplyTeal} />
              <Stat label="Designed shifts" value={distinctShifts} />
              <Stat label="Rule flags" value={flagCount} tone={flagCount ? gapRed : supplyTeal} />
            </div>
            <div style={cardStyle}>
              <div style={hTitle}>Agents vs active calls — {day}</div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={0} showBookout={false} showProductivity={false} demandShare={100} />
              <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
                Teal = agents on shift; shaded target = the demand-aligned agent shape (scale-free coverage of active calls). Amber floor line = minimum agents.
              </div>
            </div>
          </div>
        )}
        {tab === "schedule" && (
          <ScheduleTab {...{ board, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak, rules, glob, tColor, pct, undo, redo, hist, future }} />
        )}
      </div>
    </div>
  );
}

/* ================= RULES ================= */
function RulesTab({ rules, setRule, glob, setGlob, spans, setSpans, tColor }) {
  const setG = (k, v) => setGlob((g) => ({ ...g, [k]: v }));
  const setGArr = (k, i, v) => setGlob((g) => ({ ...g, [k]: g[k].map((x, j) => (j === i ? v : x)) }));
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Shift types</div>
        <div style={{ overflowX: "auto" }}>
          <table className="rt" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th>Type</th><th>Earliest start</th><th>Latest start</th><th>Earliest end</th><th>Latest end</th><th>Work (h)</th><th>Break allowed</th>
            </tr></thead>
            <tbody>
              {Object.entries(rules).map(([t, R]) => (
                <tr key={t} style={{ borderTop: "1px solid #EEF2F3" }}>
                  <td><span style={{ display: "inline-block", width: 10, height: 10, background: tColor(t), marginRight: 6, borderRadius: 2 }} />{t}</td>
                  <td><TimeField value={R.s[0]} onCommit={(v) => setRule(t, "s", 0, v)} /></td>
                  <td><TimeField value={R.s[1]} onCommit={(v) => setRule(t, "s", 1, v)} /></td>
                  <td><TimeField value={R.e[0]} onCommit={(v) => setRule(t, "e", 0, v)} /></td>
                  <td><TimeField value={R.e[1]} onCommit={(v) => setRule(t, "e", 1, v)} /></td>
                  <td><NumField value={Math.round(R.work / 60 * 10) / 10} onCommit={(v) => setRule(t, "work", 0, Math.round(v * 60))} width={48} /></td>
                  <td><input type="checkbox" checked={!!R.brk} onChange={(e) => setRule(t, "brk", 0, e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Full Time = 8h, Part Time = 4h by default. Times are editable; the generator and coverage score follow these windows.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
        <div style={cardStyle}>
          <div style={hTitle}>Break rules</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "8px 10px", alignItems: "center", fontSize: 13 }}>
            <span>Min break length (min)</span><NumField value={glob.brkLen[0]} step={5} onCommit={(v) => setGArr("brkLen", 0, Math.max(0, Math.round(v)))} />
            <span>Max break length (min)</span><NumField value={glob.brkLen[1]} step={5} onCommit={(v) => setGArr("brkLen", 1, Math.max(0, Math.round(v)))} />
            <span>Earliest break: after (min)</span><NumField value={glob.brkAfter[0]} step={15} onCommit={(v) => setGArr("brkAfter", 0, Math.max(0, Math.round(v)))} />
            <span>Latest break: after (min)</span><NumField value={glob.brkAfter[1]} step={15} onCommit={(v) => setGArr("brkAfter", 1, Math.max(0, Math.round(v)))} />
          </div>
        </div>

        <div style={cardStyle}>
          <div style={hTitle}>Staffing limits</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "8px 10px", alignItems: "center", fontSize: 13 }}>
            <span>Minimum agents on (floor)</span><NumField value={glob.minVeh} onCommit={(v) => setG("minVeh", Math.max(0, Math.round(v)))} />
            <span>Max consecutive days</span><NumField value={glob.maxConsec} onCommit={(v) => setG("maxConsec", Math.max(1, Math.round(v)))} />
            <span>Min rest between shifts (h)</span><NumField value={Math.round(glob.minRest / 60 * 10) / 10} onCommit={(v) => setG("minRest", Math.max(0, Math.round(v * 60)))} />
            <span>Max start variance (min)</span><NumField value={glob.maxStartVarWeekday} step={15} onCommit={(v) => { const n = Math.max(0, Math.round(v)); setGlob((g) => ({ ...g, maxStartVarWeekday: n, maxStartVarWeekend: Math.max(n, g.maxStartVarWeekend), maxStartVarCross: Math.max(n, g.maxStartVarCross) })); }} />
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>The floor is flagged when agents on shift drop below it while the line is open.</div>
        </div>

        <div style={cardStyle}>
          <div style={hTitle}>Hours of operation</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", gap: "6px 8px", alignItems: "center", fontSize: 13 }}>
            {DAYS.map((d) => (
              <React.Fragment key={d}>
                <span style={{ width: 80 }}>{d}</span>
                <TimeField value={spans[d][0]} onCommit={(v) => setSpans((s) => ({ ...s, [d]: [v, s[d][1]] }))} />
                <TimeField value={spans[d][1]} onCommit={(v) => setSpans((s) => ({ ...s, [d]: [s[d][0], v] }))} />
              </React.Fragment>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Shifts never start before open or end after close; the minimum-agents floor applies inside these hours.</div>
        </div>
      </div>
    </div>
  );
}

/* ================= DEMAND ================= */
function DemandTab({ day, calls, demSource, uploadInfo, sketchRaw, setSketchRaw, peakCalls, setPeakCalls, applySketch, useSample, uploadCalls, downloadTemplate, P }) {
  const upRef = useRef(null);
  const srcLabel = { sample: "Sample data", sketched: "Sketched", uploaded: "Uploaded call data" }[demSource] || demSource;
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={hTitle}>Active calls — {day}</div>
          <span style={{ fontSize: 11, padding: "2px 8px", background: "#EEF4F5", border: "1px solid #D7E1E4", color: sampleGray }}>{srcLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button style={nudgeBtn} onClick={useSample}>Use sample</button>
            <button style={nudgeBtn} onClick={downloadTemplate}>Download template</button>
            <button style={nudgeBtn} onClick={() => upRef.current && upRef.current.click()}>Upload call data</button>
            <input ref={upRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadCalls(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>
        {uploadInfo && (
          <div style={{ background: "#EEF4F5", border: "1px solid #CFE0E2", padding: "7px 11px", marginBottom: 8, fontSize: 12, color: "#2C4A4A" }}>{uploadInfo}</div>
        )}
        <ActualCurve ev={calls[day]} label={`Active calls (queue + talking) — ${day}`} />
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
          Upload accepts a raw ACD call export (one row per call with Call Start Time / Call End Time) — it derives concurrent active calls per interval, inbound only, averaged into a typical week — or the simple Day / Time / Active calls template.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Sketch a call shape</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 8 }}>Draw the relative shape of a weekday; it scales so the busiest interval equals your peak. Saturday/Sunday are scaled down automatically.</div>
        <Sketcher raw={sketchRaw} setRaw={setSketchRaw} trips={peakCalls} />
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
          <span style={{ fontSize: 13 }}>Peak active calls</span>
          <NumField value={peakCalls} onCommit={(v) => setPeakCalls(Math.max(1, Math.round(v)))} />
          <button style={primaryBtn} onClick={applySketch}>Apply sketch to all days</button>
        </div>
      </div>
    </div>
  );
}

/* ================= BUILD ================= */
function BuildTab({ nAgents, setNAgents, generate, buildResult, distinctShifts, flagCount, tColor }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Generate an agent schedule</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
          Greedily builds weekly packages (5 days on, 2 off) from your shift types, placing each shift where it most improves coverage of the active-calls curve. The result lands as a fully editable schedule.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Number of agents (weekly packages)</span>
          <NumField value={nAgents} onCommit={(v) => setNAgents(Math.max(1, Math.round(v)))} />
          <button style={primaryBtn} onClick={generate}>Generate schedule</button>
        </div>
      </div>
      {buildResult && (
        <div style={cardStyle}>
          <div style={hTitle}>Generated</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <Stat label="Packages" value={buildResult.packages} tone={supplyTeal} />
            <Stat label="Weekly paid hours" value={Math.round(buildResult.paidHours)} />
            <Stat label="Candidates evaluated" value={buildResult.evaluated} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(buildResult.mix).map(([t, n]) => (
              <span key={t} style={{ fontSize: 12, padding: "3px 9px", background: "#fff", border: `1px solid ${tColor(t)}`, color: tColor(t), borderRadius: 2 }}>{t}: {n}</span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Open the SCHEDULE tab to edit, or COVERAGE to see the fit. Generating again replaces the current schedule (undo available in SCHEDULE).</div>
        </div>
      )}
    </div>
  );
}

/* ================= SCHEDULE ================= */
function ScheduleTab({ board, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak, rules, glob, tColor, pct, undo, redo, hist, future }) {
  const rows = [...board].sort((a, b) => a.shift - b.shift);
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button style={nudgeBtn} onClick={addShift}>+ Add shift</button>
        <button style={nudgeBtn} onClick={undo} disabled={!hist.length}>Undo</button>
        <button style={nudgeBtn} onClick={redo} disabled={!future.length}>Redo</button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: sampleGray, alignSelf: "center" }}>{board.length} shift rows</span>
      </div>

      {selSeg && (
        <div style={{ ...cardStyle, border: `1px solid ${selIssues.length ? gapRed : "#E2E8EA"}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700 }}>Shift {selSeg.shift}</div>
            <select value={selSeg.type} onChange={(e) => patchSel({ type: e.target.value })}>
              {Object.keys(rules).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button style={nudgeBtn} onClick={dupSel}>Duplicate</button>
              <button style={nudgeBtn} onClick={toggleBreak}>{selSeg.b ? "Remove break" : "Add break"}</button>
              {selIssues.length > 0 && <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixSel}>Fix violations</button>}
              <button style={{ ...nudgeBtn, borderColor: gapRed, color: gapRed }} onClick={removeSel}>Remove</button>
              <button style={nudgeBtn} onClick={() => setSelId(null)}>Close</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
            <Nudge label="Start" value={fmt(selSeg.s)} onDec={() => patchSel({ s: selSeg.s - 5 })} onInc={() => patchSel({ s: selSeg.s + 5 })} />
            <Nudge label="End" value={fmt(selSeg.e)} onDec={() => patchSel({ e: selSeg.e - 5 })} onInc={() => patchSel({ e: selSeg.e + 5 })} />
            {selSeg.b && (
              <>
                <Nudge label="Break start" value={fmt(selSeg.b[0])} onDec={() => patchSel({ b: [selSeg.b[0] - 5, selSeg.b[1] - 5] })} onInc={() => patchSel({ b: [selSeg.b[0] + 5, selSeg.b[1] + 5] })} />
                <Nudge label="Break len" value={`${selSeg.b[1] - selSeg.b[0]}m`} onDec={() => patchSel({ b: [selSeg.b[0], selSeg.b[1] - 5] })} onInc={() => patchSel({ b: [selSeg.b[0], selSeg.b[1] + 5] })} />
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 12, flexWrap: "wrap" }}>
            {DAYS.map((d) => {
              const on = selSeg.days.includes(d);
              return <button key={d} onClick={() => toggleDay(d)} style={{ ...nudgeBtn, background: on ? supplyTeal : "#fff", color: on ? "#fff" : "#B9C6CC", borderColor: on ? supplyTeal : "#CBD5DA" }}>{d.slice(0, 3)}</button>;
            })}
          </div>
          {selIssues.length > 0 && (
            <div style={{ marginTop: 10, borderLeft: `3px solid ${gapRed}`, background: "#FDF6F5", padding: "6px 10px" }}>
              {selIssues.map((iss, i) => <div key={i} style={{ fontSize: 12.5, color: gapRed }}>⚠ {iss}</div>)}
            </div>
          )}
        </div>
      )}

      <div style={{ ...cardStyle, padding: "10px 12px" }}>
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          {rows.map((sg) => {
            const bad = validateSeg(sg, rules, glob).length > 0;
            const isSel = sg.id === selId;
            const covers = sg.days.includes(day);
            return (
              <div key={sg.id} className="ccrow" onClick={() => setSelId(sg.id)}
                style={{ opacity: covers ? 1 : 0.45, outline: isSel ? `2px solid ${ink}` : "none" }}>
                <div style={{ width: 108, fontSize: 12, fontWeight: isSel ? 700 : 500, color: bad ? gapRed : ink, paddingLeft: 4 }}>
                  {sg.shift} · {sg.type}
                </div>
                <div style={{ position: "relative", flex: 1, height: 18, background: "#F4F7F8", borderRadius: 2 }}>
                  {[360, 600, 840, 1080, 1320].map((m) => <div key={m} style={{ position: "absolute", left: `${pct(m)}%`, top: 0, bottom: 0, width: 1, background: "#E2E8EA" }} />)}
                  <div style={{ position: "absolute", top: 2, bottom: 2, left: `${pct(sg.s)}%`, width: `${pct(sg.e) - pct(sg.s)}%`, background: tColor(sg.type), borderRadius: 2, outline: bad ? `2px solid ${gapRed}` : "none" }} />
                  {sg.b && <div style={{ position: "absolute", top: 2, bottom: 2, left: `${pct(sg.b[0])}%`, width: `${pct(sg.b[1]) - pct(sg.b[0])}%`, background: "#fff", opacity: 0.7 }} />}
                </div>
                <div style={{ width: 96, fontSize: 11, color: sampleGray, textAlign: "right", paddingRight: 6, fontVariantNumeric: "tabular-nums" }}>{fmt(sg.s)}–{fmt(sg.e)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
