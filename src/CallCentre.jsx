import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  T0, T1, N, SLOT, DAYS, WEEKEND_DAYS, fmt, parseHM, cloneSeg,
  buildSupply, computeEngine, generateBoard, retimeBoard, validateSeg, autofixSeg,
  findSuggestions,
  TimeField, NumField, Nudge, Stat, CoverageChart, Sketcher, DeltaAreaChart,
  CoveragePriorityShapePreview, OffPeakShapePreview, ScheduleStabilityPreview,
  COV_PRIORITY_VALUES, STABILITY_VALUES, useDebouncedValue, COVERAGE_RESOLUTIONS,
} from "./App.jsx";
import { CALL_SAMPLE } from "./callSampleData.js";

/* Call Centre Staffing — a lean sibling of the operator workbench. It reuses the shared coverage
   engine (imported above), scoring agents-on-shift against an Active-calls curve. Vehicle-specific
   knobs are neutralized in glob, so the engine reduces to plain scale-free coverage. */

const ink = "var(--chrome)", text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", demandAmber = "var(--demand-amber)", gapRed = "var(--gap-red)",
  sampleGray = "var(--sample-gray)", targetInk = "var(--target-ink)";
const DEFAULT_TCOLOR = "#4B5D67";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const primaryBtn = { ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal };
const cardStyle = { background: card, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 14 };
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
  const cdur = hdrIndex(H, "Duration");
  const cq = hdrIndex(H, "Call Routed CSQ");
  const acc = {}, arr = {}, dates = {}, cnt = {}, durSum = {};
  for (const d of DAYS) { acc[d] = new Array(N).fill(0); arr[d] = new Array(N).fill(0); dates[d] = new Set(); cnt[d] = 0; durSum[d] = 0; }
  let used = 0, outbound = 0, allDur = 0, acd = 0, nonAcd = 0;
  const qCount = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const s = row[cs], e = row[ce];
    if (typeof s !== "number" || typeof e !== "number") continue;
    const type = ct >= 0 ? String(row[ct] || "") : "inbound";
    if (!/inbound/i.test(type)) { outbound++; continue; }
    const dateSerial = Math.floor(s);
    const d = DAYS[serialToWeekday(s)];
    const startMin = Math.round((s - dateSerial) * 1440);
    let endMin = Math.round((e - dateSerial) * 1440);
    if (endMin <= startMin) endMin = startMin + 1;
    const a = Math.floor((startMin - T0) / 5), z = Math.ceil((endMin - T0) / 5);
    if (z <= 0 || a >= N) continue;
    for (let i = Math.max(0, a); i < Math.min(N, z); i++) acc[d][i]++;
    if (a >= 0 && a < N) arr[d][a]++; // the interval the call STARTED in
    dates[d].add(dateSerial);
    cnt[d]++;
    const durMin = (typeof row[cdur] === "number" ? row[cdur] : (e - s)) * 1440; // Duration is a fraction of a day
    durSum[d] += durMin; allDur += durMin;
    if (/non-acd/i.test(type)) nonAcd++; else acd++;
    if (cq >= 0) { const q = String(row[cq] || "").replace(/^csq\s+/i, "").trim(); if (q) qCount[q] = (qCount[q] || 0) + 1; }
    used++;
  }
  if (used === 0) return null;
  const calls = {}, arrivals = {}, perDay = {};
  let minDates = Infinity, maxDates = 0;
  for (const d of DAYS) {
    const nd = dates[d].size || 1;
    if (dates[d].size) { minDates = Math.min(minDates, nd); maxDates = Math.max(maxDates, nd); }
    calls[d] = acc[d].map((v) => Math.round((v / nd) * 100) / 100);
    arrivals[d] = arr[d].map((v) => Math.round((v / nd) * 100) / 100);
    perDay[d] = { calls: Math.round(cnt[d] / nd), aht: cnt[d] ? Math.round((durSum[d] / cnt[d]) * 100) / 100 : 0 };
  }
  const queues = Object.entries(qCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, calls]) => ({ name, calls }));
  const span = minDates === maxDates ? `${maxDates}` : `${minDates}–${maxDates}`;
  return {
    calls, arrivals,
    summary: { perDay, aht: Math.round((allDur / used) * 100) / 100, composition: { acd, nonAcd }, queues },
    info: `Derived active-call curve from ${used.toLocaleString()} inbound calls (${outbound.toLocaleString()} outbound excluded), averaged over ${span} day(s) per weekday.`,
  };
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

// Erlang C: probability an arriving call waits, given offered load A (Erlangs) and N agents.
function erlangC(A, N) {
  if (N <= A) return 1;
  let B = 1; // Erlang B recursion, then convert to C
  for (let k = 1; k <= N; k++) B = (A * B) / (k + A * B);
  return (N * B) / (N - A * (1 - B));
}
// Fewest agents so that at least targetPct of calls are answered within targetSec, at offered load
// A (≈ concurrent active calls, by Little's law). AHT and the target time share the same unit.
function requiredAgents(A, ahtMin, targetSec, targetPct) {
  if (!(A > 0) || !(ahtMin > 0)) return 0;
  const t = targetSec / 60;
  let N = Math.max(1, Math.ceil(A));
  for (let guard = 0; guard < 500; guard++, N++) {
    const sl = 1 - erlangC(A, N) * Math.exp(-(N - A) * (t / ahtMin));
    if (sl >= targetPct) return N;
  }
  return N;
}

const NAV = [
  { key: "rules", label: "RULES" },
  { key: "demand", label: "DEMAND" },
  { key: "build", label: "BUILD" },
  { key: "coverage", label: "COVERAGE" },
  { key: "schedule", label: "SCHEDULE" },
];

