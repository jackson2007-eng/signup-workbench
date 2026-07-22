import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { ResponsiveContainer, ComposedChart, XAxis, YAxis, Line } from "recharts";
import {
  T0, T1, N, SLOT, DAYS, WEEKEND_DAYS, fmt, parseHM, cloneSeg,
  buildSupply, computeEngine, generateBoard, validateSeg, autofixSeg,
  findSuggestions, parseSignupWorkbook, retimeBoard, deepOptimize, refinePerDay, packageInfo, autoPackage, reconcileTypes,
  TimeField, NumField, Nudge, Stat, CoverageChart, Sketcher, DeltaAreaChart,
  CoveragePriorityShapePreview, ScheduleStabilityPreview, COVERAGE_RESOLUTIONS,
  TPL, SKETCH_GROUPS, SKETCH_MODE_LABELS,
  optimizeToConvergence, stabilityFraction, SLIDE_MAX_MIN,
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
  // Day-keyed sketch + peak, grouped by sketchMode — same model as the operator Demand tab.
  const [sketch, setSketch] = useState(() => { const o = {}; for (const d of DAYS) o[d] = [...DEFAULT_SKETCH]; return o; });
  const [sketchPeaks, setSketchPeaks] = useState(() => { const o = {}; for (const d of DAYS) o[d] = d === "Saturday" ? 7 : d === "Sunday" ? 6 : 13; return o; });
  const [sketchMode, setSketchMode] = useState("weekdaySatSun");
  const [curveTab, setCurveTab] = useState("Weekday");
  const [hist, setHist] = useState([]);
  const [future, setFuture] = useState([]);
  const [coverageResolution, setCoverageResolution] = useState(5); // minutes per chart bucket
  const fileRef = useRef(null);
  const scheduleFileRef = useRef(null);
  // Baseline agent schedule the working board is compared against — the sample until a real
  // schedule is uploaded, then that upload. Same baseline/rebase model as the operator tool.
  const [baselineBoard, setBaselineBoard] = useState(() => CALL_SAMPLE.board.map(cloneSeg));
  const [scheduleSource, setScheduleSource] = useState("sample"); // "sample" | "uploaded"
  const [scheduleUpload, setScheduleUpload] = useState(null); // parser summary for the banner
  // Part-time agent classifications — same ptRules/ptEnabled/ptCount machinery as Dispatch
  // and the operator tool (generateBoard's fully-parameterized pt args).
  const [ptRules, setPtRules] = useState({});
  const [ptEnabled, setPtEnabled] = useState(false);
  const [ptCount, setPtCount] = useState(6);
  const [newPtType, setNewPtType] = useState("");

  const nextId = useRef(Math.max(0, ...CALL_SAMPLE.board.map((s) => s.id || 0)) + 1);
  const tColor = (t) => typeColors[t] || DEFAULT_TCOLOR;
  const allRules = useMemo(() => ({ ...rules, ...ptRules }), [rules, ptRules]);

  const DEM = calls;
  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(
    () => computeEngine(DEM, ftCov, false, glob.minVeh, spans, 0, glob.offPeakBias, glob.coveragePriority, 0, 0, glob),
    [DEM, ftCov, glob, spans]
  );
  const P = eng.perDay[day];

  // Erlang C agents required for the selected day, from the active-calls (offered-load) curve.
  const reqCurve = useMemo(
    () => (calls[day] || []).map((A) => requiredAgents(A, glob.ahtMin, glob.slTargetSec, (glob.slTargetPct > 1 ? glob.slTargetPct / 100 : glob.slTargetPct))),
    [calls, day, glob.ahtMin, glob.slTargetSec, glob.slTargetPct]
  );
  const peakReq = reqCurve.length ? Math.max(...reqCurve) : 0;

  const distinctShifts = new Set(board.map((s) => s.shift)).size;
  const flagCount = board.reduce((n, s) => n + (validateSeg(s, allRules, glob).length ? 1 : 0), 0);

  // Changes vs the baseline schedule — same id-keyed diff as the operator tool's Compare.
  const boardDiff = useMemo(() => {
    const originalMap = new Map(baselineBoard.map((s) => [s.id, s]));
    const added = [], removed = [], modified = [];
    const ids = new Set();
    for (const s of board) {
      ids.add(s.id);
      const o = originalMap.get(s.id);
      if (!o) { added.push(s); continue; }
      if (o.s !== s.s || o.e !== s.e || o.type !== s.type ||
        JSON.stringify(o.b) !== JSON.stringify(s.b) || o.days.join() !== s.days.join()) {
        modified.push({ seg: s, orig: o });
      }
    }
    for (const [id, o] of originalMap) if (!ids.has(id)) removed.push(o);
    return { added, removed, modified };
  }, [board, baselineBoard]);
  const changedCount = boardDiff.added.length + boardDiff.removed.length + boardDiff.modified.length;
  const baseEng = useMemo(
    () => computeEngine(DEM, buildSupply(baselineBoard), false, glob.minVeh, spans, 0, glob.offPeakBias, glob.coveragePriority, 0, 0, glob),
    [DEM, baselineBoard, glob, spans]
  );

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
    const r = generateBoard(0, Math.max(1, Math.round(nAgents)), rules, glob, DEM, spans, glob.minVeh, false, null, glob.shiftSeriesBase, {}, ptEnabled ? ptRules : {}, ptEnabled ? ptCount : 0);
    const segs = r.segs.map((s) => ({ ...cloneSeg(s), id: nextId.current++ }));
    setHist((h) => [...h.slice(-40), board]); setFuture([]);
    setBoard(segs);
    setBuildResult({ packages: r.packages, mix: r.mix, paidHours: r.paidHours, evaluated: r.evaluated });
    setSelId(null);
  };

  /* ---------- demand load ---------- */
  const applySketch = () => {
    const c = {};
    for (const d of DAYS) c[d] = sketchToCalls(sketch[d], sketchPeaks[d]);
    setCalls(c); setDemSource("sketched"); setUploadInfo(null); setCallSummary(null); setArrivals(null);
  };
  // The active sketch group is resolved defensively every render (rather than synced via an
  // effect) so a curveTab left over from a previous sketchMode never produces an invalid lookup.
  const activeGroup = SKETCH_GROUPS[sketchMode].find((g) => g.key === curveTab) || SKETCH_GROUPS[sketchMode][0];
  const repDay = activeGroup.days[0];
  const setGroupSketch = (fn) => setSketch((s) => {
    const v = typeof fn === "function" ? fn(s[repDay]) : fn;
    const next = { ...s };
    for (const d of activeGroup.days) next[d] = [...v];
    return next;
  });
  const setGroupPeak = (v) => setSketchPeaks((t) => {
    const next = { ...t };
    for (const d of activeGroup.days) next[d] = v;
    return next;
  });
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

  /* ---------- schedule import ---------- */
  const downloadScheduleTemplate = () => {
    const wb = XLSX.utils.book_new();
    const instr = [
      ["Agent schedule template"], [],
      ["One row per agent shift. If a shift's start/end times differ on some days, add one row per distinct time pattern — every row shares the same Shift No."],
      ["Days Worked: space-separated 2-letter weekday codes, e.g. \"MO TU WE TH FR\"."],
      ["Report Time / Off are the paid on-duty start/end (24h, e.g. 14:30). If a shift runs past midnight, Off can be earlier than Report Time — it's read as the next day."],
      ["Break Start / Break End (optional): same 24h format. Leave both blank for a shift with no scheduled break."],
      ["Days Off / Type are optional — Days Off is inferred from Days Worked, and a blank Type is auto-matched against your shift types in Rules."],
      ["No agent names or IDs — this tool only tracks shift structure."],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsI, "Instructions");
    const header = ["Shift No", "Run", "Days Off", "Type", "Break Start", "Break End", "Days Worked", "Report Time", "Off"];
    const rows = [header, [7001, "7001", "SA-SU", "", "12:00", "12:30", "MO TU WE TH FR", "8:00", "16:30"]];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 9 }, { wch: 7 }, { wch: 10 }, { wch: 7 }, { wch: 11 }, { wch: 11 }, { wch: 18 }, { wch: 11 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws, "Agent Schedule");
    XLSX.writeFile(wb, "agent-schedule-template.xlsx");
  };
  const uploadSchedule = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: file.name.endsWith(".csv") ? "string" : "array" });
        const res = parseSignupWorkbook(wb, null, allRules);
        if (!res.ok) { alert(res.error); return; }
        let segs = res.segments.map((s) => ({ ...cloneSeg(s), id: nextId.current++ }));
        // Reconcile unknown type codes right at upload: match to an existing classification
        // where every shift fits its windows, otherwise build one from the observed times.
        let rec = null;
        const r = reconcileTypes(segs, rules, glob);
        if (r) {
          segs = r.board;
          setRules(r.rules);
          rec = { matched: r.matched, built: r.built };
          setReconcileResult(rec);
        }
        setBoard(segs.map(cloneSeg));
        setBaselineBoard(segs.map(cloneSeg));
        setScheduleSource("uploaded");
        setScheduleUpload(rec ? { ...res.summary, unrecognizedTypes: [], reconciled: rec } : res.summary);
        setHist([]); setFuture([]); setSelId(null); setBuildResult(null);
      } catch (e) {
        alert("Could not read that schedule file — check it matches the agent schedule template.");
      }
    };
    if (file.name.endsWith(".csv")) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };
  const resetToBaseline = () => {
    setHist((h) => [...h.slice(-40), board]); setFuture([]);
    setBoard(baselineBoard.map(cloneSeg));
    setSelId(null); setBuildResult(null);
  };

  /* ---------- optimizer tools (Suggestions tab + Retime) ---------- */
  const [sugs, setSugs] = useState(null);
  // Rename a full-time type code — the rules key, every shift on the board and baseline, and
  // its color all follow along, same as the operator tool. Undo history is cleared because old
  // snapshots would strand agent shifts on a code that no longer exists.
  const renameType = (oldCode, newCodeRaw) => {
    const newCode = String(newCodeRaw || "").toUpperCase().trim();
    if (!newCode || newCode === oldCode || allRules[newCode]) return false;
    setRules((old) => { const next = {}; for (const k of Object.keys(old)) next[k === oldCode ? newCode : k] = old[k]; return next; });
    const remap = (sg) => (sg.type === oldCode ? { ...cloneSeg(sg), type: newCode } : sg);
    setBoard((b) => b.map(remap));
    setBaselineBoard((b) => b.map(remap));
    setTypeColors((tc) => { const n = { ...tc }; n[newCode] = n[oldCode] || DEFAULT_TCOLOR; delete n[oldCode]; return n; });
    setSugs(null);
    setHist([]); setFuture([]);
    return true;
  };
  // Give unknown type codes a home: match to existing classifications where the times fit,
  // otherwise build classifications from the observed times. Applies to the baseline too —
  // this is a labeling fix, not a schedule change, so Compare stays quiet about it.
  const unknownTypes = useMemo(() => {
    const m = new Map();
    for (const sg of board) if (!allRules[sg.type]) m.set(sg.type, (m.get(sg.type) || 0) + 1);
    return [...m.entries()];
  }, [board, allRules]);
  const [reconcileResult, setReconcileResult] = useState(null);
  const runReconcile = () => {
    const r = reconcileTypes(board, rules, glob);
    if (!r) return;
    setRules(r.rules);
    commit(() => r.board.map(cloneSeg));
    if (r.matched.length) setBaselineBoard((b) => b.map((sg) => {
      const hit = r.matched.find(([from]) => from === sg.type);
      return hit ? { ...cloneSeg(sg), type: hit[1] } : sg;
    }));
    setReconcileResult({ matched: r.matched, built: r.built });
    setSugs(null);
  };
  const optMonitor = useOptimizerMonitor({
    rules, ptRules, ptEnabled, ptCount, glob, DEM, spans, baselineBoard, buildN: nAgents,
    onLoadBest: (best) => { commit(() => best.map(cloneSeg)); setSelId(null); setSugs(null); setTab("schedule"); },
  });
  const [optResult, setOptResult] = useState(null);
  const scoreOf = (b) => computeEngine(DEM, buildSupply(b), false, glob.minVeh, spans, 0, glob.offPeakBias, glob.coveragePriority, 0, 0, glob).weekScore;
  const findSugs = () => setSugs(findSuggestions(board, eng, DEM, allRules, glob, spans));
  const applySug = (s) => {
    commit((b) => b.map((sg) => (sg.id === s.id ? { ...cloneSeg(sg), s: s.payload.s, e: s.payload.e, b: s.payload.b ? [...s.payload.b] : null } : sg)));
    setSugs(null);
  };
  const runDeep = () => {
    const before = eng.weekScore;
    const r = deepOptimize(board, [DEM, false, glob.minVeh, spans, 0], allRules, glob);
    const after = scoreOf(r.board);
    commit(() => r.board.map(cloneSeg));
    setOptResult({ kind: "Deep optimize", detail: `${r.moves} moves · ${r.created} day-variant${r.created === 1 ? "" : "s"} created · ${(r.evaluated || 0).toLocaleString()} candidates evaluated`, before, after });
    setSugs(null);
  };
  const runRefine = () => {
    const before = eng.weekScore;
    const r = refinePerDay(board, allRules, glob, DEM, false, glob.minVeh, spans);
    const after = scoreOf(r.board);
    commit(() => r.board.map(cloneSeg));
    setOptResult({ kind: "Day-to-day refine", detail: `${r.moves} per-day moves · ${r.created} day-variant${r.created === 1 ? "" : "s"} created`, before, after });
    setSugs(null);
  };
  const runRetime = () => {
    const before = eng.weekScore;
    const r = retimeBoard(board, rules, glob, DEM, spans, glob.minVeh, false, { stability: glob.scheduleStability });
    const after = scoreOf(r.segs);
    commit(() => r.segs.map(cloneSeg));
    setOptResult({ kind: "Retime", detail: `${(r.evaluated || 0).toLocaleString()} candidates evaluated`, before, after });
    setSugs(null);
  };
  // Size the build from the Erlang requirement: weekly agent-hours the service-level target
  // implies across all seven days, ÷40 paid hours per weekly package.
  const reqPackages = useMemo(() => {
    const pctSL = glob.slTargetPct > 1 ? glob.slTargetPct / 100 : glob.slTargetPct;
    let h = 0;
    for (const d of DAYS) for (const A of (calls[d] || [])) h += requiredAgents(A, glob.ahtMin, glob.slTargetSec, pctSL) / 12;
    return Math.max(1, Math.ceil(h / 40));
  }, [calls, glob.ahtMin, glob.slTargetSec, glob.slTargetPct]);
  const sizeToReq = () => setNAgents(reqPackages);
  // Package-rule checking (min rest, consecutive days, report-time variance) — flags only,
  // never blocks, same as everywhere else in the toolkit.
  const packageIssues = useMemo(() => {
    const by = new Map();
    for (const sg of board) { if (!by.has(sg.shift)) by.set(sg.shift, []); by.get(sg.shift).push(sg); }
    const out = new Map();
    for (const [sh, segs] of by) {
      const issues = packageInfo(segs, allRules, glob).issues;
      if (issues.length) out.set(sh, issues);
    }
    return out;
  }, [board, allRules, glob]);
  const runAutoPackage = () => {
    const before = eng.weekScore;
    const r = autoPackage(board, rules, glob);
    const after = scoreOf(r.board);
    commit(() => r.board.map(cloneSeg));
    setOptResult({ kind: "Auto-package", detail: `${r.made} package${r.made === 1 ? "" : "s"} formed · ${r.orphans} single day${r.orphans === 1 ? "" : "s"} left unpackaged`, before, after });
    setSugs(null);
  };
  const [hasVisitedCoverage, setHasVisitedCoverage] = useState(false);
  useEffect(() => { if (tab === "coverage") setHasVisitedCoverage(true); }, [tab]);

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
    const blob = new Blob([JSON.stringify({ kind: "callcentre", board, baselineBoard, scheduleSource, rules, ptRules, ptEnabled, ptCount, glob, spans, sketch, sketchPeaks, sketchMode, calls, arrivals, demSource, typeColors, callSummary }, null, 0)], { type: "application/json" });
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
        setPtRules(p.ptRules && typeof p.ptRules === "object" ? p.ptRules : {});
        setPtEnabled(!!p.ptEnabled);
        if (p.ptCount != null) setPtCount(Math.max(0, Math.round(p.ptCount)));
        if (p.sketch) setSketch(p.sketch);
        if (p.sketchPeaks) setSketchPeaks(p.sketchPeaks);
        if (p.sketchMode) setSketchMode(p.sketchMode);
        if (p.glob) setGlob({ ...CALL_SAMPLE.global, ...p.glob });
        if (p.spans) setSpans(p.spans);
        if (p.calls) { setCalls(p.calls); setDemSource(p.demSource || "uploaded"); }
        setCallSummary(p.callSummary || null);
        setArrivals(p.arrivals || null);
        if (p.typeColors) setTypeColors(p.typeColors);
        // older saves have no baseline — the loaded board becomes its own baseline
        setBaselineBoard(Array.isArray(p.baselineBoard) ? p.baselineBoard.map(cloneSeg) : p.board.map(cloneSeg));
        setScheduleSource(p.scheduleSource === "uploaded" && Array.isArray(p.baselineBoard) ? "uploaded" : "sample");
        setScheduleUpload(null);
        setHist([]); setFuture([]); setSelId(null); setBuildResult(null);
      } catch (e) { alert("Could not read that Call Centre project file."); }
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
    for (const sg of board) if (validateSeg(sg, allRules, glob).length > 0) set.add(sg.shift);
    for (const sh of packageIssues.keys()) set.add(sh);
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

        {/* nav — phase strip (Setup → Build → Review → Handoff), same model as the operator tool */}
        <PhaseStrip tab={tab} setTab={setTab} groups={[
          { phase: "PHASE 1 · SETUP", tabs: [
            { key: "rules", label: "RULES" },
            { key: "import", label: "IMPORT", done: scheduleSource === "uploaded", reason: "Still using the sample schedule — upload your real agent schedule" },
            { key: "demand", label: "DEMAND", done: demSource !== "sample", reason: "Still using sample call data — sketch your own or upload real data" },
          ]},
          { phase: "PHASE 2 · BUILD", tabs: [
            { key: "build", label: "BUILD" },
            { key: "schedule", label: "SCHEDULE" },
          ]},
          { phase: "PHASE 3 · REVIEW", tabs: [
            { key: "coverage", label: "COVERAGE", done: hasVisitedCoverage, reason: "Not yet reviewed" },
            { key: "suggest", label: "SUGGESTIONS" },
            { key: "compare", label: "COMPARE" },
          ]},
          { phase: "PHASE 4 · HANDOFF", tabs: [
            { key: "pack", label: "PACKAGING" },
          ]},
        ]} />

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

        {tab === "rules" && <RulesTab {...{ rules, setRule, glob, setGlob, spans, setSpans, tColor, board, day, setDay, P, ptRules, setPtRules, ptEnabled, setPtEnabled, newPtType, setNewPtType, allRules, renameType, unknownTypes, runReconcile, reconcileResult }} />}
        {tab === "import" && <ImportTab {...{ scheduleSource, scheduleUpload, uploadSchedule, downloadScheduleTemplate, resetToBaseline, changedCount, baselineBoard, scheduleFileRef, noun: "agent" }} />}
        {tab === "suggest" && <SuggestTab {...{ sugs, findSugs, applySug, runDeep, runRefine, optResult, tColor, noun: "agent" }} />}
        {tab === "compare" && <CompareTab {...{ boardDiff, changedCount, scheduleSource, eng, baseEng, tColor, noun: "agent", board, baselineBoard, day }} />}
        {tab === "demand" && <DemandTab {...{ day, calls, arrivals, showArrivals, setShowArrivals, demSource, uploadInfo, callSummary, sketch, sketchPeaks, sketchMode, setSketchMode, curveTab, setCurveTab, activeGroup, repDay, setGroupSketch, setGroupPeak, applySketch, useSample, uploadCalls, downloadTemplate, P }} />}
        {tab === "build" && <BuildTab {...{ nAgents, setNAgents, generate, buildResult, distinctShifts, flagCount, tColor, sizeToReq, reqPackages, runRetime, optResult, noun: "agent", ptEnabled, ptCount, setPtCount, unknownTypes, monitor: <OptimizerMonitorCard opt={optMonitor} noun="agent" buildN={nAgents} ptEnabled={ptEnabled} ptCount={ptCount} baselineBoard={baselineBoard} /> }} />}
        {tab === "pack" && <PackagingTab {...{ board, packageIssues, tColor, runAutoPackage, runRefine, optResult, noun: "agent" }} />}
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
                supplyName="Agents on shift" targetName="Demand-aligned staffing" unitLabel="active calls" minName="floor" minUnitLabel="agents" sugTooltip={false}
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

