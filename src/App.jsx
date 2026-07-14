import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from "recharts";

import { RAW } from "./sampleData.js";

/* ---------- constants ---------- */
const DAYS = RAW.days;
const WEEKEND_DAYS = new Set(["Saturday", "Sunday"]);
const N = RAW.nslots;
const T0 = RAW.slots0;
const T1 = T0 + N * 5;
const SLOT = (i) => T0 + i * 5;
const fmt = (m) => {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
const ink = "#182430", paper = "#F4F6F7", card = "#FFFFFF",
  demandAmber = "#D98324", targetInk = "#233746", supplyTeal = "#0F7B7A",
  gapRed = "#C0392B", bookoutViolet = "#6C5B9E", sampleGray = "#5B6B75";
const DEM_SOURCE_LABEL = { imported: "Sample data", sketched: "Sketched demand", uploaded: "Uploaded real data" };
// pinned-header stacking: fixed heights (with a small buffer) for the sticky Signup Package
// banner + day paddles and the .kpistrip, so each locked layer sits directly under the last.
const ENVELOPE_H = 132;
const KPI_H = 52;
const TYPE_ORDER = ["AM", "NN", "AX", "NN10", "AX10", "BST", "BX", "BS"];
const TYPE_COLOR = {
  AM: "#0F7B7A", NN: "#2E86AB", AX: "#6C5B9E", NN10: "#1B6E53",
  AX10: "#8E5B3B", BST: "#B07D2B", BX: "#7A3E5F", BS: "#4B5D67",
};
// colors handed to types created or renamed at runtime — same muted family as TYPE_COLOR,
// cycled in order so each new code stays visually distinct from the shipped ones
const TYPE_COLOR_EXTRA = ["#3E6B8A", "#7A6C3E", "#5F7A3E", "#8A3E52", "#3E8A78", "#6B3E8A", "#8A5E3E", "#4A4A72"];
const IMPORTED_DEM = (() => {
  const o = {};
  for (const d of DAYS) {
    o[d] = [];
    for (let i = 0; i < N; i++) o[d].push(RAW.demand[d].pu[i] + RAW.demand[d].do[i]);
  }
  return o;
})();
const cloneSeg = (s) => ({ ...s, b: s.b ? [...s.b] : null, days: s.days ? [...s.days] : undefined });

// Scans a baseline board's distinct shift numbers ascending and collapses consecutive
// same-type runs into ordered blocks — e.g. shifts 101-104 all AX, 105-107 all NN becomes
// [{type:"AX",count:4},{type:"NN",count:3}]. Used to make structure-aware generation follow
// the same shift-type/number-block convention the uploaded signup already uses.
function deriveTypeBlocks(baseline) {
  const byShift = new Map();
  for (const sg of baseline) if (!byShift.has(sg.shift)) byShift.set(sg.shift, sg.type);
  const shiftNums = [...byShift.keys()].sort((a, b) => a - b);
  const blocks = [];
  for (const sh of shiftNums) {
    const type = byShift.get(sh);
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.count++;
    else blocks.push({ type, count: 1 });
  }
  return blocks;
}
// Cycles the blocks in order to produce one type per package slot — fills the first
// category completely before moving to the next, wrapping back to the first block if
// nPackages exceeds the baseline's total shift count.
function buildTypeSequence(blocks, nPackages) {
  if (!blocks.length) return null;
  const seq = [];
  let bi = 0, remaining = blocks[0].count;
  while (seq.length < nPackages) {
    seq.push(blocks[bi].type);
    remaining--;
    if (remaining <= 0) { bi = (bi + 1) % blocks.length; remaining = blocks[bi].count; }
  }
  return seq;
}

/* ---------- editable rule defaults ---------- */
const DEFAULT_RULES = JSON.parse(JSON.stringify(RAW.rules));
const DEFAULT_GLOBAL = JSON.parse(JSON.stringify(RAW.global));
// "Average trip cycle time" (pickup to dropoff to next pickup, including deadhead) is the
// user-facing input — more intuitive to estimate from real experience than an abstract
// trips/vehicle-hour ratio. Productivity is derived from it wherever needed (60 / cycle time),
// never stored directly, so there's a single source of truth. (Old project files without
// this field still migrate from their saved productivity value in loadProject.)
const DEFAULT_AVG_CYCLE_TIME = 31;
// Share of total demand this signup's fleet serves (%). Multi-provider systems upload
// system-wide demand but sign up only their own vehicles — absolute displays (suggested
// vehicles, productivity calibration) must scale by this or they describe a fleet that
// doesn't exist. Coverage scoring is scale-free and ignores it entirely.
const DEFAULT_DEMAND_SHARE = 50;
const DEFAULT_SPANS = {
  Sunday: [360, 1440], Saturday: [360, 1485],
  Monday: [315, 1440], Tuesday: [315, 1440], Wednesday: [315, 1440],
  Thursday: [315, 1440], Friday: [315, 1485],
};
const parseHM = (str) => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(str || "");
  if (!m) return null;
  const v = parseInt(m[1]) * 60 + parseInt(m[2]);
  return v >= 0 && v <= T1 && parseInt(m[2]) < 60 ? v : null;
};
// Same as parseHM but also accepts military HHMM with no colon (e.g. "1310") — real agency
// exports commonly use this in Break Start/Break End columns even when Report Time/Off use
// colons, since it's carried over from the older single combined "Break" column's format.
const parseHMFlexible = (str) => {
  const direct = parseHM(str);
  if (direct != null) return direct;
  const m = /^\s*(\d{1,2})(\d{2})\s*$/.exec(str || "");
  if (!m) return null;
  const v = parseInt(m[1]) * 60 + parseInt(m[2]);
  return v >= 0 && v <= T1 && parseInt(m[2]) < 60 ? v : null;
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Parses a literal calendar date out of a "Days Worked" cell (e.g. a stat-holiday row uses
// a specific date instead of weekday codes). `raw` may be a raw worksheet cell object (native
// Excel dates, and — critically — SheetJS's CSV reader auto-detects date-like text like
// "August 3, 2026" and silently replaces it with a serial-date number before this ever runs,
// so a plain string parse alone would miss real-world CSV uploads entirely) or a plain string.
// Deliberately narrow otherwise: only ISO "YYYY-MM-DD" and "Month D, YYYY" (full or 3-letter
// month, comma optional) — never a bare `new Date(raw)` on free text (implementation-defined
// across engines), and never numeric M/D/YYYY (US-vs-international order is genuinely
// ambiguous; a wrong guess would silently misfile a shift under the wrong date).
const parseLiteralDate = (raw) => {
  if (raw && typeof raw === "object" && raw.t === "n" && typeof raw.v === "number") {
    const dc = XLSX.SSF.parse_date_code(Math.round(raw.v));
    if (!dc) return null;
    return `${dc.y}-${String(dc.m).padStart(2, "0")}-${String(dc.d).padStart(2, "0")}`;
  }
  const s = String((raw && typeof raw === "object" ? raw.w : raw) || "").trim();
  if (!s) return null;
  const validate = (y, mo, d) => {
    const dt = new Date(`${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00`);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
    return `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validate(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const word = m[1].toLowerCase();
    const mo = MONTH_NAMES.findIndex((mn) => mn === word || mn.slice(0, 3) === word);
    if (mo < 0) return null;
    return validate(parseInt(m[3]), mo, parseInt(m[2]));
  }
  return null;
};

/* ---------- signup import (real or template signup roster -> board segments) ---------- */
const SIGNUP_HEADER_ALIASES = {
  shiftNo: ["shift no", "shift no.", "shift number"],
  run: ["run"],
  daysOff: ["days off"],
  type: ["type", "shift type"],
  splitType: ["split type", "split shift type"],
  brk: ["break", "split"],
  breakStart: ["break start"],
  breakEnd: ["break end"],
  daysWorked: ["days worked"],
  start: ["report time"],
  end: ["off"],
};
const DOW_CODE = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
const EXCEPTION_DEFAULT_TYPE = "AX";

function parseSignupWorkbook(wb, sheetName, classifyRules = DEFAULT_RULES) {
  const name = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames.find((n) => n.toLowerCase() !== "instructions") || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) return { ok: false, error: "The file has no readable sheet." };
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (!rows.length) return { ok: false, error: "The file has no rows." };

  const headerRow = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const colIndex = {};
  for (const [key, aliases] of Object.entries(SIGNUP_HEADER_ALIASES)) {
    colIndex[key] = headerRow.findIndex((h) => aliases.includes(h));
  }
  if (colIndex.shiftNo < 0 || colIndex.daysWorked < 0 || colIndex.start < 0 || colIndex.end < 0) {
    return { ok: false, error: "Couldn't find required columns (Shift No, Days Worked, Report Time, Off). Check the file matches the template." };
  }

  const parseDaysWorked = (raw) => {
    const tokens = String(raw || "").toUpperCase().match(/[A-Z]{2}/g) || [];
    const days = [];
    for (const t of tokens) if (DOW_CODE[t] && !days.includes(DOW_CODE[t])) days.push(DOW_CODE[t]);
    return days;
  };

  // shared by regular and exception-day rows: report time / off + break, in whichever
  // of the two break-column conventions the file uses (two-column, or the older
  // single combined "HHMM-HHMM" column, which real-world exports and this app's own
  // Export board still use)
  const parseRowTimesAndBreak = (row) => {
    const start = parseHM(String(row[colIndex.start] || "").trim());
    let end = parseHM(String(row[colIndex.end] || "").trim());
    if (start == null || end == null) return { s: null, e: null, b: null };
    if (end < start) end += 1440;

    let b = null;
    if (colIndex.breakStart >= 0 && colIndex.breakEnd >= 0) {
      const bStartRaw = String(row[colIndex.breakStart] || "").trim();
      const bEndRaw = String(row[colIndex.breakEnd] || "").trim();
      if (bStartRaw && bEndRaw) {
        const b0 = parseHMFlexible(bStartRaw);
        let b1 = parseHMFlexible(bEndRaw);
        if (b0 != null && b1 != null) {
          if (b1 < b0) b1 += 1440;
          b = [b0, b1];
        }
      }
    }
    if (!b && colIndex.brk >= 0) {
      const bm = /^\s*(\d{1,2})(\d{2})\s*-\s*(\d{1,2})(\d{2})\s*$/.exec(String(row[colIndex.brk] || "").trim());
      if (bm) {
        const b0 = parseInt(bm[1]) * 60 + parseInt(bm[2]);
        let b1 = parseInt(bm[3]) * 60 + parseInt(bm[4]);
        if (b1 < b0) b1 += 1440;
        b = [b0, b1];
      }
    }
    return { s: start, e: end, b };
  };

  // pass 1: collect valid rows grouped by shift number — continuation rows in real
  // exports can leave Type/Days Off/Split Type blank on ANY row of a shift's group,
  // not necessarily after the row that carries the value, so grouping has to happen
  // before resolving those fields (a simple "inherit from the last row seen" doesn't
  // work when the blank row comes first).
  const rawByShift = new Map();
  const shiftOrder = [];
  const rawExceptions = [];
  let footerRowsSkipped = 0, dateSpecificSkipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c === "" || c == null)) continue;
    const shiftNo = Number(row[colIndex.shiftNo]);
    if (!Number.isFinite(shiftNo) || shiftNo <= 0 || !Number.isInteger(shiftNo)) { footerRowsSkipped++; continue; }

    const days = parseDaysWorked(row[colIndex.daysWorked]);
    if (days.length === 0) {
      // Not weekday codes — either a stat-holiday/one-off variant of this shift (if it
      // carries a Run number and the cell parses as a literal date) or an undecipherable
      // date-specific relief row (left as-is, silently skipped, same as always).
      if (colIndex.run >= 0) {
        const runRaw = String(row[colIndex.run] || "").trim();
        const dwCell = ws[XLSX.utils.encode_cell({ r, c: colIndex.daysWorked })];
        const dateISO = parseLiteralDate(dwCell != null ? dwCell : row[colIndex.daysWorked]);
        if (dateISO && runRaw) {
          const { s, e, b } = parseRowTimesAndBreak(row);
          if (s == null || e == null) { footerRowsSkipped++; continue; }
          rawExceptions.push({
            shiftNo, run: runRaw, dateISO,
            typeRaw: colIndex.type >= 0 ? String(row[colIndex.type] || "").trim() : "",
            s, e, b,
          });
          continue;
        }
      }
      dateSpecificSkipped++; continue;
    }

    const { s: start, e: end, b } = parseRowTimesAndBreak(row);
    if (start == null || end == null) { footerRowsSkipped++; continue; }

    if (!rawByShift.has(shiftNo)) { rawByShift.set(shiftNo, []); shiftOrder.push(shiftNo); }
    rawByShift.get(shiftNo).push({
      typeRaw: colIndex.type >= 0 ? String(row[colIndex.type] || "").trim() : "",
      daysOffRaw: colIndex.daysOff >= 0 ? String(row[colIndex.daysOff] || "").trim() : "",
      splitTypeRaw: colIndex.splitType >= 0 ? String(row[colIndex.splitType] || "").trim() : "",
      run: colIndex.run >= 0 ? String(row[colIndex.run] || "").trim() : String(shiftNo),
      days, s: start, e: end, b,
    });
  }
  if (rawByShift.size === 0 && rawExceptions.length === 0) return { ok: false, error: "No usable rows found — check the file matches the template." };

  // pass 2: resolve each shift's canonical type/days-off/split-type from whichever
  // row in its group carries it, then build one segment per row.
  // Shifts with NO classification anywhere in their group get auto-classified by
  // matching their actual times against every rule type's windows (start, end, spread,
  // work hours, break-allowed) — every row of the package must fit. A unique fit is
  // assigned outright; multiple fits take the type with the tightest windows (most
  // specific); no fit stays blank and is flagged downstream as always.
  const classifyGroup = (group) => {
    let best = null, bestSpan = Infinity, matches = 0;
    for (const [t, R] of Object.entries(classifyRules)) {
      let ok = true;
      for (const g of group) {
        const spread = g.e - g.s;
        const brkLen = g.b ? g.b[1] - g.b[0] : 0;
        const work = spread - brkLen;
        if (g.s < R.s[0] || g.s > R.s[1] || g.e < R.e[0] || g.e > R.e[1] ||
          spread < R.spr[0] || spread > R.spr[1] || Math.abs(work - R.work) > 1 ||
          (!R.brk && g.b)) { ok = false; break; }
      }
      if (!ok) continue;
      matches++;
      const span = (R.s[1] - R.s[0]) + (R.e[1] - R.e[0]) + (R.spr[1] - R.spr[0]);
      if (span < bestSpan) { bestSpan = span; best = t; }
    }
    return { best, matches };
  };
  const segments = [];
  let nextTempId = 1;
  const unrecognizedTypes = new Set();
  const resolvedTypeByShift = new Map();
  let autoClassified = 0, ambiguousClassified = 0, unclassified = 0;
  for (const shiftNo of shiftOrder) {
    const group = rawByShift.get(shiftNo);
    let type = (group.find((g) => g.typeRaw) || {}).typeRaw || "";
    if (!type) {
      const c = classifyGroup(group);
      if (c.best) {
        type = c.best;
        autoClassified++;
        if (c.matches > 1) ambiguousClassified++;
      } else {
        unclassified++;
      }
    }
    const splitType = (group.find((g) => g.splitTypeRaw) || {}).splitTypeRaw || "";
    let daysOff = (group.find((g) => g.daysOffRaw) || {}).daysOffRaw || "";
    if (!daysOff) {
      const worked = new Set();
      for (const g of group) for (const d of g.days) worked.add(d);
      daysOff = DAYS.filter((d) => !worked.has(d)).map((d) => d.slice(0, 2).toUpperCase()).join("-");
    }
    resolvedTypeByShift.set(shiftNo, type);
    if (type && !classifyRules[type]) unrecognizedTypes.add(type);
    for (const g of group) {
      segments.push({
        id: nextTempId++, shift: shiftNo, run: g.run,
        type, daysOff, splitType: splitType || (g.b ? "Split Break" : "Straight"),
        days: g.days, s: g.s, e: g.e, b: g.b,
      });
    }
  }

  // pass 3: resolve each stat-holiday/one-off row's type (its own value, else the same
  // shift's regular weekly type if that shift also appears with weekday-coded rows in
  // this file, else a sensible default) and group into one entry per calendar date —
  // multiple rows (different shifts) can land on the same date.
  const exceptionsByDate = new Map();
  for (const ex of rawExceptions) {
    let type = ex.typeRaw || resolvedTypeByShift.get(ex.shiftNo) || EXCEPTION_DEFAULT_TYPE;
    if (type && !classifyRules[type]) unrecognizedTypes.add(type);
    if (!exceptionsByDate.has(ex.dateISO)) exceptionsByDate.set(ex.dateISO, []);
    exceptionsByDate.get(ex.dateISO).push({ type, s: ex.s, e: ex.e, b: ex.b, sourceShift: ex.shiftNo, sourceRun: ex.run });
  }
  const exceptionDays = [...exceptionsByDate.entries()]
    .map(([date, segs]) => ({ date, segs }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    ok: true, segments, exceptionDays,
    summary: {
      shifts: shiftOrder.length, rows: segments.length,
      dateSpecificSkipped, footerRowsSkipped,
      unrecognizedTypes: [...unrecognizedTypes],
      autoClassified, ambiguousClassified, unclassified,
      exceptionDates: exceptionDays.length,
      exceptionRows: exceptionDays.reduce((n, ed) => n + ed.segs.length, 0),
    },
  };
}

function TimeField({ value, onCommit, width = 62 }) {
  const [txt, setTxt] = useState(fmt(value));
  const [bad, setBad] = useState(false);
  React.useEffect(() => { setTxt(fmt(value)); setBad(false); }, [value]);
  return (
    <input value={txt} inputMode="numeric"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        const v = parseHM(txt);
        if (v == null) { setBad(true); return; }
        setBad(false); onCommit(v);
      }}
      style={{
        width, padding: "5px 6px", border: `1px solid ${bad ? "#C0392B" : "#B9C6CC"}`,
        background: "#fff", color: "#182430", borderRadius: 2, fontSize: 13,
        textAlign: "center", fontVariantNumeric: "tabular-nums",
      }} />
  );
}

function NumField({ value, onCommit, width = 58, style: styleOverride }) {
  const [txt, setTxt] = useState(String(value));
  const focused = useRef(false);
  React.useEffect(() => { if (!focused.current) setTxt(String(value)); }, [value]);
  return (
    <input type="text" inputMode="decimal" value={txt}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const raw = e.target.value;
        setTxt(raw);
        if (raw.trim() === "") return;
        const v = parseFloat(raw);
        if (!isNaN(v)) onCommit(v);
      }}
      onBlur={() => {
        focused.current = false;
        const v = parseFloat(txt);
        setTxt(String(isNaN(v) ? value : v));
      }}
      style={{
        width, padding: "5px 6px", border: "1px solid #B9C6CC", background: "#fff",
        color: "#182430", borderRadius: 2, fontSize: 13, textAlign: "center",
        ...styleOverride,
      }} />
  );
}

/* ---------- signup period & statutory holidays ---------- */
function computeHolidaysInRange(hd, startISO, endISO) {
  const startY = +startISO.slice(0, 4), endY = +endISO.slice(0, 4);
  const byDate = new Map();
  for (let y = startY; y <= endY; y++) {
    for (const h of hd.getHolidays(y)) {
      if (h.type !== "public") continue;
      const d = h.date.slice(0, 10);
      if (d < startISO || d > endISO) continue;
      if (!byDate.has(d)) byDate.set(d, h.name);
    }
  }
  return [...byDate.entries()].map(([date, name]) => ({ date, name })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function mergeHolidayEdits(detected, existing) {
  const customDates = new Set(existing.filter((h) => h.source === "custom").map((h) => h.date));
  const prevAuto = new Map(existing.filter((h) => h.source === "auto").map((h) => [h.date, h]));
  const merged = detected
    .filter((d) => !customDates.has(d.date))
    .map((d) =>
      prevAuto.has(d.date)
        ? { ...prevAuto.get(d.date), name: d.name }
        : { id: "auto:" + d.date, date: d.date, name: d.name, source: "auto", runsAs: null, segs: [] }
    );
  const custom = existing.filter((h) => h.source === "custom");
  return [...merged, ...custom].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ---------- supply from a board ---------- */
function buildSupply(board) {
  const cov = {};
  for (const d of DAYS) cov[d] = new Array(N).fill(0);
  for (const seg of board) {
    for (const d of seg.days) {
      const arr = cov[d];
      for (let i = 0; i < N; i++) {
        const t = SLOT(i);
        let on = seg.s <= t && t < seg.e;
        if (on && seg.b && seg.b[0] <= t && t < seg.b[1]) on = false;
        if (on) arr[i]++;
      }
    }
  }
  return cov;
}

/* ---------- rules ---------- */
function validateSeg(seg, RULES, G) {
  const issues = [];
  const R = RULES[seg.type];
  if (!R) issues.push(`Type "${seg.type}" is not defined in Rules`);
  const spread = seg.e - seg.s;
  const brkLen = seg.b ? seg.b[1] - seg.b[0] : 0;
  const work = spread - brkLen;
  if (R) {
    if (seg.s < R.s[0] || seg.s > R.s[1])
      issues.push(`${seg.type} start window is ${fmt(R.s[0])}–${fmt(R.s[1])}; this starts ${fmt(seg.s)}`);
    if (seg.e < R.e[0] || seg.e > R.e[1])
      issues.push(`${seg.type} end window is ${fmt(R.e[0])}–${fmt(R.e[1])}; this ends ${fmt(seg.e)}`);
    if (spread < R.spr[0] || spread > R.spr[1])
      issues.push(`Spread ${(spread / 60).toFixed(2)}h outside ${R.spr[0] / 60}–${R.spr[1] / 60}h for ${seg.type}`);
    if (Math.abs(work - R.work) > 1)
      issues.push(`Working time ${(work / 60).toFixed(2)}h ≠ ${R.work / 60}h for ${seg.type}`);
    if (!R.brk && seg.b) issues.push(`${seg.type} does not take a scheduled break`);
  }
  if (seg.b) {
    if (brkLen < G.brkLen[0] || brkLen > G.brkLen[1])
      issues.push(`Break ${brkLen} min outside ${G.brkLen[0]}–${G.brkLen[1]} min`);
    const before = seg.b[0] - seg.s;
    if (before < G.brkAfter[0] || before > G.brkAfter[1])
      issues.push(`Break begins ${(before / 60).toFixed(2)}h in; window is ${G.brkAfter[0] / 60}–${G.brkAfter[1] / 60}h of work first`);
    if (seg.b[0] < seg.s || seg.b[1] > seg.e) issues.push(`Break falls outside the shift`);
  }
  if (seg.days && seg.days.length === 0) issues.push(`No working days assigned`);
  return issues;
}

/* ---------- autofix ---------- */
function autofixSeg(seg, rules, glob) {
  const R = rules[seg.type];
  if (!R) return null;
  const snap = (v) => Math.round(v / 5) * 5;

  // break length: keep what the shift had, clamped legal; never invent one it didn't have
  let bl = 0;
  const roomMax = R.spr[1] - R.work;
  if (R.brk && seg.b) {
    const hi = Math.min(glob.brkLen[1], roomMax);
    if (hi >= glob.brkLen[0]) bl = snap(Math.max(glob.brkLen[0], Math.min(hi, seg.b[1] - seg.b[0])));
  }
  let spread = R.work + bl;
  if (spread < R.spr[0] && R.brk) {
    const need = R.spr[0] - R.work;
    const hi = Math.min(glob.brkLen[1], roomMax);
    if (need <= hi) { bl = snap(Math.max(need, glob.brkLen[0])); spread = R.work + bl; }
  }
  if (spread > R.spr[1]) {
    bl = Math.max(0, R.spr[1] - R.work);
    if (bl > 0 && bl < glob.brkLen[0]) bl = 0;
    spread = R.work + bl;
  }
  if (spread < R.spr[0] || spread > R.spr[1]) return null;

  // start: nearest legal position satisfying both start and end windows
  const sLo = Math.max(Math.ceil(R.s[0] / 5) * 5, R.e[0] - spread);
  const sHi = Math.min(Math.floor(R.s[1] / 5) * 5, R.e[1] - spread);
  if (sLo > sHi) return null;
  const s = Math.max(sLo, Math.min(sHi, snap(seg.s)));
  const e = s + spread;

  let b = null;
  if (bl > 0) {
    const offLo = Math.ceil(glob.brkAfter[0] / 5) * 5;
    const offHi = Math.min(glob.brkAfter[1], R.work);
    let off = seg.b ? seg.b[0] - seg.s : offLo;
    off = snap(Math.max(offLo, Math.min(offHi, off)));
    b = [s + off, s + off + bl];
  }
  const fixed = { ...seg, s, e, b: b, days: seg.days ? [...seg.days] : undefined };
  const before = validateSeg(seg, rules, glob).length;
  const after = validateSeg(fixed, rules, glob).length;
  return after === 0 || after < before ? fixed : null;
}

/* ---------- engine ---------- */
// concave demand weighting: w = ev^gamma, gamma = 1 − offPeakBias/100. Light slots gain
// relative claim, peaks lose — off-peak trips ride mostly alone while peak trips share,
// so a trip at the edges of service genuinely needs more of a vehicle. bias 0 → identity
// (proportional, the original objective). 0^gamma = 0: no-demand slots never attract target.
const demandGamma = (glob) => 1 - Math.min(60, Math.max(0, glob.offPeakBias || 0)) / 100;
const weightEv = (v, gamma) => (gamma === 1 ? v : Math.pow(v, gamma));

function computeEngine(DEM, ftCov, includePT, minVeh, SPANS, maxFleet, offPeakBias = 0) {
  const gamma = demandGamma({ offPeakBias });
  const perDay = {};
  let weekW = 0, weekSupSlots = 0;
  for (const d of DAYS) {
    const ev = [], w = [], sup = [];
    for (let i = 0; i < N; i++) {
      const e = DEM[d][i];
      ev.push(e);
      const we = weightEv(e, gamma);
      w.push(we);
      const s = ftCov[d][i] + (includePT ? RAW.pt[d][i] : 0);
      sup.push(s);
      weekW += we; weekSupSlots += s;
    }
    perDay[d] = { ev, w, sup };
  }
  // demandShare (day paddles) stays TRUE trip share; all scoring below uses w-shares
  let weekEvents = 0;
  for (const d of DAYS) weekEvents += perDay[d].ev.reduce((a, b) => a + b, 0);
  let weekScore = 0;
  for (const d of DAYS) {
    const p = perDay[d];
    const dayEv = p.ev.reduce((a, b) => a + b, 0);
    const dayW = p.w.reduce((a, b) => a + b, 0);
    const daySupSlots = p.sup.reduce((a, b) => a + b, 0);
    const [s0, s1] = SPANS[d];
    let dayScore = 0;
    const target = [];
    for (let i = 0; i < N; i++) {
      const dSh = dayW > 0 ? p.w[i] / dayW : 0;
      const sSh = daySupSlots > 0 ? p.sup[i] / daySupSlots : 0;
      dayScore += Math.min(dSh, sSh);
      target.push(dSh * daySupSlots);
    }
    for (let i = 0; i < N; i++)
      weekScore += Math.min(weekW > 0 ? p.w[i] / weekW : 0, weekSupSlots > 0 ? p.sup[i] / weekSupSlots : 0);
    const gaps = [];
    let cur = null;
    for (let i = 0; i < N; i++) {
      const dSh = dayW > 0 ? p.w[i] / dayW : 0;
      const sSh = daySupSlots > 0 ? p.sup[i] / daySupSlots : 0;
      const deficit = dSh - sSh;
      if (deficit > 1e-9) {
        if (!cur) cur = { from: i, to: i, weight: deficit, maxVeh: target[i] - p.sup[i] };
        else { cur.to = i; cur.weight += deficit; cur.maxVeh = Math.max(cur.maxVeh, target[i] - p.sup[i]); }
      } else if (cur) { gaps.push(cur); cur = null; }
    }
    if (cur) gaps.push(cur);
    gaps.sort((a, b) => b.weight - a.weight);
    const floorViol = [];
    let fc = null;
    for (let i = 0; i < N; i++) {
      const t = SLOT(i);
      if (t >= s0 && t < s1 && p.sup[i] < minVeh) {
        if (!fc) fc = { from: i, to: i, min: p.sup[i] };
        else { fc.to = i; fc.min = Math.min(fc.min, p.sup[i]); }
      } else if (fc) { floorViol.push(fc); fc = null; }
    }
    if (fc) floorViol.push(fc);
    const fleetViol = [];
    let fv = null;
    for (let i = 0; i < N; i++) {
      if (maxFleet > 0 && p.sup[i] > maxFleet) {
        if (!fv) fv = { from: i, to: i, max: p.sup[i] };
        else { fv.to = i; fv.max = Math.max(fv.max, p.sup[i]); }
      } else if (fv) { fleetViol.push(fv); fv = null; }
    }
    if (fv) fleetViol.push(fv);
    Object.assign(perDay[d], {
      dayEv, dayW, daySupSlots, dayScore, target, gaps, floorViol, fleetViol,
      supVH: daySupSlots / 12,
      misallocVH: (1 - dayScore) * daySupSlots / 12,
      peakSup: Math.max(...p.sup),
    });
  }
  let weekSupVH = 0;
  for (const d of DAYS) weekSupVH += perDay[d].supVH;
  for (const d of DAYS) {
    perDay[d].demandShare = weekEvents > 0 ? perDay[d].dayEv / weekEvents : 0;
    perDay[d].resourceShare = weekSupVH > 0 ? perDay[d].supVH / weekSupVH : 0;
  }
  return { perDay, weekScore, weekSupVH, weekW };
}

/* ---------- suggestions ---------- */
function segContrib(seg) {
  const a = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const t = SLOT(i);
    let on = seg.s <= t && t < seg.e;
    if (on && seg.b && seg.b[0] <= t && t < seg.b[1]) on = false;
    if (on) a[i] = 1;
  }
  return a;
}

const SLIDES = [-60, -45, -30, -20, -15, -10, -5, 5, 10, 15, 20, 30, 45, 60];
const BRK_SLIDES = [-90, -60, -45, -30, -15, -10, -5, 5, 10, 15, 30, 45, 60, 90];

function startsPerSlot(board) {
  const starts = {};
  for (const d of DAYS) starts[d] = new Array(N).fill(0);
  for (const sg of board) {
    const k = Math.floor((sg.s - T0) / 5);
    if (k >= 0 && k < N) for (const d of sg.days) starts[d][k]++;
  }
  return starts;
}

function findSuggestions(board, eng, DEM, rules, glob) {
  const starts = startsPerSlot(board);
  const maxPull = glob.maxPullout || 0;
  let evaluated = 0;
  // weighted shares (p.w / dayW) so suggestions chase the same objective the engine scores
  let weekEv = 0, weekSup = 0;
  for (const d of DAYS) {
    weekEv += eng.perDay[d].dayW;
    weekSup += eng.perDay[d].daySupSlots;
  }
  const termBase = {};
  for (const d of DAYS) {
    let t = 0;
    const p = eng.perDay[d];
    for (let i = 0; i < N; i++) t += Math.min(p.w[i] / weekEv, p.sup[i] / weekSup);
    termBase[d] = t;
  }
  const out = [];
  for (const seg of board) {
    const baseIssues = validateSeg(seg, rules, glob).length;
    const oldC = segContrib(seg);
    const tryCand = (cand, label) => {
      evaluated++;
      if (validateSeg(cand, rules, glob).length > baseIssues) return;
      if (maxPull > 0 && cand.s !== seg.s) {
        const k = Math.floor((cand.s - T0) / 5);
        if (k >= 0 && k < N) {
          for (const d of cand.days) {
            if (starts[d][k] >= maxPull) return; // would crowd sign-in slot
          }
        }
      }
      const newC = segContrib(cand);
      let delta = 0;
      for (const d of cand.days) {
        const p = eng.perDay[d];
        let term = 0, fleetBad = false;
        for (let i = 0; i < N; i++) {
          const ns = p.sup[i] - oldC[i] + newC[i];
          if (glob.maxFleet > 0 && ns > glob.maxFleet && p.sup[i] <= glob.maxFleet) { fleetBad = true; break; }
          term += Math.min(p.w[i] / weekEv, ns / weekSup);
        }
        if (fleetBad) return;
        delta += term - termBase[d];
      }
      if (delta > 0.0004) out.push({ id: seg.id, shift: seg.shift, run: seg.run, type: seg.type, label, delta, payload: { s: cand.s, e: cand.e, b: cand.b } });
    };
    for (const m of SLIDES) {
      const cand = { ...seg, s: seg.s + m, e: seg.e + m, b: seg.b ? [seg.b[0] + m, seg.b[1] + m] : null };
      tryCand(cand, `slide ${m > 0 ? "+" : ""}${m} min → ${fmt(seg.s + m)}–${fmt(seg.e + m)}`);
    }
    if (seg.b) {
      for (const m of BRK_SLIDES) {
        const cand = { ...seg, b: [seg.b[0] + m, seg.b[1] + m] };
        tryCand(cand, `move break ${m > 0 ? "+" : ""}${m} min → ${fmt(seg.b[0] + m)}–${fmt(seg.b[1] + m)}`);
      }
    }
  }
  out.sort((a, b) => b.delta - a.delta);
  // keep best move per segment, top 12 overall
  const seen = new Set(), top = [];
  for (const s of out) {
    if (seen.has(s.id)) continue;
    seen.add(s.id); top.push(s);
    if (top.length >= 12) break;
  }
  top.evaluated = evaluated;
  return top;
}

/* ---------- auto-builder ---------- */
// shared by generateBoard and retimeBoard: every legal placement shape, one entry per
// type × grid start × (break length × break position, where the type takes one)
const slotIdx = (t) => Math.max(0, Math.min(N, Math.round((t - T0) / 5)));
function buildCandidates(rules, glob) {
  const cands = [];
  for (const [t, R] of Object.entries(rules)) {
    const startLo = Math.ceil(R.s[0] / 5) * 5;
    if (!R.brk) {
      const spread = R.work;
      if (spread < R.spr[0] || spread > R.spr[1]) continue;
      for (let s = startLo; s <= R.s[1]; s += 5) {
        const e = s + spread;
        if (e < R.e[0] || e > R.e[1]) continue;
        cands.push({ type: t, s, e, b: null, work: R.work, is10: R.work === 600, startSlot: slotIdx(s) });
      }
    } else {
      const blLo = Math.max(30, Math.ceil(glob.brkLen[0] / 30) * 30);
      const blHi = Math.min(240, glob.brkLen[1]);
      for (let bl = blLo; bl <= blHi; bl += 30) {
        const spread = R.work + bl;
        if (spread < R.spr[0] || spread > R.spr[1]) continue;
        const offLo = Math.ceil(glob.brkAfter[0] / 30) * 30;
        const offHi = Math.min(glob.brkAfter[1], R.work);
        for (let off = offLo; off <= offHi; off += 30) {
          for (let s = startLo; s <= R.s[1]; s += 5) {
            const e = s + spread;
            if (e < R.e[0] || e > R.e[1]) continue;
            cands.push({ type: t, s, e, b: [s + off, s + off + bl], work: R.work, is10: R.work === 600, startSlot: slotIdx(s) });
          }
        }
      }
    }
  }
  return cands;
}

// opts.rng + opts.noise let the optimization monitor perturb tie-breaks so repeated calls
// explore different constructions; with opts omitted the build is deterministic, exactly
// as the single-shot Generate button has always been.
function generateBoard(tenTarget, nPackages, rules, glob, DEM, spans, minVeh, includePT, typeSequence = null, startShiftNumber = null, opts = {}) {
  const rng = opts.rng || null;
  const noise = rng && opts.noise > 0 ? opts.noise : 0;
  let evaluated = 0;
  const gammaG = demandGamma(glob);
  const WD = {};
  for (const d of DAYS) WD[d] = gammaG === 1 ? DEM[d] : DEM[d].map((v) => weightEv(v, gammaG));
  let weekEv = 0;
  for (const d of DAYS) weekEv += WD[d].reduce((a, b) => a + b, 0);

  const sup = {};
  for (const d of DAYS) sup[d] = includePT ? RAW.pt[d].slice() : new Array(N).fill(0);
  const ptSlots = includePT ? DAYS.reduce((a, d) => a + RAW.pt[d].reduce((x, y) => x + y, 0), 0) : 0;
  const planned = ptSlots + nPackages * 460;
  const target = {};
  for (const d of DAYS) {
    target[d] = [];
    for (let i = 0; i < N; i++) target[d].push((WD[d][i] / weekEv) * planned);
  }

  const idx = slotIdx;
  const cands = buildCandidates(rules, glob);

  const patterns = { 5: [], 4: [] };
  for (let st = 0; st < 7; st++) {
    patterns[5].push(DAYS.filter((_, i) => i !== st && i !== (st + 1) % 7));
    patterns[4].push(DAYS.filter((_, i) => i !== st && i !== (st + 1) % 7 && i !== (st + 2) % 7));
  }

  const maxPull = glob.maxPullout || 0;
  const outSlots = Math.round((glob.deadheadOutMin || 0) / 5);
  const inSlots = Math.round((glob.deadheadInMin || 0) / 5);
  const starts = {};
  for (const d of DAYS) starts[d] = new Array(N).fill(0);
  let used10 = 0;
  const packs = [];

  for (let p = 0; p < nPackages; p++) {
    // per-day prefix sums of marginal gain and at-fleet-cap counts → O(1) per candidate-day
    const PG = {}, PC = {};
    for (const d of DAYS) {
      const [s0, s1] = spans[d];
      const pg = new Array(N + 1).fill(0), pc = new Array(N + 1).fill(0);
      for (let i = 0; i < N; i++) {
        let tgt = target[d][i];
        if (outSlots > 0) tgt = Math.max(tgt, target[d][Math.min(N - 1, i + outSlots)]);
        if (inSlots > 0) tgt = Math.max(tgt, target[d][Math.max(0, i - inSlots)]);
        let g = Math.max(0, Math.min(1, tgt - sup[d][i]));
        const t = SLOT(i);
        if (t >= s0 && t < s1 && sup[d][i] < minVeh) g += 0.5;
        pg[i + 1] = pg[i] + g;
        pc[i + 1] = pc[i] + (glob.maxFleet > 0 && sup[d][i] >= glob.maxFleet ? 1 : 0);
      }
      PG[d] = pg; PC[d] = pc;
    }
    const evalDay = (c, d) => {
      // hard constraint: a shift never starts before this day's service span opens or
      // ends after it closes — classification windows are day-agnostic, spans are not
      if (c.s < spans[d][0] || c.e > spans[d][1]) return null;
      if (maxPull > 0 && starts[d][c.startSlot] >= maxPull) return null;
      const a = idx(c.s), z = idx(c.e);
      let cap = PC[d][z] - PC[d][a];
      let g = PG[d][z] - PG[d][a];
      if (c.b) {
        const b0 = idx(c.b[0]), b1 = idx(c.b[1]);
        cap -= PC[d][b1] - PC[d][b0];
        g -= PG[d][b1] - PG[d][b0];
      }
      if (cap > 0) return null; // would exceed fleet cap somewhere it covers
      return g - starts[d][c.startSlot] * 0.15;
    };
    const pick = (only10, forceType) => {
      let best = null, bestVal = -Infinity;
      for (const c of cands) {
        if (forceType && c.type !== forceType) continue;
        if (c.is10 && used10 >= glob.max10) continue;
        if (only10 && !c.is10) continue;
        const dayVal = {};
        let anyBad = false;
        for (const d of DAYS) {
          const v = evalDay(c, d);
          dayVal[d] = v;
        }
        for (const days of patterns[c.is10 ? 4 : 5]) {
          evaluated++;
          let total = 0, ok = true;
          for (const d of days) {
            if (dayVal[d] === null) { ok = false; break; }
            total += dayVal[d];
          }
          if (!ok) continue;
          if (noise) total += (rng() - 0.5) * noise;
          if (total > bestVal) { bestVal = total; best = { c, days }; }
        }
      }
      return best;
    };
    const forceType = typeSequence ? typeSequence[p % typeSequence.length] : null;
    let best = null;
    if (used10 < tenTarget) best = pick(true, forceType) || pick(false, forceType);
    else best = pick(false, forceType);
    if (!best) break;
    const { c, days } = best;
    const a = idx(c.s), z = idx(c.e);
    for (const d of days) {
      for (let i = a; i < z; i++) sup[d][i]++;
      if (c.b) for (let i = idx(c.b[0]); i < idx(c.b[1]); i++) sup[d][i]--;
      starts[d][c.startSlot]++;
    }
    if (c.is10) used10++;
    packs.push({ type: c.type, s: c.s, e: c.e, b: c.b ? [...c.b] : null, work: c.work, days: [...days] });
  }

  const shiftBase = startShiftNumber != null ? startShiftNumber : (glob.shiftSeriesBase || 6000);
  const segs = packs.map((o, i) => ({
    id: 100000 + i, shift: shiftBase + i, run: "G" + (i + 1), type: o.type,
    daysOff: DAYS.filter((d) => !o.days.includes(d)).map((d) => d.slice(0, 2).toUpperCase()).join("-"),
    splitType: o.b ? "Split Break" : "Straight",
    days: o.days.sort((x, y) => DAYS.indexOf(x) - DAYS.indexOf(y)),
    s: o.s, e: o.e, b: o.b,
  }));
  const paidHours = packs.reduce((a, o) => a + o.work * o.days.length, 0) / 60;
  const runDays = packs.reduce((a, o) => a + o.days.length, 0);
  const mix = {};
  for (const o of packs) mix[o.type] = (mix[o.type] || 0) + 1;
  return { segs, paidHours, mix, used10, runDays, packages: packs.length, evaluated };
}

// "Same runs, better times": re-place every package of the loaded signup within the full
// rule windows, keeping its shift number, run, classification, and days-off pattern fixed.
// Times, break placement, and break length are the only free choices, so the output is
// bid-recognizable and diffs cleanly against the baseline (segments keep their ids).
// Day-variant packages consolidate to one uniform time across their days — consistent
// report times by construction, same philosophy as generateBoard.
// opts.rng shuffles placement order and opts.noise jitters near-tie choices (for the
// optimization monitor's randomized restarts); opts.subsetShifts (Set) locks every package
// NOT in the set at its current times — the ruin-and-recreate move re-places only the subset.
// With opts omitted the retime is deterministic, exactly as the single-shot button.
function retimeBoard(baseline, rules, glob, DEM, spans, minVeh, includePT, opts = {}) {
  const rng = opts.rng || null;
  const noise = rng && opts.noise > 0 ? opts.noise : 0;
  const subset = opts.subsetShifts || null;
  // stability preference: each candidate pays a small penalty per hour its report time
  // moves from the run's current time, so near-equal options resolve to "keep the run
  // that's already there" instead of score-neutral swaps between runs — while genuine
  // coverage gains (typically much larger) still override it and move the closest run.
  const stability = opts.stability != null ? opts.stability : 3;
  let evaluated = 0;
  const gammaT = demandGamma(glob);
  const WD = {};
  for (const d of DAYS) WD[d] = gammaT === 1 ? DEM[d] : DEM[d].map((v) => weightEv(v, gammaT));
  let weekEv = 0;
  for (const d of DAYS) weekEv += WD[d].reduce((a, b) => a + b, 0);

  // group baseline segments into packages by shift number
  const byShift = new Map();
  for (const sg of baseline) {
    if (!byShift.has(sg.shift)) byShift.set(sg.shift, []);
    byShift.get(sg.shift).push(sg);
  }
  const pkgs = [];
  const passthrough = []; // types not defined in Rules — kept exactly as uploaded
  for (const [shift, segs] of byShift) {
    const first = segs[0];
    const R = rules[first.type];
    const days = [...new Set(segs.flatMap((sg) => sg.days))].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    if (!R || (subset && !subset.has(shift))) { passthrough.push(...segs); continue; }
    pkgs.push({ shift, run: first.run, daysOff: first.daysOff, splitBase: first.splitType, id: first.id, type: first.type, days, work: R.work, origS: first.s, origSegs: segs });
  }
  // larger work blocks place first (the generator's 10-hour-first logic, minus the forcing —
  // the mix is given), then original shift order for determinism
  pkgs.sort((a, b) => (b.work - a.work) || (a.shift - b.shift));
  if (rng) for (let i = pkgs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pkgs[i], pkgs[j]] = [pkgs[j], pkgs[i]]; }

  const sup = {}, starts = {};
  for (const d of DAYS) {
    sup[d] = includePT ? RAW.pt[d].slice() : new Array(N).fill(0);
    starts[d] = new Array(N).fill(0);
  }
  const ptSlots = includePT ? DAYS.reduce((a, d) => a + RAW.pt[d].reduce((x, y) => x + y, 0), 0) : 0;
  const idx = slotIdx;
  const addSeg = (sg) => {
    for (const d of sg.days) {
      const a = idx(sg.s), z = idx(sg.e);
      for (let i = a; i < z; i++) sup[d][i]++;
      if (sg.b) for (let i = idx(sg.b[0]); i < idx(sg.b[1]); i++) sup[d][i]--;
      starts[d][idx(sg.s)]++;
    }
  };
  for (const sg of passthrough) addSeg(sg);

  // target scaled to this board's actual work slots, not the generator's per-package average
  const planned = ptSlots + pkgs.reduce((a, p) => a + (p.work / 5) * p.days.length, 0);
  const target = {};
  for (const d of DAYS) {
    target[d] = [];
    for (let i = 0; i < N; i++) target[d].push((WD[d][i] / weekEv) * planned);
  }

  const cands = buildCandidates(rules, glob);
  const maxPull = glob.maxPullout || 0;
  const outSlots = Math.round((glob.deadheadOutMin || 0) / 5);
  const inSlots = Math.round((glob.deadheadInMin || 0) / 5);

  const placed = [];
  let retimed = 0, kept = 0;
  for (const pkg of pkgs) {
    const PG = {}, PC = {};
    for (const d of pkg.days) {
      const [s0, s1] = spans[d];
      const pg = new Array(N + 1).fill(0), pc = new Array(N + 1).fill(0);
      for (let i = 0; i < N; i++) {
        let tgt = target[d][i];
        if (outSlots > 0) tgt = Math.max(tgt, target[d][Math.min(N - 1, i + outSlots)]);
        if (inSlots > 0) tgt = Math.max(tgt, target[d][Math.max(0, i - inSlots)]);
        let g = Math.max(0, Math.min(1, tgt - sup[d][i]));
        const t = SLOT(i);
        if (t >= s0 && t < s1 && sup[d][i] < minVeh) g += 0.5;
        pg[i + 1] = pg[i] + g;
        pc[i + 1] = pc[i] + (glob.maxFleet > 0 && sup[d][i] >= glob.maxFleet ? 1 : 0);
      }
      PG[d] = pg; PC[d] = pc;
    }
    let best = null, bestVal = -Infinity;
    for (const c of cands) {
      if (c.type !== pkg.type) continue;
      evaluated++;
      let total = 0, ok = true;
      for (const d of pkg.days) {
        if (c.s < spans[d][0] || c.e > spans[d][1]) { ok = false; break; } // outside this day's service span
        if (maxPull > 0 && starts[d][c.startSlot] >= maxPull) { ok = false; break; }
        const a = idx(c.s), z = idx(c.e);
        let cap = PC[d][z] - PC[d][a];
        let g = PG[d][z] - PG[d][a];
        if (c.b) {
          const b0 = idx(c.b[0]), b1 = idx(c.b[1]);
          cap -= PC[d][b1] - PC[d][b0];
          g -= PG[d][b1] - PG[d][b0];
        }
        if (cap > 0) { ok = false; break; } // would exceed the fleet cap somewhere it covers
        total += g - starts[d][c.startSlot] * 0.15;
      }
      if (!ok) continue;
      if (noise) total += (rng() - 0.5) * noise;
      if (stability) total -= (Math.abs(c.s - pkg.origS) / 60) * stability;
      if (total > bestVal) { bestVal = total; best = c; }
    }
    let seg;
    if (best) {
      seg = {
        id: pkg.id, shift: pkg.shift, run: pkg.run, type: pkg.type,
        daysOff: pkg.daysOff, splitType: best.b ? "Split Break" : "Straight",
        days: pkg.days, s: best.s, e: best.e, b: best.b ? [...best.b] : null,
      };
      retimed++;
    } else {
      // every candidate vetoed (stagger/fleet edge case) — keep the original times unchanged
      seg = { ...pkg.origSegs[0], b: pkg.origSegs[0].b ? [...pkg.origSegs[0].b] : null, days: pkg.days };
      kept++;
    }
    addSeg(seg);
    placed.push(seg);
  }

  const segs = [...placed, ...passthrough.map((sg) => ({ ...sg, b: sg.b ? [...sg.b] : null, days: [...sg.days] }))]
    .sort((a, b) => (a.shift - b.shift) || (a.id - b.id));
  const mix = {};
  for (const p of pkgs) mix[p.type] = (mix[p.type] || 0) + 1;
  const passShifts = new Set(passthrough.map((s) => s.shift));
  for (const sh of passShifts) { const t = byShift.get(sh)[0].type; mix[t] = (mix[t] || 0) + 1; }
  return { segs, retimed, kept: kept + passShifts.size, evaluated, mix, packages: pkgs.length + passShifts.size };
}

function optimizeToConvergence(board0, engine0Args, rules, glob, maxIter = 25) {
  // engine0Args = (DEM, includePT, minVeh, spans, maxFleet)
  const [DEM, includePT, minVeh, spans, maxFleet] = engine0Args;
  let board = board0.map((s) => ({ ...s, b: s.b ? [...s.b] : null, days: [...s.days] }));
  let applied = 0, iter = 0, evaluated = 0;
  while (iter < maxIter) {
    iter++;
    const eng = computeEngine(DEM, buildSupply(board), includePT, minVeh, spans, maxFleet, glob.offPeakBias);
    const sugs = findSuggestions(board, eng, DEM, rules, glob);
    evaluated += sugs.evaluated || 0;
    if (!sugs.length) break;
    const byId = new Map(board.map((s) => [s.id, s]));
    for (const s of sugs) {
      const seg = byId.get(s.id);
      if (!seg) continue;
      seg.s = s.payload.s; seg.e = s.payload.e; seg.b = s.payload.b ? [...s.payload.b] : null;
      applied++;
    }
  }
  return { board, applied, iterations: iter, evaluated };
}

function deepOptimize(board0, engineArgs, rules, glob) {
  let board = board0;
  let moves = 0, evaluated = 0, created = 0, passes = 0;
  const [DEM, includePT, minVeh, spans, maxFleet] = engineArgs;
  for (let round = 0; round < 4; round++) {
    passes++;
    const r1 = optimizeToConvergence(board, engineArgs, rules, glob);
    board = r1.board; moves += r1.applied; evaluated += r1.evaluated;
    const r2 = refinePerDay(board, rules, glob, DEM, includePT, minVeh, spans);
    board = r2.board; moves += r2.moves; created += r2.created; evaluated += r2.evaluated;
    if (r1.applied + r2.moves === 0) break;
  }
  return { board, moves, created, evaluated, passes };
}

/* ---------- packaging ---------- */
// dayStarts: [{day, s}]; checks weekday-internal, weekend-internal (Sat vs Sun),
// and weekday-vs-weekend spread independently against their own thresholds.
function startVarianceIssues(dayStarts, glob) {
  const wd = dayStarts.filter((x) => !WEEKEND_DAYS.has(x.day)).map((x) => x.s);
  const we = dayStarts.filter((x) => WEEKEND_DAYS.has(x.day)).map((x) => x.s);
  const out = [];
  if (wd.length > 1 && glob.maxStartVarWeekday) {
    const v = Math.max(...wd) - Math.min(...wd);
    if (v > glob.maxStartVarWeekday) out.push({ kind: "weekday", v, cap: glob.maxStartVarWeekday });
  }
  if (we.length > 1 && glob.maxStartVarWeekend) {
    const v = Math.max(...we) - Math.min(...we);
    if (v > glob.maxStartVarWeekend) out.push({ kind: "weekend", v, cap: glob.maxStartVarWeekend });
  }
  if (wd.length && we.length && glob.maxStartVarCross) {
    const all = [...wd, ...we];
    const v = Math.max(...all) - Math.min(...all);
    if (v > glob.maxStartVarCross) out.push({ kind: "cross", v, cap: glob.maxStartVarCross });
  }
  return out;
}

function packageInfo(segs, rules, glob) {
  // segs: all segments of one shift number
  const daysWorked = new Set();
  const byDay = {};
  for (const sg of segs) for (const d of sg.days) { daysWorked.add(d); byDay[d] = sg; }
  const issues = [];
  const type = segs[0].type;
  const R = rules[type];
  const expDays = R ? (R.work >= 600 ? 4 : 5) : null;
  if (expDays && daysWorked.size !== expDays)
    issues.push(`${type} package: works ${daysWorked.size} day${daysWorked.size === 1 ? "" : "s"}, expected ${expDays}`);
  // days off contiguity (circular week)
  const offIdx = DAYS.map((d, i) => (daysWorked.has(d) ? null : i)).filter((x) => x !== null);
  if (offIdx.length > 0 && offIdx.length < 7) {
    const offSet = new Set(offIdx);
    let blocks = 0;
    for (const i of offIdx) if (!offSet.has((i + 6) % 7)) blocks++;
    if (blocks > 1) issues.push(`Days off are split (${offIdx.map((i) => DAYS[i].slice(0, 2).toUpperCase()).join(" ")}) — not consecutive`);
  }
  // rest between adjacent working days + max consecutive
  let maxRun = 0, run = 0;
  for (let i = 0; i < 14; i++) {
    const d = DAYS[i % 7];
    if (daysWorked.has(d)) { run++; maxRun = Math.max(maxRun, Math.min(run, 7)); }
    else run = 0;
  }
  if (daysWorked.size === 7) maxRun = 7;
  if (glob.maxConsec && maxRun > glob.maxConsec)
    issues.push(`${maxRun} consecutive working days (max ${glob.maxConsec})`);
  // start-time consistency within the package (weekday / weekend / cross)
  const dayStarts = [...daysWorked].map((d) => ({ day: d, s: byDay[d].s }));
  const VAR_LABEL = { weekday: "Weekday report times", weekend: "Weekend report times", cross: "Weekday vs weekend report times" };
  for (const viol of startVarianceIssues(dayStarts, glob)) {
    issues.push(`${VAR_LABEL[viol.kind]} vary ${(viol.v / 60).toFixed(1)}h (max ${(viol.cap / 60).toFixed(1)}h)`);
  }
  for (let i = 0; i < 7; i++) {
    const d = DAYS[i], nd = DAYS[(i + 1) % 7];
    if (daysWorked.has(d) && daysWorked.has(nd)) {
      const rest = 1440 - byDay[d].e + byDay[nd].s;
      if (glob.minRest && rest < glob.minRest)
        issues.push(`Rest ${(rest / 60).toFixed(1)}h between ${d.slice(0, 3)} finish ${fmt(byDay[d].e)} and ${nd.slice(0, 3)} report ${fmt(byDay[nd].s)} (min ${glob.minRest / 60}h)`);
    }
  }
  return { daysWorked, byDay, issues, expDays };
}

function autoPackage(board, rules, glob) {
  // keep multi-day segments (already packaged) untouched; package single-day runs
  const keep = [], singles = [];
  const shiftDays = new Map();
  for (const sg of board) {
    if (!shiftDays.has(sg.shift)) shiftDays.set(sg.shift, 0);
    shiftDays.set(sg.shift, shiftDays.get(sg.shift) + sg.days.length);
  }
  for (const sg of board) {
    if (shiftDays.get(sg.shift) > 1) keep.push(cloneSeg(sg));
    else singles.push(cloneSeg(sg));
  }
  if (singles.length === 0) return { board: keep, made: 0, holes: 0, orphans: 0 };

  const groups = { 4: [], 5: [] };
  for (const sg of singles) {
    const R = rules[sg.type];
    groups[R && R.work >= 600 ? 4 : 5].push(sg);
  }
  let nextShift = Math.max(0, ...board.map((s) => s.shift)) + 1;
  const packageBase = glob.shiftSeriesBase || 6000;
  if (nextShift < packageBase) nextShift = packageBase;
  let nextId = 200000;
  const outSegs = [...keep];
  let made = 0, holes = 0, orphans = 0;

  for (const [wd, list] of [[5, groups[5]], [4, groups[4]]]) {
    if (!list.length) continue;
    const need = {};
    for (const d of DAYS) need[d] = list.filter((s) => s.days[0] === d).length;
    const byDayPool = {};
    for (const d of DAYS) byDayPool[d] = list.filter((s) => s.days[0] === d).sort((a, b) => a.s - b.s);
    const nPk = Math.round(list.length / wd);
    const offLen = 7 - wd;
    const packs = [];
    for (let p = 0; p < nPk; p++) {
      // choose off-block (offLen consecutive days) covering the days with lowest remaining need
      let bestStart = 0, bestVal = Infinity;
      for (let s = 0; s < 7; s++) {
        let offSum = 0, workMin = Infinity;
        for (let k = 0; k < offLen; k++) offSum += need[DAYS[(s + k) % 7]];
        for (let k = offLen; k < 7; k++) workMin = Math.min(workMin, need[DAYS[(s + k) % 7]]);
        const val = offSum - workMin * 0.01;
        if (val < bestVal) { bestVal = val; bestStart = s; }
      }
      const off = new Set(Array.from({ length: offLen }, (_, k) => (bestStart + k) % 7));
      const work = DAYS.filter((_, i) => !off.has(i));
      for (const d of work) need[d]--;
      packs.push({ off, work });
    }
    // fill packages rank-wise per day
    const assign = packs.map(() => ({}));
    for (const d of DAYS) {
      const pool = byDayPool[d];
      const takers = packs.map((p, i) => ({ p, i })).filter((x) => x.p.work.includes(d));
      // stable order: by package index (anchored by construction order)
      takers.forEach((tk, rank) => {
        if (rank < pool.length) assign[tk.i][d] = pool[rank];
        else holes++;
      });
      if (pool.length > takers.length) orphans += pool.length - takers.length;
      // orphan runs stay as their own single-day shifts
      for (let r = takers.length; r < pool.length; r++) outSegs.push(pool[r]);
    }
    // merge identical times within a package into shared rows
    for (const a of assign) {
      const daysOf = Object.keys(a);
      if (!daysOf.length) continue;
      const buckets = new Map();
      for (const d of daysOf) {
        const sg = a[d];
        const key = `${sg.type}|${sg.s}|${sg.e}|${JSON.stringify(sg.b)}`;
        if (!buckets.has(key)) buckets.set(key, { sg, days: [] });
        buckets.get(key).days.push(d);
      }
      const offStr = DAYS.filter((d) => !daysOf.includes(d)).map((d) => d.slice(0, 2).toUpperCase()).join("-");
      for (const { sg, days } of buckets.values()) {
        outSegs.push({
          ...cloneSeg(sg), id: nextId++, shift: nextShift, run: sg.run,
          daysOff: offStr, days: days.sort((x, y) => DAYS.indexOf(x) - DAYS.indexOf(y)),
        });
      }
      nextShift++; made++;
    }
  }
  return { board: outSegs, made, holes, orphans };
}

/* ---------- per-day refinement ---------- */
function refinePerDay(board0, rules, glob, DEM, includePT, minVeh, spans) {
  let board = board0.map(cloneSeg);
  const maxVar = Math.max(glob.maxStartVarWeekday || 0, glob.maxStartVarWeekend || 0, glob.maxStartVarCross || 0) || 60;
  const maxPull = glob.maxPullout || 0;
  let created = 0, moves = 0, evaluated = 0;
  let nextId = Math.max(0, ...board.map((s) => s.id)) + 1;

  // live supply per day (includes PT if toggled)
  const sup = {};
  for (const d of DAYS) {
    sup[d] = includePT ? RAW.pt[d].slice() : new Array(N).fill(0);
  }
  for (const sg of board) {
    const c = segContrib(sg);
    for (const d of sg.days) for (let i = 0; i < N; i++) sup[d][i] += c[i];
  }
  let weekEv = 0, weekSup = 0;
  const gammaR = demandGamma(glob);
  const ev = {};
  for (const d of DAYS) {
    ev[d] = gammaR === 1 ? DEM[d] : DEM[d].map((v) => weightEv(v, gammaR));
    weekEv += ev[d].reduce((a, b) => a + b, 0);
    weekSup += sup[d].reduce((a, b) => a + b, 0);
  }
  const dayTerm = (d) => {
    let t = 0;
    for (let i = 0; i < N; i++) t += Math.min(ev[d][i] / weekEv, sup[d][i] / weekSup);
    return t;
  };
  const term = {};
  for (const d of DAYS) term[d] = dayTerm(d);
  const starts = startsPerSlot(board);

  const shiftStartsOf = (shiftNo, exceptId, exceptDay) => {
    const arr = [];
    for (const sg of board) if (sg.shift === shiftNo)
      for (const dd of sg.days) if (!(sg.id === exceptId && dd === exceptDay)) arr.push({ day: dd, s: sg.s });
    return arr;
  };

  for (let sweep = 0; sweep < 12; sweep++) {
    let improvedThisSweep = 0;
    // snapshot list of (segment, day) targets — board mutates as we go
    const targets = [];
    for (const sg of board) for (const d of sg.days) targets.push({ id: sg.id, day: d });
    for (const tgt of targets) {
      const seg = board.find((s) => s.id === tgt.id);
      if (!seg || !seg.days.includes(tgt.day)) continue;
      const d = tgt.day;
      const R = rules[seg.type];
      if (!R) continue;
      const oldC = segContrib(seg);
      const oldStartSlot = Math.floor((seg.s - T0) / 5);
      let bestM = 0, bestDelta = 1e-6, bestTerm = 0;
      for (let m = -maxVar; m <= maxVar; m += 5) {
        if (m === 0) continue;
        evaluated++;
        const s2 = seg.s + m, e2 = seg.e + m;
        if (s2 < R.s[0] || s2 > R.s[1] || e2 < R.e[0] || e2 > R.e[1]) continue;
        const k = Math.floor((s2 - T0) / 5);
        if (maxPull > 0 && k >= 0 && k < N && starts[d][k] >= maxPull) continue;
        const sibs = shiftStartsOf(seg.shift, seg.id, d);
        if (sibs.length) {
          if (startVarianceIssues([...sibs, { day: d, s: s2 }], glob).length) continue;
        }
        const b2 = seg.b ? [seg.b[0] + m, seg.b[1] + m] : null;
        const cand = { ...seg, s: s2, e: e2, b: b2 };
        const newC = segContrib(cand);
        let t = 0, fleetBad = false;
        for (let i = 0; i < N; i++) {
          const ns = sup[d][i] - oldC[i] + newC[i];
          if (glob.maxFleet > 0 && ns > glob.maxFleet && sup[d][i] <= glob.maxFleet) { fleetBad = true; break; }
          t += Math.min(ev[d][i] / weekEv, ns / weekSup);
        }
        if (fleetBad) continue;
        const delta = t - term[d];
        if (delta > bestDelta) { bestDelta = delta; bestM = m; bestTerm = t; }
      }
      if (bestM === 0) continue;
      // apply live
      const m = bestM;
      const b2 = seg.b ? [seg.b[0] + m, seg.b[1] + m] : null;
      const newSeg = { ...cloneSeg(seg), s: seg.s + m, e: seg.e + m, b: b2 };
      const newC = segContrib(newSeg);
      for (let i = 0; i < N; i++) sup[d][i] += newC[i] - oldC[i];
      term[d] = bestTerm;
      const k2 = Math.floor((newSeg.s - T0) / 5);
      if (oldStartSlot >= 0 && oldStartSlot < N) starts[d][oldStartSlot]--;
      if (k2 >= 0 && k2 < N) starts[d][k2]++;
      if (seg.days.length === 1) {
        seg.s = newSeg.s; seg.e = newSeg.e; seg.b = newSeg.b;
      } else {
        seg.days = seg.days.filter((x) => x !== d);
        board.push({ ...newSeg, id: nextId++, days: [d] });
        created++;
      }
      moves++; improvedThisSweep++;
    }
    if (!improvedThisSweep) break;
  }
  return { board, moves, created, evaluated };
}

/* ---------- ui bits ---------- */
const Stat = ({ label, value, sub, tone }) => (
  <div style={{
    background: card, border: "1px solid #E2E8EA", borderTop: `3px solid ${tone || targetInk}`,
    padding: "10px 14px", minWidth: 112, flex: "1 1 auto",
  }}>
    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5B6B75" }}>{label}</div>
    <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontSize: 28, fontWeight: 600, color: ink, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, color: "#5B6B75" }}>{sub}</div>}
  </div>
);

const numInput = {
  width: 74, padding: "7px 8px", border: "1px solid #B9C6CC",
  background: "#FFFFFF", color: "#182430", borderRadius: 2,
  fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif",
  fontSize: 20, fontWeight: 600, textAlign: "center",
  WebkitAppearance: "none", appearance: "textfield",
};
const nudgeBtn = {
  padding: "6px 12px", border: "1px solid #B9C6CC", background: "#fff",
  color: "#182430", fontSize: 14, fontWeight: 600, cursor: "pointer", borderRadius: 2,
};
const Nudge = ({ label, onDec, onInc, value }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <span style={{ fontSize: 11.5, color: "#5B6B75", width: 74 }}>{label}</span>
    <button onClick={onDec} style={nudgeBtn}>−5</button>
    <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, width: 56, textAlign: "center" }}>{value}</span>
    <button onClick={onInc} style={nudgeBtn}>+5</button>
  </div>
);

const WeekStrip = ({ segs, day, onPick }) => (
  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 10 }}>
    {DAYS.map((d) => {
      const sg = segs.find((s) => s.days.includes(d));
      const on = d === day;
      return (
        <div key={d} onClick={() => onPick(d)} style={{
          cursor: "pointer", padding: "3px 6px", borderRadius: 2, textAlign: "center", minWidth: 60,
          border: on ? `1px solid ${ink}` : "1px solid transparent",
          background: sg ? "rgba(15,123,122,0.08)" : "transparent",
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: sg ? ink : "#B9C6CC" }}>{d.slice(0, 3).toUpperCase()}</div>
          <div style={{ fontSize: 10.5, fontVariantNumeric: "tabular-nums", color: sg ? "#41525C" : "#B9C6CC" }}>
            {sg ? `${fmt(sg.s)}–${fmt(sg.e)}` : "OFF"}
          </div>
        </div>
      );
    })}
  </div>
);

/* ---------- demand sketcher ---------- */
const CTRL_TIMES = Array.from({ length: 42 }, (_, k) => 300 + k * 30);
const TPL = {
  weekday: [8,10,14,20,30,42,55,65,70,68,62,58,55,54,55,58,62,68,75,85,95,100,96,85,72,60,50,42,36,30,25,20,16,13,10,8,6,5,4,3,2,2],
  hump:    [4,5,7,10,14,20,28,36,45,54,62,70,76,80,82,82,80,76,70,64,58,52,46,40,35,30,26,22,18,15,12,10,8,6,5,4,3,3,2,2,1,1],
  flat:    Array(42).fill(50),
};
const SKETCH_GROUPS = {
  weekdaySatSun: [
    { key: "Weekday", label: "Weekday", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
    { key: "Saturday", label: "Saturday", days: ["Saturday"] },
    { key: "Sunday", label: "Sunday", days: ["Sunday"] },
  ],
  weekdayWeekend: [
    { key: "Weekday", label: "Weekday", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
    { key: "Weekend", label: "Weekend", days: ["Saturday", "Sunday"] },
  ],
  perDay: DAYS.map((d) => ({ key: d, label: d, days: [d] })),
};
const SKETCH_MODE_LABELS = { weekdaySatSun: "Weekdays + Sat + Sun", weekdayWeekend: "Weekdays + Weekend", perDay: "All 7 days" };

function sketchToEv(raw, trips) {
  const ev = new Array(N);
  let sumV = 0;
  for (let i = 0; i < N; i++) {
    const t = SLOT(i);
    const k = Math.min(CTRL_TIMES.length - 2, Math.floor((t - 300) / 30));
    const f = (t - (300 + k * 30)) / 30;
    const v = Math.max(0, raw[k] * (1 - f) + raw[k + 1] * f);
    ev[i] = v; sumV += v;
  }
  const scale = sumV > 0 ? (trips * 2) / sumV : 0;
  for (let i = 0; i < N; i++) ev[i] *= scale;
  return ev;
}

function Sketcher({ raw, setRaw, trips }) {
  const W = 940, H = 260, PADL = 34, PADB = 22;
  const maxV = 110;
  const svgRef = useRef(null);
  const dragging = useRef(false);
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const x = (k) => PADL + (k / 39) * (W - PADL - 8);
  const y = (v) => (H - PADB) - (Math.min(v, maxV) / maxV) * (H - PADB - 8);
  const fromEvent = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    const k = Math.round(((px - PADL) / (W - PADL - 8)) * 39);
    const v = ((H - PADB - py) / (H - PADB - 8)) * maxV;
    return [Math.max(0, Math.min(39, k)), Math.max(0, Math.min(maxV, v))];
  };
  const paint = (e) => {
    const [k, v] = fromEvent(e);
    setRaw((old) => { const n = [...old]; n[k] = v; return n; });
  };
  const path = raw.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(39).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const peakK = raw.indexOf(Math.max(...raw));
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", touchAction: "none", cursor: "crosshair", background: "#FBFCFC", border: "1px solid #E2E8EA", borderRadius: 2 }}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); paint(e); }}
      onPointerMove={(e) => { if (dragging.current) paint(e); }}
      onPointerUp={() => { dragging.current = false; }}>
      {[6, 9, 12, 15, 18, 21, 24].map((h) => (
        <g key={h}>
          <line x1={x((h * 60 - 300) / 30)} y1={8} x2={x((h * 60 - 300) / 30)} y2={H - PADB} stroke="#EBF0F2" />
          <text x={x((h * 60 - 300) / 30)} y={H - 7} fontSize={11} fill="#8899A3" textAnchor="middle">{h}:00</text>
        </g>
      ))}
      {[25, 50, 75, 100].map((v) => (
        <line key={v} x1={PADL} y1={y(v)} x2={W - 8} y2={y(v)} stroke="#F0F4F5" />
      ))}
      <path d={area} fill="#D98324" fillOpacity={0.14} />
      <path d={path} fill="none" stroke="#D98324" strokeWidth={2.5} strokeLinejoin="round" />
      {raw.map((v, k) => (
        <circle key={k} cx={x(k)} cy={y(v)} r={k === peakK ? 5 : 3.5} fill={k === peakK ? "#C0392B" : "#D98324"} stroke="#fff" strokeWidth={1.2} />
      ))}
      <text x={PADL} y={16} fontSize={11} fill="#5B6B75">relative demand — drag or paint across the curve</text>
    </svg>
  );
}

function ActualCurve({ ev, label }) {
  const W = 940, H = 260, PADL = 38, PADB = 22;
  const maxV = Math.max(1, Math.max(...ev) * 1.15);
  const x = (i) => PADL + (i / (N - 1)) * (W - PADL - 8);
  const y = (v) => (H - PADB) - (Math.min(v, maxV) / maxV) * (H - PADB - 8);
  const path = ev.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(N - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const peakI = ev.indexOf(Math.max(...ev));
  const totalTrips = Math.round(ev.reduce((a, b) => a + b, 0) / 2);
  // gridline labels read in trips per 5-minute slot (events ÷ 2 — each trip is one
  // pickup + one dropoff), matching how schedulers talk about volume
  const tripsVal = (v) => { const t = v / 2; return t >= 20 ? Math.round(t).toString() : t.toFixed(1); };
  const peakLeft = peakI > N * 0.75; // flip the peak label when the dot is near the right edge
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
      {[25, 50, 75, 100].map((pct) => (
        <g key={pct}>
          <line x1={PADL} y1={y(maxV * pct / 100)} x2={W - 8} y2={y(maxV * pct / 100)} stroke="#F0F4F5" />
          <text x={PADL - 4} y={y(maxV * pct / 100) + 3.5} fontSize={10} fill="#8899A3" textAnchor="end">{tripsVal(maxV * pct / 100)}</text>
        </g>
      ))}
      <path d={area} fill={demandAmber} fillOpacity={0.14} />
      <path d={path} fill="none" stroke={demandAmber} strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={x(peakI)} cy={y(ev[peakI])} r={5} fill="#C0392B" stroke="#fff" strokeWidth={1.2} />
      <text x={x(peakI) + (peakLeft ? -9 : 9)} y={y(ev[peakI]) - 6} fontSize={11} fontWeight={700} fill="#C0392B" textAnchor={peakLeft ? "end" : "start"}>
        {tripsVal(ev[peakI])} trips / 5 min
      </text>
      <text x={PADL} y={16} fontSize={11} fill="#5B6B75">{label} · axis in trips per 5-minute slot</text>
      <text x={W - 8} y={16} fontSize={13} fontWeight={700} fill="#182430" textAnchor="end">{totalTrips.toLocaleString()} passenger trips today</text>
    </svg>
  );
}

/* ---------- coverage chart ---------- */
function CoverageChart({ P, day, minVeh, fleetCap, showBookout, showProductivity, height = 320, selBand }) {
  const data = useMemo(() => {
    const bk = RAW.bookout[day];
    const bkMap = {};
    if (bk) for (const [t, b] of bk) bkMap[t] = b;
    // "Suggested vehicles" allocates the DAY'S OWN scheduled vehicle-slots along the day's
    // trip-share curve: sug(i) = (demand share of slot i within the day) × (today's total
    // supply slots). No productivity constant, no demand-share scaling — it's this board's
    // fleet redistributed by trip percentage, so it always integrates back to exactly the
    // vehicle-hours already on the board. Smoothed over ~30 minutes so a single busy
    // 5-minute slot doesn't spike the line.
    const SMOOTH_HALF_SLOTS = 3;
    const smoothedEv = (i) => {
      let sum = 0, count = 0;
      for (let k = Math.max(0, i - SMOOTH_HALF_SLOTS); k <= Math.min(N - 1, i + SMOOTH_HALF_SLOTS); k++) {
        sum += P.ev[k]; count++;
      }
      return count > 0 ? sum / count : 0;
    };
    let dayEv = 0, daySup = 0;
    for (let i = 0; i < N; i++) { dayEv += P.ev[i]; daySup += P.sup[i]; }
    const rows = [];
    for (let i = 0; i < N; i++) {
      const t = SLOT(i), tgt = P.target[i];
      rows.push({
        time: fmt(t),
        target: Math.round(tgt * 10) / 10,
        sup: P.sup[i],
        covered: Math.round(Math.min(tgt, P.sup[i]) * 10) / 10,
        gap: tgt - P.sup[i] > 0.05 ? Math.round(tgt * 10) / 10 : null,
        bookout: bkMap[t] ?? null,
        sugVeh: dayEv > 0 && daySup > 0 ? Math.round((smoothedEv(i) / dayEv) * daySup * 10) / 10 : null,
        events: P.ev[i],
      });
    }
    return rows;
  }, [P, day]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 5, right: 14, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="#EBF0F2" vertical={false} />
        <XAxis dataKey="time" tick={{ fontSize: 10.5 }} interval={23} tickLine={false} />
        <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
        <Tooltip
          formatter={(v, name) => [v, { target: "Demand-aligned target", sup: "Supply", covered: "Aligned", bookout: "Observed (sample)", gap: "Target (underweighted)", sugVeh: "Suggested vehicles (day share)" }[name] || name]}
          labelFormatter={(l, pl) => {
            const r = pl && pl[0] && pl[0].payload;
            if (!r) return l;
            const evTxt = r.events >= 10 ? Math.round(r.events).toString() : r.events.toFixed(1);
            const sugTxt = r.sugVeh != null ? ` · ${r.sugVeh.toFixed(1)} suggested vehicles` : "";
            return `${l} · ${evTxt} events${sugTxt}`;
          }}
          contentStyle={{ fontSize: 12, border: "1px solid #D7DFE2" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="stepAfter" dataKey="target" name="Demand-aligned target" stroke={targetInk} strokeWidth={1.5} fill="#233746" fillOpacity={0.07} />
        <Area type="stepAfter" dataKey="gap" name="Gap" stroke="none" fill={gapRed} fillOpacity={0.22} legendType="none" />
        <Area type="stepAfter" dataKey="covered" name="Aligned" stroke="none" fill={supplyTeal} fillOpacity={0.16} legendType="none" />
        <Line type="stepAfter" dataKey="sup" name="Supply" stroke={supplyTeal} strokeWidth={2.2} dot={false} />
        <ReferenceLine y={minVeh} stroke={demandAmber} strokeDasharray="4 4" label={{ value: `min ${minVeh}`, position: "right", fontSize: 10, fill: demandAmber }} />
        {fleetCap > 0 && <ReferenceLine y={fleetCap} stroke={gapRed} strokeDasharray="6 3" label={{ value: `fleet ${fleetCap}`, position: "right", fontSize: 10, fill: gapRed }} />}
        {selBand && <ReferenceLine x={fmt(selBand[0])} stroke={ink} strokeDasharray="3 3" />}
        {selBand && <ReferenceLine x={fmt(Math.min(selBand[1], T1 - 5))} stroke={ink} strokeDasharray="3 3" />}
        {showBookout && RAW.bookout[day] &&
          <Line type="monotone" dataKey="bookout" name="Observed (sample)" stroke={bookoutViolet} strokeWidth={1.6} strokeDasharray="5 4" dot={false} connectNulls />}
        {showProductivity &&
          <Line type="stepAfter" dataKey="sugVeh" name="Suggested vehicles (day share)" stroke={sampleGray} strokeWidth={1.6} strokeDasharray="2 3" dot={false} connectNulls />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---------- main ---------- */
export default function App() {
  const [tab, setTab] = useState("rules");
  const [day, setDay] = useState("Wednesday");
  const [showBookout, setShowBookout] = useState(false);
  const [showProductivity, setShowProductivity] = useState(false);
  const [includePT, setIncludePT] = useState(false);
  const [totalSigned, setTotalSigned] = useState(125);
  const [blockSize, setBlockSize] = useState(25);
  const [board, setBoard] = useState(() => RAW.segments.map(cloneSeg));
  const [baselineBoard, setBaselineBoard] = useState(() => RAW.segments.map(cloneSeg));
  const [signupSource, setSignupSource] = useState("imported"); // "imported" | "uploaded"
  const [signupUploadResult, setSignupUploadResult] = useState(null);
  const signupFileRef = useRef(null);
  const [rules, setRules] = useState(() => JSON.parse(JSON.stringify(DEFAULT_RULES)));
  // per-code chip/bar colors — state (not the static TYPE_COLOR map) so a renamed type
  // keeps its color and a brand-new type gets a distinct one instead of the ink fallback
  const [typeColors, setTypeColors] = useState(() => ({ ...TYPE_COLOR }));
  const tColor = (t) => typeColors[t] || TYPE_COLOR[t] || ink;
  const [editingType, setEditingType] = useState(null); // type code whose chip is in rename mode
  const [typeDraft, setTypeDraft] = useState("");
  const [glob, setGlob] = useState(() => ({ ...JSON.parse(JSON.stringify(DEFAULT_GLOBAL)), avgCycleTime: DEFAULT_AVG_CYCLE_TIME, demandShare: DEFAULT_DEMAND_SHARE }));
  const [spans, setSpans] = useState(() => JSON.parse(JSON.stringify(DEFAULT_SPANS)));
  const [newType, setNewType] = useState("");
  const [demSource, setDemSource] = useState("imported"); // "imported" | "sketched" | "uploaded"
  const [uploadedDem, setUploadedDem] = useState(null);
  const [demUploadResult, setDemUploadResult] = useState(null);
  const demFileRef = useRef(null);
  const [sketchMode, setSketchMode] = useState("weekdaySatSun");
  const [curveTab, setCurveTab] = useState("Weekday");
  const [sketch, setSketch] = useState(() => {
    const o = {}; for (const d of DAYS) o[d] = [...(WEEKEND_DAYS.has(d) ? TPL.hump : TPL.weekday)]; return o;
  });
  const [trips, setTrips] = useState(() => {
    const o = {}; for (const d of DAYS) o[d] = d === "Saturday" ? 700 : d === "Sunday" ? 600 : 1600; return o;
  });
  const [sugs, setSugs] = useState(null);
  const [buildN, setBuildN] = useState(100);
  const [buildResult, setBuildResult] = useState(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [retimeResult, setRetimeResult] = useState(null);
  const [retimeBusy, setRetimeBusy] = useState(false);

  /* ---- optimization monitor ----
     A long-running, time-sliced search: one iteration per setTimeout(0) tick so the UI
     keeps painting between passes. Strategy: randomized restarts (full rebuilds with
     shuffled order + tie-break noise) until 12 consecutive restarts fail to improve,
     then mostly ruin-and-recreate around the best board (re-place a random handful of
     packages, everything else locked), with an occasional fresh restart to escape
     plateaus. The best score can only ever go up. All inputs are snapshotted at Start
     so mid-run edits elsewhere can't corrupt the search. The heavy per-tick data lives
     in a ref; state carries only the numbers the monitor displays. */
  const [optRun, setOptRun] = useState(null);
  const [optMode, setOptMode] = useState("retime"); // "retime" | "generate"
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
      const o = { rng, noise: st.iter === 0 ? 0 : 3 }; // first pass deterministic = the single-shot result
      if (cfg.mode === "generate") {
        const g = generateBoard(cfg.glob.max10, cfg.buildN, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, cfg.includePT, cfg.typeSequence, cfg.startShiftNumber, o);
        segs = g.segs; ev = g.evaluated;
      } else {
        const r = retimeBoard(cfg.baseline, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, cfg.includePT, o);
        segs = r.segs; ev = r.evaluated;
      }
    } else {
      st.refines++;
      const shifts = [...new Set(st.best.map((s) => s.shift))];
      const k = Math.min(shifts.length, 4 + Math.floor(rng() * 9));
      const subset = new Set();
      while (subset.size < k) subset.add(shifts[Math.floor(rng() * shifts.length)]);
      const r = retimeBoard(st.best, cfg.rules, cfg.glob, cfg.DEM, cfg.spans, cfg.glob.minVeh, cfg.includePT, { rng, noise: 2, subsetShifts: subset });
      segs = r.segs; ev = r.evaluated;
    }
    st.iter++;
    st.evaluated += ev;
    const sc = st.scoreFn(segs);
    const tSec = (performance.now() - st.startedAt) / 1000;
    if (cfg.mode === "generate" && st.baselineScore == null) st.baselineScore = sc; // reference = the plain single-shot Generate
    if (sc > st.bestScore + 1e-12) {
      st.best = segs;
      st.bestScore = sc;
      st.lastImproveT = tSec;
      if (doRestart) st.restartFails = 0;
      st.history.push({ t: Math.round(tSec * 10) / 10, score: Math.round(sc * 10000) / 100 });
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

  const startOptimize = (mode) => {
    if (optRef.current && !optRef.current.abort) return;
    const cfg = {
      mode,
      baseline: baselineBoard.map(cloneSeg),
      rules: JSON.parse(JSON.stringify(rules)),
      glob: { ...glob },
      DEM,
      spans: JSON.parse(JSON.stringify(spans)),
      includePT,
      buildN,
      typeSequence: mode === "generate" && followBaselinePattern ? buildTypeSequence(deriveTypeBlocks(baselineBoard), buildN) : null,
      startShiftNumber: mode === "generate" && followBaselinePattern
        ? Math.max(glob.shiftSeriesBase || 6000, 1 + Math.max(0, ...board.map((s) => s.shift), ...baselineBoard.map((s) => s.shift)))
        : null,
    };
    const scoreFn = (segs) => computeEngine(cfg.DEM, buildSupply(segs), cfg.includePT, cfg.glob.minVeh, cfg.spans, cfg.glob.maxFleet, cfg.glob.offPeakBias).weekScore;
    const baselineScore = mode === "retime" ? scoreFn(cfg.baseline) : null;
    optRef.current = {
      abort: false, cfg, scoreFn,
      // retime mode seeds the loaded signup itself as the incumbent — the search can only
      // ever improve on what's already in hand, never hand back something worse
      best: mode === "retime" ? cfg.baseline : null,
      bestScore: mode === "retime" ? baselineScore : -Infinity,
      baselineScore,
      iter: 0, restarts: 0, refines: 0, evaluated: 0, restartFails: 0,
      startedAt: performance.now(), lastImproveT: 0, lastBeat: 0,
      history: mode === "retime" ? [{ t: 0, score: Math.round(baselineScore * 10000) / 100 }] : [],
    };
    setOptRun({ running: true, mode, iter: 0, restarts: 0, refines: 0, evaluated: 0, bestScore: null, baselineScore: optRef.current.baselineScore, elapsed: 0, lastImproveT: 0, history: [] });
    setTimeout(optTick, 0);
  };

  const stopOptimize = () => {
    const st = optRef.current;
    if (!st || st.abort) return;
    st.abort = true;
    if (st.best) {
      // one polish pass on the final best: whole-segment slides preserve package identity in
      // both modes; per-day refinement (which splits day-variants) only for generated boards
      const engineArgs = [st.cfg.DEM, st.cfg.includePT, st.cfg.glob.minVeh, st.cfg.spans, st.cfg.glob.maxFleet];
      const polished = st.cfg.mode === "generate"
        ? deepOptimize(st.best, engineArgs, st.cfg.rules, st.cfg.glob).board
        : optimizeToConvergence(st.best, engineArgs, st.cfg.rules, st.cfg.glob).board;
      const pScore = st.scoreFn(polished);
      if (pScore >= st.bestScore) { st.best = polished; st.bestScore = pScore; }
      const tSec = (performance.now() - st.startedAt) / 1000;
      st.history.push({ t: Math.round(tSec * 10) / 10, score: Math.round(st.bestScore * 10000) / 100 });
    }
    setOptRun((o) => (o ? {
      ...o, running: false, bestScore: st.bestScore > -Infinity ? st.bestScore : null,
      elapsed: (performance.now() - st.startedAt) / 1000, history: st.history.slice(),
    } : o));
  };
  const optRunning = !!(optRun && optRun.running);
  const [followBaselinePattern, setFollowBaselinePattern] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [compareChangedOnly, setCompareChangedOnly] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineResult, setRefineResult] = useState(null);
  const [fixResult, setFixResult] = useState(null);
  const [optBusy, setOptBusy] = useState(false);
  const [optResult, setOptResult] = useState(null);
  const [sugsStale, setSugsStale] = useState(false);
  const fileRef = useRef(null);
  const [hist, setHist] = useState([]);
  const [selId, setSelId] = useState(null);
  const [editAllDays, setEditAllDays] = useState(true); // time edits hit every day the segment works vs. split out just the viewed day
  const nextId = useRef(RAW.segments.length + 1000);
  const designed = totalSigned - blockSize;


  const [signupPeriod, setSignupPeriod] = useState({ start: "", end: "", country: "CA", region: "" });
  const [holidays, setHolidays] = useState([]);
  const [hdCtor, setHdCtor] = useState(null);
  const [hdCountries, setHdCountries] = useState(null);
  const [hdRegions, setHdRegions] = useState({});
  const [hdLoading, setHdLoading] = useState(false);
  const [hdError, setHdError] = useState(null);
  const [customDraft, setCustomDraft] = useState({ date: "", name: "", runsAs: "" });
  const hdImportStarted = useRef(false);
  const [selectedHolidayId, setSelectedHolidayId] = useState(null);
  const [selHolSegId, setSelHolSegId] = useState(null);
  const [holFixResult, setHolFixResult] = useState(null);
  const [hasVisitedCoverage, setHasVisitedCoverage] = useState(false);

  useEffect(() => {
    if (tab === "coverage") setHasVisitedCoverage(true);
  }, [tab]);

  const mutate = (fn) => {
    setHist((h) => [...h.slice(-49), board]);
    setBoard(fn);
    setSugsStale(true);
  };
  const undo = () => {
    if (!hist.length) return;
    setBoard(hist[hist.length - 1]);
    setHist((h) => h.slice(0, -1));
  };
  const resetAll = () => {
    setHist((h) => [...h.slice(-49), board]);
    setBoard(baselineBoard.map(cloneSeg));
    setSelId(null);
  };

  const DEM = useMemo(() => {
    if (demSource === "uploaded") return uploadedDem || IMPORTED_DEM;
    if (demSource === "imported") return IMPORTED_DEM;
    const o = {};
    for (const d of DAYS) o[d] = sketchToEv(sketch[d], trips[d]);
    return o;
  }, [demSource, uploadedDem, sketch, trips]);

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
  const setGroupTrips = (v) => setTrips((t) => {
    const next = { ...t };
    for (const d of activeGroup.days) next[d] = v;
    return next;
  });

  // lazy-load date-holidays only once the user opens Rules, so its bundled
  // per-country data doesn't inflate the main chunk for users who never touch it
  useEffect(() => {
    if (tab !== "rules" || hdImportStarted.current) return;
    hdImportStarted.current = true;
    setHdLoading(true);
    import("date-holidays")
      .then((m) => {
        setHdCtor(() => m.default);
        setHdCountries(new m.default().getCountries());
        setHdLoading(false);
      })
      .catch((err) => { setHdError(String(err)); setHdLoading(false); });
  }, [tab]);

  useEffect(() => {
    if (!hdCtor) return;
    const regions = new hdCtor(signupPeriod.country).getStates(signupPeriod.country) || {};
    setHdRegions(regions);
    if (signupPeriod.region && !regions[signupPeriod.region]) {
      setSignupPeriod((p) => ({ ...p, region: "" }));
    }
  }, [hdCtor, signupPeriod.country]);

  useEffect(() => {
    if (!hdCtor || !signupPeriod.start || !signupPeriod.end) return;
    const hd = new hdCtor(signupPeriod.country, signupPeriod.region || undefined);
    const detected = computeHolidaysInRange(hd, signupPeriod.start, signupPeriod.end);
    setHolidays((hs) => mergeHolidayEdits(detected, hs));
  }, [hdCtor, signupPeriod.start, signupPeriod.end, signupPeriod.country, signupPeriod.region]);

  const saveProject = () => {
    const payload = {
      v: 1, savedAt: new Date().toISOString(),
      demSource, sketch, trips, sketchMode, uploadedDem, board, rules, glob, spans,
      totalSigned, blockSize, includePT, signupPeriod, holidays,
      baselineBoard, signupSource, typeColors,
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "signup-project.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const exportBoard = () => {
    const DOW = { Sunday: "SU", Monday: "MO", Tuesday: "TU", Wednesday: "WE", Thursday: "TH", Friday: "FR", Saturday: "SA" };
    const hm = (m) => `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, "0")}`;
    const mil = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
    const header = ["Shift No", "Run", "Days Off", "Shift Type", "Operator Name", "Badge #", "Split Shift Type", "Break", "Days Worked", "Report Time", "On", "Off"];
    const rows = [header];
    const byShift = new Map();
    for (const sg of board) {
      if (!byShift.has(sg.shift)) byShift.set(sg.shift, []);
      byShift.get(sg.shift).push(sg);
    }
    const shifts = [...byShift.keys()].sort((a, b) => a - b);
    for (const sh of shifts) {
      const segs = byShift.get(sh);
      segs.sort((a, b) => DAYS.indexOf(a.days[0]) - DAYS.indexOf(b.days[0]));
      segs.forEach((sg, idx) => {
        rows.push([
          idx === 0 ? sg.shift : sg.shift,
          sg.run,
          idx === 0 ? sg.daysOff : "",
          idx === 0 ? sg.type : "",
          "", "",
          sg.splitType || "",
          sg.b ? `${mil(sg.b[0])}-${mil(sg.b[1])}` : "",
          " " + sg.days.map((d) => DOW[d]).join(" ") + " ",
          hm(sg.s),
          hm(sg.s + 13),
          hm(sg.e),
        ]);
      });
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 8 }, { wch: 7 }, { wch: 14 }, { wch: 9 }, { wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 11 }, { wch: 24 }, { wch: 11 }, { wch: 7 }, { wch: 7 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Signup Board");
    // summary sheet
    const sum = [["Signup export"], [],
      ["Designed runs", distinctShifts],
      ["Total signed (envelope)", totalSigned],
      ["Extra board", blockSize],
      ["10-hour shifts", `${tenCount} of ${glob.max10}`],
      ["Rule flags", flagCount],
      ["Weekly coverage score", `${(eng.weekScore * 100).toFixed(1)}%`],
      ["Demand source", DEM_SOURCE_LABEL[demSource] || demSource],
      [],
      ["Day", "Demand %", "Resource %", "Coverage score"]];
    for (const d of DAYS) {
      const p = eng.perDay[d];
      sum.push([d, +(p.demandShare * 100).toFixed(1), +(p.resourceShare * 100).toFixed(1), +(p.dayScore * 100).toFixed(1)]);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(sum);
    ws2["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Summary");
    // exceptions sheet (only when a signup period is configured)
    if (signupPeriod.start && signupPeriod.end) {
      const exc = [["Signup period & exception days"], [],
        ["Signup period", `${signupPeriod.start} – ${signupPeriod.end}`],
        ["Jurisdiction", `${hdCountries?.[signupPeriod.country] || signupPeriod.country}${signupPeriod.region ? " / " + (hdRegions?.[signupPeriod.region] || signupPeriod.region) : ""}`],
        [],
        ["Date", "Weekday", "Holiday", "Runs as", "Source"]];
      for (const h of holidays) {
        exc.push([h.date, DAYS[new Date(h.date + "T00:00:00").getDay()], h.name, h.runsAs === "custom" ? "Custom schedule" : (h.runsAs || "Regular"), h.source]);
        if (h.runsAs === "custom") {
          for (const sg of (h.segs || [])) {
            exc.push(["", "", `  ${sg.type} ${fmt(sg.s)}–${fmt(sg.e)}${sg.b ? ` (break ${fmt(sg.b[0])}–${fmt(sg.b[1])})` : ""}${sg.sourceShift != null ? ` [from shift ${sg.sourceShift} / run ${sg.sourceRun}]` : ""}`, "", ""]);
          }
        }
      }
      const ws3 = XLSX.utils.aoa_to_sheet(exc);
      ws3["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 26 }, { wch: 12 }, { wch: 8 }];
      XLSX.utils.book_append_sheet(wb, ws3, "Exceptions");
    }
    XLSX.writeFile(wb, "signup-board.xlsx");
  };

  const downloadDemandTemplate = () => {
    const wb = XLSX.utils.book_new();
    const instr = [
      ["Real demand data template"], [],
      ["One sheet per day of the week (Sunday–Saturday). Enter Pickups and Dropoffs for every 5-minute slot."],
      ["Do not edit the Time column — it is for reference only; rows are matched by position, not by the time text."],
      ["All 7 day sheets must be present or the upload will be rejected."],
      ["Leave a slot as 0 if there is no activity — blank cells are also treated as 0."],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 78 }];
    XLSX.utils.book_append_sheet(wb, wsI, "Instructions");
    for (const d of DAYS) {
      const rows = [["Time", "Pickups", "Dropoffs"]];
      for (let i = 0; i < N; i++) rows.push([fmt(SLOT(i)), 0, 0]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 10 }, { wch: 10 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws, d);
    }
    XLSX.writeFile(wb, "demand-template.xlsx");
  };

  const downloadSignupTemplate = () => {
    const wb = XLSX.utils.book_new();
    const instr = [
      ["Signup template"], [],
      ["One row per shift. If a shift's report/off times differ on some days (day-variant), add one row per distinct time pattern — every row shares the same Shift No."],
      ["Days Worked: space-separated 2-letter weekday codes, e.g. \"MO TU WE TH FR\"."],
      ["Report Time / Off are the paid on-duty start/end (24h, e.g. 14:30). If a shift runs past midnight, Off can be earlier than Report Time (e.g. 0:00) — it's read as the next day."],
      ["Break Start / Break End (optional): same 24h format as Report Time, e.g. 13:10 to 14:10. Leave both blank for a straight run with no break."],
      ["Days Off / Split Type are optional — Days Off is inferred from Days Worked if left blank."],
      ["Stat-holiday / one-off variant of a shift: put the literal calendar date (e.g. \"August 3, 2026\") in Days Worked instead of weekday codes, and give it a Run number (often different from the shift's regular weekly Run, e.g. 301 vs 101) under the SAME Shift No. These rows import as Exception days (Coverage tab), not part of the weekly pattern — Type/Days Off/Split Type may be left blank to inherit the shift's regular values. A date-specific row with no Run number is ignored."],
      ["No operator names or badge numbers — this tool only tracks shift structure."],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI["!cols"] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsI, "Instructions");
    const header = ["Shift No", "Run", "Days Off", "Type", "Split Type", "Break Start", "Break End", "Days Worked", "Report Time", "Off"];
    const rows = [header,
      [101, "101", "SU-SA", "AM", "Straight", "", "", "MO TU WE TH FR", "5:15", "13:15"],
      [101, "301", "", "", "", "", "", "August 3, 2026", "5:15", "13:15"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 9 }, { wch: 7 }, { wch: 10 }, { wch: 7 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 18 }, { wch: 11 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws, "Signup");
    XLSX.writeFile(wb, "signup-template.xlsx");
  };

  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (!p || !Array.isArray(p.board)) throw new Error("bad file");
        setBoard(p.board.map(cloneSeg));
        if (p.rules) setRules(p.rules);
        if (p.glob) {
          const g = { minVeh: p.floorVal ?? DEFAULT_GLOBAL.minVeh, ...p.glob };
          if (g.maxStartVar != null && g.maxStartVarWeekday == null) {
            g.maxStartVarWeekday = g.maxStartVar;
            g.maxStartVarWeekend = g.maxStartVar;
            g.maxStartVarCross = g.maxStartVar;
          }
          if (g.avgCycleTime == null) {
            g.avgCycleTime = Math.round((60 / (g.productivity || 1.75)) * 10) / 10;
          }
          if (g.demandShare == null) g.demandShare = DEFAULT_DEMAND_SHARE;
          if (g.offPeakBias == null) g.offPeakBias = 30; // matches the shipped default; note scores are only comparable at the same weighting
          setGlob(g);
        }
        if (p.spans) setSpans(p.spans);
        if (p.sketch) {
          if (p.sketch.Weekday) {
            // pre-per-day save: expand the old 3-group shape onto all 7 days
            const migrated = {};
            for (const d of DAYS) migrated[d] = [...(WEEKEND_DAYS.has(d) ? (p.sketch[d] || p.sketch.Sunday) : p.sketch.Weekday)];
            setSketch(migrated);
          } else setSketch(p.sketch);
        }
        if (p.trips) {
          if (p.trips.Weekday != null) {
            const migrated = {};
            for (const d of DAYS) migrated[d] = d === "Saturday" ? p.trips.Saturday : d === "Sunday" ? p.trips.Sunday : p.trips.Weekday;
            setTrips(migrated);
          } else setTrips(p.trips);
        }
        setSketchMode(p.sketchMode || "weekdaySatSun");
        if (p.uploadedDem) setUploadedDem(p.uploadedDem);
        if (p.demSource === "uploaded" && !p.uploadedDem) setDemSource("imported");
        else if (p.demSource) setDemSource(p.demSource);
        if (p.totalSigned != null) setTotalSigned(p.totalSigned);
        if (p.blockSize != null) setBlockSize(p.blockSize);
        if (p.includePT != null) setIncludePT(p.includePT);
        if (p.signupPeriod) setSignupPeriod(p.signupPeriod);
        if (Array.isArray(p.holidays)) setHolidays(p.holidays);
        if (Array.isArray(p.baselineBoard)) setBaselineBoard(p.baselineBoard.map(cloneSeg));
        if (p.signupSource === "uploaded" && !Array.isArray(p.baselineBoard)) setSignupSource("imported");
        else if (p.signupSource) setSignupSource(p.signupSource);
        // older saves have no typeColors — shipped codes fall back to TYPE_COLOR, renamed/custom
        // ones get ink until the user touches them again, so merging over the defaults is safe
        setTypeColors(p.typeColors ? { ...TYPE_COLOR, ...p.typeColors } : { ...TYPE_COLOR });
        setHist([]); setSelId(null); setSugs(null); setSugsStale(false);
      } catch (err) {
        alert("Could not read that project file.");
      }
    };
    rd.readAsText(file);
  };

  const parseDemandWorkbook = (wb) => {
    const missing = DAYS.filter((d) => !wb.Sheets[d]);
    if (missing.length) {
      return { ok: false, error: `Missing sheet(s) for: ${missing.join(", ")}. All 7 day sheets (${DAYS.join(", ")}) must be present in the uploaded file.` };
    }
    const dem = {};
    let paddedRows = 0, coercedCells = 0, extraRowsIgnored = 0;
    const suspiciousDays = [];
    for (const d of DAYS) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[d], { header: 1 });
      const data = rows.slice(1);
      const arr = new Array(N).fill(0);
      const keys = new Array(N).fill("0|0");
      for (let i = 0; i < N; i++) {
        const row = data[i];
        if (!row) { paddedRows++; continue; }
        const pu = Number(row[1]), doo = Number(row[2]);
        if (!Number.isFinite(pu)) coercedCells++;
        if (!Number.isFinite(doo)) coercedCells++;
        const puN = Number.isFinite(pu) ? pu : 0, dooN = Number.isFinite(doo) ? doo : 0;
        arr[i] = puN + dooN;
        keys[i] = puN + "|" + dooN;
      }
      if (data.length > N) extraRowsIgnored += data.length - N;
      dem[d] = arr;

      // A run of 6+ identical consecutive nonzero slots covering most of the day's active
      // time is the signature of coarser-granularity totals (e.g. half-hourly) pasted into
      // every 5-minute slot instead of split across them — flag it rather than silently
      // trusting numbers that would badly inflate anything derived from them.
      let activeSlots = 0, suspiciousSlots = 0, i2 = 0;
      while (i2 < N) {
        let j = i2;
        while (j < N && keys[j] === keys[i2]) j++;
        const len = j - i2;
        if (keys[i2] !== "0|0") {
          activeSlots += len;
          if (len >= 6) suspiciousSlots += len;
        }
        i2 = j;
      }
      if (activeSlots > 0 && suspiciousSlots / activeSlots >= 0.5) suspiciousDays.push(d);
    }
    return { ok: true, dem, summary: { paddedRows, coercedCells, extraRowsIgnored, suspiciousDays } };
  };

  const uploadDemand = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(rd.result, { type: "array" });
        const res = parseDemandWorkbook(wb);
        if (!res.ok) { alert(res.error); return; }
        setUploadedDem(res.dem);
        setDemSource("uploaded");
        setDemUploadResult(res.summary);
        const impliedTrips = {};
        for (const d of DAYS) impliedTrips[d] = Math.round(res.dem[d].reduce((a, b) => a + b, 0) / 2);
        setTrips(impliedTrips);
      } catch (err) {
        alert("Could not read that demand file. Make sure it's an .xlsx file matching the template.");
      }
    };
    rd.readAsArrayBuffer(file);
  };

  const uploadSignup = (file) => {
    const isCsv = /\.csv$/i.test(file.name);
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = isCsv ? XLSX.read(rd.result, { type: "string" }) : XLSX.read(rd.result, { type: "array" });
        const res = parseSignupWorkbook(wb, undefined, rules); // live rules, so auto-classification matches renamed/custom types
        if (!res.ok) { alert(res.error); return; }
        const startId = nextId.current;
        const segments = res.segments.map((sg, i) => ({ ...sg, id: startId + i }));
        nextId.current = startId + segments.length;
        setBoard(segments.map(cloneSeg));
        setBaselineBoard(segments.map(cloneSeg));
        setSignupSource("uploaded");
        setFollowBaselinePattern(true);
        setSignupUploadResult(res.summary);
        setHist([]); setSelId(null); setSugs(null); setSugsStale(false);
        if (res.exceptionDays && res.exceptionDays.length) {
          // ids assigned synchronously here (not inside the setHolidays updater below) —
          // React can invoke a state updater more than once, and nextId.current++ inside
          // it would double-increment on a second invocation
          const exceptionDaysWithIds = res.exceptionDays.map((ed) => ({
            date: ed.date,
            newHolidayId: "custom:" + ed.date + ":upload:" + nextId.current++,
            segs: ed.segs.map((sg) => ({ ...sg, id: nextId.current++ })),
          }));
          setHolidays((hs) => {
            const out = hs.slice();
            for (const ed of exceptionDaysWithIds) {
              const idx = out.findIndex((h) => h.date === ed.date);
              if (idx >= 0) {
                // force runsAs/source to custom even on a previously "auto" holiday: the
                // Coverage tab only shows segs for runsAs==="custom" entries, and only
                // source==="custom" entries survive a later signup-period/jurisdiction
                // re-detection (mergeHolidayEdits) — otherwise imported data could
                // silently vanish behind either of those.
                out[idx] = { ...out[idx], source: "custom", runsAs: "custom", segs: ed.segs };
              } else {
                out.push({ id: ed.newHolidayId, date: ed.date, name: `Exception day (${ed.date})`, source: "custom", runsAs: "custom", segs: ed.segs });
              }
            }
            return out.sort((a, b) => (a.date < b.date ? -1 : 1));
          });
        }
      } catch (err) {
        alert("Could not read that signup file. Make sure it's an .xlsx or .csv file matching the template.");
      }
    };
    if (isCsv) rd.readAsText(file); else rd.readAsArrayBuffer(file);
  };

  const holidayCountForDay = useMemo(() => holidays.filter((h) => h.runsAs === day).length, [holidays, day]);
  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(() => computeEngine(DEM, ftCov, includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias), [DEM, ftCov, includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias]);
  const base = useMemo(() => computeEngine(DEM, buildSupply(baselineBoard), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias), [DEM, baselineBoard, includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias]);
  const P = eng.perDay[day];

  const originalMap = useMemo(() => new Map(baselineBoard.map((s) => [s.id, s])), [baselineBoard]);

  const boardDiff = useMemo(() => {
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
  }, [board, originalMap]);
  const changedCount = boardDiff.added.length + boardDiff.removed.length + boardDiff.modified.length;

  const distinctShifts = useMemo(() => new Set(board.map((s) => s.shift)).size, [board]);
  const signupStats = useMemo(() => {
    const perDay = {};
    for (const d of DAYS) perDay[d] = { shifts: new Set(), hours: 0 };
    const byType = {};
    for (const sg of baselineBoard) {
      const brkMin = sg.b ? sg.b[1] - sg.b[0] : 0;
      const workHrs = (sg.e - sg.s - brkMin) / 60;
      byType[sg.type] = (byType[sg.type] || 0) + workHrs * sg.days.length;
      for (const d of sg.days) {
        perDay[d].shifts.add(sg.shift);
        perDay[d].hours += workHrs;
      }
    }
    return { perDay, byType };
  }, [baselineBoard]);
  const tenCount = useMemo(() => {
    const s = new Set();
    for (const sg of board) {
      const R = rules[sg.type];
      if (R && R.work === 600) s.add(sg.shift);
    }
    return s.size;
  }, [board, rules]);
  const eightCount = useMemo(() => {
    const s = new Set();
    for (const sg of board) {
      const R = rules[sg.type];
      if (R && R.work === 480) s.add(sg.shift);
    }
    return s.size;
  }, [board, rules]);
  const flagCount = useMemo(() => board.filter((sg) => validateSeg(sg, rules, glob).length > 0).length, [board, rules, glob]);

  // Derives an empirical trips/vehicle-hour figure from the user's own real demand + real
  // signup, instead of trusting one assumed universal constant — only available once both
  // sides are real uploads. Uploaded demand is system-wide, so trips scale by demandShare
  // before dividing by this signup's vehicle-hours — otherwise the result describes a fleet
  // serving work it doesn't do. A wildly high result (implying an implausibly short cycle
  // time) is usually the same data-quality issue parseDemandWorkbook's suspiciousDays flag
  // catches, so callers should check that before offering a one-click "use this" suggestion.
  const empiricalProductivity = useMemo(() => {
    if (!uploadedDem || signupSource !== "uploaded") return null;
    const share = (glob.demandShare > 0 ? glob.demandShare : 100) / 100;
    const cov = buildSupply(baselineBoard);
    let totalTrips = 0, totalVehHours = 0;
    const perDay = {};
    for (const d of DAYS) {
      const trips = (uploadedDem[d].reduce((a, b) => a + b, 0) / 2) * share;
      const vehHours = (cov[d].reduce((a, b) => a + b, 0) * 5) / 60;
      perDay[d] = vehHours > 0 ? trips / vehHours : null;
      totalTrips += trips;
      totalVehHours += vehHours;
    }
    return { perDay, overall: totalVehHours > 0 ? totalTrips / totalVehHours : null };
  }, [uploadedDem, baselineBoard, signupSource, glob.demandShare]);

  const [ganttSort, setGanttSort] = useState("run"); // "run" | "time" | "type"
  const daySegs = useMemo(() => {
    const list = board.filter((sg) => sg.days.includes(day));
    if (ganttSort === "time") list.sort((a, b) => (a.s - b.s) || (a.shift - b.shift));
    else if (ganttSort === "type") list.sort((a, b) =>
      (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (a.s - b.s) || (a.shift - b.shift));
    else list.sort((a, b) => (a.shift - b.shift) || (a.s - b.s));
    return list;
  }, [board, day, ganttSort]);

  const selSeg = selId != null ? board.find((s) => s.id === selId) : null;
  const selShift = selSeg ? selSeg.shift : null;
  const selShiftSegs = selShift != null ? board.filter((s) => s.shift === selShift) : [];
  const sel = selShift != null ? board.find((s) => s.shift === selShift && s.days.includes(day)) : null;
  const selDistinctTimes = new Set(selShiftSegs.map((sg) => `${sg.s}|${sg.e}|${JSON.stringify(sg.b)}`));
  const selIsDayVariant = selDistinctTimes.size > 1;
  const selIssues = sel ? validateSeg(sel, rules, glob) : [];
  const ganttSegs = selShift != null ? daySegs.filter((sg) => sg.shift === selShift) : daySegs;

  /* ---- gantt drag ----
     Direct manipulation on the gantt bars: slide a whole shift, slide its break, or resize
     either by the edges. Geometry-only clamps here (end after start, break inside the shift)
     — rule legality stays advisory via validateSeg, shown live in the readout, never blocked.
     One drag commits exactly one undo entry: the pre-drag board is pushed to history the
     moment the pointer passes the click threshold, and setBoard is called directly (not via
     mutate) for every quantized step after that. */
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { id, mode, startDayScore, days } | null
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
    // self-heal: if a previous drag's lifted/readout state leaked (pointerup lost to a
    // tab switch, dialog, or dropped pointer), the next press anywhere clears it
    setDragging((cur) => (cur ? null : cur));
    const mode = ev.target && ev.target.dataset ? ev.target.dataset.dragmode || null : null;
    // only the bar/break/handles are interactive — a press on the row background, label,
    // or empty track does nothing, so touch-scrolling through the list never selects a shift
    if (!mode) return;
    const track = ev.currentTarget.querySelector(".gtrack");
    if (!track) return;
    const pxPerMin = track.getBoundingClientRect().width / (T1 - T0);
    if (!(pxPerMin > 0)) return; // degenerate layout (hidden/zero-width track) — dividing by this would drag times to NaN
    dragRef.current = {
      sgId: sg.id, mode, orig: cloneSeg(sg),
      startX: ev.clientX,
      pxPerMin,
      lastDelta: 0, active: false,
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
      setHist((h) => [...h.slice(-49), d.boardSnapshot]);
      setSugsStale(true);
      setSelId(d.sgId);
      if (!editAllDays && d.orig.days.length > 1) {
        // day-scoped drag: carve the viewed day out of the shared times at activation —
        // the dragged segment keeps its id (so the bar under the pointer survives the
        // re-render) and shrinks to just this day; a new sibling keeps the other days
        const restId = nextId.current++;
        setBoard((b) => b.flatMap((s) => {
          if (s.id !== d.sgId) return [s];
          const rest = { ...cloneSeg(s), id: restId, days: s.days.filter((x) => x !== day) };
          return [{ ...cloneSeg(s), days: [day] }, rest];
        }));
        d.orig = { ...d.orig, days: [day] };
        setDragging({ id: d.sgId, mode: d.mode, startDayScore: d.startDayScore, days: [day] });
      } else {
        setDragging({ id: d.sgId, mode: d.mode, startDayScore: d.startDayScore, days: d.orig.days });
      }
    }
    // snap to the 5-minute grid DURING the drag — and skip the board update entirely
    // unless the quantized delta moved to a new slot, so most pointer events are free
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

  // When "apply to all working days" is off, a time/break edit on a multi-day segment
  // splits the viewed day out of the package's shared times: the edited segment keeps its
  // id (so ghosts, was-hints, and the drag under the pointer all survive) and shrinks to
  // just this day; a new sibling segment carries the other days at the original times.
  // Same shift number, so it's still one package — just day-variant now, which the whole
  // app (week strip, variance checks, retime consolidation) already understands.
  // Only time/break patches split; type and days edits are package-wide by nature.
  const patchSel = (patch) => {
    if (!sel) return;
    const timeOnly = Object.keys(patch).every((k) => k === "s" || k === "e" || k === "b");
    if (!editAllDays && timeOnly && sel.days.length > 1) {
      const restId = nextId.current++;
      mutate((b) => b.flatMap((s) => {
        if (s.id !== sel.id) return [s];
        const rest = { ...cloneSeg(s), id: restId, days: s.days.filter((d) => d !== day) };
        const edited = { ...cloneSeg(s), ...patch, days: [day] };
        return [edited, rest];
      }));
      return;
    }
    mutate((b) => b.map((s) => (s.id === sel.id ? { ...cloneSeg(s), ...patch } : s)));
  };
  // step the selection through the day's board order (the gantt's unfiltered sort),
  // wrapping at the ends; from a shift that doesn't work this day, ▶ starts at the
  // first run of the day and ◀ at the last
  const navSel = (dir) => {
    if (!daySegs.length) return;
    const idx = sel ? daySegs.findIndex((s) => s.id === sel.id) : -1;
    const next = idx < 0
      ? (dir > 0 ? daySegs[0] : daySegs[daySegs.length - 1])
      : daySegs[(idx + dir + daySegs.length) % daySegs.length];
    setSelId(next.id);
  };
  const shiftBreak = (delta) => {
    if (!sel || !sel.b) return;
    patchSel({ b: [sel.b[0] + delta, sel.b[1] + delta] });
  };
  const setType = (t) => {
    if (!sel) return;
    const R = rules[t];
    let b = sel.b ? [...sel.b] : null;
    if (R && R.brk && !b) b = [sel.s + 240, sel.s + 300];
    if (R && !R.brk) b = null;
    patchSel({ type: t, b });
  };
  const toggleBreak = () => {
    if (!sel) return;
    patchSel({ b: sel.b ? null : [sel.s + 240, sel.s + 300] });
  };
  const toggleDay = (d) => {
    if (!sel) return;
    const days = sel.days.includes(d) ? sel.days.filter((x) => x !== d) : [...sel.days, d].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    patchSel({ days });
  };
  // Renaming a classification is a global relabel, not a board edit: the rules entry is
  // re-keyed in place (order preserved), every segment referencing the code — live board,
  // comparison baseline, exception-day one-offs — follows, and the color travels with it.
  // Deliberately NOT pushed to undo history: undo can't restore the rules key, so a
  // half-undone rename would strand segments on a type that no longer exists.
  const renameType = (oldCode, newCodeRaw) => {
    const newCode = String(newCodeRaw || "").toUpperCase().trim();
    if (!newCode || newCode === oldCode || rules[newCode]) return false;
    setRules((old) => {
      const next = {};
      for (const k of Object.keys(old)) next[k === oldCode ? newCode : k] = old[k];
      return next;
    });
    const remap = (sg) => (sg.type === oldCode ? { ...cloneSeg(sg), type: newCode } : sg);
    setBoard((b) => b.map(remap));
    setBaselineBoard((b) => b.map(remap));
    setHolidays((hs) => hs.map((h) => (h.segs && h.segs.some((sg) => sg.type === oldCode)
      ? { ...h, segs: h.segs.map((sg) => (sg.type === oldCode ? { ...sg, type: newCode } : sg)) }
      : h)));
    setTypeColors((tc) => {
      const n = { ...tc };
      n[newCode] = n[oldCode] || TYPE_COLOR[oldCode] || TYPE_COLOR_EXTRA[Object.keys(n).length % TYPE_COLOR_EXTRA.length];
      delete n[oldCode];
      return n;
    });
    setSugs(null); setSugsStale(false);
    setHist([]); // old snapshots reference the old code; undoing into them would strand segments on a type that no longer exists
    return true;
  };
  const duplicateSel = () => {
    if (!sel) return;
    const maxShift = Math.max(...board.map((s) => s.shift));
    const newShift = maxShift + 1;
    const copies = selShiftSegs.map((sg) => ({ ...cloneSeg(sg), id: nextId.current++, shift: newShift, run: "NEW" }));
    mutate((b) => [...b, ...copies]);
    setSelId((copies.find((c) => c.days.includes(day)) || copies[0]).id);
  };
  const removeSel = () => {
    if (!sel) return;
    mutate((b) => b.filter((s) => s.id !== sel.id));
    setSelId(null);
  };
  const fixSel = () => {
    if (!sel) return;
    const f = autofixSeg(sel, rules, glob);
    if (!f) { setFixResult({ fixed: 0, stuck: 1, single: true }); return; }
    mutate((b) => b.map((s) => (s.id === sel.id ? f : s)));
    setFixResult(null);
  };
  const fixAll = () => {
    let fixed = 0, stuck = 0;
    mutate((b) => b.map((s) => {
      if (validateSeg(s, rules, glob).length === 0) return s;
      const f = autofixSeg(s, rules, glob);
      if (f) { fixed++; return f; }
      stuck++; return s;
    }));
    setFixResult({ fixed, stuck, single: false });
  };
  const resetSel = () => {
    if (!sel) return;
    const o = originalMap.get(sel.id);
    if (!o) return;
    mutate((b) => b.map((s) => (s.id === sel.id ? cloneSeg(o) : s)));
  };
  const addShift = () => {
    const maxShift = Math.max(...board.map((s) => s.shift));
    const id = nextId.current++;
    const seg = {
      id, shift: maxShift + 1, run: "NEW", type: "AX", daysOff: "", splitType: "Split Break",
      days: [day], s: 540, e: 1080, b: [780, 840],
    };
    mutate((b) => [...b, seg]);
    setSelId(id);
  };

  const isChanged = sel ? (() => {
    const o = originalMap.get(sel.id);
    if (!o) return false;
    return o.s !== sel.s || o.e !== sel.e || o.type !== sel.type ||
      JSON.stringify(o.b) !== JSON.stringify(sel.b) || o.days.join() !== sel.days.join();
  })() : false;

  // ---- one-off shift editor for holidays with runsAs === "custom" ----
  const customHolidays = holidays.filter((h) => h.runsAs === "custom");
  const selHoliday = customHolidays.find((h) => h.id === selectedHolidayId) || null;
  const holSegs = selHoliday ? (selHoliday.segs || []) : [];
  const selHolSeg = selHolSegId != null ? holSegs.find((s) => s.id === selHolSegId) : null;
  const selHolSegIssues = selHolSeg ? validateSeg(selHolSeg, rules, glob) : [];

  const patchHolidaySegs = (holId, fn) => {
    setHolidays((hs) => hs.map((h) => (h.id === holId ? { ...h, segs: fn(h.segs || []) } : h)));
  };
  const patchHolSeg = (patch) => {
    if (!selHoliday || !selHolSeg) return;
    patchHolidaySegs(selHoliday.id, (segs) => segs.map((s) => (s.id === selHolSeg.id ? { ...cloneSeg(s), ...patch } : s)));
  };
  const setHolSegType = (t) => {
    if (!selHolSeg) return;
    const R = rules[t];
    let b = selHolSeg.b ? [...selHolSeg.b] : null;
    if (R && R.brk && !b) b = [selHolSeg.s + 240, selHolSeg.s + 300];
    if (R && !R.brk) b = null;
    patchHolSeg({ type: t, b });
  };
  const toggleHolSegBreak = () => {
    if (!selHolSeg) return;
    patchHolSeg({ b: selHolSeg.b ? null : [selHolSeg.s + 240, selHolSeg.s + 300] });
  };
  const shiftHolSegBreak = (delta) => {
    if (!selHolSeg || !selHolSeg.b) return;
    patchHolSeg({ b: [selHolSeg.b[0] + delta, selHolSeg.b[1] + delta] });
  };
  const addHolSeg = () => {
    if (!selHoliday) return;
    const id = nextId.current++;
    const seg = { id, type: "AX", s: 540, e: 1080, b: [780, 840] };
    patchHolidaySegs(selHoliday.id, (segs) => [...segs, seg]);
    setSelHolSegId(id);
  };
  const duplicateHolSeg = () => {
    if (!selHoliday || !selHolSeg) return;
    const id = nextId.current++;
    const copy = { ...cloneSeg(selHolSeg), id };
    patchHolidaySegs(selHoliday.id, (segs) => [...segs, copy]);
    setSelHolSegId(id);
  };
  const removeHolSeg = () => {
    if (!selHoliday || !selHolSeg) return;
    patchHolidaySegs(selHoliday.id, (segs) => segs.filter((s) => s.id !== selHolSeg.id));
    setSelHolSegId(null);
  };
  const fixHolSeg = () => {
    if (!selHoliday || !selHolSeg) return;
    const f = autofixSeg(selHolSeg, rules, glob);
    if (!f) { setHolFixResult({ stuck: true }); return; }
    patchHolidaySegs(selHoliday.id, (segs) => segs.map((s) => (s.id === selHolSeg.id ? f : s)));
    setHolFixResult(null);
  };

  const pctPos = (m) => ((Math.max(T0, Math.min(m, T1)) - T0) / (T1 - T0)) * 100;
  const dayDelta = (P.dayScore - base.perDay[day].dayScore) * 100;
  const weekDelta = (eng.weekScore - base.weekScore) * 100;

  return (
    <div style={{ minHeight: "100vh", background: paper, color: ink, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        .paddle { cursor:pointer; border:1px solid #D7DFE2; background:#fff; padding:7px 3px 5px; text-align:center; user-select:none; min-width:0; }
        .paddle.on { background:${ink}; color:#fff; border-color:${ink}; }
        .tabbtn { cursor:pointer; padding:9px 16px; border:1px solid #D7DFE2; background:#fff; font-family:'Barlow Condensed',sans-serif; font-size:17px; font-weight:600; letter-spacing:.03em; color:${ink}; }
        .tabbtn.on { background:${ink}; color:#fff; border-color:${ink}; }
        input[type=checkbox] { accent-color:${supplyTeal}; width:16px; height:16px; }
        input[type=number]::-webkit-outer-spin-button, input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
        select { padding:6px 8px; border:1px solid #B9C6CC; background:#fff; color:${ink}; font-size:13px; border-radius:2px; }
        table.shares td, table.shares th { padding:5px 8px; font-size:12.5px; border-bottom:1px solid #E7EDEF; text-align:right; }
        table.shares th { text-transform:uppercase; letter-spacing:.06em; font-size:10.5px; color:#5B6B75; }
        table.shares td:first-child, table.shares th:first-child { text-align:left; }
        .ganttrow { display:flex; align-items:center; gap:6px; height:20px; user-select:none; }
        .glabel { font-size:10.5px; width:118px; flex:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums; }
        .gtrack { position:relative; flex:1; height:14px; background:#EFF3F4; }
        .gbar { position:absolute; top:0; height:14px; border-radius:2px; cursor:grab; touch-action:pan-y; }
        .gbrk { position:absolute; top:0; height:14px; background:repeating-linear-gradient(45deg,#fff,#fff 3px,#AEBAC0 3px,#AEBAC0 6px); border-left:1px solid rgba(0,0,0,.35); border-right:1px solid rgba(0,0,0,.35); cursor:grab; touch-action:pan-y; z-index:1; }
        .gbar.lifted, .gbrk.lifted { transform:scaleY(1.35); box-shadow:0 2px 6px rgba(0,0,0,.35); z-index:2; cursor:grabbing; }
        .ghandle { position:absolute; top:-2px; height:18px; width:7px; cursor:col-resize; touch-action:pan-y; z-index:3; }
        .daychip { cursor:pointer; padding:5px 8px; border:1px solid #B9C6CC; font-size:11.5px; border-radius:2px; user-select:none; }
        .daychip.on { background:${supplyTeal}; color:#fff; border-color:${supplyTeal}; }
        .kpistrip { position:sticky; top:0; z-index:5; display:flex; gap:14px; align-items:center; flex-wrap:wrap; background:${ink}; color:#fff; padding:8px 14px; margin-bottom:12px; }
        .kpi { display:flex; flex-direction:column; }
        .kpi .l { font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; opacity:.7; }
        .kpi .v { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1.1; }
        @media (max-width:640px){
          .hdr-title{font-size:24px !important;} .glabel{width:84px;} .phase-row{flex-direction:column;}
          /* phones: nothing stays pinned — the sticky stack (package banner + paddles +
             KPI strip + shift editor) would consume nearly the whole viewport, hiding the
             gantt and coverage chart the user is actually working on */
          .envlock, .kpistrip, .seleditor { position: static !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "16px 12px 40px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", borderBottom: `3px solid ${ink}`, paddingBottom: 10 }}>
          <div className="hdr-title" style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 30 }}>
            SIGNUP WORKBENCH
          </div>
          <div style={{ marginLeft: "auto", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 600 }}>
            <span style={{ fontSize: 11, verticalAlign: "middle", padding: "2px 7px", marginRight: 8, borderRadius: 2, background: demSource === "sketched" ? demandAmber : demSource === "uploaded" ? supplyTeal : sampleGray, color: "#fff", letterSpacing: ".06em" }}>
              {demSource === "sketched" ? "SKETCHED DEMAND" : demSource === "uploaded" ? "UPLOADED DEMAND" : "SAMPLE DATA"}
            </span>
            Weekly coverage score{" "}
            <span style={{ color: eng.weekScore >= 0.9 ? supplyTeal : demandAmber }}>
              {(eng.weekScore * 100).toFixed(1)}%
            </span>
            {changedCount > 0 && (
              <span style={{ fontSize: 14, color: weekDelta >= 0 ? supplyTeal : gapRed }}>
                {" "}({weekDelta >= 0 ? "+" : ""}{weekDelta.toFixed(2)} vs signed)
              </span>
            )}
          </div>
        </div>

        {/* utility toolbar */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, margin: "10px 0" }}>
          <button style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={exportBoard}>Export board</button>
          <button style={nudgeBtn} onClick={saveProject}>Save project</button>
          <button style={nudgeBtn} onClick={() => fileRef.current && fileRef.current.click()}>Load project</button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
            onChange={(e) => { if (e.target.files && e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ""; }} />
        </div>

        {/* phased step navigation */}
        {(() => {
          const PHASES = [
            { label: "Phase 1 · Setup", steps: [
              { key: "rules", label: "RULES", done: !!(signupPeriod.start && signupPeriod.end), reason: "Set a period and jurisdiction in Rules" },
              { key: "signup", label: "SIGNUP", done: signupSource === "uploaded", reason: "Still using Sample Signup — upload your real signup to compare against it" },
              { key: "demand", label: "DEMAND", done: demSource !== "imported", reason: "Still using shipped sample data — sketch your own or upload real data in Demand" },
            ] },
            { label: "Phase 2 · Build", steps: [
              { key: "signup-builder", label: "SIGNUP BUILDER" },
              { key: "board", label: "SHIFT BUILDER", done: changedCount > 0 || signupSource === "uploaded", reason: signupSource === "uploaded" ? "Review the promoted signup or generate a new board" : "Board unchanged from Sample Signup" },
            ] },
            { label: "Phase 3 · Review", steps: [
              { key: "coverage", label: "COVERAGE", done: hasVisitedCoverage, reason: "Not yet reviewed" },
              { key: "suggest", label: "SUGGESTIONS" },
              { key: "compare", label: "COMPARE" },
            ] },
            { label: "Phase 4 · Handoff", steps: [
              { key: "pack", label: "PACKAGING" },
            ] },
          ];
          return (
            <div className="phase-row" style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", margin: "12px 0" }}>
              {PHASES.map((phase, pi) => (
                <React.Fragment key={phase.label}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "#5B6B75" }}>
                      {phase.label}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {phase.steps.map((s) => {
                        const selected = tab === s.key;
                        const tint = selected ? {}
                          : s.done === true ? { background: "#EAF4F3", borderColor: supplyTeal }
                          : s.done === false ? { background: "#FBF1E6", borderColor: demandAmber }
                          : {};
                        return (
                          <div key={s.key} className={"tabbtn" + (selected ? " on" : "")} style={tint}
                            title={!selected && s.done === false ? s.reason : undefined} onClick={() => setTab(s.key)}>
                            {s.done === true && <span style={{ color: supplyTeal, marginRight: 4 }}>✓</span>}
                            {s.label}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {pi < PHASES.length - 1 && (
                    <div style={{ alignSelf: "center", fontSize: 16, color: "#B9C6CC", marginTop: 12 }}>→</div>
                  )}
                </React.Fragment>
              ))}
            </div>
          );
        })()}

        {tab === "board" && (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              <button style={{ ...nudgeBtn, opacity: hist.length ? 1 : 0.4 }} onClick={undo} disabled={!hist.length}>↶ Undo</button>
              <button style={{ ...nudgeBtn, borderColor: changedCount ? demandAmber : "#B9C6CC", opacity: changedCount ? 1 : 0.4 }} onClick={resetAll} disabled={!changedCount}>Reset board</button>
              {flagCount > 0 && (
                <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixAll}>
                  Fix all flags ({flagCount})
                </button>
              )}
              <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={addShift}>+ Add shift</button>
              <button style={{ ...nudgeBtn, opacity: changedCount ? 1 : 0.4, marginLeft: "auto" }} disabled={!changedCount} onClick={() => setShowDiff((v) => !v)}>
                {showDiff ? "Hide" : "Show"} changes since upload ({changedCount})
              </button>
            </div>

            {showDiff && changedCount > 0 && (
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 12, fontSize: 12.5 }}>
                {boardDiff.modified.length > 0 && (() => {
                  const startDeltas = boardDiff.modified.filter(({ seg, orig }) => seg.s !== orig.s).map(({ seg, orig }) => Math.abs(seg.s - orig.s));
                  const brkChanged = boardDiff.modified.filter(({ seg, orig }) => JSON.stringify(seg.b) !== JSON.stringify(orig.b)).length;
                  const retyped = boardDiff.modified.filter(({ seg, orig }) => seg.type !== orig.type).length;
                  const daysChanged = boardDiff.modified.filter(({ seg, orig }) => seg.days.join() !== orig.days.join()).length;
                  const avg = startDeltas.length ? Math.round(startDeltas.reduce((a, b) => a + b, 0) / startDeltas.length) : 0;
                  const max = startDeltas.length ? Math.max(...startDeltas) : 0;
                  return (
                    <div style={{ background: "#F7FAF9", border: "1px solid #DCE7E4", padding: "8px 12px", marginBottom: 10, fontSize: 12.5 }}>
                      <b>Summary vs loaded signup:</b>{" "}
                      {startDeltas.length > 0 && `${startDeltas.length} report-time change${startDeltas.length === 1 ? "" : "s"} (avg ${avg} min, largest ${max} min)`}
                      {startDeltas.length > 0 && (brkChanged > 0 || retyped > 0 || daysChanged > 0) && " · "}
                      {brkChanged > 0 && `${brkChanged} break change${brkChanged === 1 ? "" : "s"}`}
                      {brkChanged > 0 && (retyped > 0 || daysChanged > 0) && " · "}
                      {retyped > 0 && `${retyped} retyped`}
                      {retyped > 0 && daysChanged > 0 && " · "}
                      {daysChanged > 0 && `${daysChanged} day-pattern change${daysChanged === 1 ? "" : "s"}`}
                      {startDeltas.length === 0 && brkChanged === 0 && retyped === 0 && daysChanged === 0 && "end-time-only adjustments"}
                    </div>
                  );
                })()}
                {boardDiff.added.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, color: supplyTeal, marginBottom: 4 }}>Added ({boardDiff.added.length})</div>
                    {boardDiff.added.map((s) => (
                      <div key={s.id} style={{ cursor: "pointer", padding: "2px 0" }} onClick={() => { setSelId(s.id); setShowDiff(false); }}>
                        Shift {s.shift}·{s.run} {s.type} — {fmt(s.s)}–{fmt(s.e)}
                      </div>
                    ))}
                  </div>
                )}
                {boardDiff.removed.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, color: gapRed, marginBottom: 4 }}>Removed ({boardDiff.removed.length})</div>
                    {boardDiff.removed.map((o) => (
                      <div key={o.id} style={{ padding: "2px 0" }}>
                        Shift {o.shift}·{o.run} {o.type} — {fmt(o.s)}–{fmt(o.e)}
                      </div>
                    ))}
                  </div>
                )}
                {boardDiff.modified.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 700, color: demandAmber, marginBottom: 4 }}>Modified ({boardDiff.modified.length})</div>
                    {boardDiff.modified.map(({ seg, orig }) => {
                      const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
                      const parts = [];
                      if (seg.s !== orig.s) parts.push(`start ${sgn(seg.s - orig.s)}m`);
                      if (seg.e !== orig.e) parts.push(`end ${sgn(seg.e - orig.e)}m`);
                      if (!orig.b && seg.b) parts.push("break added");
                      else if (orig.b && !seg.b) parts.push("break removed");
                      else if (orig.b && seg.b) {
                        if (seg.b[0] !== orig.b[0]) parts.push(`break start ${sgn(seg.b[0] - orig.b[0])}m`);
                        const dLen = (seg.b[1] - seg.b[0]) - (orig.b[1] - orig.b[0]);
                        if (dLen !== 0) parts.push(`break ${sgn(dLen)}m ${dLen > 0 ? "longer" : "shorter"}`);
                      }
                      if (seg.type !== orig.type) parts.push(`type ${orig.type}→${seg.type}`);
                      if (seg.days.join() !== orig.days.join()) parts.push("days changed");
                      return (
                        <div key={seg.id} style={{ cursor: "pointer", padding: "2px 0" }} onClick={() => { setSelId(seg.id); setShowDiff(false); }}>
                          Shift {seg.shift}·{seg.run} {seg.type} — {fmt(orig.s)}–{fmt(orig.e)}{orig.b ? ` (break ${fmt(orig.b[0])}–${fmt(orig.b[1])})` : ""} → {fmt(seg.s)}–{fmt(seg.e)}{seg.b ? ` (break ${fmt(seg.b[0])}–${fmt(seg.b[1])})` : ""}
                          {parts.length > 0 && <span style={{ color: demandAmber, fontWeight: 600 }}>  [{parts.join(" · ")}]</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* envelope + day paddles, locked together while scrolling (desktop only — on
            phones the pinned stack would swallow most of the viewport, so .envlock/.seleditor/
            .kpistrip all fall back to normal scrolling under the 640px breakpoint) */}
        <div className="envlock" style={{ position: "sticky", top: 0, zIndex: 10, background: paper, marginBottom: 12 }}>
          <div style={{ border: "1px solid #E2E8EA" }}>
            <div style={{ background: ink, color: "#fff", padding: "10px 14px" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 600 }}>SIGNUP PACKAGE</div>
                <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                  Total signed
                  <NumField value={totalSigned} onCommit={(v) => setTotalSigned(Math.round(v))} style={numInput} />
                </label>
                <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                  Extra board
                  <NumField value={blockSize} onCommit={(v) => setBlockSize(Math.round(v))} style={numInput} />
                </label>
                <div style={{ fontSize: 13 }}>
                  → <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 21, fontWeight: 700 }}>{designed}</span> designed runs
                  {designed !== distinctShifts && <span style={{ color: "#F5C16C" }}> (board has {distinctShifts})</span>}
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.8, marginLeft: "auto" }}>
                  Loaded board: {distinctShifts} runs · sample data — Load project to work on your own board{changedCount > 0 ? ` · ${changedCount} local change${changedCount > 1 ? "s" : ""}` : ""}
                </div>
              </div>
            </div>
          </div>

          {/* day paddles */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: 5, marginTop: 8 }}>
            {DAYS.map((d) => {
              const p = eng.perDay[d];
              return (
                <div key={d} className={"paddle" + (d === day ? " on" : "")} onClick={() => { setDay(d); }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 14 }}>{d.slice(0, 3).toUpperCase()}</div>
                  <div style={{ fontSize: 9.5, opacity: .75 }}>demand {(p.demandShare * 100).toFixed(1)}%</div>
                  <div style={{ fontSize: 10.5, marginTop: 2, fontWeight: 600, color: d === day ? "#fff" : (p.dayScore >= 0.9 ? supplyTeal : demandAmber) }}>
                    cov {(p.dayScore * 100).toFixed(1)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {tab === "signup" && (
          <>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>Signup source</div>
              <span style={{ fontSize: 13.5 }}>
                Working from: <b>{signupSource === "uploaded" ? "your uploaded signup" : "Sample Signup"}</b>
              </span>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button style={nudgeBtn} onClick={downloadSignupTemplate}>Download template</button>
                <button style={nudgeBtn} onClick={() => signupFileRef.current && signupFileRef.current.click()}>Upload signup</button>
                <input ref={signupFileRef} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => { if (e.target.files && e.target.files[0]) uploadSignup(e.target.files[0]); e.target.value = ""; }} />
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", flexBasis: "100%" }}>
                Load a real current or previous signup to work off of instead of Sample Signup — the coverage-score deltas shown throughout the tool ("vs signed") will measure improvement against it instead of synthetic data. Download the template, fill in your real shifts (one row per shift, or one row per day-variant time pattern), and upload it. No operator names or badge numbers are read or stored — only shift structure.
              </div>
              {signupUploadResult && (
                <div style={{ background: "#F2F8F7", border: `1px solid ${supplyTeal}`, padding: "8px 12px", fontSize: 12.5, flexBasis: "100%" }}>
                  <b>Upload complete:</b> now working from {signupUploadResult.shifts} shifts ({signupUploadResult.rows} rows) — this is also your new comparison baseline.
                  {(signupUploadResult.dateSpecificSkipped > 0 || signupUploadResult.footerRowsSkipped > 0 || signupUploadResult.unrecognizedTypes.length > 0 || signupUploadResult.exceptionDates > 0 || signupUploadResult.autoClassified > 0 || signupUploadResult.unclassified > 0) && <>{" "}
                    {signupUploadResult.autoClassified > 0 && `${signupUploadResult.autoClassified} shift(s) had no classification and were auto-matched to your Rules windows from their times${signupUploadResult.ambiguousClassified > 0 ? ` (${signupUploadResult.ambiguousClassified} fit more than one type — the tightest window was chosen; review in Shift Builder)` : ""}. `}
                    {signupUploadResult.unclassified > 0 && `${signupUploadResult.unclassified} shift(s) had no classification and matched no type in Rules — they're flagged until you assign one. `}
                    {signupUploadResult.exceptionDates > 0 && `${signupUploadResult.exceptionRows} exception-day shift row(s) across ${signupUploadResult.exceptionDates} date(s) were imported into Exception days (Coverage tab) — any existing custom schedule for those dates was overwritten. `}
                    {signupUploadResult.dateSpecificSkipped > 0 && `${signupUploadResult.dateSpecificSkipped} date-specific relief row(s) skipped (not part of the recurring weekly pattern). `}
                    {signupUploadResult.footerRowsSkipped > 0 && `${signupUploadResult.footerRowsSkipped} row(s) skipped (no valid shift number or times). `}
                    {signupUploadResult.unrecognizedTypes.length > 0 && `Unrecognized shift type(s) kept as-is: ${signupUploadResult.unrecognizedTypes.join(", ")} — review in Rules.`}
                  </>}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 14 }}>
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Shifts & hours by day
                </div>
                <table className="shares" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th>Day</th><th>Shifts</th><th>Planned hours</th></tr></thead>
                  <tbody>
                    {DAYS.map((d) => (
                      <tr key={d}>
                        <td>{d}</td>
                        <td>{signupStats.perDay[d].shifts.size}</td>
                        <td>{signupStats.perDay[d].hours.toFixed(0)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: "1px solid #E7EDEF" }}>
                      <td>Total</td>
                      <td>{DAYS.reduce((n, d) => n + signupStats.perDay[d].shifts.size, 0)}</td>
                      <td>{DAYS.reduce((n, d) => n + signupStats.perDay[d].hours, 0).toFixed(0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Weekly hours by shift type
                </div>
                <table className="shares" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th>Type</th><th>Planned hours / week</th></tr></thead>
                  <tbody>
                    {Object.entries(signupStats.byType).sort((a, b) => b[1] - a[1]).map(([t, hrs]) => (
                      <tr key={t}>
                        <td><span style={{ fontSize: 10.5, padding: "1px 6px", background: tColor(t), color: "#fff", borderRadius: 2 }}>{t}</span></td>
                        <td>{hrs.toFixed(0)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: "1px solid #E7EDEF" }}>
                      <td>Total planned weekly hours</td>
                      <td>{Object.values(signupStats.byType).reduce((a, b) => a + b, 0).toFixed(0)}</td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  These figures reflect the loaded baseline (what you started with), not live edits made elsewhere in the tool.
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "demand" && (
          <>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>Demand source</div>
              <label style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={demSource === "imported"} onChange={() => setDemSource("imported")} />
                Sample demand data
              </label>
              <label style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={demSource === "sketched"} onChange={() => setDemSource("sketched")} />
                Sketched demand
              </label>
              <label style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, opacity: uploadedDem ? 1 : 0.5 }}>
                <input type="radio" checked={demSource === "uploaded"} disabled={!uploadedDem} onChange={() => setDemSource("uploaded")} />
                Uploaded real data{!uploadedDem ? " (upload below)" : ""}
              </label>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button style={nudgeBtn} onClick={downloadDemandTemplate}>Download template</button>
                <button style={nudgeBtn} onClick={() => demFileRef.current && demFileRef.current.click()}>Upload demand data</button>
                <input ref={demFileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  style={{ display: "none" }}
                  onChange={(e) => { if (e.target.files && e.target.files[0]) uploadDemand(e.target.files[0]); e.target.value = ""; }} />
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", flexBasis: "100%" }}>
                No data export needed to get started: tell the tool roughly how many trips you run, then shape the curve by feel. Every screen scores against whichever source is active, and the badge in the header always shows which one that is. Or download the template, fill in your real 5-minute pickup/dropoff counts, and upload it — without losing anything you've already set up.
              </div>
              {demUploadResult && (
                <div style={{ background: "#F2F8F7", border: `1px solid ${supplyTeal}`, padding: "8px 12px", fontSize: 12.5, flexBasis: "100%" }}>
                  <b>Upload complete:</b> now scoring against your uploaded data. Trip counts for each day below were recalculated from your file.
                  {demUploadResult.paddedRows > 0 || demUploadResult.coercedCells > 0 || demUploadResult.extraRowsIgnored > 0
                    ? <>{" "}{demUploadResult.paddedRows > 0 && `${demUploadResult.paddedRows} missing row(s) padded with 0. `}
                        {demUploadResult.coercedCells > 0 && `${demUploadResult.coercedCells} non-numeric cell(s) treated as 0. `}
                        {demUploadResult.extraRowsIgnored > 0 && `${demUploadResult.extraRowsIgnored} extra row(s) ignored.`}</>
                    : " All 7 sheets matched the template exactly."}
                </div>
              )}
              {demUploadResult && demUploadResult.suspiciousDays && demUploadResult.suspiciousDays.length > 0 && (
                <div style={{ background: "#FDF3E7", border: `1px solid ${demandAmber}`, padding: "8px 12px", fontSize: 12.5, flexBasis: "100%" }}>
                  <b>Possible data-entry issue on {demUploadResult.suspiciousDays.join(", ")}:</b> most of the active 5-minute
                  slots on {demUploadResult.suspiciousDays.length > 1 ? "these days" : "this day"} repeat the same pickup/dropoff
                  values in runs of 6 or more — the usual sign that coarser totals (e.g. half-hourly) were pasted into every
                  5-minute row instead of split across them. That would inflate trip counts and anything derived from them
                  (like Suggested vehicles on Coverage) by roughly the run length. This doesn't block anything — your uploaded
                  numbers are used exactly as-is — but if this wasn't intentional, re-check the source file before relying on
                  totals derived from it.
                </div>
              )}
            </div>

            {demSource !== "sketched" && (
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                  {DAYS.map((d) => (
                    <div key={d} className={"tabbtn" + (day === d ? " on" : "")} style={{ padding: "6px 12px", fontSize: 13 }}
                      onClick={() => setDay(d)}>
                      {d.slice(0, 3).toUpperCase()}
                    </div>
                  ))}
                  <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#41525C" }}>
                    Scoring against {DEM_SOURCE_LABEL[demSource].toLowerCase()}
                  </span>
                </div>
                <ActualCurve ev={DEM[day]} label="actual demand" />
                {(() => {
                  const ev = DEM[day];
                  const tot = ev.reduce((a, b) => a + b, 0);
                  let pk = 0, pkI = 0, am = 0;
                  for (let i = 0; i < N; i++) {
                    if (ev[i] > pk) { pk = ev[i]; pkI = i; }
                    if (SLOT(i) < 720) am += ev[i];
                  }
                  return (
                    <div style={{ fontSize: 12.5, color: "#41525C", marginTop: 8 }}>
                      Peak {fmt(SLOT(pkI))} · {tot > 0 ? ((am / tot) * 100).toFixed(0) : 0}% of demand before noon · {Math.round(tot / 2).toLocaleString()} implied trips
                      {glob.demandShare < 100 ? ` (all providers; this signup ≈ ${Math.round((tot / 2) * (glob.demandShare / 100)).toLocaleString()} at its ${glob.demandShare}% share)` : ""} · {day}
                    </div>
                  );
                })()}
              </div>
            )}

            {demSource === "sketched" && (
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontSize: 12.5, color: "#5B6B75", marginBottom: 10 }}>
                  Sketch a typical day's shape, then set its trip count. Choose how finely to split the week below — a shared weekday pattern, a shared weekend pattern, or every day on its own. Each trip counts as a pickup and a drop-off (×2) in the coverage score.
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 11.5, color: "#5B6B75", alignSelf: "center" }}>Split the week:</span>
                  {Object.entries(SKETCH_MODE_LABELS).map(([m, label]) => (
                    <div key={m} className={"tabbtn" + (sketchMode === m ? " on" : "")} style={{ padding: "4px 10px", fontSize: 12.5 }}
                      onClick={() => setSketchMode(m)}>
                      {label}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                  {SKETCH_GROUPS[sketchMode].map((g) => (
                    <div key={g.key} className={"tabbtn" + (curveTab === g.key ? " on" : "")} style={{ padding: "6px 14px", fontSize: 15 }}
                      onClick={() => setCurveTab(g.key)}>
                      {g.label.toUpperCase()}
                    </div>
                  ))}
                  <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    {activeGroup.days.length > 1 ? `Trips per day (same value applied ${activeGroup.label})` : `Trips on ${activeGroup.label}`}
                    <NumField value={trips[repDay]} onCommit={(v) => setGroupTrips(Math.round(v))} style={numInput} />
                  </label>
                </div>

                <Sketcher raw={sketch[repDay]} trips={trips[repDay]} setRaw={setGroupSketch} />

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#5B6B75" }}>Start from:</span>
                  <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.weekday])}>Weekday pattern</button>
                  <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.hump])}>Midday hump</button>
                  <button style={nudgeBtn} onClick={() => setGroupSketch([...TPL.flat])}>Flat</button>
                  {(() => {
                    const ev = sketchToEv(sketch[repDay], trips[repDay]);
                    const tot = ev.reduce((a, b) => a + b, 0);
                    let pk = 0, pkI = 0, am = 0;
                    for (let i = 0; i < N; i++) {
                      if (ev[i] > pk) { pk = ev[i]; pkI = i; }
                      if (SLOT(i) < 720) am += ev[i];
                    }
                    return (
                      <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#41525C" }}>
                        Peak {fmt(SLOT(pkI))} · {tot > 0 ? ((am / tot) * 100).toFixed(0) : 0}% of demand before noon · applies to {activeGroup.days.map((d) => d.slice(0, 3)).join(", ")}
                      </span>
                    );
                  })()}
                </div>
              </div>
            )}
          </>
        )}

        {tab === "signup-builder" && (
          <>
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
                Start from your uploaded signup
              </div>
              {signupSource === "uploaded" ? (
                <>
                  <div style={{ fontSize: 13, color: "#41525C" }}>
                    Working board already reflects your uploaded signup{changedCount > 0 ? ` — ${changedCount} local change${changedCount > 1 ? "s" : ""} since then` : " — no local changes yet"}.
                  </div>
                  <button style={{ ...nudgeBtn, marginTop: 8, borderColor: changedCount ? demandAmber : "#B9C6CC", opacity: changedCount ? 1 : 0.5 }} disabled={!changedCount}
                    onClick={resetAll}>
                    Use uploaded signup as working board
                  </button>
                </>
              ) : (
                <div style={{ fontSize: 13, color: "#41525C" }}>
                  Still working from Sample Signup — upload your real signup on the SIGNUP tab to promote it as your working board.
                </div>
              )}
            </div>

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Generate a starting board from the rules and demand
                </div>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  Weekly packages to build
                  <NumField value={buildN} onCommit={(v) => setBuildN(Math.round(v))} style={numInput} />
                </label>
                <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink, opacity: buildBusy || optRunning ? 0.5 : 1 }} disabled={buildBusy || optRunning}
                  onClick={() => {
                    setBuildBusy(true);
                    setTimeout(() => {
                      let typeSequence = null, startShiftNumber = null;
                      if (followBaselinePattern) {
                        const blocks = deriveTypeBlocks(baselineBoard);
                        typeSequence = buildTypeSequence(blocks, buildN);
                        startShiftNumber = Math.max(glob.shiftSeriesBase || 6000, 1 + Math.max(0, ...board.map((s) => s.shift), ...baselineBoard.map((s) => s.shift)));
                      }
                      const g = generateBoard(glob.max10, buildN, rules, glob, DEM, spans, glob.minVeh, includePT, typeSequence, startShiftNumber);
                      const score = computeEngine(DEM, buildSupply(g.segs), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias).weekScore;
                      setBuildResult({ ...g, score });
                      setBuildBusy(false);
                    }, 30);
                  }}>
                  {buildBusy ? "Generating…" : "Generate board"}
                </button>
              </div>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <input type="checkbox" checked={followBaselinePattern} onChange={(e) => setFollowBaselinePattern(e.target.checked)} />
                Follow existing shift-type pattern (recommended when working from an uploaded signup)
              </label>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 6 }}>
                Builds whole weekly packages: each placement chooses a shift type, a start time on the 5-minute grid, and a consecutive days-off pattern together, so every generated shift is signable by construction — consistent report times all week, legal rest, no orphan runs. Uses the full 10-hour allowance from Rules before any 8-hour work. Break-taking types are explored at every legal length (30 min to 4 h) and position, so long midday breaks that stretch a shift across both peaks are found automatically. The fleet cap, minimum-vehicle floor, sign-in stagger, and pull-out/pull-in lead time (Rules → Deadhead & productivity) steer every placement — a shift may start before the first trip it serves and end after the last, to allow for that lead time. Set the count to your designed-run envelope ({designed} currently). Loading a build replaces the current board — save your project first. With "Follow existing shift-type pattern" checked, new shifts fill one baseline shift-type block completely before moving to the next, in the same order as your uploaded signup, numbered to continue past its highest shift number.
              </div>
            </div>

            {buildResult && (
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", maxWidth: 420, marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 10px" }}>
                  <Stat label="Weekly coverage score" value={`${(buildResult.score * 100).toFixed(1)}%`} sub={`${(buildResult.evaluated || 0).toLocaleString()} placements evaluated`} tone={supplyTeal} />
                  <Stat label="Paid hours / week" value={buildResult.paidHours.toFixed(0)} tone={targetInk} />
                  <Stat label="10-hour packages" value={buildResult.used10} sub={`cap ${glob.max10}`} tone={demandAmber} />
                </div>
                <div style={{ fontSize: 12.5, color: "#41525C" }}>
                  Mix: {Object.entries(buildResult.mix).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ")}
                </div>
                <button style={{ ...nudgeBtn, marginTop: 10, background: supplyTeal, color: "#fff", borderColor: supplyTeal }}
                  onClick={() => {
                    mutate(() => buildResult.segs.map(cloneSeg));
                    setSelId(null);
                    setTab("board");
                  }}>
                  Load this board into the Designer
                </button>
              </div>
            )}

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Retime the loaded signup within the rules
                </div>
                <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink, opacity: retimeBusy || optRunning || !baselineBoard.length ? 0.5 : 1 }}
                  disabled={retimeBusy || optRunning || !baselineBoard.length}
                  onClick={() => {
                    setRetimeBusy(true);
                    setTimeout(() => {
                      const r = retimeBoard(baselineBoard, rules, glob, DEM, spans, glob.minVeh, includePT);
                      const score = computeEngine(DEM, buildSupply(r.segs), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias).weekScore;
                      const baselineScore = computeEngine(DEM, buildSupply(baselineBoard), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias).weekScore;
                      setRetimeResult({ ...r, score, baselineScore });
                      setRetimeBusy(false);
                    }, 30);
                  }}>
                  {retimeBusy ? "Retiming…" : "Retime signup"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 6 }}>
                "Same runs, better times": every run keeps its shift number, run number, classification, and days-off pattern — only report time, end time, and break placement are re-chosen, from the full rule windows in Rules, to maximize coverage. Placement prefers keeping each run near its current report time: near-equal options resolve to the run already at that hour instead of swapping two runs’ times, and only genuine coverage gains move a run far. Because the runs stay recognizable, the result compares one-for-one against the loaded signup (ghost bars and the change list show every move). Starts from the loaded signup, not local edits. Runs whose times vary by day are consolidated to one consistent time across their days; runs whose type isn't defined in Rules pass through unchanged. Fleet cap, minimum vehicles, sign-in stagger, and pull-out/pull-in lead all steer every placement.
              </div>
            </div>

            {retimeResult && (
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", maxWidth: 460 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 10px" }}>
                  <Stat label="Weekly coverage score"
                    value={`${(retimeResult.baselineScore * 100).toFixed(1)}% → ${(retimeResult.score * 100).toFixed(1)}%`}
                    sub={`${retimeResult.score >= retimeResult.baselineScore ? "+" : ""}${((retimeResult.score - retimeResult.baselineScore) * 100).toFixed(1)} vs loaded signup`}
                    tone={retimeResult.score >= retimeResult.baselineScore ? supplyTeal : gapRed} />
                  <Stat label="Runs retimed" value={retimeResult.retimed} sub={`${retimeResult.kept} kept as-is`} tone={targetInk} />
                  <Stat label="Placements evaluated" value={(retimeResult.evaluated || 0).toLocaleString()} tone={demandAmber} />
                </div>
                <div style={{ fontSize: 12.5, color: "#41525C" }}>
                  Mix (unchanged by construction): {Object.entries(retimeResult.mix).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ")}
                </div>
                <button style={{ ...nudgeBtn, marginTop: 10, background: supplyTeal, color: "#fff", borderColor: supplyTeal }}
                  onClick={() => {
                    mutate(() => retimeResult.segs.map(cloneSeg));
                    setSelId(null);
                    setTab("board");
                  }}>
                  Load the retimed signup into the Designer
                </button>
              </div>
            )}

            <div style={{ background: card, border: `1px solid ${optRunning ? supplyTeal : "#E2E8EA"}`, padding: "12px 14px", marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Optimization monitor
                </div>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="radio" checked={optMode === "retime"} disabled={optRunning} onChange={() => setOptMode("retime")} />
                  Retime the loaded signup
                </label>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="radio" checked={optMode === "generate"} disabled={optRunning} onChange={() => setOptMode("generate")} />
                  New signup from rules &amp; demand ({buildN} packages{followBaselinePattern ? ", following type pattern" : ""})
                </label>
                {!optRunning ? (
                  <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink, marginLeft: "auto" }}
                    disabled={optMode === "retime" && !baselineBoard.length}
                    onClick={() => startOptimize(optMode)}>
                    ▶ Start optimizing
                  </button>
                ) : (
                  <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed, marginLeft: "auto" }}
                    onClick={stopOptimize}>
                    ■ Stop
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 6 }}>
                Runs until you stop it: randomized full rebuilds explore different constructions, then the search digs around the best board found by re-placing a few runs at a time with everything else locked — millions of placements deep. The best score only ever goes up. Inputs (rules, demand, signup) are snapshotted when you press Start; keep this page open while it runs. Stopping finishes with a polish pass before the result is final.
              </div>

              {optRun && (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0 0" }}>
                    <Stat label="Runtime" value={`${Math.floor(optRun.elapsed / 60)}:${String(Math.floor(optRun.elapsed % 60)).padStart(2, "0")}`} sub={optRun.running ? "running" : "stopped"} tone={optRun.running ? supplyTeal : sampleGray} />
                    <Stat label="Iterations" value={optRun.iter.toLocaleString()} sub={`${optRun.restarts.toLocaleString()} rebuilds · ${optRun.refines.toLocaleString()} refinements`} tone={targetInk} />
                    <Stat label="Placements evaluated" value={optRun.evaluated.toLocaleString()} tone={demandAmber} />
                    <Stat label="Best weekly coverage"
                      value={optRun.bestScore != null ? `${(optRun.bestScore * 100).toFixed(2)}%` : "—"}
                      sub={optRun.bestScore != null && optRun.baselineScore != null
                        ? `${optRun.bestScore >= optRun.baselineScore ? "+" : ""}${((optRun.bestScore - optRun.baselineScore) * 100).toFixed(2)} vs ${optRun.mode === "retime" ? "loaded signup" : "single-shot build"}`
                        : undefined}
                      tone={supplyTeal} />
                    <Stat label="Last improvement" value={optRun.lastImproveT > 0 ? `${Math.round(optRun.elapsed - optRun.lastImproveT)}s ago` : "—"} tone={sampleGray} />
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
                      <div style={{ fontSize: 11, color: "#8899A3", textAlign: "right" }}>best coverage over time</div>
                    </div>
                  )}
                  {optRun.bestScore != null && (
                    <button style={{ ...nudgeBtn, marginTop: 10, background: supplyTeal, color: "#fff", borderColor: supplyTeal }}
                      onClick={() => {
                        const st = optRef.current;
                        if (!st || !st.best) return;
                        mutate(() => st.best.map(cloneSeg));
                        setSelId(null);
                        setTab("board");
                      }}>
                      Load best into the Designer
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {tab === "coverage" && (
          <>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", background: card, border: "1px solid #E2E8EA", padding: "10px 14px", marginBottom: 12 }}>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
                <input type="checkbox" checked={showBookout} onChange={(e) => setShowBookout(e.target.checked)} />
                Observed vehicles{RAW.bookout[day] ? "" : " (none this day)"}
              </label>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
                <input type="checkbox" checked={showProductivity} onChange={(e) => setShowProductivity(e.target.checked)} />
                Suggested vehicles (day share)
              </label>
            </div>

            <details style={{ background: "#F7FAF9", border: "1px solid #DCE7E4", padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16 }}>
                What do these numbers mean?
              </summary>
              <div style={{ marginTop: 8, lineHeight: 1.55, color: "#33434D" }}>
                <b>Coverage score</b> answers one question: of all the trip demand in the period, what share happens while your service hours are proportionally in place to serve it? 100% would mean your hours perfectly trace the demand pattern — impossible in practice, since shifts come in fixed lengths with rules. Use the score to compare boards: higher means hours better matched to demand.<br /><br />
                On each day tile, <b>demand</b> is that day's share of the week's trips, and <b>cov</b> is that day's coverage score. In the chart, the dark line is the <b>demand-aligned target</b> — your own hours redrawn to follow demand exactly (or weighted demand, when an off-peak weighting is set in Rules — light periods then claim proportionally more). <b>Red</b> = you're lighter than demand suggests at that time. <b>Teal above the line</b> = heavier than demand suggests (those hours earn no score). <b>Misplaced hours</b> totals the hours sitting in the heavy zones.<br /><br />
                <b>Suggested vehicles</b> (optional overlay) takes the vehicle-hours already on today's board and redistributes them along the day's trip-share curve: at each moment it shows how many of your own vehicles would be in service if the day's fleet were allocated purely by that moment's percentage of the day's trips. No assumed constants — it always adds back up to exactly the hours you've scheduled, so where it sits above the supply line you're proportionally light, and below it you're proportionally heavy. It differs from the demand-aligned target only in scope: the target spreads the whole week's hours by the week's demand, this line spreads today's hours by today's. Visual reference only — never affects the coverage score or generation.
              </div>
            </details>

            {(() => {
              const starts = startsPerSlot(board);
              const viol = [];
              for (let i = 0; i < N; i++) {
                if (glob.maxPullout > 0 && starts[day][i] > glob.maxPullout)
                  viol.push({ t: SLOT(i), n: starts[day][i] });
              }
              if (!viol.length) return null;
              return (
                <div style={{ background: "#FDF3E7", border: `1px solid ${demandAmber}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
                  <b>Sign-in bottlenecks ({day}):</b>{" "}
                  {viol.slice(0, 8).map((v, i) => (
                    <span key={i}>{fmt(v.t)} has {v.n} sign-ins (max {glob.maxPullout}){i < Math.min(viol.length, 8) - 1 ? "; " : ""}</span>
                  ))}
                  {viol.length > 8 && <span> … and {viol.length - 8} more slots</span>}
                  <span> — stagger these report times to avoid a garage queue.</span>
                </div>
              );
            })()}

            {P.floorViol.length > 0 && (
              <div style={{ background: "#FDF3E7", border: `1px solid ${demandAmber}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
                <b>Minimum vehicles check ({day}):</b>{" "}
                {P.floorViol.map((v, i) => (
                  <span key={i}>{fmt(SLOT(v.from))}–{fmt(SLOT(v.to) + 5)} runs {v.min} (minimum {glob.minVeh}){i < P.floorViol.length - 1 ? "; " : ""}</span>
                ))}
              </div>
            )}
            {P.fleetViol.length > 0 && (
              <div style={{ background: "#FBEDEB", border: `1px solid ${gapRed}`, padding: "8px 12px", marginBottom: 12, fontSize: 12.5 }}>
                <b>Fleet cap ({day}):</b>{" "}
                {P.fleetViol.map((v, i) => (
                  <span key={i}>{fmt(SLOT(v.from))}–{fmt(SLOT(v.to) + 5)} peaks at {v.max} vehicles (cap {glob.maxFleet}){i < P.fleetViol.length - 1 ? "; " : ""}</span>
                ))}
                <span> — more buses booked out than operationally available.</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <Stat label={`${day} coverage score`} value={`${(P.dayScore * 100).toFixed(1)}%`}
                sub={changedCount ? `signed board: ${(base.perDay[day].dayScore * 100).toFixed(1)}%` : "% of demand pattern your service hours line up with"}
                tone={P.dayScore >= 0.9 ? supplyTeal : demandAmber} />
              <Stat label="Misplaced hours" value={`${P.misallocVH.toFixed(0)} vh`} sub="service hours sitting where demand is proportionally lower" tone={gapRed} />
              <Stat label="Peak supply" value={P.peakSup} sub={includePT ? "incl. supplemental runs, breaks netted" : "designed runs only, breaks netted"} tone={supplyTeal} />
              <Stat label="Day resources" value={`${P.supVH.toFixed(0)} vh`} sub={`${(P.resourceShare * 100).toFixed(1)}% of week vs ${(P.demandShare * 100).toFixed(1)}% demand`} tone={targetInk} />
            </div>

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "14px 4px 4px" }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, padding: "0 10px 6px" }}>
                {day} — service hours vs demand-aligned target
              </div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={glob.maxFleet} showBookout={showBookout} showProductivity={showProductivity} height={340} />
              <div style={{ fontSize: 11.5, color: "#5B6B75", padding: "2px 10px 10px" }}>
                The dark line shows where {day}'s {P.supVH.toFixed(0)} service hours would sit if they exactly followed the demand pattern. Red = times you're lighter than demand suggests; teal above the line = heavier.
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))", gap: 14, marginTop: 14 }}>
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 600, marginBottom: 8 }}>
                  Most underweighted {day} windows
                </div>
                {P.gaps.slice(0, 3).map((g, i) => (
                  <div key={i} style={{ borderLeft: `3px solid ${gapRed}`, padding: "6px 10px", marginBottom: 8, background: "#FDF6F5" }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      {fmt(SLOT(g.from))}–{fmt(SLOT(g.to) + 5)} · up to {g.maxVeh.toFixed(1)} vehicles below target
                    </div>
                    <div style={{ fontSize: 12, color: "#5B6B75" }}>
                      Worth {(g.weight * 100).toFixed(2)} points of {day}'s score. Open the Shift Builder to move work here.
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
                  Demand share vs resource share
                </div>
                <table className="shares" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th>Day</th><th>Dem %</th><th>Res %</th><th>Δ</th><th>Coverage</th></tr></thead>
                  <tbody>
                    {DAYS.map((d) => {
                      const p = eng.perDay[d];
                      const delta = (p.resourceShare - p.demandShare) * 100;
                      return (
                        <tr key={d} style={{ background: d === day ? "#F0F5F6" : "transparent" }}>
                          <td>{d}</td>
                          <td>{(p.demandShare * 100).toFixed(1)}</td>
                          <td>{(p.resourceShare * 100).toFixed(1)}</td>
                          <td style={{ color: Math.abs(delta) > 1.5 ? demandAmber : "#5B6B75" }}>{delta >= 0 ? "+" : ""}{delta.toFixed(1)}</td>
                          <td style={{ fontWeight: 600, color: p.dayScore >= 0.9 ? supplyTeal : demandAmber }}>{(p.dayScore * 100).toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {customHolidays.length > 0 && (() => {
              const segs = holSegs;
              const weekday = selHoliday ? DAYS[new Date(selHoliday.date + "T00:00:00").getDay()] : null;
              const flagCountHol = segs.reduce((n, s) => n + (validateSeg(s, rules, glob).length > 0 ? 1 : 0), 0);
              return (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 8 }}>
                    Exception days
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(customHolidays.length, 7)},minmax(0,1fr))`, gap: 5, marginBottom: 12 }}>
                    {customHolidays.map((h) => {
                      const w = DAYS[new Date(h.date + "T00:00:00").getDay()];
                      const on = selHoliday && h.id === selHoliday.id;
                      return (
                        <div key={h.id} className={"paddle" + (on ? " on" : "")}
                          onClick={() => setSelectedHolidayId(on ? null : h.id)}>
                          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 13 }}>{h.date}</div>
                          <div style={{ fontSize: 9.5, opacity: .8 }}>{w.slice(0, 3)} · {h.name}</div>
                          <div style={{ fontSize: 10.5, marginTop: 2, fontWeight: 600 }}>{(h.segs || []).length} shift{(h.segs || []).length === 1 ? "" : "s"}</div>
                        </div>
                      );
                    })}
                  </div>

                  {selHoliday && (
                    <>
                      <div className="kpistrip" style={{ top: ENVELOPE_H }}>
                        <div className="kpi"><span className="l">editing</span><span className="v">{selHoliday.name}</span></div>
                        <div className="kpi"><span className="l">date</span><span className="v">{selHoliday.date} ({weekday})</span></div>
                        <div className="kpi"><span className="l">shifts</span><span className="v">{segs.length}</span></div>
                        <div className="kpi"><span className="l">rule flags</span><span className="v" style={{ color: flagCountHol ? "#F09E93" : "#7FD1C0" }}>{flagCountHol}</span></div>
                        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                          <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={addHolSeg}>+ Add shift</button>
                          <button style={nudgeBtn} onClick={() => setSelectedHolidayId(null)}>Close</button>
                        </div>
                      </div>

                      <div style={{ background: "#EEF4F5", border: "1px dashed #B9C6CC", padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#41525C" }}>
                        A one-off shift list for this specific date only — no coverage score, and none of the weekly-package rules (rest between shifts, consecutive days, days-off contiguity) apply, since this isn't a recurring week. Each shift is still checked against its type's classification rules.
                      </div>

                      {selHolSeg && (
                        <div style={{ background: card, border: `1px solid ${selHolSegIssues.length ? gapRed : "#E2E8EA"}`, padding: "12px 14px", marginBottom: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700 }}>
                              One-off shift
                            </div>
                            <select value={selHolSeg.type} onChange={(e) => setHolSegType(e.target.value)}>
                              {Object.keys(rules).map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                            {selHolSeg.sourceShift != null && <span style={{ fontSize: 11, color: "#5B6B75" }}>from shift {selHolSeg.sourceShift} / run {selHolSeg.sourceRun}</span>}
                            <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button style={nudgeBtn} onClick={duplicateHolSeg}>Duplicate</button>
                              <button style={{ ...nudgeBtn, borderColor: gapRed, color: gapRed }} onClick={removeHolSeg}>Remove</button>
                              {selHolSegIssues.length > 0 && <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixHolSeg}>Fix violations</button>}
                              <button style={nudgeBtn} onClick={() => setSelHolSegId(null)}>Close</button>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
                            <Nudge label="Start" value={fmt(selHolSeg.s)}
                              onDec={() => patchHolSeg({ s: selHolSeg.s - 5 })} onInc={() => patchHolSeg({ s: selHolSeg.s + 5 })} />
                            <Nudge label="End" value={fmt(selHolSeg.e)}
                              onDec={() => patchHolSeg({ e: selHolSeg.e - 5 })} onInc={() => patchHolSeg({ e: selHolSeg.e + 5 })} />
                            <Nudge label="Shift spread" value={`${((selHolSeg.e - selHolSeg.s) / 60).toFixed(2)}h`}
                              onDec={() => patchHolSeg({ s: selHolSeg.s - 5, e: selHolSeg.e - 5, b: selHolSeg.b ? [selHolSeg.b[0] - 5, selHolSeg.b[1] - 5] : null })}
                              onInc={() => patchHolSeg({ s: selHolSeg.s + 5, e: selHolSeg.e + 5, b: selHolSeg.b ? [selHolSeg.b[0] + 5, selHolSeg.b[1] + 5] : null })} />
                            {selHolSeg.b && (
                              <>
                                <Nudge label={`Break start`} value={fmt(selHolSeg.b[0])}
                                  onDec={() => shiftHolSegBreak(-5)} onInc={() => shiftHolSegBreak(5)} />
                                <Nudge label={`Break length`} value={`${selHolSeg.b[1] - selHolSeg.b[0]}m`}
                                  onDec={() => patchHolSeg({ b: [selHolSeg.b[0], selHolSeg.b[1] - 5] })} onInc={() => patchHolSeg({ b: [selHolSeg.b[0], selHolSeg.b[1] + 5] })} />
                              </>
                            )}
                            <button style={nudgeBtn} onClick={toggleHolSegBreak}>{selHolSeg.b ? "Remove break" : "Add break"}</button>
                          </div>
                          {selHolSegIssues.length > 0 && (
                            <div style={{ marginTop: 10, borderLeft: `3px solid ${gapRed}`, background: "#FDF6F5", padding: "6px 10px" }}>
                              {selHolSegIssues.map((iss, i) => <div key={i} style={{ fontSize: 12.5, color: gapRed }}>⚠ {iss}</div>)}
                            </div>
                          )}
                          {holFixResult && holFixResult.stuck && (
                            <div style={{ marginTop: 10, fontSize: 12.5, color: "#5B6B75" }}>
                              No legal correction exists for this shift under its current type — try changing its type, or adjust the windows in Rules.
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 10px" }}>
                        <div style={{ maxHeight: 430, overflowY: "auto" }}>
                          {segs.length === 0 && (
                            <div style={{ fontSize: 13, color: "#5B6B75", padding: "8px 4px" }}>No shifts yet — "+ Add shift" above to start laying out this date's board.</div>
                          )}
                          {segs.map((sg) => {
                            const bad = validateSeg(sg, rules, glob).length > 0;
                            const isSel = sg.id === selHolSegId;
                            const brkMin = sg.b ? sg.b[1] - sg.b[0] : 0;
                            const workHrs = ((sg.e - sg.s - brkMin) / 60).toFixed(2);
                            const barTitle = `${fmt(sg.s)}–${fmt(sg.e)} · ${workHrs}h working${sg.b ? ` · ${brkMin}m break (${fmt(sg.b[0])}–${fmt(sg.b[1])})` : ""}${sg.sourceShift != null ? ` · from shift ${sg.sourceShift}/run ${sg.sourceRun}` : ""}`;
                            return (
                              <div key={sg.id} className="ganttrow" onClick={() => setSelHolSegId(sg.id)}>
                                <div className="glabel" style={{ fontWeight: isSel ? 700 : 400, color: bad ? gapRed : undefined }}>
                                  {sg.type}
                                </div>
                                <div className="gtrack" title={barTitle}>
                                  {[360, 600, 840, 1080, 1320].map((m) => (
                                    <div key={m} style={{ position: "absolute", left: `${pctPos(m)}%`, top: 0, bottom: 0, width: 1, background: "#E2E8EA" }} />
                                  ))}
                                  <div className="gbar" style={{
                                    left: `${pctPos(sg.s)}%`, width: `${pctPos(Math.min(sg.e, T1)) - pctPos(sg.s)}%`,
                                    background: tColor(sg.type),
                                    outline: isSel ? `2px solid ${ink}` : (bad ? `2px solid ${gapRed}` : "none"),
                                  }} />
                                  {sg.b && (
                                    <div className="gbrk" style={{
                                      left: `${pctPos(sg.b[0])}%`, width: `${pctPos(sg.b[1]) - pctPos(sg.b[0])}%`,
                                    }} />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {tab === "board" && (
          <>
            {/* KPI strip */}
            <div className="kpistrip" style={{ top: ENVELOPE_H }}>
              <div className="kpi"><span className="l">{day} coverage</span><span className="v" style={{ color: P.dayScore >= 0.9 ? "#7FD1C0" : "#F5C16C" }}>{(P.dayScore * 100).toFixed(1)}%</span></div>
              <div className="kpi"><span className="l">vs signed</span><span className="v" style={{ color: dayDelta >= 0 ? "#7FD1C0" : "#F09E93" }}>{dayDelta >= 0 ? "+" : ""}{dayDelta.toFixed(2)}</span></div>
              <div className="kpi"><span className="l">week</span><span className="v">{(eng.weekScore * 100).toFixed(1)}%</span></div>
              <div className="kpi"><span className="l">misplaced</span><span className="v">{P.misallocVH.toFixed(0)} vh</span></div>
              <div className="kpi"><span className="l">peak / fleet</span><span className="v" style={{ color: P.peakSup > glob.maxFleet ? "#F09E93" : "#fff" }}>{P.peakSup}/{glob.maxFleet}</span></div>
              <div className="kpi"><span className="l">rule flags</span><span className="v" style={{ color: flagCount ? "#F09E93" : "#7FD1C0" }}>{flagCount}</span></div>
              <div className="kpi"><span className="l">10-hour</span><span className="v" style={{ color: tenCount > glob.max10 ? "#F09E93" : "#fff" }}>{tenCount}/{glob.max10}</span></div>
              <div className="kpi"><span className="l">8-hour</span><span className="v">{eightCount}</span></div>
              <div className="kpi"><span className="l">runs</span><span className="v">{distinctShifts}</span></div>
              <div className="kpi"><span className="l">changes</span><span className="v">{changedCount}</span></div>
              {holidayCountForDay > 0 && (
                <div className="kpi"><span className="l">exception dates run as {day}</span><span className="v" style={{ color: demandAmber }}>{holidayCountForDay}</span></div>
              )}
            </div>

            {fixResult && (
              <div style={{ background: fixResult.stuck ? "#FDF3E7" : "#F2F8F7", border: `1px solid ${fixResult.stuck ? demandAmber : supplyTeal}`, padding: "8px 12px", marginBottom: 10, fontSize: 12.5 }}>
                {fixResult.single
                  ? "No legal correction exists for this shift under its current type — the time windows can't accommodate it. Try changing its type, or adjust the windows in Rules if the rule itself is wrong."
                  : <><b>Autocorrect:</b> {fixResult.fixed} shift{fixResult.fixed === 1 ? "" : "s"} repaired with the smallest legal adjustment{fixResult.stuck > 0 ? `; ${fixResult.stuck} couldn't be fixed under their current type — retype them or review the rule windows` : ""}. Check the score delta in the header — fixes move times, so coverage shifts too.</>}
              </div>
            )}

            {/* selected shift editor */}
            {sel ? (
              <div className="seleditor" style={{ background: card, border: `1px solid ${selIssues.length ? gapRed : "#E2E8EA"}`, padding: "12px 14px", marginBottom: 12, position: "sticky", top: ENVELOPE_H + KPI_H, zIndex: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <button style={nudgeBtn} title="Previous run this day" onClick={() => navSel(-1)}>◀</button>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700 }}>
                    Shift {sel.shift} · Run {sel.run}
                  </div>
                  <select value={sel.type} onChange={(e) => setType(e.target.value)}>
                    {Object.keys(rules).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span style={{ fontSize: 12, color: "#5B6B75" }}>{sel.splitType}</span>
                  {selIsDayVariant && <span style={{ fontSize: 11.5, color: demandAmber, border: `1px solid ${demandAmber}`, borderRadius: 2, padding: "2px 6px" }}>Times vary by day</span>}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={nudgeBtn} onClick={duplicateSel}>Duplicate</button>
                    <button style={{ ...nudgeBtn, borderColor: gapRed, color: gapRed }} onClick={removeSel}>Remove</button>
                    {selIssues.length > 0 && <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixSel}>Fix violations</button>}
                    {isChanged && <button style={{ ...nudgeBtn, borderColor: demandAmber }} onClick={resetSel}>Reset</button>}
                    <button style={nudgeBtn} onClick={() => setSelId(null)}>Close</button>
                    <button style={nudgeBtn} title="Next run this day" onClick={() => navSel(1)}>▶</button>
                  </div>
                </div>
                {(() => {
                  const origSel = isChanged ? originalMap.get(sel.id) : null;
                  return (
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10, alignItems: "flex-end" }}>
                      <div>
                        <Nudge label="Start" value={fmt(sel.s)}
                          onDec={() => patchSel({ s: sel.s - 5 })} onInc={() => patchSel({ s: sel.s + 5 })} />
                        {origSel && origSel.s !== sel.s && <div style={{ fontSize: 10.5, color: "#8899A3", marginLeft: 80 }}>was {fmt(origSel.s)}</div>}
                      </div>
                      <div>
                        <Nudge label="End" value={fmt(sel.e)}
                          onDec={() => patchSel({ e: sel.e - 5 })} onInc={() => patchSel({ e: sel.e + 5 })} />
                        {origSel && origSel.e !== sel.e && <div style={{ fontSize: 10.5, color: "#8899A3", marginLeft: 80 }}>was {fmt(origSel.e)}</div>}
                      </div>
                      <Nudge label="Shift spread" value={`${((sel.e - sel.s) / 60).toFixed(2)}h`}
                        onDec={() => patchSel({ s: sel.s - 5, e: sel.e - 5, b: sel.b ? [sel.b[0] - 5, sel.b[1] - 5] : null })}
                        onInc={() => patchSel({ s: sel.s + 5, e: sel.e + 5, b: sel.b ? [sel.b[0] + 5, sel.b[1] + 5] : null })} />
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11.5, color: "#5B6B75" }}>Working hours</span>
                        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                          {((sel.e - sel.s - (sel.b ? sel.b[1] - sel.b[0] : 0)) / 60).toFixed(2)}h
                        </span>
                      </div>
                      {sel.b && (
                        <>
                          <div>
                            <Nudge label={`Break start`} value={fmt(sel.b[0])}
                              onDec={() => shiftBreak(-5)} onInc={() => shiftBreak(5)} />
                            {origSel && origSel.b && origSel.b[0] !== sel.b[0] && <div style={{ fontSize: 10.5, color: "#8899A3", marginLeft: 80 }}>was {fmt(origSel.b[0])}</div>}
                          </div>
                          <Nudge label={`Break length`} value={`${sel.b[1] - sel.b[0]}m`}
                            onDec={() => patchSel({ b: [sel.b[0], sel.b[1] - 5] })} onInc={() => patchSel({ b: [sel.b[0], sel.b[1] + 5] })} />
                        </>
                      )}
                      <button style={nudgeBtn} onClick={toggleBreak}>{sel.b ? "Remove break" : "Add break"}</button>
                    </div>
                  );
                })()}
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#5B6B75" }}>Works:</span>
                  {DAYS.map((d) => (
                    <span key={d} className={"daychip" + (sel.days.includes(d) ? " on" : "")} onClick={() => toggleDay(d)}>
                      {d.slice(0, 2).toUpperCase()}
                    </span>
                  ))}
                  <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", color: editAllDays ? "#41525C" : demandAmber }}>
                    <input type="checkbox" checked={editAllDays} onChange={(e) => setEditAllDays(e.target.checked)} />
                    Apply time changes to all working days
                  </label>
                </div>
                {!editAllDays && sel.days.length > 1 && (
                  <div style={{ fontSize: 11.5, color: demandAmber, marginTop: 4 }}>
                    Day-scoped editing: the next time or break change splits {day} out of this package's shared times — the other days keep their current schedule. Type and working-day changes still apply to the whole package.
                  </div>
                )}
                {selIssues.length > 0 && (
                  <div style={{ marginTop: 10, borderLeft: `3px solid ${gapRed}`, background: "#FDF6F5", padding: "6px 10px" }}>
                    {selIssues.map((iss, i) => <div key={i} style={{ fontSize: 12.5, color: gapRed }}>⚠ {iss}</div>)}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>This shift's week — tap a day to view it:</div>
                <WeekStrip segs={selShiftSegs} day={day} onPick={setDay} />
              </div>
            ) : selShift != null ? (
              <div className="seleditor" style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 12, position: "sticky", top: ENVELOPE_H + KPI_H, zIndex: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <button style={nudgeBtn} title="Last run this day" onClick={() => navSel(-1)}>◀</button>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700 }}>
                    Shift {selShift}
                  </div>
                  <span style={{ fontSize: 13, color: "#5B6B75" }}>doesn't work {day}</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button style={nudgeBtn} onClick={() => setSelId(null)}>Close</button>
                    <button style={nudgeBtn} title="First run this day" onClick={() => navSel(1)}>▶</button>
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>This shift's week — tap a day to view and edit it:</div>
                <WeekStrip segs={selShiftSegs} day={day} onPick={setDay} />
              </div>
            ) : (
              <div style={{ background: "#EEF4F5", border: "1px dashed #B9C6CC", padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#41525C" }}>
                Tap any bar to open it: nudge times, move breaks, change type, toggle working days, duplicate or remove. "+ Add shift" creates a new AX split shift on {day} to shape from scratch. Every change re-scores instantly; Undo and Reset are always available.
              </div>
            )}

            {/* gantt */}
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 10px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600 }}>
                  {day} board — {ganttSegs.length} working segment{ganttSegs.length === 1 ? "" : "s"}
                  {selShift != null && <span style={{ fontSize: 12, fontWeight: 400, color: "#5B6B75" }}> (showing shift {selShift} only — {daySegs.length} total this day)</span>}
                </div>
                <label style={{ fontSize: 12, color: "#41525C", display: "flex", alignItems: "center", gap: 6 }}>
                  Sort
                  <select value={ganttSort} onChange={(e) => setGanttSort(e.target.value)} style={{ fontSize: 12 }}>
                    <option value="run">Run number</option>
                    <option value="time">Start time</option>
                    <option value="type">Type, then time</option>
                  </select>
                </label>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#5B6B75" }}>{fmt(T0)} — {fmt(T1)}</div>
              </div>
              <div style={{ display: "flex", gap: 6, margin: "6px 0 2px" }}>
                <div className="glabel" />
                <div style={{ position: "relative", flex: 1, height: 14 }}>
                  {[6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((h) => (
                    <div key={h} style={{ position: "absolute", left: `${pctPos(h * 60)}%`, fontSize: 9.5, color: "#8899A3", transform: "translateX(-50%)" }}>{h}</div>
                  ))}
                </div>
              </div>
              <div style={{ maxHeight: 430, overflowY: "auto" }}>
                {ganttSegs.map((sg) => {
                  const issues = validateSeg(sg, rules, glob);
                  const bad = issues.length > 0;
                  const isSel = selShift != null && sg.shift === selShift;
                  const brkMin = sg.b ? sg.b[1] - sg.b[0] : 0;
                  const workHrs = ((sg.e - sg.s - brkMin) / 60).toFixed(2);
                  const barTitle = `${fmt(sg.s)}–${fmt(sg.e)} · ${workHrs}h working${sg.b ? ` · ${brkMin}m break (${fmt(sg.b[0])}–${fmt(sg.b[1])})` : ""}`;
                  const orig = isSel ? originalMap.get(sg.id) : null;
                  const ghost = orig && (orig.s !== sg.s || orig.e !== sg.e || JSON.stringify(orig.b) !== JSON.stringify(sg.b)) ? orig : null;
                  const isDrag = dragging != null && dragging.id === sg.id;
                  const barL = pctPos(sg.s), barR = pctPos(Math.min(sg.e, T1));
                  return (
                    <div key={sg.id} className="ganttrow"
                      onPointerDown={(ev) => onGanttPointerDown(ev, sg)}
                      onPointerMove={onGanttPointerMove}
                      onPointerUp={(ev) => onGanttPointerUp(ev, sg)}
                      onPointerCancel={(ev) => onGanttPointerUp(ev, sg)}>
                      <div className="glabel" style={{ fontWeight: isSel ? 700 : 400, color: bad ? gapRed : undefined }}>
                        {sg.shift} {sg.type}
                      </div>
                      <div className="gtrack" title={isDrag ? undefined : barTitle}>
                        {[360, 600, 840, 1080, 1320].map((m) => (
                          <div key={m} style={{ position: "absolute", left: `${pctPos(m)}%`, top: 0, bottom: 0, width: 1, background: "#E2E8EA" }} />
                        ))}
                        {ghost && (
                          <div title={`was ${fmt(ghost.s)}–${fmt(ghost.e)}`} style={{
                            position: "absolute", left: `${pctPos(ghost.s)}%`, width: `${pctPos(Math.min(ghost.e, T1)) - pctPos(ghost.s)}%`,
                            top: 0, height: 14, borderRadius: 2, background: "transparent",
                            border: `1.5px dashed ${tColor(ghost.type)}`, boxSizing: "border-box",
                            opacity: 0.7, pointerEvents: "none",
                          }} />
                        )}
                        {ghost && ghost.b && (
                          <div style={{
                            position: "absolute", left: `${pctPos(ghost.b[0])}%`, width: `${pctPos(ghost.b[1]) - pctPos(ghost.b[0])}%`,
                            top: 0, height: 14, border: "1.5px dashed #AEBAC0", borderStyle: "dashed", background: "transparent",
                            boxSizing: "border-box", opacity: 0.7, pointerEvents: "none",
                          }} />
                        )}
                        <div className={"gbar" + (isDrag ? " lifted" : "")} data-dragmode="move" style={{
                          left: `${barL}%`, width: `${barR - barL}%`,
                          background: tColor(sg.type),
                          outline: isSel ? `2px solid ${ink}` : (bad ? `2px solid ${gapRed}` : "none"),
                        }} />
                        <div className="ghandle" data-dragmode="seg-start" style={{ left: `calc(${barL}% - 3px)` }} />
                        <div className="ghandle" data-dragmode="seg-end" style={{ left: `calc(${barR}% - 4px)` }} />
                        {sg.b && (
                          <>
                            <div className={"gbrk" + (isDrag ? " lifted" : "")} data-dragmode="break-move" style={{
                              left: `${pctPos(sg.b[0])}%`, width: `${pctPos(sg.b[1]) - pctPos(sg.b[0])}%`,
                            }} />
                            <div className="ghandle" data-dragmode="break-start" style={{ left: `calc(${pctPos(sg.b[0])}% - 3px)` }} />
                            <div className="ghandle" data-dragmode="break-end" style={{ left: `calc(${pctPos(sg.b[1])}% - 4px)` }} />
                          </>
                        )}
                        {isDrag && (() => {
                          const dScore = (P.dayScore - dragging.startDayScore) * 100;
                          const flipLeft = barR > 65;
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
                              <div style={{ color: dScore >= 0 ? "#7FD1C0" : "#F09E93" }}>
                                Δ {day} cov {dScore >= 0 ? "+" : ""}{dScore.toFixed(2)}
                              </div>
                              {issues.length > 0
                                ? <div style={{ color: "#F09E93" }}>⚠ {issues[0]}{issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}</div>
                                : <div style={{ color: "#7FD1C0" }}>✓ legal</div>}
                              {dragging.days.length > 1 && (
                                <div style={{ opacity: 0.75 }}>applies {dragging.days.map((d) => d.slice(0, 2).toUpperCase()).join(" ")}</div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                {[...new Set(ganttSegs.map((s) => s.type))].sort((a, b) => {
                  const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
                  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
                }).map(t => (
                  <span key={t} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 12, height: 10, background: tColor(t), display: "inline-block", borderRadius: 2 }} />{t}
                  </span>
                ))}
                <span style={{ fontSize: 11, color: "#5B6B75" }}>hatched notch = break · red outline = rule flag · dashed outline = original position before edits · hover a bar for hours</span>
              </div>
            </div>

            {/* live coverage */}
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 4px 4px" }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, padding: "0 10px 6px" }}>
                Live {day} coverage
              </div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={glob.maxFleet} showBookout={showBookout} showProductivity={showProductivity} height={280}
                selBand={sel ? [sel.s, sel.e] : null} />
              <div style={{ fontSize: 11.5, color: "#5B6B75", padding: "2px 10px 10px" }}>
                Dashed lines mark the selected shift. On desktop, the KPI strip and shift editor stay pinned while you scroll; on phones everything scrolls freely so the board and this chart get the full screen.
              </div>
            </div>
          </>
        )}
        {tab === "compare" && (() => {
          // Original vs revised, one row per run for the viewed day. Runs are matched by
          // SHIFT NUMBER (the stable business key — survives retime and manual edits alike);
          // the loaded signup draws as a dashed ghost behind the current solid bar.
          const shifts = [...new Set([
            ...baselineBoard.filter((s) => s.days.includes(day)).map((s) => s.shift),
            ...board.filter((s) => s.days.includes(day)).map((s) => s.shift),
          ])].sort((a, b) => a - b);
          const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
          const rows = shifts.map((sh) => {
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
              if (cur.type !== orig.type) parts.push(`${orig.type}→${cur.type}`);
              if (parts.length) status = "changed";
            }
            return { sh, orig, cur, status, delta: parts.join(" · ") };
          });
          const visible = compareChangedOnly ? rows.filter((r) => r.status !== "same") : rows;
          const changedWeek = boardDiff.modified.length;
          return (
            <>
              <div className="kpistrip" style={{ top: ENVELOPE_H }}>
                <div className="kpi"><span className="l">loaded signup · week</span><span className="v">{(base.weekScore * 100).toFixed(1)}%</span></div>
                <div className="kpi"><span className="l">current board · week</span><span className="v" style={{ color: eng.weekScore >= base.weekScore ? "#7FD1C0" : "#F09E93" }}>{(eng.weekScore * 100).toFixed(1)}%</span></div>
                <div className="kpi"><span className="l">{day} cov · was → now</span><span className="v">{(base.perDay[day].dayScore * 100).toFixed(1)}% → {(P.dayScore * 100).toFixed(1)}%</span></div>
                <div className="kpi"><span className="l">modified / added / removed</span><span className="v">{changedWeek} / {boardDiff.added.length} / {boardDiff.removed.length}</span></div>
              </div>

              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 10px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600 }}>
                    {day} — loaded signup (dashed) vs current board (solid)
                  </div>
                  <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={compareChangedOnly} onChange={(e) => setCompareChangedOnly(e.target.checked)} />
                    Changed runs only
                  </label>
                  <div style={{ marginLeft: "auto", fontSize: 11, color: "#5B6B75" }}>{fmt(T0)} — {fmt(T1)} · tap a row to open it in Shift Builder</div>
                </div>
                <div style={{ display: "flex", gap: 6, margin: "6px 0 2px" }}>
                  <div className="glabel" />
                  <div style={{ position: "relative", flex: 1, height: 14 }}>
                    {[6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((h) => (
                      <div key={h} style={{ position: "absolute", left: `${pctPos(h * 60)}%`, fontSize: 9.5, color: "#8899A3", transform: "translateX(-50%)" }}>{h}</div>
                    ))}
                  </div>
                  <div style={{ width: 128, flex: "none" }} />
                </div>
                {visible.length === 0 && (
                  <div style={{ fontSize: 13, color: "#5B6B75", padding: "14px 6px" }}>
                    {compareChangedOnly ? `No runs changed on ${day} vs the loaded signup.` : `No runs work ${day}.`}
                  </div>
                )}
                <div style={{ maxHeight: 560, overflowY: "auto" }}>
                  {visible.map(({ sh, orig, cur, status, delta }) => {
                    const show = cur || orig;
                    return (
                      <div key={sh} className="ganttrow" style={{ cursor: cur ? "pointer" : "default", opacity: status === "same" && !compareChangedOnly ? 0.55 : 1 }}
                        onClick={() => { if (cur) { setSelId(cur.id); setTab("board"); } }}>
                        <div className="glabel" style={{ color: status === "removed" ? gapRed : undefined, fontWeight: status !== "same" ? 700 : 400 }}>
                          {sh} {show.type}
                        </div>
                        <div className="gtrack">
                          {[360, 600, 840, 1080, 1320].map((m) => (
                            <div key={m} style={{ position: "absolute", left: `${pctPos(m)}%`, top: 0, bottom: 0, width: 1, background: "#E2E8EA" }} />
                          ))}
                          {orig && (
                            <div title={`was ${fmt(orig.s)}–${fmt(orig.e)}${orig.b ? ` (break ${fmt(orig.b[0])}–${fmt(orig.b[1])})` : ""}`} style={{
                              position: "absolute", left: `${pctPos(orig.s)}%`, width: `${pctPos(Math.min(orig.e, T1)) - pctPos(orig.s)}%`,
                              top: 0, height: 14, borderRadius: 2, background: status === "removed" ? "#F6E4E1" : "transparent",
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
                            <div title={`now ${fmt(cur.s)}–${fmt(cur.e)}${cur.b ? ` (break ${fmt(cur.b[0])}–${fmt(cur.b[1])})` : ""}`} style={{
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
                        <div style={{ width: 128, flex: "none", fontSize: 10.5, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          color: status === "removed" ? gapRed : status === "added" ? supplyTeal : status === "changed" ? demandAmber : "#8899A3" }}
                          title={delta || status}>
                          {status === "removed" ? "removed" : status === "added" ? "new" : status === "changed" ? delta : "unchanged"}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: "#5B6B75", marginTop: 8 }}>
                  Dashed outline = the run as it was in the loaded signup · solid bar = the run on the current board · hatched = break. Runs are matched by shift number; a generated-from-scratch board therefore shows the whole loaded signup as removed and the new runs as added — that comparison is honest, just busy.
                </div>
              </div>
            </>
          );
        })()}
        {tab === "pack" && (() => {
          const byShift = new Map();
          for (const sg of board) {
            if (!byShift.has(sg.shift)) byShift.set(sg.shift, []);
            byShift.get(sg.shift).push(sg);
          }
          const shifts = [...byShift.keys()].sort((a, b) => a - b);
          const infos = shifts.map((sh) => ({ sh, segs: byShift.get(sh), info: packageInfo(byShift.get(sh), rules, glob) }));
          const flagged = infos.filter((x) => x.info.issues.length > 0);
          const singleDay = infos.filter((x) => x.info.daysWorked.size === 1).length;
          return (
            <>
              <div className="kpistrip" style={{ top: ENVELOPE_H }}>
                <div className="kpi"><span className="l">packages</span><span className="v">{shifts.length}</span></div>
                <div className="kpi"><span className="l">single-day runs</span><span className="v" style={{ color: singleDay ? "#F5C16C" : "#fff" }}>{singleDay}</span></div>
                <div className="kpi"><span className="l">package flags</span><span className="v" style={{ color: flagged.length ? "#F09E93" : "#7FD1C0" }}>{flagged.length}</span></div>
                <div className="kpi"><span className="l">weekly coverage</span><span className="v">{(eng.weekScore * 100).toFixed(1)}%</span></div>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {singleDay > 0 && (
                    <button style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: "transparent" }}
                      onClick={() => {
                        const r = autoPackage(board, rules, glob);
                        mutate(() => r.board);
                        setSelId(null);
                        setRefineResult(null);
                      }}>
                      Auto-package {singleDay} single-day runs
                    </button>
                  )}
                  <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: "transparent", opacity: refineBusy ? 0.5 : 1 }}
                    disabled={refineBusy}
                    onClick={() => {
                      setRefineBusy(true);
                      setTimeout(() => {
                        const before = eng.weekScore;
                        const r = refinePerDay(board, rules, glob, DEM, includePT, glob.minVeh, spans);
                        const after = computeEngine(DEM, buildSupply(r.board), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias).weekScore;
                        mutate(() => r.board);
                        setRefineResult({ moves: r.moves, created: r.created, evaluated: r.evaluated, gained: (after - before) * 100 });
                        setSelId(null);
                        setRefineBusy(false);
                      }, 30);
                    }}>
                    {refineBusy ? "Refining…" : "Refine day-to-day times"}
                  </button>
                </div>
              </div>

              {refineResult && (
                <div style={{ background: "#F2F8F7", border: `1px solid ${supplyTeal}`, padding: "8px 12px", margin: "0 0 10px", fontSize: 12.5 }}>
                  <b>Refined:</b> +{refineResult.gained.toFixed(2)} weekly points from {refineResult.moves} per-day adjustment{refineResult.moves === 1 ? "" : "s"} ({refineResult.created} day-variant row{refineResult.created === 1 ? "" : "s"} created, {(refineResult.evaluated || 0).toLocaleString()} candidates evaluated). Every variant stays inside the report-time variation rule.
                </div>
              )}
              <div style={{ fontSize: 12.5, color: "#5B6B75", margin: "0 0 10px" }}>
                Each row is one signable weekly package. <b>Refine day-to-day times</b> nudges individual days of a package (within the report-time variation rule) wherever a single day's demand justifies a slightly different start — the source of day-variant rows like a 07:20 Sunday inside a 07:30 week. Auto-packaging appears when the board contains loose single-day runs. Rest, consecutive-day, and variation rules come from the Rules tab. Tap a row to inspect; edit times or working days in the Shift Builder.
              </div>

              {flagged.length > 0 && (
                <div style={{ background: "#FBEDEB", border: `1px solid ${gapRed}`, padding: "8px 12px", marginBottom: 10, fontSize: 12.5, maxHeight: 130, overflowY: "auto" }}>
                  {flagged.slice(0, 20).map((x, i) => (
                    <div key={i}><b>Shift {x.sh}:</b> {x.info.issues.join("; ")}</div>
                  ))}
                  {flagged.length > 20 && <div>… and {flagged.length - 20} more</div>}
                </div>
              )}

              <div style={{ background: card, border: "1px solid #E2E8EA", overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
                  <thead>
                    <tr style={{ position: "sticky", top: 0, background: ink, color: "#fff" }}>
                      <th style={{ padding: "6px 10px", fontSize: 11, textAlign: "left" }}>Shift</th>
                      <th style={{ padding: "6px 8px", fontSize: 11, textAlign: "left" }}>Type</th>
                      <th style={{ padding: "6px 8px", fontSize: 11, textAlign: "left" }}>Days off</th>
                      {DAYS.map((d) => <th key={d} style={{ padding: "6px 6px", fontSize: 11 }}>{d.slice(0, 3).toUpperCase()}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {infos.map(({ sh, segs, info }) => (
                      <tr key={sh} style={{ borderBottom: "1px solid #EDF1F3", background: info.issues.length ? "#FDF6F5" : "transparent", cursor: "pointer" }}
                        onClick={() => { setSelId(segs[0].id); setTab("board"); setDay(segs[0].days[0]); }}>
                        <td style={{ padding: "4px 10px", fontWeight: 600, fontSize: 12.5, color: info.issues.length ? gapRed : ink }}>{sh}</td>
                        <td style={{ padding: "4px 8px" }}>
                          <span style={{ fontSize: 10.5, padding: "1px 6px", background: tColor(segs[0].type), color: "#fff", borderRadius: 2 }}>{segs[0].type}</span>
                        </td>
                        <td style={{ padding: "4px 8px", fontSize: 11.5, color: "#5B6B75" }}>{segs[0].daysOff || DAYS.filter((d) => !info.daysWorked.has(d)).map((d) => d.slice(0, 2).toUpperCase()).join("-") || "—"}</td>
                        {DAYS.map((d) => {
                          const sg = info.byDay[d];
                          return (
                            <td key={d} style={{ padding: "3px 4px", textAlign: "center", fontSize: 10.5, fontVariantNumeric: "tabular-nums", background: sg ? "rgba(15,123,122,0.08)" : "transparent", color: sg ? ink : "#B9C6CC" }}>
                              {sg ? `${fmt(sg.s)}–${fmt(sg.e)}` : "OFF"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}

        {tab === "suggest" && (
          <>
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Top ranked moves — whole-week impact
                </div>
                <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }}
                  onClick={() => { setSugs(findSuggestions(board, eng, DEM, rules, glob)); setSugsStale(false); }}>
                  {sugs ? "Recompute" : "Find suggestions"}
                </button>
                <button style={{ ...nudgeBtn, borderColor: supplyTeal, color: supplyTeal, opacity: optBusy ? 0.5 : 1 }} disabled={optBusy}
                  onClick={() => {
                    setOptBusy(true);
                    setTimeout(() => {
                      const before = eng.weekScore;
                      const r = deepOptimize(board, [DEM, includePT, glob.minVeh, spans, glob.maxFleet], rules, glob);
                      const after = computeEngine(DEM, buildSupply(r.board), includePT, glob.minVeh, spans, glob.maxFleet, glob.offPeakBias).weekScore;
                      mutate(() => r.board);
                      setOptResult({ applied: r.moves, evaluated: r.evaluated, created: r.created, passes: r.passes, gained: (after - before) * 100 });
                      setSugs(null); setSugsStale(false); setOptBusy(false);
                    }, 30);
                  }}>
                  {optBusy ? "Optimizing…" : "Deep optimize (slides, breaks, per-day)"}
                </button>
                {optResult && !optBusy && (
                  <span style={{ fontSize: 12.5, color: supplyTeal, fontWeight: 600 }}>
                    Converged after evaluating {(optResult.evaluated || 0).toLocaleString()} candidate adjustments: +{optResult.gained.toFixed(2)} pts from {optResult.applied} moves{optResult.created ? ` (${optResult.created} day-variants created)` : ""}. No remaining single adjustment of any explored type improves the score.
                  </span>
                )}
                {sugsStale && sugs && <span style={{ fontSize: 12.5, color: demandAmber, fontWeight: 600 }}>Board changed — results are stale, recompute.</span>}
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 4 }}>
                Searches every legal slide and break move on the current board. Only moves that keep the shift rule-clean, respect the fleet cap, and improve the weekly coverage score are shown — hours are never added, only repositioned.
              </div>
              {sugs && sugs.length === 0 && (
                <div style={{ fontSize: 13, color: "#5B6B75", marginTop: 10 }}>
                  No single slide or break move improves the weekly score. Remaining misalignment needs structural changes — retyping shifts, moving days, or adding/removing runs.
                </div>
              )}
              {sugs && sugs.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, borderLeft: `3px solid ${supplyTeal}`, background: "#F2F8F7", padding: "8px 10px", marginTop: 8, flexWrap: "wrap" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, color: supplyTeal, width: 64 }}>
                    +{(s.delta * 100).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <b>Shift {s.shift}</b> · Run {s.run} ({s.type}) — {s.label}
                  </div>
                  <button style={{ ...nudgeBtn, marginLeft: "auto" }}
                    onClick={() => {
                      mutate((b) => b.map((x) => x.id === s.id ? { ...cloneSeg(x), s: s.payload.s, e: s.payload.e, b: s.payload.b ? [...s.payload.b] : null } : x));
                    }}>
                    Apply
                  </button>
                </div>
              ))}
            </div>

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
                Where the waste sits — {day}
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginBottom: 10 }}>
                Windows where supply share runs above demand share (hours earning no score), and the shifts spending the most time inside them. Change the day on the paddles above.
              </div>
              {(() => {
                const p = eng.perDay[day];
                const dayEv = p.dayEv, daySup = p.daySupSlots;
                const wins = [];
                let cur = null;
                for (let i = 0; i < N; i++) {
                  const dSh = dayEv > 0 ? p.ev[i] / dayEv : 0;
                  const sSh = daySup > 0 ? p.sup[i] / daySup : 0;
                  const over = sSh - dSh;
                  if (over > 1e-9) {
                    if (!cur) cur = { from: i, to: i, weight: over };
                    else { cur.to = i; cur.weight += over; }
                  } else if (cur) { wins.push(cur); cur = null; }
                }
                if (cur) wins.push(cur);
                wins.sort((a, b) => b.weight - a.weight);
                const top = wins.slice(0, 3);
                const overSlot = new Array(N).fill(false);
                for (const w of top) for (let i = w.from; i <= w.to; i++) overSlot[i] = true;
                const idle = board
                  .filter((sg) => sg.days.includes(day))
                  .map((sg) => {
                    const c = segContrib(sg);
                    let m = 0;
                    for (let i = 0; i < N; i++) if (c[i] && overSlot[i]) m += 5;
                    return { sg, m };
                  })
                  .filter((x) => x.m > 0)
                  .sort((a, b) => b.m - a.m)
                  .slice(0, 3);
                return (
                  <>
                    {top.map((w, i) => (
                      <div key={i} style={{ borderLeft: `3px solid ${demandAmber}`, background: "#FDF8EF", padding: "6px 10px", marginBottom: 8 }}>
                        <b style={{ fontSize: 13.5 }}>{fmt(SLOT(w.from))}–{fmt(SLOT(w.to) + 5)}</b>
                        <span style={{ fontSize: 12.5, color: "#5B6B75" }}> · {(w.weight * 100).toFixed(2)} points of {day}'s score parked here</span>
                      </div>
                    ))}
                    {idle.length > 0 && (
                      <div style={{ fontSize: 13, marginTop: 6 }}>
                        Heaviest sitters: {idle.map((x, i) => (
                          <span key={i}>
                            <b>Shift {x.sg.shift}</b> ({x.sg.type}, {(x.m / 60).toFixed(1)}h in surplus){i < idle.length - 1 ? ", " : ""}
                          </span>
                        ))}
                        — candidates for a slide or retype in the Shift Builder.
                      </div>
                    )}
                  </>
                );
              })()}
              <div style={{ fontSize: 11.5, color: "#8899A3", marginTop: 12 }}>
                Coming later in this module: the ceiling computation — the best score any rule-legal board of this size could reach, so you know when a design is done.
              </div>
            </div>
          </>
        )}

        {tab === "rules" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: "#5B6B75" }}>
                Every number here drives validation and scoring live. Edits flag existing shifts immediately — nothing is blocked, only flagged. Click a type code to rename it — every shift using it follows along.
              </div>
              <button style={{ ...nudgeBtn, marginLeft: "auto", borderColor: demandAmber }}
                onClick={() => {
                  setRules(JSON.parse(JSON.stringify(DEFAULT_RULES)));
                  setGlob({ ...JSON.parse(JSON.stringify(DEFAULT_GLOBAL)), avgCycleTime: DEFAULT_AVG_CYCLE_TIME, demandShare: DEFAULT_DEMAND_SHARE });
                  setSpans(JSON.parse(JSON.stringify(DEFAULT_SPANS)));
                  setTypeColors({ ...TYPE_COLOR });
                }}>
                Reset to defaults
              </button>
            </div>

            {/* shift types */}
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14, overflowX: "auto" }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                Shift classification
              </div>
              <table style={{ borderCollapse: "collapse", minWidth: 720 }}>
                <thead>
                  <tr>
                    {["Type", "Earliest start", "Latest start", "Earliest end", "Latest end", "Min spread (h)", "Max spread (h)", "Work (h)", "Break allowed", "In use", ""].map((h) => (
                      <th key={h} style={{ padding: "4px 8px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "#5B6B75", textAlign: "left", borderBottom: "1px solid #E7EDEF" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(rules).map((t) => {
                    const R = rules[t];
                    const inUse = board.filter((s) => s.type === t).length;
                    const upd = (patch) => setRules((old) => ({ ...old, [t]: { ...old[t], ...patch } }));
                    return (
                      <tr key={t}>
                        <td style={{ padding: "4px 8px" }}>
                          {editingType === t ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <input autoFocus value={typeDraft}
                                onChange={(e) => setTypeDraft(e.target.value.toUpperCase().slice(0, 6))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { if (renameType(t, typeDraft) || typeDraft.trim().toUpperCase() === t) setEditingType(null); }
                                  if (e.key === "Escape") setEditingType(null);
                                }}
                                onBlur={() => { renameType(t, typeDraft); setEditingType(null); }}
                                style={{ width: 64, padding: "2px 6px", fontSize: 12, fontWeight: 600, border: `2px solid ${tColor(t)}`, borderRadius: 2, background: "#fff", color: ink, textTransform: "uppercase" }} />
                              {typeDraft.trim().toUpperCase() !== t && rules[typeDraft.trim().toUpperCase()] && (
                                <span style={{ fontSize: 11, color: gapRed }}>exists</span>
                              )}
                            </span>
                          ) : (
                            <span title="Click to rename — every shift using this code follows along"
                              onClick={() => { setEditingType(t); setTypeDraft(t); }}
                              style={{ fontSize: 12, padding: "2px 8px", background: tColor(t), color: "#fff", borderRadius: 2, fontWeight: 600, cursor: "pointer" }}>
                              {t}
                            </span>
                          )}
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
                        <td style={{ padding: "3px 8px", fontSize: 12, color: inUse ? "#182430" : "#8899A3" }}>{inUse}</td>
                        <td style={{ padding: "3px 6px" }}>
                          {Object.keys(rules).length > 1 && (
                            <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12, color: gapRed, borderColor: gapRed }}
                              title={inUse > 0 ? `${inUse} shift${inUse === 1 ? "" : "s"} use this type — they'll be flagged until retyped` : "Remove this type"}
                              onClick={() => {
                                // flag-never-block: removing an in-use type is allowed, but the
                                // shifts keep their code and get a "not defined in Rules" flag —
                                // visible, fixable by retyping, and undone by re-adding the type
                                if (inUse > 0 && !window.confirm(
                                  `${inUse} shift${inUse === 1 ? "" : "s"} on the board still use ${t}. ` +
                                  `They won't be deleted — they'll be flagged until you retype them or re-add ${t}. Remove the type?`)) return;
                                setRules((old) => { const n = { ...old }; delete n[t]; return n; });
                              }}>
                              remove
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ fontWeight: 700, borderTop: "1px solid #E7EDEF" }}>
                    <td style={{ padding: "4px 8px" }}>Total</td>
                    <td /><td /><td /><td /><td /><td /><td /><td />
                    <td style={{ padding: "3px 8px", fontSize: 12 }}>{board.length}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <input placeholder="New type code (e.g. BS9)" value={newType}
                  onChange={(e) => setNewType(e.target.value.toUpperCase().slice(0, 6))}
                  style={{ padding: "6px 8px", border: "1px solid #B9C6CC", borderRadius: 2, fontSize: 13, width: 170, background: "#fff", color: ink }} />
                <button style={nudgeBtn} disabled={!newType || !!rules[newType]}
                  onClick={() => {
                    if (!newType || rules[newType]) return;
                    setRules((old) => ({ ...old, [newType]: { s: [300, 660], e: [840, 1470], spr: [480, 720], work: 480, brk: true } }));
                    setTypeColors((tc) => (tc[newType] ? tc : { ...tc, [newType]: TYPE_COLOR_EXTRA[Object.keys(tc).length % TYPE_COLOR_EXTRA.length] }));
                    setNewType("");
                  }}>
                  + Add type
                </button>
                {newType && rules[newType] && <span style={{ fontSize: 12, color: gapRed }}>Type already exists</span>}
              </div>
            </div>

            {/* breaks + limits + spans */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Break rules
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
                  <span>Minimum break length (min)</span>
                  <NumField value={glob.brkLen[0]} onCommit={(v) => setGlob((g) => ({ ...g, brkLen: [v, g.brkLen[1]] }))} />
                  <span>Maximum break length (min)</span>
                  <NumField value={glob.brkLen[1]} onCommit={(v) => setGlob((g) => ({ ...g, brkLen: [g.brkLen[0], v] }))} />
                  <span>Earliest break: after (min worked)</span>
                  <NumField value={glob.brkAfter[0]} onCommit={(v) => setGlob((g) => ({ ...g, brkAfter: [v, g.brkAfter[1]] }))} />
                  <span>Latest break: after (min worked)</span>
                  <NumField value={glob.brkAfter[1]} onCommit={(v) => setGlob((g) => ({ ...g, brkAfter: [g.brkAfter[0], v] }))} />
                </div>
              </div>

              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Board limits
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
                  <span>Max 10-hour shifts on board</span>
                  <NumField value={glob.max10} onCommit={(v) => setGlob((g) => ({ ...g, max10: v }))} />
                  <span>Minimum vehicles in service (span)</span>
                  <NumField value={glob.minVeh} onCommit={(v) => setGlob((g) => ({ ...g, minVeh: v }))} />
                  <span>Max vehicles in service (fleet cap)</span>
                  <NumField value={glob.maxFleet} onCommit={(v) => setGlob((g) => ({ ...g, maxFleet: v }))} />
                  <span>Max sign-ins per 5 min (stagger)</span>
                  <NumField value={glob.maxPullout} onCommit={(v) => setGlob((g) => ({ ...g, maxPullout: v }))} />
                  <span>Auto-generated shift series (starting number)</span>
                  <NumField value={glob.shiftSeriesBase} onCommit={(v) => setGlob((g) => ({ ...g, shiftSeriesBase: Math.round(v) }))} />
                  <span>Off-peak weighting (%)</span>
                  <NumField value={glob.offPeakBias ?? 0} step={5} onCommit={(v) => setGlob((g) => ({ ...g, offPeakBias: Math.min(60, Math.max(0, Math.round(v))) }))} />
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  Currently {tenCount} ten-hour shifts on the board{tenCount > glob.max10 ? " — over the cap" : ""}. Auto-Build and Auto-package number their generated shifts starting from the series above, continuing past it if the board already has higher numbers. Off-peak weighting: 0 means resources follow demand exactly (proportional); higher values flatten the target so lightly-loaded early and late periods claim proportionally more vehicles per trip and the peaks fewer — reflecting that off-peak trips share rides less. It applies to scoring, the target line, generation, retime, suggestions, and the optimizer, so scores are only comparable between boards evaluated at the same weighting.
                </div>
              </div>

              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Packaging rules
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
                  <span>Min rest between shifts (h)</span>
                  <NumField value={glob.minRest / 60} step={0.5} onCommit={(v) => setGlob((g) => ({ ...g, minRest: Math.round(v * 60) }))} />
                  <span>Max consecutive working days</span>
                  <NumField value={glob.maxConsec} onCommit={(v) => setGlob((g) => ({ ...g, maxConsec: v }))} />
                  <span>Max report-time variation — weekdays (h)</span>
                  <NumField value={glob.maxStartVarWeekday / 60} step={0.25} onCommit={(v) => setGlob((g) => ({ ...g, maxStartVarWeekday: Math.round(v * 60) }))} />
                  <span>Max report-time variation — weekend days (h)</span>
                  <NumField value={glob.maxStartVarWeekend / 60} step={0.25} onCommit={(v) => setGlob((g) => ({ ...g, maxStartVarWeekend: Math.round(v * 60) }))} />
                  <span>Max report-time variation — weekday vs weekend (h)</span>
                  <NumField value={glob.maxStartVarCross / 60} step={0.25} onCommit={(v) => setGlob((g) => ({ ...g, maxStartVarCross: Math.round(v * 60) }))} />
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  Weekdays and weekend days are checked separately, plus a third cap on how far weekend report times may drift from the weekday report time. Checked on every weekly package in the Packaging tab; the auto-builder satisfies rest, consecutive-day, and variance rules by construction.
                </div>
              </div>

              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Service span
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", gap: "8px 10px", alignItems: "center", fontSize: 13 }}>
                  {DAYS.map((d) => (
                    <React.Fragment key={d}>
                      <span style={{ width: 84 }}>{d}</span>
                      <TimeField value={spans[d][0]} onCommit={(v) => setSpans((s) => ({ ...s, [d]: [v, s[d][1]] }))} />
                      <TimeField value={spans[d][1]} onCommit={(v) => setSpans((s) => ({ ...s, [d]: [s[d][0], v] }))} />
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  The minimum-vehicles rule applies inside the span, and Auto-Build, Retime, and the optimizer never place a shift outside it — no starts before the span opens or ends after it closes on any working day. The demand model itself is unaffected; manual edits can still cross the span (flag-never-block).
                </div>
              </div>

              <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                  Deadhead & productivity
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
                  <span>Pull-out time before first trip (min)</span>
                  <NumField value={glob.deadheadOutMin} step={5} onCommit={(v) => setGlob((g) => ({ ...g, deadheadOutMin: Math.round(v) }))} />
                  <span>Pull-in time after last trip (min)</span>
                  <NumField value={glob.deadheadInMin} step={5} onCommit={(v) => setGlob((g) => ({ ...g, deadheadInMin: Math.round(v) }))} />
                  <span>Average trip cycle time (min)</span>
                  <NumField value={glob.avgCycleTime} step={0.5} onCommit={(v) => setGlob((g) => ({ ...g, avgCycleTime: v }))} />
                  <span>Share of demand served by this signup (%)</span>
                  <NumField value={glob.demandShare} step={5} onCommit={(v) => setGlob((g) => ({ ...g, demandShare: Math.min(100, Math.max(1, Math.round(v))) }))} />
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  Pull-out/pull-in affects only Auto-Build's placement — a generated shift may start before the first trip it serves and end after the last, within this lead time. Cycle time (pickup to dropoff to next pickup, including deadhead) is an operational reference: the calibration below compares it against what your uploaded demand + signup imply. It no longer drives the Coverage chart's "Suggested vehicles" line, which now simply redistributes each day's scheduled vehicle-hours along that day's trip-share curve. If contractors or other providers serve part of the demand you upload, set the share this signup's fleet covers — the calibration and the absolute trip captions scale by it, while coverage scoring (shape-based, scale-free) is unaffected.
                </div>
                {empiricalProductivity && empiricalProductivity.overall > 0 && (
                  empiricalProductivity.overall <= 7.5 ? (
                    <div style={{ background: "#F2F8F7", border: `1px solid ${supplyTeal}`, padding: "8px 12px", fontSize: 12, marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span>
                        Your uploaded demand{glob.demandShare < 100 ? ` (at this signup's ${glob.demandShare}% share)` : ""} + signup imply <b>{empiricalProductivity.overall.toFixed(2)} trips/vehicle-hour</b> ({(60 / empiricalProductivity.overall).toFixed(1)} min cycle time) on average — calibrated from your own real vehicle-hours, not an assumed constant.
                      </span>
                      <button style={nudgeBtn}
                        onClick={() => setGlob((g) => ({ ...g, avgCycleTime: Math.round((60 / empiricalProductivity.overall) * 10) / 10 }))}>
                        Use this
                      </button>
                    </div>
                  ) : (
                    <div style={{ background: "#FDF3E7", border: `1px solid ${demandAmber}`, padding: "8px 12px", fontSize: 12, marginTop: 10 }}>
                      Your uploaded demand{glob.demandShare < 100 ? ` (at this signup's ${glob.demandShare}% share)` : ""} + signup imply {empiricalProductivity.overall.toFixed(1)} trips/vehicle-hour — an
                      unrealistically short {(60 / empiricalProductivity.overall).toFixed(1)}-minute cycle time. That usually means
                      the demand file has a data-quality issue (check the warning banner on the Demand tab) or the demand share
                      above is set too high for what this fleet really serves — fix that before using it to set cycle time.
                    </div>
                  )
                )}
              </div>
            </div>

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginTop: 14 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
                Signup period &amp; exception days
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "#5B6B75", marginBottom: 4 }}>Period start</div>
                  <input type="date" value={signupPeriod.start}
                    onChange={(e) => setSignupPeriod((p) => ({ ...p, start: e.target.value }))}
                    style={{ ...numInput, width: 150, fontSize: 14, fontWeight: 500, textAlign: "left" }} />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "#5B6B75", marginBottom: 4 }}>Period end</div>
                  <input type="date" value={signupPeriod.end}
                    onChange={(e) => setSignupPeriod((p) => ({ ...p, end: e.target.value }))}
                    style={{ ...numInput, width: 150, fontSize: 14, fontWeight: 500, textAlign: "left" }} />
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "#5B6B75", marginBottom: 4 }}>Country</div>
                  <select value={signupPeriod.country} disabled={!hdCountries}
                    onChange={(e) => setSignupPeriod((p) => ({ ...p, country: e.target.value, region: "" }))}>
                    {hdCountries
                      ? Object.entries(hdCountries).map(([code, name]) => <option key={code} value={code}>{name}</option>)
                      : <option>{hdLoading ? "Loading…" : "—"}</option>}
                  </select>
                </label>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "#5B6B75", marginBottom: 4 }}>Province / state</div>
                  <select value={signupPeriod.region} disabled={!hdCtor}
                    onChange={(e) => setSignupPeriod((p) => ({ ...p, region: e.target.value }))}>
                    <option value="">All / nationwide only</option>
                    {Object.entries(hdRegions).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ fontSize: 11.5, color: hdError ? gapRed : "#5B6B75", marginTop: 10 }}>
                {hdError
                  ? `Couldn't load holiday data: ${hdError}`
                  : !signupPeriod.start || !signupPeriod.end
                    ? "Set a start and end date to detect statutory holidays for the selected jurisdiction."
                    : `${holidays.length} date${holidays.length === 1 ? "" : "s"} found in range. "Runs as" assigns which weekday's board pattern governs that date; it doesn't change the board itself.`}
              </div>

              {holidays.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #E2E8EA" }}>
                        {["Date", "Weekday", "Holiday", "Runs as", "Source", ""].map((h) => (
                          <th key={h} style={{ padding: "5px 8px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "#5B6B75", textAlign: "left" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {holidays.map((h) => {
                        const weekday = DAYS[new Date(h.date + "T00:00:00").getDay()];
                        return (
                          <tr key={h.id} style={{ borderBottom: "1px solid #EDF1F3" }}>
                            <td style={{ padding: "5px 8px", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>{h.date}</td>
                            <td style={{ padding: "5px 8px", fontSize: 12.5 }}>{weekday}</td>
                            <td style={{ padding: "5px 8px", fontSize: 12.5 }}>
                              {h.source === "custom"
                                ? <input value={h.name} onChange={(e) => setHolidays((hs) => hs.map((x) => (x.id === h.id ? { ...x, name: e.target.value } : x)))}
                                    style={{ padding: "3px 6px", border: "1px solid #B9C6CC", borderRadius: 2, fontSize: 12.5, width: 160 }} />
                                : h.name}
                            </td>
                            <td style={{ padding: "5px 8px" }}>
                              <select value={h.runsAs || ""} onChange={(e) => setHolidays((hs) => hs.map((x) => (x.id === h.id ? { ...x, runsAs: e.target.value || null } : x)))}>
                                <option value="">Regular (not observed)</option>
                                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                                <option value="custom">Custom schedule</option>
                              </select>
                            </td>
                            <td style={{ padding: "5px 8px" }}>
                              <span style={{ fontSize: 10.5, padding: "1px 6px", background: h.source === "custom" ? demandAmber : ink, color: "#fff", borderRadius: 2 }}>{h.source}</span>
                              {h.runsAs === "custom" && (h.segs || []).some((s) => validateSeg(s, rules, glob).length > 0) && (
                                <span style={{ fontSize: 10.5, padding: "1px 6px", background: gapRed, color: "#fff", borderRadius: 2, marginLeft: 4 }}>flagged</span>
                              )}
                            </td>
                            <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                              {h.runsAs === "custom" ? (
                                <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12 }}
                                  onClick={() => { setSelectedHolidayId(h.id); setTab("coverage"); }}>
                                  Edit shifts ({(h.segs || []).length})
                                </button>
                              ) : (
                                <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12 }}
                                  onClick={() => { setDay(h.runsAs || weekday); setTab("board"); }}>
                                  View board
                                </button>
                              )}
                              {h.source === "custom" && (
                                <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12, color: gapRed, borderColor: gapRed, marginLeft: 6 }}
                                  onClick={() => setHolidays((hs) => hs.filter((x) => x.id !== h.id))}>
                                  remove
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12.5 }}>
                  <div style={{ color: "#5B6B75", marginBottom: 4 }}>Date</div>
                  <input type="date" value={customDraft.date}
                    onChange={(e) => setCustomDraft((d) => ({ ...d, date: e.target.value }))}
                    style={{ ...numInput, width: 150, fontSize: 14, fontWeight: 500, textAlign: "left" }} />
                </label>
                <input placeholder="Closure name" value={customDraft.name}
                  onChange={(e) => setCustomDraft((d) => ({ ...d, name: e.target.value }))}
                  style={{ padding: "6px 8px", border: "1px solid #B9C6CC", borderRadius: 2, fontSize: 13, width: 170, background: "#fff", color: ink }} />
                <select value={customDraft.runsAs} onChange={(e) => setCustomDraft((d) => ({ ...d, runsAs: e.target.value }))}>
                  <option value="">Regular (not observed)</option>
                  {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                  <option value="custom">Custom schedule</option>
                </select>
                <button style={nudgeBtn} disabled={!customDraft.date}
                  onClick={() => {
                    if (!customDraft.date) return;
                    setHolidays((hs) => [...hs.filter((x) => x.date !== customDraft.date), {
                      id: "custom:" + customDraft.date + ":" + Date.now(),
                      date: customDraft.date, name: customDraft.name || "Custom closure",
                      source: "custom", runsAs: customDraft.runsAs || null, segs: [],
                    }].sort((a, b) => (a.date < b.date ? -1 : 1)));
                    setCustomDraft({ date: "", name: "", runsAs: "" });
                  }}>
                  + Add custom date
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