export default function CallCentre({ onHome }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const [board, setBoard] = useState(() => CALL_SAMPLE.board.map(cloneSeg));
  const [rules, setRules] = useState(() => clone(CALL_SAMPLE.rules));
  const [glob, setGlob] = useState(() => clone(CALL_SAMPLE.global));
  const [spans, setSpans] = useState(() => clone(CALL_SAMPLE.spans));
  const [calls, setCalls] = useState(() => clone(CALL_SAMPLE.calls));
  const [demSource, setDemSource] = useState("sample");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [callSummary, setCallSummary] = useState(() => CALL_SAMPLE.summary || null);
  const [arrivals, setArrivals] = useState(() => CALL_SAMPLE.arrivals || null);
  const [showArrivals, setShowArrivals] = useState(false);
  const [typeColors, setTypeColors] = useState(() => ({ ...CALL_SAMPLE.typeColors }));
  const [tab, setTab] = useState("coverage");
  const [day, setDay] = useState("Monday");
  const [selId, setSelId] = useState(null);
  const [nAgents, setNAgents] = useState(24);
  const [buildResult, setBuildResult] = useState(null);
  const [sketchRaw, setSketchRaw] = useState(() => [...DEFAULT_SKETCH]);
  const [peakCalls, setPeakCalls] = useState(13);
  const [hist, setHist] = useState([]);
  const [future, setFuture] = useState([]);
  const [coverageResolution, setCoverageResolution] = useState(5); // minutes per chart bucket
  const fileRef = useRef(null);

  const nextId = useRef(Math.max(0, ...CALL_SAMPLE.board.map((s) => s.id || 0)) + 1);
  const tColor = (t) => typeColors[t] || DEFAULT_TCOLOR;

  const DEM = calls;
  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(
    () => computeEngine(DEM, ftCov, false, glob.minVeh, spans, 0, glob.offPeakBias, glob.coveragePriority, 0, 0, glob),
    [DEM, ftCov, glob, spans]
  );
  const P = eng.perDay[day];

  // Coverage priority / schedule stability live previews (Rules tab) — same precompute-and-
  // lookup pattern as the operator tool: every legal slider position is a real retimeBoard()
  // result, computed once when the Rules tab is open and the other settings have settled, then
  // looked up instantly as the slider moves. See src/App.jsx's "Scheduling algorithm" card for
  // the original build notes.
  const rulesCtxKey = JSON.stringify([glob.offPeakBias, glob.scheduleStability, glob.coveragePriority, glob.minVeh, glob.maxPullout]);
  const debouncedRulesCtxKey = useDebouncedValue(rulesCtxKey, 350);
  const covPreviewCache = useMemo(() => {
    if (tab !== "rules") return null;
    const out = {};
    for (const p of COV_PRIORITY_VALUES) {
      const g = { ...glob, coveragePriority: p };
      const r = retimeBoard(board, rules, g, DEM, spans, g.minVeh, false, { stability: g.scheduleStability });
      out[p] = buildSupply(r.segs);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, board, rules, DEM, spans, debouncedRulesCtxKey]);
  const stabPreviewCache = useMemo(() => {
    if (tab !== "rules") return null;
    const origByShift = new Map(board.map((sg) => [sg.shift, sg.s]));
    const out = {};
    for (const s of STABILITY_VALUES) {
      const g = { ...glob, scheduleStability: s };
      const r = retimeBoard(board, rules, g, DEM, spans, g.minVeh, false, { stability: s });
      const seen = new Set();
      out[s] = r.segs.filter((sg) => origByShift.has(sg.shift) && !seen.has(sg.shift) && seen.add(sg.shift))
        .map((sg) => ({ origS: origByShift.get(sg.shift), moveMin: sg.s - origByShift.get(sg.shift) }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, board, rules, DEM, spans, debouncedRulesCtxKey]);

  // Erlang C agents required for the selected day, from the active-calls (offered-load) curve.
  const reqCurve = useMemo(
    () => (calls[day] || []).map((A) => requiredAgents(A, glob.ahtMin, glob.slTargetSec, (glob.slTargetPct > 1 ? glob.slTargetPct / 100 : glob.slTargetPct))),
    [calls, day, glob.ahtMin, glob.slTargetSec, glob.slTargetPct]
  );
  const peakReq = reqCurve.length ? Math.max(...reqCurve) : 0;

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
    setCalls(c); setDemSource("sketched"); setUploadInfo(null); setCallSummary(null); setArrivals(null);
  };
  const useSample = () => { setCalls(clone(CALL_SAMPLE.calls)); setDemSource("sample"); setUploadInfo(null); setCallSummary(CALL_SAMPLE.summary || null); setArrivals(CALL_SAMPLE.arrivals || null); };

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
        setCalls(result.calls); setDemSource("uploaded"); setUploadInfo(result.info); setCallSummary(result.summary || null); setArrivals(result.arrivals || null);
        if (result.summary && result.summary.aht > 0) setGlob((g) => ({ ...g, ahtMin: result.summary.aht })); // auto-fill handle time for Erlang sizing
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
    const blob = new Blob([JSON.stringify({ kind: "callcentre", board, rules, glob, spans, calls, arrivals, demSource, typeColors, callSummary }, null, 0)], { type: "application/json" });
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
        if (p.glob) setGlob({ ...CALL_SAMPLE.global, ...p.glob });
        if (p.spans) setSpans(p.spans);
        if (p.calls) { setCalls(p.calls); setDemSource(p.demSource || "uploaded"); }
        setCallSummary(p.callSummary || null);
        setArrivals(p.arrivals || null);
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

  /* ---------- Schedule tab: sort + decision support ----------
     Same idea as the operator tool's Shift Builder, simplified: every shift here has one
     time range across all its `days` (no day-variant packages), so there's no "editAllDays"
     concept to port — every drag or suggestion patches the whole shift, matching patchSel's
     existing semantics exactly. */
  const [ganttSort, setGanttSort] = useState("run"); // "run"|"time"|"end"|"type"|"flags"|"improve"
  const flaggedShifts = useMemo(() => {
    const set = new Set();
    for (const sg of board) if (validateSeg(sg, rules, glob).length > 0) set.add(sg.shift);
    return set;
  }, [board, rules, glob]);
  // Best single-move score delta per shift, for "Room to improve first" — only computed
  // when that sort is actually selected, since a full-board findSuggestions pass is
  // heavier than the other sort keys.
  const improveDeltas = useMemo(() => {
    if (ganttSort !== "improve") return null;
    const sugs = findSuggestions(board, eng, DEM, rules, glob, spans, null, null, 80);
    const m = new Map();
    for (const s of sugs) { const prev = m.get(s.shift); if (prev == null || s.delta > prev) m.set(s.shift, s.delta); }
    return m;
  }, [ganttSort, board, eng, DEM, rules, glob, spans]);
  const sortedRows = useMemo(() => {
    const list = [...board];
    if (ganttSort === "time") list.sort((a, b) => (a.s - b.s) || (a.shift - b.shift));
    else if (ganttSort === "end") list.sort((a, b) => (a.e - b.e) || (a.shift - b.shift));
    else if (ganttSort === "type") list.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.s - b.s) || (a.shift - b.shift));
    else if (ganttSort === "flags") list.sort((a, b) =>
      ((flaggedShifts.has(b.shift) ? 1 : 0) - (flaggedShifts.has(a.shift) ? 1 : 0)) || (a.shift - b.shift));
    else if (ganttSort === "improve") list.sort((a, b) =>
      ((improveDeltas && improveDeltas.get(b.shift)) || 0) - ((improveDeltas && improveDeltas.get(a.shift)) || 0) || (a.shift - b.shift));
    else list.sort((a, b) => a.shift - b.shift);
    return list;
  }, [board, ganttSort, flaggedShifts, improveDeltas]);
  // Best available single-move candidates for the selected shift — an in-context "what's
  // the best I could do with this one run" decision aid.
  const selSuggestions = useMemo(() => {
    if (!selSeg) return [];
    return findSuggestions(board, eng, DEM, rules, glob, spans, null, selSeg.id);
  }, [selSeg, board, eng, DEM, rules, glob, spans]);
  const bestMoveSup = useMemo(() => {
    if (!selSeg || !selSuggestions.length) return null;
    const top = selSuggestions[0];
    const patched = board.map((s) => (s.id === top.id ? { ...s, ...top.payload } : s));
    return buildSupply(patched);
  }, [selSeg, selSuggestions, board]);
  // Sign-ins per 5-minute slot on the viewed day (garage-stagger view).
  const dayStarts = useMemo(() => {
    const c = new Array(N).fill(0);
    for (const sg of board) {
      if (!sg.days.includes(day)) continue;
      const k = Math.floor((sg.s - T0) / 5);
      if (k >= 0 && k < N) c[k]++;
    }
    return c;
  }, [board, day]);

  /* ---------- gantt drag (Schedule tab) ----------
     Direct manipulation on the schedule bars: slide a whole shift, slide its break, or
     resize either by the edges. Geometry-only clamps here — rule legality stays advisory
     via validateSeg, shown live in the readout, never blocked. One drag commits exactly one
     undo entry: the pre-drag board is pushed to history the moment the pointer passes the
     click threshold, then setBoard is called directly for every quantized step after that. */
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { id, mode, startDayScore } | null
  const DRAG_THRESHOLD_PX = 4;
  const clampDragDelta = (o, mode, d) => {
    switch (mode) {
      case "move": return d;
      case "seg-start": return Math.min(d, (o.b ? Math.min(o.b[0], o.e - 5) : o.e - 5) - o.s);
      case "seg-end": return Math.max(d, (o.b ? Math.max(o.b[1], o.s + 5) : o.s + 5) - o.e);
      case "break-move": return Math.max(o.s - o.b[0], Math.min(d, o.e - o.b[1]));
      case "break-start": return Math.max(o.s - o.b[0], Math.min(d, o.b[1] - 5 - o.b[0]));
      case "break-end": return Math.max(o.b[0] + 5 - o.b[1], Math.min(d, o.e - o.b[1]));
      default: return 0;
    }
  };
  const dragPatch = (o, mode, d) => {
    switch (mode) {
      case "move": return { s: o.s + d, e: o.e + d, b: o.b ? [o.b[0] + d, o.b[1] + d] : null };
      case "seg-start": return { s: o.s + d };
      case "seg-end": return { e: o.e + d };
      case "break-move": return { b: [o.b[0] + d, o.b[1] + d] };
      case "break-start": return { b: [o.b[0] + d, o.b[1]] };
      case "break-end": return { b: [o.b[0], o.b[1] + d] };
      default: return {};
    }
  };
  const onGanttPointerDown = (ev, sg) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    setDragging((cur) => (cur ? null : cur)); // self-heal a leaked drag from a lost pointerup
    const mode = ev.target && ev.target.dataset ? ev.target.dataset.dragmode || null : null;
    if (!mode) return; // press on row background/label does nothing
    const track = ev.currentTarget.querySelector(".gtrack");
    if (!track) return;
    const pxPerMin = track.getBoundingClientRect().width / (T1 - T0);
    if (!(pxPerMin > 0)) return;
    dragRef.current = {
      sgId: sg.id, mode, orig: cloneSeg(sg),
      startX: ev.clientX, pxPerMin, lastDelta: 0, active: false,
      boardSnapshot: board, startDayScore: P.dayScore,
    };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* pointer capture unsupported */ }
  };
  const onGanttPointerMove = (ev) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = ev.clientX - d.startX;
    if (!d.active) {
      if (!d.mode || Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      d.active = true;
      setHist((h) => [...h.slice(-40), d.boardSnapshot]);
      setFuture([]);
      setDragging({ id: d.sgId, mode: d.mode, startDayScore: d.startDayScore });
    }
    const dMin = clampDragDelta(d.orig, d.mode, Math.round(dx / d.pxPerMin / 5) * 5);
    if (dMin === d.lastDelta) return;
    d.lastDelta = dMin;
    const patch = dragPatch(d.orig, d.mode, dMin);
    setBoard((b) => b.map((s) => (s.id === d.sgId ? { ...cloneSeg(s), ...patch } : s)));
  };
  const onGanttPointerUp = (ev, sg) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging((cur) => (cur ? null : cur)); // unconditional — never leave a lifted bar behind
    if (!d) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    if (!d.active) setSelId(sg.id); // never crossed the threshold — behaves as the plain click it was
  };

  /* ---------- rules editing ---------- */
  const setRule = (t, field, idx, val) => setRules((rs) => {
    const R = { ...rs[t] };
    if (Array.isArray(R[field])) { const a = [...R[field]]; a[idx] = val; R[field] = a; }
    else R[field] = val;
    return { ...rs, [t]: R };
  });

  const weekPct = (eng.weekScore * 100).toFixed(1);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --target-ink: #233746; --supply-teal: #0F7B7A;
          --gap-red: #C0392B; --bookout-violet: #6C5B9E; --sample-gray: #5B6B75; --queue-blue: #2E86AB;
          --required-pink: #B0455E; --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #CBD5DA;
          --muted: #5B6B75; --muted-light: #8899A3; --text-mid: #41525C;
          --row-border: #E7EDEF; --track-bg: #F0F4F5; --row-hover: #F7FAFA;
          --tint-neutral: #FBFCFC; --tint-neutral-b: #EEF4F5; --tint-teal-b: #EEF6F6;
          --tint-red-a: #FBEDEB; --tint-red-b: #FDF6F5; --chart-border: #EBF0F2;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --target-ink: #8CA3B8; --supply-teal: #2FB3AC;
          --gap-red: #E27A70; --bookout-violet: #A594D1; --sample-gray: #8B9AA5; --queue-blue: #5FA3C9;
          --required-pink: #D97C93; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D;
          --muted: #93A2AC; --muted-light: #6B7882; --text-mid: #A9B6BF;
          --row-border: #263038; --track-bg: #202A31; --row-hover: #202A31;
          --tint-neutral: #1B242B; --tint-neutral-b: #1C262B; --tint-teal-b: #172227;
          --tint-red-a: #2E1714; --tint-red-b: #2A1613; --chart-border: #263038;
        }
        body { background: var(--paper); }
        .ccnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:var(--sample-gray); }
        .ccnav.on { color:${text}; border-bottom-color:${supplyTeal}; }
        .ccrow { display:flex; align-items:center; height:30px; border-bottom:1px solid var(--row-border); user-select:none; }
        .ccrow:hover { background:var(--row-hover); }
        .gbar { position:absolute; border-radius:2px; cursor:grab; touch-action:pan-y; }
        .gbrk { position:absolute; background:repeating-linear-gradient(45deg,#fff,#fff 3px,#AEBAC0 3px,#AEBAC0 6px); border-left:1px solid rgba(0,0,0,.35); border-right:1px solid rgba(0,0,0,.35); cursor:grab; touch-action:pan-y; z-index:1; }
        .gbar.lifted, .gbrk.lifted { transform:scaleY(1.35); box-shadow:0 2px 6px rgba(0,0,0,.35); z-index:2; cursor:grabbing; }
        .ghandle { position:absolute; top:0; bottom:0; width:7px; cursor:col-resize; touch-action:pan-y; z-index:3; }
        input[type=text], input[type=number] { background:${card}; color:${text}; border:1px solid var(--border-input); }
        select { background:${card}; color:${text}; border:1px solid var(--border-input); }
        table.rt th { font-size:11px; color:var(--sample-gray); text-align:left; font-weight:600; padding:4px 8px; }
        table.rt td { padding:3px 8px; }
      `}</style>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 20px 60px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 0 10px", borderBottom: `3px solid ${ink}`, flexWrap: "wrap" }}>
          <div onClick={onHome} style={{ cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: ".1em", color: sampleGray }}>‹ TRANSIT OPERATIONS TOOLKIT</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>CALL CENTRE STAFFING</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>Weekly coverage <b style={{ color: text, fontSize: 15 }}>{weekPct}%</b></div>
            <button style={primaryBtn} onClick={exportSchedule}>Export Schedule</button>
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

        {/* nav */}
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
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
                <div key={d} onClick={() => setDay(d)} style={{ cursor: "pointer", textAlign: "center", padding: "6px 4px", background: on ? ink : card, color: on ? "#fff" : text, border: "1px solid var(--border)" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 13 }}>{d.slice(0, 3).toUpperCase()}</div>
                  <div style={{ fontSize: 10, opacity: .8 }}>cov {(p.dayScore * 100).toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "rules" && <RulesTab {...{ rules, setRule, glob, setGlob, spans, setSpans, tColor, board, day, setDay, P, covPreviewCache, stabPreviewCache }} />}
        {tab === "demand" && <DemandTab {...{ day, calls, arrivals, showArrivals, setShowArrivals, demSource, uploadInfo, callSummary, sketchRaw, setSketchRaw, peakCalls, setPeakCalls, applySketch, useSample, uploadCalls, downloadTemplate, P }} />}
        {tab === "build" && <BuildTab {...{ nAgents, setNAgents, generate, buildResult, distinctShifts, flagCount, tColor }} />}
        {tab === "coverage" && (
          <div>
            {P.floorViol.length > 0 && (
              <div style={{ background: "var(--tint-red-a)", border: `1px solid ${gapRed}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
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
              <Stat label="Required (peak)" value={peakReq} tone="var(--required-pink)" sub={`${glob.slTargetPct > 1 ? glob.slTargetPct : glob.slTargetPct * 100}% in ${glob.slTargetSec}s`} />
              <Stat label="Rule flags" value={flagCount} tone={flagCount ? gapRed : supplyTeal} />
            </div>
            <div style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                <div style={hTitle}>Agents vs active calls — {day}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: sampleGray }}>Chart resolution</span>
                  <input type="range" min={0} max={COVERAGE_RESOLUTIONS.length - 1} step={1}
                    value={COVERAGE_RESOLUTIONS.indexOf(coverageResolution)}
                    onChange={(e) => setCoverageResolution(COVERAGE_RESOLUTIONS[Number(e.target.value)])}
                    style={{ width: 110, accentColor: supplyTeal }} />
                  <span style={{ fontSize: 11, color: sampleGray, minWidth: 60 }}>
                    {coverageResolution < 60 ? `${coverageResolution} min avg` : "1 hr avg"}
                  </span>
                </div>
              </div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={0} showBookout={false} showProductivity={false} demandShare={100}
                supplyName="Agents on shift" targetName="Demand-aligned staffing" unitLabel="active calls" minName="floor" sugTooltip={false}
                extraSeries={peakReq > 0 ? [{ key: "req", name: "Agents required (Erlang)", color: "var(--required-pink)", values: reqCurve, dash: "5 3" }] : null}
                aggregateMin={coverageResolution} showTripBar />
              <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
                Teal = agents on shift; shaded target = the demand-aligned agent shape (scale-free coverage of active calls). Amber floor line = minimum agents. Dashed red = agents an Erlang C model needs to answer {glob.slTargetPct > 1 ? glob.slTargetPct : glob.slTargetPct * 100}% of calls within {glob.slTargetSec}s (from active calls + handle time in Rules) — an absolute headcount check the scale-free coverage can't give.
              </div>
            </div>
          </div>
        )}
        {tab === "schedule" && (
          <ScheduleTab {...{
            board, sortedRows, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak,
            rules, glob, tColor, pct, undo, redo, hist, future,
            ganttSort, setGanttSort, flaggedShifts, improveDeltas, selSuggestions, bestMoveSup, dayStarts, P,
            dragging, onGanttPointerDown, onGanttPointerMove, onGanttPointerUp,
          }} />
        )}
      </div>
    </div>
  );
}

