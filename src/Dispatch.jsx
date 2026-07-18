import React, { useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  T0, T1, N, SLOT, DAYS, fmt, parseHM, cloneSeg,
  buildSupply, computeEngine, generateBoard, validateSeg, autofixSeg,
  TimeField, NumField, Nudge, Stat, CoverageChart, Sketcher,
} from "./App.jsx";
import { DISPATCH_SAMPLE } from "./dispatchSampleData.js";

/* Dispatch Desks — a third sibling of the operator workbench, reusing the shared coverage engine
   (imported above) exactly as Call Centre Staffing does. The one thing that's genuinely different
   here is what demand *means*: it's a concurrency curve of operators/vehicles working the road,
   not trips and not calls — dispatch-desk load tracks concurrent field activity. Sizing is a
   simple operators-per-dispatcher ratio (glob.ratioPerDispatcher/minOnDuty), not a call-queue
   model — a control room isn't a queueing problem the way a call centre is, so there's no Erlang
   math here. FT/PT dispatcher shifts reuse the Signup Workbench's ptRules/ptEnabled/ptCount
   machinery verbatim (generateBoard's `ptRules`/`ptCount` params, fully parameterized, no shared
   state with the operator tool's own PT sample board). `includePT` is always passed `false` to
   computeEngine/generateBoard — that flag internally reads App.jsx's own hardcoded RAW.pt sample
   data, which must never leak into this module. */

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
function sketchToOperators(raw, peak) {
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

// Simple Day / Time / Operators working template → per-slot curve (one value per interval).
function parseSimpleOperators(rows) {
  if (!rows || !rows.length) return null;
  const H = rows[0];
  const di = hdrIndex(H, "Day", "Weekday");
  const ti = H.map((h) => String(h || "").toLowerCase()).findIndex((h) => h.startsWith("time") || h.startsWith("interval"));
  const ai = H.map((h) => String(h || "").toLowerCase()).findIndex((h) => h.includes("operator"));
  if (di < 0 || ti < 0 || ai < 0) return null;
  const dayKey = {}; for (const d of DAYS) { dayKey[d.toLowerCase()] = d; dayKey[d.slice(0, 3).toLowerCase()] = d; }
  const operators = {}; for (const d of DAYS) operators[d] = new Array(N).fill(0);
  let used = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const d = dayKey[String(row[di] || "").trim().toLowerCase()];
    let raw = row[ti];
    const t = typeof raw === "number" && raw < 1 ? Math.round(raw * 1440) : parseHM(String(raw || "").trim());
    const v = Number(row[ai]);
    if (!d || t == null || !Number.isFinite(v)) continue;
    const i = Math.round((t - T0) / 5);
    if (i >= 0 && i < N) { operators[d][i] = v; used++; }
  }
  return used ? { operators, info: `Loaded ${used.toLocaleString()} interval values from the template.` } : null;
}

// Required dispatchers at a given operators-working level: a capacity ratio, not a queueing model
// — one dispatcher competently covers up to `ratio` concurrent operators, with a minimum floor.
function requiredDispatchers(ops, ratio, minOnDuty) {
  if (!(ratio > 0)) return minOnDuty;
  return Math.max(minOnDuty, Math.ceil(ops / ratio));
}

const NAV = [
  { key: "rules", label: "RULES" },
  { key: "demand", label: "DEMAND" },
  { key: "build", label: "BUILD" },
  { key: "coverage", label: "COVERAGE" },
  { key: "schedule", label: "SCHEDULE" },
];