/* ================= IMPORT (shared by Call Centre + Dispatch via copy) ================= */
export function ImportTab({ scheduleSource, scheduleUpload, uploadSchedule, downloadScheduleTemplate, resetToBaseline, changedCount, baselineBoard, scheduleFileRef, noun }) {
  const baselineShifts = new Set(baselineBoard.map((s) => s.shift)).size;
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Current {noun} schedule</div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          {scheduleSource === "uploaded"
            ? <>Working from an <b>uploaded schedule</b> — {baselineShifts} shifts. Every edit, generate, and optimization compares back to it on the Compare tab.</>
            : <>Working from the <b>shipped sample schedule</b> ({baselineShifts} shifts). Upload your real {noun} schedule to plan against it — the upload becomes the baseline everything is compared to.</>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }}
            onClick={() => scheduleFileRef.current && scheduleFileRef.current.click()}>Upload {noun} schedule</button>
          <button style={nudgeBtn} onClick={downloadScheduleTemplate}>Download template</button>
          {changedCount > 0 && (
            <button style={{ ...nudgeBtn, borderColor: demandAmber, color: demandAmber }} onClick={resetToBaseline}>
              Reset working schedule to baseline ({changedCount} change{changedCount === 1 ? "" : "s"})
            </button>
          )}
          <input ref={scheduleFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
            onChange={(e) => { if (e.target.files && e.target.files[0]) uploadSchedule(e.target.files[0]); e.target.value = ""; }} />
        </div>
        {scheduleUpload && (
          <div style={{ marginTop: 10, background: "var(--tint-teal-a, rgba(15,123,122,.08))", border: `1px solid ${supplyTeal}`, padding: "8px 12px", fontSize: 12.5 }}>
            Loaded <b>{scheduleUpload.shifts}</b> shifts ({scheduleUpload.rows} rows).
            {scheduleUpload.autoClassified > 0 && <> {scheduleUpload.autoClassified} auto-matched to a shift type{scheduleUpload.ambiguousClassified > 0 ? ` (${scheduleUpload.ambiguousClassified} ambiguous)` : ""}.</>}
            {scheduleUpload.unclassified > 0 && <> <span style={{ color: gapRed }}>{scheduleUpload.unclassified} could not be matched to any type — they'll be flagged until retyped.</span></>}
            {scheduleUpload.unrecognizedTypes.length > 0 && <> Types not in Rules: {scheduleUpload.unrecognizedTypes.join(", ")}.</>}
            {scheduleUpload.reconciled && scheduleUpload.reconciled.matched.length > 0 && <> Codes matched to existing rules: {scheduleUpload.reconciled.matched.map(([a, b]) => `${a} \u2192 ${b}`).join(", ")}.</>}
            {scheduleUpload.reconciled && scheduleUpload.reconciled.built.length > 0 && <> New classification{scheduleUpload.reconciled.built.length === 1 ? "" : "s"} <b>{scheduleUpload.reconciled.built.join(", ")}</b> built from the shift times — review the windows in RULES.</>}
            {(scheduleUpload.dateSpecificSkipped > 0 || scheduleUpload.exceptionRows > 0) && <> {scheduleUpload.dateSpecificSkipped + scheduleUpload.exceptionRows} date-specific row{scheduleUpload.dateSpecificSkipped + scheduleUpload.exceptionRows === 1 ? "" : "s"} ignored (this module has no exception days yet).</>}
            {scheduleUpload.footerRowsSkipped > 0 && <> {scheduleUpload.footerRowsSkipped} non-shift row{scheduleUpload.footerRowsSkipped === 1 ? "" : "s"} skipped.</>}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 10, lineHeight: 1.6 }}>
          The template is one row per shift (Shift No, Days Worked, Report Time, Off, optional break columns). No {noun} names or IDs — shift structure only. Uploading replaces the working schedule AND the baseline; use Save project first if you want to keep what you have.
        </div>
      </div>
    </div>
  );
}