/* ================= RULES ================= */
function RulesTab({ rules, setRule, glob, setGlob, spans, setSpans, tColor, board, day, setDay, P, covPreviewCache, stabPreviewCache }) {
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
                <tr key={t} style={{ borderTop: "1px solid var(--border-light)" }}>
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

        <div style={cardStyle}>
          <div style={hTitle}>Service level (Erlang sizing)</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "8px 10px", alignItems: "center", fontSize: 13 }}>
            <span>Average handle time (min)</span><NumField value={glob.ahtMin ?? 1.8} step={0.1} onCommit={(v) => setG("ahtMin", Math.max(0.1, Math.round(v * 100) / 100))} />
            <span>Answer target (%)</span><NumField value={glob.slTargetPct > 1 ? glob.slTargetPct : Math.round((glob.slTargetPct ?? 0.8) * 100)} step={5} onCommit={(v) => setG("slTargetPct", Math.min(0.999, Math.max(0.5, Math.round(v) / 100)))} />
            <span>…within (seconds)</span><NumField value={glob.slTargetSec ?? 30} step={5} onCommit={(v) => setG("slTargetSec", Math.max(1, Math.round(v)))} />
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Drives the "agents required" line on Coverage — the Erlang C headcount to answer the target share of calls in time, given the active-calls load and handle time. Handle time auto-fills from uploaded call data.</div>
        </div>

        <div style={cardStyle}>
          <div style={hTitle}>Scheduling algorithm</div>
          <div style={{ fontSize: 12, color: sampleGray, marginBottom: 10 }}>
            How the schedule generator and coverage score decide between candidate agent placements — not a hard limit, a tuning of the search itself.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
            <span>Coverage priority</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={0} max={4} step={0.5} value={glob.coveragePriority ?? 0}
                onChange={(e) => setG("coveragePriority", Number(e.target.value))}
                style={{ flex: 1, accentColor: supplyTeal }} />
              <span style={{ minWidth: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{glob.coveragePriority ?? 0}</span>
            </div>
            <span>Off-peak weighting (%)</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={0} max={60} step={5} value={glob.offPeakBias ?? 0}
                onChange={(e) => setG("offPeakBias", Number(e.target.value))}
                style={{ flex: 1, accentColor: supplyTeal }} />
              <span style={{ minWidth: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{glob.offPeakBias ?? 0}%</span>
            </div>
            <span>Schedule stability</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={0} max={10} step={0.5} value={glob.scheduleStability ?? 3}
                onChange={(e) => setG("scheduleStability", Number(e.target.value))}
                style={{ flex: 1, accentColor: supplyTeal }} />
              <span style={{ minWidth: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{glob.scheduleStability ?? 3}</span>
            </div>
          </div>
          <CoveragePriorityShapePreview P={P} day={day} setDay={setDay} coveragePriority={glob.coveragePriority ?? 0} previewCache={covPreviewCache} />
          <OffPeakShapePreview P={P} day={day} setDay={setDay} />
          <ScheduleStabilityPreview board={board} scheduleStability={glob.scheduleStability ?? 3} previewCache={stabPreviewCache} />
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 10, lineHeight: 1.6 }}>
            <b>Coverage priority</b> spreads agents across busy times: 0 sends everything to the single biggest gap first; higher (0.5–2) spreads agents more evenly across all under-served times before deepening any one gap.<br /><br />
            <b>Off-peak weighting</b> gives quiet times of day a bit more staffing than raw call volume alone. 0 = follow call volume exactly; higher % = flatter, more even coverage.<br /><br />
            <b>Schedule stability</b> affects how strongly the generator favors keeping shifts close to where they already sit: 0 chases every coverage point regardless of disruption; higher = a stronger pull to keep shifts in place, only moving one when the coverage gain is worth it.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= DEMAND ================= */
function DemandTab({ day, calls, arrivals, showArrivals, setShowArrivals, demSource, uploadInfo, callSummary, sketchRaw, setSketchRaw, peakCalls, setPeakCalls, applySketch, useSample, uploadCalls, downloadTemplate, P }) {
  const upRef = useRef(null);
  const srcLabel = { sample: "Sample call data (Jul–Aug 2025)", sketched: "Sketched", uploaded: "Uploaded call data" }[demSource] || demSource;
  const hasArrivals = arrivals && arrivals[day];
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={hTitle}>Active calls — {day}</div>
          <span style={{ fontSize: 11, padding: "2px 8px", background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", color: sampleGray }}>{srcLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {hasArrivals && (
              <label style={{ fontSize: 12, color: sampleGray, display: "flex", alignItems: "center", gap: 5, cursor: "pointer", marginRight: 4 }}>
                <input type="checkbox" checked={showArrivals} onChange={(e) => setShowArrivals(e.target.checked)} /> show arrivals
              </label>
            )}
            <button style={nudgeBtn} onClick={useSample}>Use sample</button>
            <button style={nudgeBtn} onClick={downloadTemplate}>Download template</button>
            <button style={nudgeBtn} onClick={() => upRef.current && upRef.current.click()}>Upload call data</button>
            <input ref={upRef} type="file" accept=".csv,.xlsx" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) uploadCalls(e.target.files[0]); e.target.value = ""; }} />
          </div>
        </div>
        {uploadInfo && (
          <div style={{ background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", padding: "7px 11px", marginBottom: 8, fontSize: 12, color: text }}>{uploadInfo}</div>
        )}
        <CallCurveChart ev={calls[day]} day={day} arrivals={showArrivals && hasArrivals ? arrivals[day] : null} />
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 6 }}>
          Upload accepts a raw ACD call export (one row per call with Call Start Time / Call End Time) — it derives concurrent active calls per interval, inbound only, averaged into a typical week — or the simple Day / Time / Active calls template.
        </div>
      </div>

      <CallDataSummary summary={callSummary} day={day} calls={calls} />

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
              <span key={t} style={{ fontSize: 12, padding: "3px 9px", background: card, border: `1px solid ${tColor(t)}`, color: tColor(t), borderRadius: 2 }}>{t}: {n}</span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Open the SCHEDULE tab to edit, or COVERAGE to see the fit. Generating again replaces the current schedule (undo available in SCHEDULE).</div>
        </div>
      )}
    </div>
  );
}