export default function Dispatch({ onHome }) {
  const [board, setBoard] = useState(() => DISPATCH_SAMPLE.board.map(cloneSeg));
  const [rules, setRules] = useState(() => clone(DISPATCH_SAMPLE.rules));
  const [ptRules, setPtRules] = useState(() => clone(DISPATCH_SAMPLE.ptRules));
  const [ptEnabled, setPtEnabled] = useState(() => !!DISPATCH_SAMPLE.ptEnabled);
  const [ptCount, setPtCount] = useState(() => DISPATCH_SAMPLE.ptCount || 0);
  const [newPtType, setNewPtType] = useState("");
  const [glob, setGlob] = useState(() => clone(DISPATCH_SAMPLE.glob));
  const [spans, setSpans] = useState(() => clone(DISPATCH_SAMPLE.spans));
  const [operators, setOperators] = useState(() => clone(DISPATCH_SAMPLE.operators));
  const [demSource, setDemSource] = useState("sample");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [typeColors, setTypeColors] = useState(() => ({ ...DISPATCH_SAMPLE.typeColors }));
  const [tab, setTab] = useState("coverage");
  const [day, setDay] = useState("Monday");
  const [selId, setSelId] = useState(null);
  const [nDispatchers, setNDispatchers] = useState(10);
  const [buildResult, setBuildResult] = useState(null);
  const [sketchRaw, setSketchRaw] = useState(() => [...DEFAULT_SKETCH]);
  const [peakOps, setPeakOps] = useState(30);
  const [hist, setHist] = useState([]);
  const [future, setFuture] = useState([]);
  const fileRef = useRef(null);

  const nextId = useRef(Math.max(0, ...DISPATCH_SAMPLE.board.map((s) => s.id || 0)) + 1);
  const allRules = useMemo(() => ({ ...rules, ...ptRules }), [rules, ptRules]);
  const tColor = (t) => typeColors[t] || DEFAULT_TCOLOR;

  const DEM = operators;
  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(
    () => computeEngine(DEM, ftCov, false, glob.minVeh, spans, 0, 0, 0, 0, 0, glob),
    [DEM, ftCov, glob, spans]
  );
  const P = eng.perDay[day];

  // Required-dispatchers reference curve for the selected day, from the operators-working level.
  const reqCurve = useMemo(
    () => (operators[day] || []).map((v) => requiredDispatchers(v, glob.ratioPerDispatcher, glob.minOnDuty)),
    [operators, day, glob.ratioPerDispatcher, glob.minOnDuty]
  );
  const peakReq = reqCurve.length ? Math.max(...reqCurve) : 0;

  const distinctShifts = new Set(board.map((s) => s.shift)).size;
  const flagCount = board.reduce((n, s) => n + (validateSeg(s, allRules, glob).length ? 1 : 0), 0);

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
    const r = generateBoard(0, Math.max(1, Math.round(nDispatchers)), rules, glob, DEM, spans,
      glob.minVeh, false, null, glob.shiftSeriesBase, {}, ptEnabled ? ptRules : {}, ptEnabled ? ptCount : 0);
    const segs = r.segs.map((s) => ({ ...cloneSeg(s), id: nextId.current++ }));
    setHist((h) => [...h.slice(-40), board]); setFuture([]);
    setBoard(segs);
    setBuildResult({ packages: r.packages, mix: r.mix, paidHours: r.paidHours, evaluated: r.evaluated });
    setSelId(null);
  };

  /* ---------- demand load ---------- */
  const applySketch = () => {
    const wk = sketchToOperators(sketchRaw, peakOps);
    const o = {};
    for (const d of DAYS) {
      const f = d === "Saturday" ? 0.5 : d === "Sunday" ? 0.45 : 1;
      o[d] = wk.map((v) => Math.round(v * f * 100) / 100);
    }
    setOperators(o); setDemSource("sketched"); setUploadInfo(null);
  };
  const useSample = () => { setOperators(clone(DISPATCH_SAMPLE.operators)); setDemSource("sample"); setUploadInfo(null); };

  const uploadOperators = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
        let result = null;
        for (const sn of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, raw: true });
          result = parseSimpleOperators(rows);
          if (result) break;
        }
        if (!result) throw new Error("no usable data");
        setOperators(result.operators); setDemSource("uploaded"); setUploadInfo(result.info);
      } catch (e) {
        alert("Could not read that operator-data file. Upload the Day / Time / Operators working template.");
      }
    };
    if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };
  const downloadTemplate = () => {
    const rows = [["Day", "Time", "Operators working"], ["Monday", "08:00", 18], ["Monday", "08:05", 20], ["Monday", "16:15", 24], ["Saturday", "10:00", 9]];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, "Operators working");
    XLSX.writeFile(wb, "operators-working-template.xlsx");
  };
  // Derive the operators-working curve directly from a real signed Resourcing (Signup Workbench)
  // board — the literal vehicle-in-service curve becomes Dispatch's demand input. Flag-never-block:
  // a bad file shows an alert, never crashes, and never partially mutates state.
  const uploadSignupBoard = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (!p || !Array.isArray(p.board) || !p.board.length) throw new Error("bad");
        const ops = buildSupply(p.board.map(cloneSeg));
        setOperators(ops); setDemSource("derived");
        setUploadInfo(`Derived operators-working curve from ${p.board.length} segments in the uploaded Resourcing project.`);
      } catch (e) {
        alert("Could not read that as a Resourcing project file — expected a project JSON with a board array of shift segments (Save project from the Resourcing module).");
      }
    };
    rd.readAsText(file);
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
    XLSX.utils.book_append_sheet(wb, ws, "Dispatcher Schedule");
    XLSX.writeFile(wb, "dispatcher-schedule.xlsx");
  };
  const saveProject = () => {
    const blob = new Blob([JSON.stringify({ kind: "dispatch", board, rules, ptRules, ptEnabled, ptCount, glob, spans, operators, demSource, typeColors }, null, 0)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "dispatch-project.json"; a.click();
  };
  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (!p || !Array.isArray(p.board)) throw new Error("bad");
        setBoard(p.board.map(cloneSeg));
        if (p.rules) setRules(p.rules);
        if (p.ptRules) setPtRules(p.ptRules);
        setPtEnabled(!!p.ptEnabled);
        setPtCount(p.ptCount || 0);
        if (p.glob) setGlob({ ...DISPATCH_SAMPLE.glob, ...p.glob });
        if (p.spans) setSpans(p.spans);
        if (p.operators) { setOperators(p.operators); setDemSource(p.demSource || "uploaded"); }
        if (p.typeColors) setTypeColors(p.typeColors);
        setHist([]); setFuture([]); setSelId(null); setBuildResult(null);
      } catch (e) { alert("Could not read that Dispatch project file."); }
    };
    rd.readAsText(file);
  };

  /* ---------- shift editing ---------- */
  const selSeg = selId != null ? board.find((s) => s.id === selId) : null;
  const selIssues = selSeg ? validateSeg(selSeg, allRules, glob) : [];
  const patchSel = (patch) => commit((b) => b.map((s) => (s.id === selId ? { ...cloneSeg(s), ...patch } : s)));
  const addShift = () => {
    const t = Object.keys(rules)[0];
    const R = rules[t];
    const s = Math.round(R.s[0] / 5) * 5, work = R.work, e = s + (R.brk ? work + 30 : work);
    const seg = { id: nextId.current++, shift: (glob.shiftSeriesBase || 9000) + board.length, run: "N" + (board.length + 1), type: t, daysOff: "SU-SA", splitType: R.brk ? "Split Break" : "Straight", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], s, e, b: R.brk ? [s + 240, s + 270] : null };
    commit((b) => [...b, seg]); setSelId(seg.id);
  };
  const dupSel = () => { if (!selSeg) return; const c = { ...cloneSeg(selSeg), id: nextId.current++ }; commit((b) => [...b, c]); setSelId(c.id); };
  const removeSel = () => { if (!selSeg) return; commit((b) => b.filter((s) => s.id !== selId)); setSelId(null); };
  const fixSel = () => { if (!selSeg) return; const f = autofixSeg(selSeg, allRules, glob); if (f) commit((b) => b.map((s) => (s.id === selId ? f : s))); };
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
        .dsnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:#5B6B75; }
        .dsnav.on { color:${ink}; border-bottom-color:${demandAmber}; }
        .dsrow { display:flex; align-items:center; height:30px; border-bottom:1px solid #F0F4F5; cursor:pointer; }
        .dsrow:hover { background:#F7FAFA; }
        input[type=text], input[type=number] { background:#fff; color:${ink}; }
        table.rt th { font-size:11px; color:#5B6B75; text-align:left; font-weight:600; padding:4px 8px; }
        table.rt td { padding:3px 8px; }
      `}</style>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 20px 60px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 0 10px", borderBottom: `3px solid ${ink}`, flexWrap: "wrap" }}>
          <div onClick={onHome} style={{ cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: ".1em", color: sampleGray }}>‹ TRANSIT OPERATIONS TOOLKIT</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>DISPATCH DESKS</div>
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
            <div key={n.key} className={"dsnav" + (tab === n.key ? " on" : "")} onClick={() => setTab(n.key)}>{n.label}</div>
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

        {tab === "rules" && (
          <RulesTab {...{
            rules, setRule, glob, setGlob, spans, setSpans, tColor,
            ptRules, setPtRules, ptEnabled, setPtEnabled, newPtType, setNewPtType, allRules, board,
          }} />
        )}
        {tab === "demand" && <DemandTab {...{ day, operators, demSource, uploadInfo, sketchRaw, setSketchRaw, peakOps, setPeakOps, applySketch, useSample, uploadOperators, uploadSignupBoard, downloadTemplate, P }} />}
        {tab === "build" && <BuildTab {...{ nDispatchers, setNDispatchers, generate, buildResult, distinctShifts, flagCount, tColor, ptEnabled }} />}
        {tab === "coverage" && (
          <div>
            {P.floorViol.length > 0 && (
              <div style={{ background: "var(--tint-red-a, #FBEDEB)", border: `1px solid ${gapRed}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
                <b>Minimum dispatchers ({day}):</b>{" "}
                {P.floorViol.map((v, i) => (
                  <span key={i}>{fmt(SLOT(v.from))}–{fmt(SLOT(v.to) + 5)} drops to {v.min} (floor {glob.minVeh}){i < P.floorViol.length - 1 ? "; " : ""}</span>
                ))}
                <span> — fewer dispatchers scheduled than the floor while the desk is open.</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <Stat label={`${day} coverage`} value={`${(P.dayScore * 100).toFixed(1)}%`} tone={supplyTeal} />
              <Stat label="Week coverage" value={`${weekPct}%`} tone={targetInk} />
              <Stat label="Operators working (peak)" value={Math.round(Math.max(...(operators[day] || [0])))} tone={demandAmber} />
              <Stat label="Dispatchers required (peak)" value={peakReq} tone="#B0455E" sub={`1 per ${glob.ratioPerDispatcher} operators`} />
              <Stat label="Rule flags" value={flagCount} tone={flagCount ? gapRed : supplyTeal} />
            </div>
            <div style={cardStyle}>
              <div style={hTitle}>Dispatchers vs operators working — {day}</div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={0} showBookout={false} showProductivity={false} demandShare={100}
                supplyName="Dispatchers on shift" targetName="Demand-aligned staffing" unitLabel="operators working" minName="floor" sugTooltip={false}
                extraSeries={peakReq > 0 ? [{ key: "req", name: "Dispatchers required (ratio)", color: "#B0455E", values: reqCurve, dash: "5 3" }] : null} />
              <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
                Teal = dispatchers on shift; shaded target = the demand-aligned dispatcher shape (scale-free coverage of concurrent operators working). Amber floor line = minimum dispatchers. Dashed red = dispatchers a simple capacity ratio needs (1 per {glob.ratioPerDispatcher} concurrent operators, floor {glob.minOnDuty}) — an absolute headcount check the scale-free coverage can't give.
              </div>
            </div>
          </div>
        )}
        {tab === "schedule" && (
          <ScheduleTab {...{ board, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak, allRules, glob, tColor, pct, undo, redo, hist, future }} />
        )}
      </div>
    </div>
  );
}