/* ================= COMPARE ================= */
export function CompareTab({ boardDiff, changedCount, scheduleSource, eng, baseEng, tColor, noun, board, baselineBoard, day }) {
  // Ghost gantt (ported from the operator tool's Compare): one row per shift for the viewed
  // day, matched by SHIFT NUMBER — the baseline draws as a dashed outline behind the solid
  // working bar, so every move reads as "was there, now here".
  const [changedOnly, setChangedOnly] = useState(false);
  const pctPos = (m) => ((Math.min(Math.max(m, T0), T1) - T0) / (T1 - T0)) * 100;
  const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
  const dayShifts = [...new Set([
    ...baselineBoard.filter((s) => s.days.includes(day)).map((s) => s.shift),
    ...board.filter((s) => s.days.includes(day)).map((s) => s.shift),
  ])].sort((a, b) => a - b);
  const ghostRows = dayShifts.map((sh) => {
    const orig = baselineBoard.find((s) => s.shift === sh && s.days.includes(day)) || null;
    const cur = board.find((s) => s.shift === sh && s.days.includes(day)) || null;
    let status = "same";
    const parts = [];
    if (orig && !cur) status = "removed";
    else if (!orig && cur) status = "added";
    else if (orig && cur) {
      if (cur.s !== orig.s) parts.push(`start ${sgn(cur.s - orig.s)}m`);
      if (cur.e !== orig.e) parts.push(`end ${sgn(cur.e - orig.e)}m`);
      if (!orig.b && cur.b) parts.push("break added");
      else if (orig.b && !cur.b) parts.push("break removed");
      else if (orig.b && cur.b) {
        if (cur.b[0] !== orig.b[0]) parts.push(`brk ${sgn(cur.b[0] - orig.b[0])}m`);
        const dl = (cur.b[1] - cur.b[0]) - (orig.b[1] - orig.b[0]);
        if (dl !== 0) parts.push(`brk len ${sgn(dl)}m`);
      }
      if (cur.type !== orig.type) parts.push(`${orig.type}\u2192${cur.type}`);
      if (parts.length) status = "changed";
    }
    return { sh, orig, cur, status, delta: parts.join(" \u00b7 ") };
  });
  const visibleGhost = changedOnly ? ghostRows.filter((r) => r.status !== "same") : ghostRows;
  const fmtB = (b) => (b ? `${fmt(b[0])}–${fmt(b[1])}` : "no break");
  const rowStyle = { borderTop: "1px solid var(--border-light)", fontSize: 12.5 };
  const cur = Math.round(eng.weekScore * 1000) / 10;
  const base = Math.round(baseEng.weekScore * 1000) / 10;
  const delta = Math.round((cur - base) * 10) / 10;
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={hTitle}>{day} — baseline (dashed) vs working schedule (solid)</div>
          <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Changed shifts only
          </label>
          <div style={{ marginLeft: "auto", fontSize: 11, color: sampleGray }}>{fmt(T0)} — {fmt(T1)} · switch days with the paddles above</div>
        </div>
        <div style={{ display: "flex", gap: 6, margin: "6px 0 2px" }}>
          <div style={{ width: 74, flex: "none" }} />
          <div style={{ position: "relative", flex: 1, height: 14 }}>
            {[6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((h) => (
              <div key={h} style={{ position: "absolute", left: `${pctPos(h * 60)}%`, fontSize: 9.5, color: sampleGray, transform: "translateX(-50%)" }}>{h}</div>
            ))}
          </div>
          <div style={{ width: 128, flex: "none" }} />
        </div>
        {visibleGhost.length === 0 && (
          <div style={{ fontSize: 13, color: sampleGray, padding: "12px 4px" }}>
            {changedOnly ? `No shifts changed on ${day} vs the baseline.` : `No shifts work ${day}.`}
          </div>
        )}
        <div style={{ maxHeight: 480, overflowY: "auto" }}>
          {visibleGhost.map(({ sh, orig, cur, status, delta }) => {
            const show = cur || orig;
            return (
              <div key={sh} style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 0", opacity: status === "same" && !changedOnly ? 0.55 : 1 }}>
                <div style={{ width: 74, flex: "none", fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: status === "removed" ? gapRed : text, fontWeight: status !== "same" ? 700 : 400 }}>
                  {sh} {show.type}
                </div>
                <div style={{ position: "relative", flex: 1, height: 14, background: "var(--track-bg, var(--tint-neutral-b))", borderRadius: 2 }}>
                  {[360, 600, 840, 1080, 1320].map((m) => (
                    <div key={m} style={{ position: "absolute", left: `${pctPos(m)}%`, top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
                  ))}
                  {orig && (
                    <div title={`was ${fmt(orig.s)}\u2013${fmt(orig.e)}${orig.b ? ` (break ${fmt(orig.b[0])}\u2013${fmt(orig.b[1])})` : ""}`} style={{
                      position: "absolute", left: `${pctPos(orig.s)}%`, width: `${pctPos(Math.min(orig.e, T1)) - pctPos(orig.s)}%`,
                      top: 0, height: 14, borderRadius: 2, background: status === "removed" ? "var(--tint-red, #F6E4E1)" : "transparent",
                      border: `1.5px dashed ${tColor(orig.type)}`, boxSizing: "border-box", opacity: 0.85, pointerEvents: "none",
                    }} />
                  )}
                  {orig && orig.b && (
                    <div style={{
                      position: "absolute", left: `${pctPos(orig.b[0])}%`, width: `${pctPos(orig.b[1]) - pctPos(orig.b[0])}%`,
                      top: 0, height: 14, border: "1.5px dashed #AEBAC0", boxSizing: "border-box", opacity: 0.7, pointerEvents: "none",
                    }} />
                  )}
                  {cur && (
                    <div title={`now ${fmt(cur.s)}\u2013${fmt(cur.e)}${cur.b ? ` (break ${fmt(cur.b[0])}\u2013${fmt(cur.b[1])})` : ""}`} style={{
                      position: "absolute", left: `${pctPos(cur.s)}%`, width: `${pctPos(Math.min(cur.e, T1)) - pctPos(cur.s)}%`,
                      top: 3, height: 8, borderRadius: 2, background: tColor(cur.type), opacity: 0.95,
                    }} />
                  )}
                  {cur && cur.b && (
                    <div style={{
                      position: "absolute", left: `${pctPos(cur.b[0])}%`, width: `${pctPos(cur.b[1]) - pctPos(cur.b[0])}%`,
                      top: 3, height: 8, background: "repeating-linear-gradient(45deg,#fff,#fff 2px,#AEBAC0 2px,#AEBAC0 4px)",
                    }} />
                  )}
                </div>
                <div title={delta || status} style={{ width: 128, flex: "none", fontSize: 10.5, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  color: status === "removed" ? gapRed : status === "added" ? supplyTeal : status === "changed" ? demandAmber : sampleGray }}>
                  {status === "removed" ? "removed" : status === "added" ? "new" : status === "changed" ? delta : "unchanged"}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: sampleGray, marginTop: 8 }}>
          Dashed outline = the shift as it was in the baseline · solid bar = the working schedule · hatched = break. Shifts are matched by shift number; a generated-from-scratch schedule therefore shows every baseline shift as removed and the new ones as added.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Working schedule vs. {scheduleSource === "uploaded" ? "uploaded baseline" : "sample baseline"}</div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13, marginBottom: 10 }}>
          <span>Baseline coverage <b>{base}%</b></span>
          <span>Current coverage <b>{cur}%</b></span>
          <span style={{ color: delta > 0 ? supplyTeal : delta < 0 ? gapRed : sampleGray }}>
            {delta > 0 ? "+" : ""}{delta} pts
          </span>
          <span>{boardDiff.modified.length} modified · {boardDiff.added.length} added · {boardDiff.removed.length} removed</span>
        </div>
        {changedCount === 0 ? (
          <div style={{ fontSize: 13, color: sampleGray }}>No changes yet — the working schedule matches the baseline exactly.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: sampleGray, textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>Change</th><th style={{ padding: "4px 8px" }}>Shift</th><th style={{ padding: "4px 8px" }}>Type</th><th style={{ padding: "4px 8px" }}>Days</th><th style={{ padding: "4px 8px" }}>Before</th><th style={{ padding: "4px 8px" }}>After</th>
              </tr></thead>
              <tbody>
                {boardDiff.modified.map(({ seg, orig }) => (
                  <tr key={`m${seg.id}`} style={rowStyle}>
                    <td style={{ padding: "4px 8px", color: demandAmber }}>Modified</td>
                    <td style={{ padding: "4px 8px" }}>{seg.shift}</td>
                    <td style={{ padding: "4px 8px" }}><span style={{ background: tColor(seg.type), color: "#fff", padding: "1px 6px", borderRadius: 2, fontSize: 11 }}>{seg.type}</span></td>
                    <td style={{ padding: "4px 8px" }}>{seg.days.map((d) => d.slice(0, 2)).join(" ")}</td>
                    <td style={{ padding: "4px 8px", color: sampleGray }}>{fmt(orig.s)}–{fmt(orig.e)} · {fmtB(orig.b)}</td>
                    <td style={{ padding: "4px 8px" }}>{fmt(seg.s)}–{fmt(seg.e)} · {fmtB(seg.b)}</td>
                  </tr>
                ))}
                {boardDiff.added.map((seg) => (
                  <tr key={`a${seg.id}`} style={rowStyle}>
                    <td style={{ padding: "4px 8px", color: supplyTeal }}>Added</td>
                    <td style={{ padding: "4px 8px" }}>{seg.shift}</td>
                    <td style={{ padding: "4px 8px" }}><span style={{ background: tColor(seg.type), color: "#fff", padding: "1px 6px", borderRadius: 2, fontSize: 11 }}>{seg.type}</span></td>
                    <td style={{ padding: "4px 8px" }}>{seg.days.map((d) => d.slice(0, 2)).join(" ")}</td>
                    <td style={{ padding: "4px 8px", color: sampleGray }}>—</td>
                    <td style={{ padding: "4px 8px" }}>{fmt(seg.s)}–{fmt(seg.e)} · {fmtB(seg.b)}</td>
                  </tr>
                ))}
                {boardDiff.removed.map((seg) => (
                  <tr key={`r${seg.id}`} style={rowStyle}>
                    <td style={{ padding: "4px 8px", color: gapRed }}>Removed</td>
                    <td style={{ padding: "4px 8px" }}>{seg.shift}</td>
                    <td style={{ padding: "4px 8px" }}><span style={{ background: tColor(seg.type), color: "#fff", padding: "1px 6px", borderRadius: 2, fontSize: 11 }}>{seg.type}</span></td>
                    <td style={{ padding: "4px 8px" }}>{seg.days.map((d) => d.slice(0, 2)).join(" ")}</td>
                    <td style={{ padding: "4px 8px", color: sampleGray }}>{fmt(seg.s)}–{fmt(seg.e)} · {fmtB(seg.b)}</td>
                    <td style={{ padding: "4px 8px" }}>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 10, lineHeight: 1.6 }}>
          Coverage percentages are the honest weekly score (share of {noun === "agent" ? "call volume" : "workload"} aligned with staffing) for each schedule, measured identically. Removed shifts from a full regenerate are listed too — a generated schedule replaces every baseline shift.
        </div>
      </div>
    </div>
  );
}

/* ================= SUGGESTIONS (shared by Call Centre + Dispatch) ================= */
export function OptResultBanner({ optResult }) {
  if (!optResult) return null;
  const b = Math.round(optResult.before * 1000) / 10, a = Math.round(optResult.after * 1000) / 10;
  const d = Math.round((a - b) * 10) / 10;
  return (
    <div style={{ background: "var(--tint-teal-a, rgba(15,123,122,.08))", border: `1px solid ${supplyTeal}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
      <b>{optResult.kind}:</b> coverage {b}% → {a}% ({d > 0 ? "+" : ""}{d} pts) · {optResult.detail}. Undo available in SCHEDULE.
    </div>
  );
}

export function SuggestTab({ sugs, findSugs, applySug, runDeep, runRefine, optResult, tColor, noun }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Ranked improvements</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
          Legal single moves (shift slides, break slides) ranked by whole-week coverage gain, respecting every rule and the schedule-stability setting. Nothing is applied until you choose — the {noun} schedule always stays yours to edit.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={findSugs}>{sugs ? "Recompute" : "Find suggestions"}</button>
          <button style={{ ...nudgeBtn, borderColor: supplyTeal, color: supplyTeal }} onClick={runDeep}>Deep optimize (slides, breaks, per-day)</button>
          <button style={nudgeBtn} onClick={runRefine}>Refine day-to-day times</button>
        </div>
        <OptResultBanner optResult={optResult} />
        {sugs && sugs.length === 0 && <div style={{ fontSize: 13, color: sampleGray }}>No improving moves found — this schedule is locally optimal under the current rules.</div>}
        {sugs && sugs.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: sampleGray, textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>Shift</th><th style={{ padding: "4px 8px" }}>Type</th><th style={{ padding: "4px 8px" }}>Move</th><th style={{ padding: "4px 8px" }}>Gain</th><th style={{ padding: "4px 8px" }}></th>
              </tr></thead>
              <tbody>
                {sugs.map((s, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border-light)", fontSize: 12.5 }}>
                    <td style={{ padding: "4px 8px" }}>{s.shift}</td>
                    <td style={{ padding: "4px 8px" }}><span style={{ background: tColor(s.type), color: "#fff", padding: "1px 6px", borderRadius: 2, fontSize: 11 }}>{s.type}</span></td>
                    <td style={{ padding: "4px 8px" }}>{s.label}</td>
                    <td style={{ padding: "4px 8px", color: supplyTeal }}>+{(s.delta * 100).toFixed(2)} pts</td>
                    <td style={{ padding: "4px 8px" }}><button style={{ ...nudgeBtn, fontSize: 12, padding: "3px 8px" }} onClick={() => applySug(s)}>Apply</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!sugs && <div style={{ fontSize: 13, color: sampleGray }}>Click Find suggestions to rank the best legal moves for this schedule.</div>}
      </div>
    </div>
  );
}

/* ================= RULES ================= */
function RulesTab({ rules, setRule, glob, setGlob, spans, setSpans, tColor, board, day, setDay, P, ptRules, setPtRules, ptEnabled, setPtEnabled, newPtType, setNewPtType, allRules, renameType, unknownTypes, runReconcile, reconcileResult }) {
  const [editingType, setEditingType] = useState(null);
  const [typeDraft, setTypeDraft] = useState("");
  const setG = (k, v) => setGlob((g) => ({ ...g, [k]: v }));
  const setGArr = (k, i, v) => setGlob((g) => ({ ...g, [k]: g[k].map((x, j) => (j === i ? v : x)) }));
  return (
    <div>
      {unknownTypes && unknownTypes.length > 0 && (
        <div style={{ background: "var(--tint-amber-a, rgba(214,138,0,.10))", border: `1px solid ${demandAmber}`, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            <b>{unknownTypes.reduce((a, x) => a + x[1], 0)} shift{unknownTypes.reduce((a, x) => a + x[1], 0) === 1 ? "" : "s"} use codes not defined in Rules</b> ({unknownTypes.map(([t, n]) => `${t}\u00d7${n}`).join(", ")}) — Retime and the optimizers leave them untouched until they have a classification.
          </span>
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={runReconcile}>Auto-match & build rules</button>
        </div>
      )}
      {reconcileResult && (!unknownTypes || unknownTypes.length === 0) && (
        <div style={{ background: "var(--tint-teal-a, rgba(15,123,122,.08))", border: "1px solid var(--supply-teal)", padding: "8px 12px", marginBottom: 14, fontSize: 12.5 }}>
          {reconcileResult.matched.length > 0 && <>Matched to existing rules: {reconcileResult.matched.map(([a, b]) => `${a} \u2192 ${b}`).join(", ")}. </>}
          {reconcileResult.built.length > 0 && <>Built from the shift times: <b>{reconcileResult.built.join(", ")}</b> — windows are the observed range ±1h; review and tighten below. </>}
          The optimizers can now work these shifts.
        </div>
      )}
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
                  <td>
                    {editingType === t ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <input autoFocus value={typeDraft}
                          onChange={(e) => setTypeDraft(e.target.value.toUpperCase().slice(0, 6))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { if (renameType(t, typeDraft) || typeDraft.trim().toUpperCase() === t) setEditingType(null); }
                            if (e.key === "Escape") setEditingType(null);
                          }}
                          onBlur={() => { renameType(t, typeDraft); setEditingType(null); }}
                          style={{ width: 64, padding: "2px 6px", fontSize: 12, fontWeight: 600, border: `2px solid ${tColor(t)}`, borderRadius: 2, background: card, color: text, textTransform: "uppercase" }} />
                        {typeDraft.trim().toUpperCase() !== t && allRules[typeDraft.trim().toUpperCase()] && (
                          <span style={{ fontSize: 11, color: gapRed }}>exists</span>
                        )}
                      </span>
                    ) : (
                      <span title="Click to rename — every shift using this code follows along"
                        onClick={() => { setEditingType(t); setTypeDraft(t); }}
                        style={{ fontSize: 12, padding: "2px 8px", background: tColor(t), color: "#fff", borderRadius: 2, fontWeight: 600, cursor: "pointer" }}>{t}</span>
                    )}
                  </td>
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
        <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 8 }}>Full Time = 8h, Part Time = 4h by default. Times are editable; the generator and coverage score follow these windows. Click a type code to rename it — every shift using it follows along.</div>
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
              <input type="range" min={0} max={4} step={0.5} value={glob.coveragePriority ?? 2}
                onChange={(e) => setG("coveragePriority", Number(e.target.value))}
                style={{ flex: 1, accentColor: supplyTeal }} />
              <span style={{ minWidth: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{glob.coveragePriority ?? 2}</span>
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
          <CoveragePriorityShapePreview P={P} day={day} setDay={setDay} coveragePriority={glob.coveragePriority ?? 2} offPeakBias={glob.offPeakBias ?? 0} />
          <ScheduleStabilityPreview scheduleStability={glob.scheduleStability ?? 3} />
          <div style={{ fontSize: 11.5, color: sampleGray, marginTop: 10, lineHeight: 1.6 }}>
            <b>Coverage priority</b> tilts the target the generator chases between the peaks and the quiet times: left of 2 gives the peaks extra claim on agents, 2 follows call volume as-is, and right of 2 shifts emphasis toward the edges and off-peak stretches.<br /><br />
            <b>Off-peak weighting</b> gives quiet times of day a bit more staffing than raw call volume alone. 0 = follow call volume exactly; higher % = flatter, more even coverage.<br /><br />
            <b>Schedule stability</b> affects how strongly the generator favors keeping shifts close to where they already sit: 0 chases every coverage point regardless of disruption; higher = a stronger pull to keep shifts in place, only moving one when the coverage gain is worth it. Only applies to full-time agent shifts — part-time placement isn't retimed by this preview.
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={ptEnabled} onChange={(e) => setPtEnabled(e.target.checked)} />
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>Offer part-time agent shifts</span>
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
                      <th key={h} style={{ padding: "4px 8px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: sampleGray, textAlign: "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
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
                                    border: `1px solid ${on ? supplyTeal : "var(--border-input)"}`, background: on ? supplyTeal : card, color: on ? "#fff" : sampleGray }}>
                                  {d.slice(0, 2)}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        <td style={{ padding: "3px 8px", fontSize: 12, color: inUse ? text : sampleGray }}>{inUse}</td>
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
              <input placeholder="New part-time code (e.g. AGPT-EVE)" value={newPtType}
                onChange={(e) => setNewPtType(e.target.value.toUpperCase().slice(0, 8))}
                style={{ padding: "6px 8px", border: "1px solid var(--border-input)", borderRadius: 2, fontSize: 13, width: 210, background: card, color: text }} />
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
function DemandTab({ day, calls, arrivals, showArrivals, setShowArrivals, demSource, uploadInfo, callSummary, sketch, sketchPeaks, sketchMode, setSketchMode, curveTab, setCurveTab, activeGroup, repDay, setGroupSketch, setGroupPeak, applySketch, useSample, uploadCalls, downloadTemplate, P }) {
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
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 8 }}>Draw each pattern's relative shape; it scales so the busiest interval equals that pattern's peak. Choose how finely to split the week — a shared weekday pattern, a shared weekend pattern, or every day on its own.</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: sampleGray }}>Split the week:</span>
          {Object.entries(SKETCH_MODE_LABELS).map(([m, label]) => (
            <button key={m} style={{ ...nudgeBtn, ...(sketchMode === m ? { background: ink, color: "#fff", border: `1px solid ${ink}` } : {}) }} onClick={() => setSketchMode(m)}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          {SKETCH_GROUPS[sketchMode].map((g) => (
            <button key={g.key} style={{ ...nudgeBtn, ...(activeGroup.key === g.key ? { background: supplyTeal, color: "#fff", border: `1px solid ${supplyTeal}` } : {}) }} onClick={() => setCurveTab(g.key)}>{g.label.toUpperCase()}</button>
          ))}
          <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            {activeGroup.days.length > 1 ? `Peak active calls (same value applied ${activeGroup.label})` : `Peak active calls on ${activeGroup.label}`}
            <NumField value={sketchPeaks[repDay]} onCommit={(v) => setGroupPeak(Math.max(1, Math.round(v)))} />
          </label>
        </div>
        <Sketcher raw={sketch[repDay]} setRaw={setGroupSketch} trips={sketchPeaks[repDay]} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: sampleGray }}>Start from:</span>
          <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.weekday])}>Weekday pattern</button>
          <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.hump])}>Midday hump</button>
          <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.flat])}>Flat</button>
          <span style={{ marginLeft: "auto", fontSize: 12, color: sampleGray }}>applies to {activeGroup.days.map((d) => d.slice(0, 3)).join(", ")}</span>
          <button style={primaryBtn} onClick={applySketch}>Apply sketch to all days</button>
        </div>
      </div>
    </div>
  );
}

/* ================= BUILD ================= */
function BuildTab({ nAgents, setNAgents, generate, buildResult, distinctShifts, flagCount, tColor, sizeToReq, reqPackages, runRetime, optResult, noun, ptEnabled, ptCount, setPtCount, unknownTypes, monitor }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Generate an agent schedule</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
          Greedily builds weekly packages (5 days on, 2 off) from your shift types, placing each shift where it most improves coverage of the active-calls curve{ptEnabled ? ", filling in part-time shifts alongside full-time" : ""}. The result lands as a fully editable schedule.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Number of full-time {noun}s (weekly packages)</span>
          <NumField value={nAgents} onCommit={(v) => setNAgents(Math.max(1, Math.round(v)))} />
          {ptEnabled && (
            <>
              <span style={{ fontSize: 13 }}>Part-time shifts</span>
              <NumField value={ptCount} onCommit={(v) => setPtCount(Math.max(0, Math.round(v)))} />
            </>
          )}
          {sizeToReq && <button style={nudgeBtn} onClick={sizeToReq} title="Set the package count from the weekly requirement">Size to requirement ({reqPackages})</button>}
          <button style={primaryBtn} onClick={generate}>Generate schedule</button>
        </div>
      </div>
      {runRetime && (
        <div style={cardStyle}>
          <div style={hTitle}>Retime the current schedule</div>
          <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
            Keeps every shift and its type — only re-chooses start times and breaks within the rules to better fit the demand curve, honoring the schedule-stability setting. Undo available in SCHEDULE.
          </div>
          {unknownTypes && unknownTypes.length > 0 && (
            <div style={{ background: "var(--tint-amber-a, rgba(214,138,0,.10))", border: `1px solid ${demandAmber}`, padding: "7px 11px", marginBottom: 10, fontSize: 12 }}>
              {unknownTypes.reduce((a, x) => a + x[1], 0)} shift{unknownTypes.reduce((a, x) => a + x[1], 0) === 1 ? "" : "s"} use codes not defined in Rules ({unknownTypes.map(([t]) => t).join(", ")}) — Retime leaves them untouched. Go to RULES to auto-match & build classifications.
            </div>
          )}
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={runRetime}>Retime schedule</button>
          <div style={{ marginTop: 10 }}><OptResultBanner optResult={optResult && optResult.kind === "Retime" ? optResult : null} /></div>
        </div>
      )}
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
      {monitor}
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

/* ================= SHARED: PHASE STRIP ================= */
/* Setup → Build → Review → Handoff navigation, mirroring the operator tool's phase tabs:
   done = teal with a checkmark, pending = amber with the reason as a tooltip. Purely
   informational — clicking any tab always works (flag, never block). */
export function PhaseStrip({ tab, setTab, groups, navClass = "ccnav" }) {
  return (
    <div style={{ display: "flex", gap: 20, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
      {groups.map((g) => (
        <div key={g.phase}>
          <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".1em", color: sampleGray, margin: "0 2px 3px", fontWeight: 600 }}>{g.phase}</div>
          <div style={{ display: "flex", gap: 4 }}>
            {g.tabs.map((n) => {
              const status = n.done === undefined ? null : n.done ? "done" : "pending";
              return (
                <div key={n.key}
                  className={navClass + (tab === n.key ? " on" : "")}
                  title={status === "pending" ? n.reason : status === "done" ? "Done" : undefined}
                  onClick={() => setTab(n.key)}
                  style={status === "done" ? { color: supplyTeal } : status === "pending" ? { color: demandAmber } : undefined}>
                  {status === "done" ? "\u2713 " : ""}{n.label}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================= SHARED: PACKAGING ================= */
/* Signup-sheet-style weekly package grid, shared by Call Centre and Dispatch. Groups the board
   by shift number, shows each package's week at a glance, flags package-rule issues from
   packageInfo, and offers auto-package + per-day refine. */
export function PackagingTab({ board, packageIssues, tColor, runAutoPackage, runRefine, optResult, noun }) {
  const packages = useMemo(() => {
    const by = new Map();
    for (const sg of board) { if (!by.has(sg.shift)) by.set(sg.shift, []); by.get(sg.shift).push(sg); }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([shift, segs]) => {
      const perDay = {};
      for (const d of DAYS) perDay[d] = segs.filter((s) => s.days.includes(d));
      const daysWorked = DAYS.filter((d) => perDay[d].length > 0);
      return { shift, segs, perDay, daysWorked };
    });
  }, [board]);
  const singles = packages.filter((p) => p.daysWorked.length === 1).length;
  const flagged = packages.filter((p) => (packageIssues.get(p.shift) || []).length > 0).length;
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Weekly packages</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 10 }}>
          Each row is one {noun}'s week — every shift sharing a shift number. Auto-package combines single-day shifts into legal weekly packages (min rest, consecutive-day, and report-time-variance rules respected); per-day refine then nudges times day by day for coverage. Issues are flagged, never blocking.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Stat label="Packages" value={packages.length} tone={supplyTeal} />
          <Stat label="Single-day" value={singles} tone={singles ? demandAmber : undefined} />
          <Stat label="Flagged" value={flagged} tone={flagged ? gapRed : undefined} />
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={runAutoPackage}>Auto-package</button>
          <button style={nudgeBtn} onClick={runRefine}>Refine day-to-day times</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <OptResultBanner optResult={optResult && (optResult.kind === "Auto-package" || optResult.kind === "Day-to-day refine") ? optResult : null} />
        </div>
      </div>
      <div style={cardStyle}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
            <thead>
              <tr>
                {["Shift", ...DAYS.map((d) => d.slice(0, 3)), "Issues"].map((h) => (
                  <th key={h} style={{ padding: "5px 8px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: sampleGray, textAlign: "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => {
                const issues = packageIssues.get(p.shift) || [];
                return (
                  <tr key={p.shift} style={{ borderTop: "1px solid var(--border-light)", background: issues.length ? "var(--tint-red)" : undefined }}>
                    <td style={{ padding: "5px 8px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{p.shift}</td>
                    {DAYS.map((d) => {
                      const cell = p.perDay[d];
                      if (!cell.length) return <td key={d} style={{ padding: "5px 8px", color: sampleGray, fontSize: 11.5 }}>—</td>;
                      return (
                        <td key={d} style={{ padding: "5px 8px", fontSize: 11.5, whiteSpace: "nowrap" }}>
                          {cell.map((sg) => (
                            <div key={sg.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ display: "inline-block", width: 8, height: 8, background: tColor(sg.type), borderRadius: 2, flex: "none" }} />
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(sg.s)}–{fmt(sg.e)}</span>
                            </div>
                          ))}
                        </td>
                      );
                    })}
                    <td style={{ padding: "5px 8px", fontSize: 11.5, color: issues.length ? gapRed : sampleGray }}>
                      {issues.length ? issues.join("; ") : "\u2713"}
                    </td>
                  </tr>
                );
              })}
              {packages.length === 0 && (
                <tr><td colSpan={9} style={{ padding: "10px 8px", fontSize: 12.5, color: sampleGray }}>No shifts yet — build or import a schedule first.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= SHARED: OPTIMIZATION MONITOR ================= */
/* Port of the operator tool's long-running, time-sliced search: one iteration per
   setTimeout(0) tick so the UI keeps painting. Randomized restarts until 12 consecutive
   fail to improve, then mostly ruin-and-recreate around the best board (re-place a random
   handful of packages, everything else locked), with occasional fresh restarts. Accepts on
   the weighted objective discounted by schedule-stability disruption, but only if honest
   coverage doesn't drop — so the displayed best score is monotonically non-decreasing.
   All inputs snapshotted at Start; stop finishes with a polish pass. */
export function useOptimizerMonitor({ rules, ptRules, ptEnabled, ptCount, glob, DEM, spans, baselineBoard, buildN, onLoadBest }) {
  const [optRun, setOptRun] = useState(null);
  const [optMode, setOptMode] = useState("retime"); // "retime" | "generate"
  const [fitEachDay, setFitEachDay] = useState(true);
  const optRef = useRef(null);

  const optTick = () => {
    const st = optRef.current;
    if (!st || st.abort) return;
    const { cfg } = st;
    const rng = Math.random;
    const inRestartPhase = st.best == null || st.restartFails < 12;
    const doRestart = inRestartPhase || rng() < 0.05;
    let segs, ev;
    if (doRestart) {
      st.restarts++;
      const o = { rng, noise: st.iter === 0 ? 0 : 3 };
      if (cfg.mode === "generate") {
        const g = generateBoard(cfg.glob.min10 || 0, cfg.buildN, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, false, null, cfg.glob.shiftSeriesBase, o, cfg.ptRules, cfg.ptCount);
        segs = g.segs; ev = g.evaluated;
      } else {
        o.stability = cfg.glob.scheduleStability;
        const r = retimeBoard(cfg.baseline, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, false, o);
        segs = r.segs; ev = r.evaluated;
      }
    } else {
      st.refines++;
      const shifts = [...new Set(st.best.map((s) => s.shift))];
      const k = Math.min(shifts.length, 4 + Math.floor(rng() * 9));
      const subset = new Set();
      while (subset.size < k) subset.add(shifts[Math.floor(rng() * shifts.length)]);
      const r = retimeBoard(st.best, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, false, { rng, noise: 2, subsetShifts: subset, stability: cfg.glob.scheduleStability });
      segs = r.segs; ev = r.evaluated;
    }
    st.iter++;
    st.evaluated += ev;
    const sc = st.scoreFn(segs);
    const tSec = (performance.now() - st.startedAt) / 1000;
    if (cfg.mode === "generate" && st.baselineScore == null) st.baselineScore = sc.cov;
    const gain = sc.obj - st.bestObj;
    if (gain * (1 - st.disruptionFraction(segs)) > 1e-12 && sc.cov >= st.bestScore - 1e-9) {
      st.best = segs;
      st.bestObj = sc.obj;
      st.bestScore = sc.cov;
      st.lastImproveT = tSec;
      if (doRestart) st.restartFails = 0;
      st.history.push({ t: Math.round(tSec * 10) / 10, score: Math.round(sc.cov * 10000) / 100 });
    } else if (doRestart) {
      st.restartFails++;
    }
    if (tSec - st.lastBeat > 5 && st.bestScore > -Infinity) {
      st.lastBeat = tSec;
      st.history.push({ t: Math.round(tSec * 10) / 10, score: Math.round(st.bestScore * 10000) / 100 });
    }
    setOptRun({
      running: true, mode: cfg.mode, iter: st.iter, restarts: st.restarts, refines: st.refines,
      evaluated: st.evaluated, bestScore: st.bestScore, baselineScore: st.baselineScore,
      elapsed: tSec, lastImproveT: st.lastImproveT, history: st.history.slice(),
    });
    setTimeout(optTick, 0);
  };

  const startOptimize = () => {
    if (optRef.current && !optRef.current.abort) return;
    const mode = optMode;
    const cfg = {
      mode,
      baseline: baselineBoard.map(cloneSeg),
      rules: JSON.parse(JSON.stringify(rules)),
      ptRules: ptEnabled ? JSON.parse(JSON.stringify(ptRules)) : {},
      ptCount: ptEnabled ? ptCount : 0,
      allRules: { ...JSON.parse(JSON.stringify(rules)), ...(ptEnabled ? JSON.parse(JSON.stringify(ptRules)) : {}) },
      glob: { ...glob },
      DEM,
      spans: JSON.parse(JSON.stringify(spans)),
      buildN,
      fitEachDay,
    };
    const scoreFn = (segs) => {
      const e = computeEngine(cfg.DEM, buildSupply(segs), false, cfg.glob.minVeh, cfg.spans, 0, cfg.glob.offPeakBias, cfg.glob.coveragePriority, 0, 0, cfg.glob);
      return { obj: e.weekObjective, cov: e.weekScore };
    };
    const baseline = mode === "retime" ? scoreFn(cfg.baseline) : null;
    const disruptionFraction = (segs) => {
      if (!segs) return 0;
      const orig = new Map(cfg.baseline.map((s) => [s.shift, s.s]));
      const mins = segs.map((s) => Math.abs(s.s - (orig.get(s.shift) ?? s.s)));
      const meanMin = mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : 0;
      return stabilityFraction(meanMin, SLIDE_MAX_MIN, cfg.glob.scheduleStability || 0);
    };
    optRef.current = {
      abort: false, cfg, scoreFn, disruptionFraction,
      best: mode === "retime" ? cfg.baseline : null,
      bestObj: mode === "retime" ? baseline.obj : -Infinity,
      bestScore: mode === "retime" ? baseline.cov : -Infinity,
      baselineScore: baseline ? baseline.cov : null,
      iter: 0, restarts: 0, refines: 0, evaluated: 0, restartFails: 0,
      startedAt: performance.now(), lastImproveT: 0, lastBeat: 0,
      history: mode === "retime" ? [{ t: 0, score: Math.round(baseline.cov * 10000) / 100 }] : [],
    };
    setOptRun({ running: true, mode, iter: 0, restarts: 0, refines: 0, evaluated: 0, bestScore: null, baselineScore: optRef.current.baselineScore, elapsed: 0, lastImproveT: 0, history: [] });
    setTimeout(optTick, 0);
  };

  const stopOptimize = () => {
    const st = optRef.current;
    if (!st || st.abort) return;
    st.abort = true;
    if (st.best) {
      const engineArgs = [st.cfg.DEM, false, st.cfg.glob.minVeh, st.cfg.spans, 0];
      const polished = st.cfg.fitEachDay
        ? deepOptimize(st.best, engineArgs, st.cfg.allRules, st.cfg.glob, st.cfg.baseline).board
        : optimizeToConvergence(st.best, engineArgs, st.cfg.allRules, st.cfg.glob, 25, st.cfg.baseline).board;
      const pScore = st.scoreFn(polished);
      const pGain = pScore.obj - st.bestObj;
      if (pGain * (1 - st.disruptionFraction(polished)) >= 0 && pScore.cov >= st.bestScore - 1e-9) {
        st.best = polished; st.bestObj = pScore.obj; st.bestScore = pScore.cov;
      }
      const tSec = (performance.now() - st.startedAt) / 1000;
      st.history.push({ t: Math.round(tSec * 10) / 10, score: Math.round(st.bestScore * 10000) / 100 });
    }
    setOptRun((o) => (o ? {
      ...o, running: false, bestScore: st.bestScore > -Infinity ? st.bestScore : null,
      elapsed: (performance.now() - st.startedAt) / 1000, history: st.history.slice(),
    } : o));
  };

  const loadBest = () => {
    const st = optRef.current;
    if (st && st.best) onLoadBest(st.best);
  };

  return { optRun, optMode, setOptMode, fitEachDay, setFitEachDay, optRunning: !!(optRun && optRun.running), startOptimize, stopOptimize, loadBest };
}

export function OptimizerMonitorCard({ opt, noun, buildN, ptEnabled, ptCount, baselineBoard }) {
  const { optRun, optMode, setOptMode, fitEachDay, setFitEachDay, optRunning, startOptimize, stopOptimize, loadBest } = opt;
  return (
    <div style={{ ...cardStyle, border: `1px solid ${optRunning ? supplyTeal : "var(--border)"}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={hTitle}>Optimization monitor</div>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="radio" checked={optMode === "retime"} disabled={optRunning} onChange={() => setOptMode("retime")} />
          Retime the loaded schedule
        </label>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="radio" checked={optMode === "generate"} disabled={optRunning} onChange={() => setOptMode("generate")} />
          New schedule from rules &amp; demand ({buildN} packages{ptEnabled && ptCount > 0 ? ` + ${ptCount} part-time` : ""})
        </label>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }} title="On stop, split shifts into per-day start times (within the variation limits) so a shift can sit later on days with later demand. Off keeps each shift uniform across its days.">
          <input type="checkbox" checked={fitEachDay} disabled={optRunning} onChange={(e) => setFitEachDay(e.target.checked)} />
          Fit start times to each day's demand
        </label>
        {!optRunning ? (
          <button style={{ ...nudgeBtn, background: ink, color: "#fff", border: `1px solid ${ink}`, marginLeft: "auto", opacity: optMode === "retime" && !baselineBoard.length ? 0.5 : 1 }}
            disabled={optMode === "retime" && !baselineBoard.length}
            onClick={startOptimize}>
            ▶ Start optimizing
          </button>
        ) : (
          <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", border: `1px solid ${gapRed}`, marginLeft: "auto" }} onClick={stopOptimize}>
            ■ Stop
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: sampleGray, marginTop: 6 }}>
        Runs until you stop it: randomized full rebuilds explore different constructions, then the search digs around the best schedule found by re-placing a few shifts at a time with everything else locked. Every move stays within the day's hours and the start-time-variation limits. The best score only ever goes up. Inputs (rules, demand, schedule) are snapshotted when you press Start; keep this page open while it runs. Stopping finishes with a polish pass before the result is final.
      </div>

      {optRun && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0 0" }}>
            <Stat label="Runtime" value={`${Math.floor(optRun.elapsed / 60)}:${String(Math.floor(optRun.elapsed % 60)).padStart(2, "0")}`} sub={optRun.running ? "running" : "stopped"} tone={optRun.running ? supplyTeal : sampleGray} />
            <Stat label="Iterations" value={optRun.iter.toLocaleString()} sub={`${optRun.restarts.toLocaleString()} rebuilds \u00b7 ${optRun.refines.toLocaleString()} refinements`} tone={targetInk} />
            <Stat label="Placements evaluated" value={optRun.evaluated.toLocaleString()} tone={demandAmber} />
            <Stat label="Best weekly coverage"
              value={optRun.bestScore != null ? `${(optRun.bestScore * 100).toFixed(2)}%` : "\u2014"}
              sub={optRun.bestScore != null && optRun.baselineScore != null
                ? `${optRun.bestScore >= optRun.baselineScore ? "+" : ""}${((optRun.bestScore - optRun.baselineScore) * 100).toFixed(2)} vs ${optRun.mode === "retime" ? "loaded schedule" : "single-shot build"}`
                : undefined}
              tone={supplyTeal} />
            <Stat label="Last improvement" value={optRun.lastImproveT > 0 ? `${Math.round(optRun.elapsed - optRun.lastImproveT)}s ago` : "\u2014"} tone={sampleGray} />
          </div>
          {optRun.history.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <ResponsiveContainer width="100%" height={90}>
                <ComposedChart data={optRun.history} margin={{ top: 4, right: 14, left: -14, bottom: 0 }}>
                  <XAxis dataKey="t" tick={{ fontSize: 9.5 }} tickLine={false} unit="s" type="number" domain={[0, "dataMax"]} />
                  <YAxis tick={{ fontSize: 9.5 }} tickLine={false} axisLine={false} domain={["dataMin - 0.05", "dataMax + 0.05"]} width={54} tickFormatter={(v) => v.toFixed(1) + "%"} />
                  <Line type="stepAfter" dataKey="score" stroke={supplyTeal} strokeWidth={1.8} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 11, color: sampleGray, textAlign: "right" }}>best coverage over time</div>
            </div>
          )}
          {optRun.bestScore != null && (
            <button style={{ ...nudgeBtn, marginTop: 10, background: supplyTeal, color: "#fff", border: `1px solid ${supplyTeal}` }} onClick={loadBest}>
              Load best into SCHEDULE
            </button>
          )}
        </>
      )}
    </div>
  );
}