/* ================= SCHEDULE ================= */
function ScheduleTab({
  board, sortedRows, day, setDay, selSeg, selId, setSelId, selIssues, patchSel, addShift, dupSel, removeSel, fixSel, toggleDay, toggleBreak,
  rules, glob, tColor, pct, undo, redo, hist, future,
  ganttSort, setGanttSort, flaggedShifts, improveDeltas, selSuggestions, bestMoveSup, dayStarts, P,
  dragging, onGanttPointerDown, onGanttPointerMove, onGanttPointerUp,
}) {
  const rows = sortedRows;
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button style={nudgeBtn} onClick={addShift}>+ Add shift</button>
        <button style={nudgeBtn} onClick={undo} disabled={!hist.length}>Undo</button>
        <button style={nudgeBtn} onClick={redo} disabled={!future.length}>Redo</button>
        <label style={{ fontSize: 12, color: sampleGray, display: "flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
          Sort
          <select value={ganttSort} onChange={(e) => setGanttSort(e.target.value)} style={{ fontSize: 12 }}>
            <option value="run">Run number</option>
            <option value="time">Start time</option>
            <option value="end">End time</option>
            <option value="type">Type, then time</option>
            <option value="flags">Flagged first{flaggedShifts.size > 0 ? ` (${flaggedShifts.size})` : ""}</option>
            <option value="improve">Room to improve first</option>
          </select>
        </label>
        <span style={{ marginLeft: "auto", fontSize: 12, color: sampleGray, alignSelf: "center" }}>{board.length} shift rows</span>
      </div>

      {selSeg && (
        <div style={{ ...cardStyle, border: `1px solid ${selIssues.length ? gapRed : "var(--border)"}` }}>
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
              return <button key={d} onClick={() => toggleDay(d)} style={{ ...nudgeBtn, background: on ? supplyTeal : card, color: on ? "#fff" : "var(--muted-light)", borderColor: on ? supplyTeal : "var(--border-input)" }}>{d.slice(0, 3)}</button>;
            })}
          </div>
          {selIssues.length > 0 && (
            <div style={{ marginTop: 10, borderLeft: `3px solid ${gapRed}`, background: "var(--tint-red-b)", padding: "6px 10px" }}>
              {selIssues.map((iss, i) => <div key={i} style={{ fontSize: 12.5, color: gapRed }}>⚠ {iss}</div>)}
            </div>
          )}
          {selSuggestions.length > 0 && (
            <div style={{ marginTop: 10, borderLeft: `3px solid ${supplyTeal}`, background: "var(--tint-teal-b)", padding: "8px 10px" }}>
              <div style={{ fontSize: 12, color: sampleGray, marginBottom: 6 }}>Best available moves for this run:</div>
              {selSuggestions.slice(0, 3).map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: i ? 4 : 0 }}>
                  <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: supplyTeal, width: 52 }}>
                    +{(s.delta * 100).toFixed(2)}
                  </span>
                  <span style={{ fontSize: 12, flex: 1 }}>{s.label}</span>
                  <button style={{ ...nudgeBtn, padding: "2px 8px" }} onClick={() => patchSel(s.payload)}>Apply</button>
                </div>
              ))}
              {bestMoveSup && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: sampleGray, marginBottom: 2 }}>
                    {day} coverage if you apply the top move — <span style={{ color: supplyTeal }}>teal</span> gains, <span style={{ color: gapRed }}>red</span> loses:
                  </div>
                  <DeltaAreaChart delta={bestMoveSup[day].map((v, i) => v - P.sup[i])} demandRef={P.target} height={110} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ ...cardStyle, padding: "10px 12px" }}>
        {(() => {
          const peak = Math.max(1, ...dayStarts);
          const cap = glob.maxPullout || 0;
          const overSlots = cap > 0 ? dayStarts.filter((n) => n > cap).length : 0;
          return (
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <div style={{ width: 108, fontSize: 9.5, color: sampleGray, display: "flex", alignItems: "flex-end", lineHeight: 1.1 }}>
                sign-ins{cap > 0 ? ` /5m (cap ${cap})` : " /5m"}
              </div>
              <div style={{ position: "relative", flex: 1, height: 22, borderBottom: "1px solid var(--border)" }}
                title={`Shifts signing in per 5-minute slot on ${day}. Peak ${peak}${cap > 0 ? `; ${overSlots} slot${overSlots === 1 ? "" : "s"} over the ${cap} cap` : ""}.`}>
                {dayStarts.map((n, i) => n > 0 && (
                  <div key={i} style={{
                    position: "absolute", bottom: 0, left: `${pct(SLOT(i))}%`, width: 2, transform: "translateX(-1px)",
                    height: `${Math.max(2, (n / peak) * 20)}px`,
                    background: (cap > 0 && n > cap) ? gapRed : supplyTeal,
                  }} />
                ))}
              </div>
              <div style={{ width: 96 }} />
            </div>
          );
        })()}
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          {rows.map((sg) => {
            const issues = validateSeg(sg, rules, glob);
            const bad = issues.length > 0;
            const isSel = sg.id === selId;
            const covers = sg.days.includes(day);
            const brkMin = sg.b ? sg.b[1] - sg.b[0] : 0;
            const workHrs = ((sg.e - sg.s - brkMin) / 60).toFixed(2);
            const isDrag = dragging != null && dragging.id === sg.id;
            const barL = pct(sg.s), barR = pct(sg.e);
            return (
              <div key={sg.id} className="ccrow"
                onPointerDown={(ev) => onGanttPointerDown(ev, sg)}
                onPointerMove={onGanttPointerMove}
                onPointerUp={(ev) => onGanttPointerUp(ev, sg)}
                onPointerCancel={(ev) => onGanttPointerUp(ev, sg)}
                style={{ opacity: covers ? 1 : 0.45, outline: isSel ? `2px solid ${ink}` : "none" }}>
                <div style={{ width: 108, fontSize: 12, fontWeight: isSel ? 700 : 500, color: bad ? gapRed : text, paddingLeft: 4 }}>
                  {sg.shift} · {sg.type}
                  {ganttSort === "improve" && improveDeltas && improveDeltas.get(sg.shift) > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, color: supplyTeal, fontWeight: 700 }}>+{(improveDeltas.get(sg.shift) * 100).toFixed(2)}</span>
                  )}
                </div>
                <div className="gtrack" style={{ position: "relative", flex: 1, height: 18, background: "var(--track-bg)", borderRadius: 2 }}
                  title={isDrag ? undefined : `${fmt(sg.s)}–${fmt(sg.e)} · ${workHrs}h working${sg.b ? ` · ${brkMin}m break (${fmt(sg.b[0])}–${fmt(sg.b[1])})` : ""}`}>
                  {[360, 600, 840, 1080, 1320].map((m) => <div key={m} style={{ position: "absolute", left: `${pct(m)}%`, top: 0, bottom: 0, width: 1, background: "var(--border)" }} />)}
                  <div className={"gbar" + (isDrag ? " lifted" : "")} data-dragmode="move" style={{
                    position: "absolute", top: 2, bottom: 2, left: `${barL}%`, width: `${barR - barL}%`,
                    background: tColor(sg.type), borderRadius: 2, outline: bad ? `2px solid ${gapRed}` : "none",
                  }} />
                  <div className="ghandle" data-dragmode="seg-start" style={{ left: `calc(${barL}% - 3px)` }} />
                  <div className="ghandle" data-dragmode="seg-end" style={{ left: `calc(${barR}% - 4px)` }} />
                  {sg.b && (
                    <>
                      <div className={"gbrk" + (isDrag ? " lifted" : "")} data-dragmode="break-move" style={{
                        position: "absolute", top: 2, bottom: 2, left: `${pct(sg.b[0])}%`, width: `${pct(sg.b[1]) - pct(sg.b[0])}%`, opacity: 0.85,
                      }} />
                      <div className="ghandle" data-dragmode="break-start" style={{ left: `calc(${pct(sg.b[0])}% - 3px)` }} />
                      <div className="ghandle" data-dragmode="break-end" style={{ left: `calc(${pct(sg.b[1])}% - 4px)` }} />
                    </>
                  )}
                  {isDrag && (() => {
                    const dScore = (P.dayScore - dragging.startDayScore) * 100;
                    const flipLeft = barR > 65;
                    const staggerIssue = (() => {
                      if (!glob.maxPullout) return null;
                      const k = Math.floor((sg.s - T0) / 5);
                      if (k < 0 || k >= N) return null;
                      const count = board.filter((o) => o.id !== sg.id && o.days.includes(day) && Math.floor((o.s - T0) / 5) === k).length + 1;
                      return count > glob.maxPullout ? `${count} sign-ins at ${fmt(sg.s)} (max ${glob.maxPullout})` : null;
                    })();
                    const allIssues = [...issues, staggerIssue].filter(Boolean);
                    return (
                      <div style={{
                        position: "absolute", top: 17, zIndex: 30, pointerEvents: "none",
                        ...(flipLeft ? { right: `${100 - barL}%`, marginRight: 6 } : { left: `${barR}%`, marginLeft: 6 }),
                        background: ink, color: "#fff", padding: "6px 9px", borderRadius: 3,
                        fontSize: 11, lineHeight: 1.5, whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(0,0,0,.3)",
                      }}>
                        <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {fmt(sg.s)} – {fmt(sg.e)} · {workHrs}h{sg.b ? ` · break ${fmt(sg.b[0])}–${fmt(sg.b[1])} (${brkMin}m)` : ""}
                        </div>
                        <div style={{ color: dScore >= 0 ? "#7FD9BE" : "#F0A0A0" }}>{dScore >= 0 ? "+" : ""}{dScore.toFixed(2)} pt {day} coverage</div>
                        {allIssues.map((iss, i) => <div key={i} style={{ color: "#F0A0A0" }}>⚠ {iss}</div>)}
                      </div>
                    );
                  })()}
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

/* Active-calls curve — concurrency per 5-min slot, no trip/vehicle framing. Optional arrivals line. */
function CallCurveChart({ ev, day, arrivals }) {
  const W = 940, H = 240, PADL = 34, PADB = 22;
  const maxV = Math.max(1, Math.max(...ev) * 1.15);
  const x = (i) => PADL + (i / (N - 1)) * (W - PADL - 8);
  const y = (v) => (H - PADB) - (Math.min(v, maxV) / maxV) * (H - PADB - 8);
  const path = ev.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(N - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const arrPath = arrivals ? arrivals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") : null;
  const peakI = ev.indexOf(Math.max(...ev));
  const peakLeft = peakI > N * 0.75;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: "var(--tint-neutral)", border: "1px solid var(--border)", borderRadius: 2 }}>
      {[6, 9, 12, 15, 18, 21, 24].map((h) => {
        const i = Math.round((h * 60 - T0) / 5);
        if (i < 0 || i >= N) return null;
        return (
          <g key={h}>
            <line x1={x(i)} y1={8} x2={x(i)} y2={H - PADB} stroke="var(--chart-border)" />
            <text x={x(i)} y={H - 7} fontSize={11} fill="var(--muted-light)" textAnchor="middle">{h}:00</text>
          </g>
        );
      })}
      {[25, 50, 75, 100].map((p) => {
        const v = maxV * p / 100;
        return (
          <g key={p}>
            <line x1={PADL} y1={y(v)} x2={W - 8} y2={y(v)} stroke="var(--track-bg)" />
            <text x={PADL - 4} y={y(v) + 3.5} fontSize={10} fill="var(--muted-light)" textAnchor="end">{v >= 20 ? Math.round(v) : v.toFixed(1)}</text>
          </g>
        );
      })}
      <path d={area} fill={demandAmber} fillOpacity={0.14} />
      <path d={path} fill="none" stroke={demandAmber} strokeWidth={2.5} strokeLinejoin="round" />
      {arrPath && <path d={arrPath} fill="none" stroke={supplyTeal} strokeWidth={1.6} strokeDasharray="4 3" strokeLinejoin="round" />}
      <circle cx={x(peakI)} cy={y(ev[peakI])} r={5} fill={gapRed} stroke="var(--card)" strokeWidth={1.2} />
      <text x={x(peakI) + (peakLeft ? -9 : 9)} y={y(ev[peakI]) - 6} fontSize={11} fontWeight={700} fill={gapRed} textAnchor={peakLeft ? "end" : "start"}>
        {ev[peakI].toFixed(1)} concurrent
      </text>
      <text x={PADL} y={16} fontSize={11} fill={sampleGray}>Active calls (queue + talking){arrivals ? " (amber) + calls arriving (teal dashed)" : ""} — {day} · concurrent calls per 5-minute slot</text>
    </svg>
  );
}