/* ================= RULES ================= */
function RulesTab({ rules, setRule, glob, setGlob, spans, setSpans, tColor, ptRules, setPtRules, ptEnabled, setPtEnabled, newPtType, setNewPtType, allRules, board }) {
  const setG = (k, v) => setGlob((g) => ({ ...g, [k]: v }));
  const setGArr = (k, i, v) => setGlob((g) => ({ ...g, [k]: g[k].map((x, j) => (j === i ? v : x)) }));
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Full-time dispatcher shift types</div>
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
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Full time = 8h by default. Times are editable; the generator and coverage score follow these windows.</div>
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
            <span>Minimum dispatchers on (floor)</span><NumField value={glob.minVeh} onCommit={(v) => setG("minVeh", Math.max(0, Math.round(v)))} />
            <span>Max consecutive days</span><NumField value={glob.maxConsec} onCommit={(v) => setG("maxConsec", Math.max(1, Math.round(v)))} />
            <span>Min rest between shifts (h)</span><NumField value={Math.round(glob.minRest / 60 * 10) / 10} onCommit={(v) => setG("minRest", Math.max(0, Math.round(v * 60)))} />
            <span>Max start variance (min)</span><NumField value={glob.maxStartVarWeekday} step={15} onCommit={(v) => { const n = Math.max(0, Math.round(v)); setGlob((g) => ({ ...g, maxStartVarWeekday: n, maxStartVarWeekend: Math.max(n, g.maxStartVarWeekend), maxStartVarCross: Math.max(n, g.maxStartVarCross) })); }} />
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>The floor is flagged when dispatchers on shift drop below it while the desk is open.</div>
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
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Shifts never start before open or end after close; the minimum-dispatchers floor applies inside these hours.</div>
        </div>

        <div style={cardStyle}>
          <div style={hTitle}>Dispatcher sizing ratio</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "8px 10px", alignItems: "center", fontSize: 13 }}>
            <span>Operators per dispatcher</span><NumField value={glob.ratioPerDispatcher ?? 8} step={1} onCommit={(v) => setG("ratioPerDispatcher", Math.max(1, Math.round(v)))} />
            <span>Minimum on duty</span><NumField value={glob.minOnDuty ?? 1} step={1} onCommit={(v) => setG("minOnDuty", Math.max(0, Math.round(v)))} />
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Drives the "dispatchers required" line on Coverage — one dispatcher can competently cover up to this many concurrent operators, with a minimum floor regardless of load.</div>
        </div>
      </div>

      <div style={cardStyle}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={ptEnabled} onChange={(e) => setPtEnabled(e.target.checked)} />
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>Offer part-time dispatcher shifts</span>
        </label>
        {ptEnabled && (
          <>
            <div style={{ fontSize: 11.5, color: sampleGray, margin: "6px 0 10px" }}>
              Part-time classifications use the same start/end/spread/work/break parameters as full-time, plus the days each is available to work. A part-time shift works <b>all</b> of its available days at once — no 40-hour week, no consecutive days-off rule. Set how many to build in the Build tab.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", minWidth: 820 }}>
                <thead>
                  <tr>
                    {["Type", "Earliest start", "Latest start", "Earliest end", "Latest end", "Min spread (h)", "Max spread (h)", "Work (h)", "Break", "Available days", "In use", ""].map((h) => (
                      <th key={h} style={{ padding: "4px 8px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: sampleGray, textAlign: "left", borderBottom: "1px solid #E2E8EA" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(ptRules).map((t) => {
                    const R = ptRules[t];
                    const inUse = board.filter((s) => s.type === t).length;
                    const upd = (patch) => setPtRules((old) => ({ ...old, [t]: { ...old[t], ...patch } }));
                    const days = R.days || [];
                    return (
                      <tr key={t}>
                        <td style={{ padding: "4px 8px" }}>
                          <span style={{ fontSize: 12, padding: "2px 8px", background: tColor(t), color: "#fff", borderRadius: 2, fontWeight: 600 }}>{t}</span>
                        </td>
                        <td style={{ padding: "3px 6px" }}><TimeField value={R.s[0]} onCommit={(v) => upd({ s: [v, R.s[1]] })} /></td>
                        <td style={{ padding: "3px 6px" }}><TimeField value={R.s[1]} onCommit={(v) => upd({ s: [R.s[0], v] })} /></td>
                        <td style={{ padding: "3px 6px" }}><TimeField value={R.e[0]} onCommit={(v) => upd({ e: [v, R.e[1]] })} /></td>
                        <td style={{ padding: "3px 6px" }}><TimeField value={R.e[1]} onCommit={(v) => upd({ e: [R.e[0], v] })} /></td>
                        <td style={{ padding: "3px 6px" }}><NumField value={R.spr[0] / 60} step={0.25} onCommit={(v) => upd({ spr: [Math.round(v * 60), R.spr[1]] })} /></td>
                        <td style={{ padding: "3px 6px" }}><NumField value={R.spr[1] / 60} step={0.25} onCommit={(v) => upd({ spr: [R.spr[0], Math.round(v * 60)] })} /></td>
                        <td style={{ padding: "3px 6px" }}><NumField value={R.work / 60} step={0.25} onCommit={(v) => upd({ work: Math.round(v * 60) })} /></td>
                        <td style={{ padding: "3px 6px", textAlign: "center" }}>
                          <input type="checkbox" checked={!!R.brk} onChange={(e) => upd({ brk: e.target.checked })} />
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <div style={{ display: "flex", gap: 3 }}>
                            {DAYS.map((d) => {
                              const on = days.includes(d);
                              return (
                                <button key={d} title={d}
                                  onClick={() => upd({ days: on ? days.filter((x) => x !== d) : [...days, d] })}
                                  style={{ padding: "2px 5px", fontSize: 10.5, fontWeight: 600, borderRadius: 2, cursor: "pointer",
                                    border: `1px solid ${on ? supplyTeal : "#C7D2D6"}`, background: on ? supplyTeal : "#fff", color: on ? "#fff" : sampleGray }}>
                                  {d.slice(0, 2)}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        <td style={{ padding: "3px 8px", fontSize: 12, color: inUse ? ink : sampleGray }}>{inUse}</td>
                        <td style={{ padding: "3px 6px" }}>
                          <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12, color: gapRed, borderColor: gapRed }}
                            title={inUse > 0 ? `${inUse} shift${inUse === 1 ? "" : "s"} use this type — they'll be flagged until retyped` : "Remove this type"}
                            onClick={() => {
                              if (inUse > 0 && !window.confirm(
                                `${inUse} shift${inUse === 1 ? "" : "s"} still use ${t}. They won't be deleted — they'll be flagged until you retype them or re-add ${t}. Remove the type?`)) return;
                              setPtRules((old) => { const n = { ...old }; delete n[t]; return n; });
                            }}>
                            remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {Object.keys(ptRules).length === 0 && (
                    <tr><td colSpan={12} style={{ padding: "8px", fontSize: 12, color: sampleGray }}>No part-time classifications yet — add one below.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input placeholder="New part-time code (e.g. DSPT-EVE)" value={newPtType}
                onChange={(e) => setNewPtType(e.target.value.toUpperCase().slice(0, 8))}
                style={{ padding: "6px 8px", border: "1px solid #B9C6CC", borderRadius: 2, fontSize: 13, width: 210, background: "#fff", color: ink }} />
              <button style={nudgeBtn} disabled={!newPtType || !!allRules[newPtType]}
                onClick={() => {
                  if (!newPtType || allRules[newPtType]) return;
                  setPtRules((old) => ({ ...old, [newPtType]: { s: [300, 660], e: [840, 1470], spr: [240, 480], work: 240, brk: false, days: [...DAYS] } }));
                  setNewPtType("");
                }}>
                + Add part-time type
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= DEMAND ================= */
function DemandTab({ day, operators, demSource, uploadInfo, sketchRaw, setSketchRaw, peakOps, setPeakOps, applySketch, useSample, uploadOperators, uploadSignupBoard, downloadTemplate, P }) {
  const upRef = useRef(null);
  const boardRef = useRef(null);
  const srcLabel = { sample: "Sample data", sketched: "Sketched", uploaded: "Uploaded operator data", derived: "Derived from a Signup board" }[demSource] || demSource;
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={hTitle}>Operators working — {day}</div>
          <span style={{ fontSize: 11, padding: "2px 8px", background: "#EEF4F5", border: "1px solid #D7E1E4", color: sampleGray }}>{srcLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button style={nudgeBtn} onClick={useSample}>Use sample</button>
            <button style={nudgeBtn} onClick={downloadTemplate}>Download template</button>
            <button style={nudgeBtn} onClick={() => upRef.current && upRef.current.click()}>Upload operator data</button>
            <input ref={upRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadOperators(e.target.files[0]); e.target.value = ""; }} />
            <button style={nudgeBtn} onClick={() => boardRef.current && boardRef.current.click()}>Load from Signup board</button>
            <input ref={boardRef} type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadSignupBoard(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>
        {uploadInfo && (
          <div style={{ background: "#EEF4F5", border: "1px solid #CFE0E2", padding: "7px 11px", marginBottom: 8, fontSize: 12, color: "#2C4A4A" }}>{uploadInfo}</div>
        )}
        <OperatorsCurveChart ev={operators[day]} day={day} />
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
          Three ways in: sketch a shape below, upload the simple Day / Time / Operators working template, or load a Resourcing project file (Save project from the Signup Workbench) to derive the curve directly from a real signed operator board.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Sketch an operators-working shape</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 8 }}>Draw the relative shape of a weekday; it scales so the busiest interval equals your peak. Saturday/Sunday are scaled down automatically.</div>
        <Sketcher raw={sketchRaw} setRaw={setSketchRaw} trips={peakOps} />
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
          <span style={{ fontSize: 13 }}>Peak operators working</span>
          <NumField value={peakOps} onCommit={(v) => setPeakOps(Math.max(1, Math.round(v)))} />
          <button style={primaryBtn} onClick={applySketch}>Apply sketch to all days</button>
        </div>
      </div>
    </div>
  );
}

/* ================= BUILD ================= */
function BuildTab({ nDispatchers, setNDispatchers, generate, buildResult, distinctShifts, flagCount, tColor, ptEnabled }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Generate a dispatcher schedule</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
          Greedily builds weekly packages (5 days on, 2 off) from your shift types, placing each shift where it most improves coverage of the operators-working curve{ptEnabled ? ", filling in part-time shifts alongside full-time" : ""}. The result lands as a fully editable schedule.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Number of full-time dispatchers (weekly packages)</span>
          <NumField value={nDispatchers} onCommit={(v) => setNDispatchers(Math.max(1, Math.round(v)))} />
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
function ScheduleTab({ board, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak, allRules, glob, tColor, pct, undo, redo, hist, future }) {
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
              {Object.keys(allRules).map((t) => <option key={t} value={t}>{t}</option>)}
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
            const bad = validateSeg(sg, allRules, glob).length > 0;
            const isSel = sg.id === selId;
            const covers = sg.days.includes(day);
            return (
              <div key={sg.id} className="dsrow" onClick={() => setSelId(sg.id)}
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

/* Operators-working curve — concurrency per 5-min slot, no trip/call framing. */
function OperatorsCurveChart({ ev, day }) {
  const W = 940, H = 240, PADL = 34, PADB = 22;
  const maxV = Math.max(1, Math.max(...ev) * 1.15);
  const x = (i) => PADL + (i / (N - 1)) * (W - PADL - 8);
  const y = (v) => (H - PADB) - (Math.min(v, maxV) / maxV) * (H - PADB - 8);
  const path = ev.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(N - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const peakI = ev.indexOf(Math.max(...ev));
  const peakLeft = peakI > N * 0.75;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "#FBFCFC", border: "1px solid #E2E8EA", borderRadius: 2 }}>
      {[6, 9, 12, 15, 18, 21, 24].map((h) => {
        const i = Math.round((h * 60 - T0) / 5);
        if (i < 0 || i >= N) return null;
        return (
          <g key={h}>
            <line x1={x(i)} y1={8} x2={x(i)} y2={H - PADB} stroke="#EBF0F2" />
            <text x={x(i)} y={H - 7} fontSize={11} fill="#8899A3" textAnchor="middle">{h}:00</text>
          </g>
        );
      })}
      {[25, 50, 75, 100].map((p) => {
        const v = maxV * p / 100;
        return (
          <g key={p}>
            <line x1={PADL} y1={y(v)} x2={W - 8} y2={y(v)} stroke="#F0F4F5" />
            <text x={PADL - 4} y={y(v) + 3.5} fontSize={10} fill="#8899A3" textAnchor="end">{v >= 20 ? Math.round(v) : v.toFixed(1)}</text>
          </g>
        );
      })}
      <path d={area} fill={demandAmber} fillOpacity={0.14} />
      <path d={path} fill="none" stroke={demandAmber} strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={x(peakI)} cy={y(ev[peakI])} r={5} fill="#C0392B" stroke="#fff" strokeWidth={1.2} />
      <text x={x(peakI) + (peakLeft ? -9 : 9)} y={y(ev[peakI]) - 6} fontSize={11} fontWeight={700} fill="#C0392B" textAnchor={peakLeft ? "end" : "start"}>
        {ev[peakI].toFixed(1)} concurrent
      </text>
      <text x={PADL} y={16} fontSize={11} fill="#5B6B75">Operators working — {day} · concurrent field operators per 5-minute slot</text>
    </svg>
  );
}