/* Call-data-at-a-glance: per-weekday inbound volume bars + average handle time, from the sheet. */
function CallDataSummary({ summary, day, calls }) {
  if (!summary || !summary.perDay) return null;
  const maxCalls = Math.max(1, ...DAYS.map((d) => summary.perDay[d]?.calls || 0));
  const selPeak = Math.max(...calls[day]);
  const selAht = summary.perDay[day]?.aht;
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={hTitle}>Call data at a glance</div>
        <span style={{ fontSize: 12, color: sampleGray }}>
          avg handle time {summary.aht?.toFixed(1)} min · {day}: peak {selPeak.toFixed(1)} concurrent{selAht ? `, ${selAht.toFixed(1)} min handle` : ""}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8, alignItems: "end", height: 116 }}>
        {DAYS.map((d) => {
          const c = summary.perDay[d]?.calls || 0;
          const on = d === day;
          return (
            <div key={d} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: on ? text : sampleGray, fontVariantNumeric: "tabular-nums" }}>{c}</div>
              <div style={{ width: "66%", background: on ? supplyTeal : "var(--border-input)", height: `${Math.max(3, (c / maxCalls) * 82)}px`, borderRadius: "2px 2px 0 0" }} />
              <div style={{ fontSize: 10, color: on ? text : sampleGray, marginTop: 3 }}>{d.slice(0, 3)}</div>
            </div>
          );
        })}
      </div>
      {(summary.composition || (summary.queues && summary.queues.length > 0)) && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border-light)" }}>
          {summary.composition && (() => {
            const tot = (summary.composition.acd || 0) + (summary.composition.nonAcd || 0);
            const acdPct = tot ? Math.round((summary.composition.acd / tot) * 100) : 0;
            return (
              <div style={{ minWidth: 190 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: sampleGray, marginBottom: 5 }}>CALL COMPOSITION</div>
                <div style={{ display: "flex", height: 14, borderRadius: 2, overflow: "hidden", border: "1px solid var(--border)" }}>
                  <div style={{ width: `${acdPct}%`, background: supplyTeal }} title={`Queued (ACD) ${acdPct}%`} />
                  <div style={{ width: `${100 - acdPct}%`, background: "var(--border-input)" }} title={`Non-ACD ${100 - acdPct}%`} />
                </div>
                <div style={{ fontSize: 11, color: sampleGray, marginTop: 4 }}>
                  <span style={{ color: supplyTeal, fontWeight: 600 }}>{acdPct}% queued (ACD)</span> · {100 - acdPct}% non-ACD
                </div>
              </div>
            );
          })()}
          {summary.queues && summary.queues.length > 0 && (() => {
            const maxQ = Math.max(1, ...summary.queues.map((q) => q.calls));
            return (
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: sampleGray, marginBottom: 5 }}>BUSIEST QUEUES (period total)</div>
                {summary.queues.slice(0, 4).map((q) => (
                  <div key={q.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <div style={{ width: 130, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.name}</div>
                    <div style={{ flex: 1, background: "var(--track-bg)", borderRadius: 2, height: 12 }}>
                      <div style={{ width: `${(q.calls / maxQ) * 100}%`, background: "var(--queue-blue)", height: "100%", borderRadius: 2 }} />
                    </div>
                    <div style={{ width: 54, textAlign: "right", fontSize: 11, color: sampleGray, fontVariantNumeric: "tabular-nums" }}>{q.calls.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>
        Average inbound calls per day (bars) and average handle time, from the loaded call data. Longer handle time ties each agent up longer, so more agents are needed for the same call volume.
      </div>
    </div>
  );
}
