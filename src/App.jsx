import React, { useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from "recharts";

import { RAW } from "./sampleData.js";

/* ---------- constants ---------- */
const DAYS = RAW.days;
const N = RAW.nslots;
const T0 = RAW.slots0;
const T1 = T0 + N * 5;
const SLOT = (i) => T0 + i * 5;
const fmt = (m) => {
  const h = Math.floor(m / 60), mm = m % 60;
  const hh = h >= 24 ? h - 24 : h;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}${h >= 24 ? "+" : ""}`;
};
const ink = "#182430", paper = "#F4F6F7", card = "#FFFFFF",
  demandAmber = "#D98324", targetInk = "#233746", supplyTeal = "#0F7B7A",
  gapRed = "#C0392B", bookoutViolet = "#6C5B9E";
const TYPE_ORDER = ["AM", "NN", "AX", "NN10", "AX10", "BST", "BX", "BS"];
const TYPE_COLOR = {
  AM: "#0F7B7A", NN: "#2E86AB", AX: "#6C5B9E", NN10: "#1B6E53",
  AX10: "#8E5B3B", BST: "#B07D2B", BX: "#7A3E5F", BS: "#4B5D67",
};
const IMPORTED_DEM = (() => {
  const o = {};
  for (const d of DAYS) {
    o[d] = [];
    for (let i = 0; i < N; i++) o[d].push(RAW.demand[d].pu[i] + RAW.demand[d].do[i]);
  }
  return o;
})();
const cloneSeg = (s) => ({ ...s, b: s.b ? [...s.b] : null, days: [...s.days] });
const ORIGINAL = new Map(RAW.segments.map((s) => [s.id, s]));

/* ---------- editable rule defaults ---------- */
const DEFAULT_RULES = JSON.parse(JSON.stringify(RAW.rules));
const DEFAULT_GLOBAL = JSON.parse(JSON.stringify(RAW.global));
const DEFAULT_SPANS = {
  Sunday: [360, 1470], Saturday: [360, 1470],
  Monday: [315, 1470], Tuesday: [315, 1470], Wednesday: [315, 1470],
  Thursday: [315, 1470], Friday: [315, 1470],
};
const parseHM = (str) => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(str || "");
  if (!m) return null;
  const v = parseInt(m[1]) * 60 + parseInt(m[2]);
  return v >= 0 && v <= 1800 && parseInt(m[2]) < 60 ? v : null;
};

function TimeField({ value, onCommit, width = 62 }) {
  const [txt, setTxt] = useState(fmt(value).replace("+", ""));
  const [bad, setBad] = useState(false);
  React.useEffect(() => { setTxt(fmt(value).replace("+", "")); setBad(false); }, [value]);
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

function NumField({ value, onCommit, width = 58, step = 1 }) {
  return (
    <input type="number" inputMode="numeric" value={value} step={step}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) onCommit(v);
      }}
      style={{
        width, padding: "5px 6px", border: "1px solid #B9C6CC", background: "#fff",
        color: "#182430", borderRadius: 2, fontSize: 13, textAlign: "center",
      }} />
  );
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
  if (seg.days.length === 0) issues.push(`No working days assigned`);
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
  const fixed = { ...seg, s, e, b: b, days: [...seg.days] };
  const before = validateSeg(seg, rules, glob).length;
  const after = validateSeg(fixed, rules, glob).length;
  return after === 0 || after < before ? fixed : null;
}

/* ---------- engine ---------- */
function computeEngine(DEM, ftCov, includePT, minVeh, SPANS, maxFleet) {
  const perDay = {};
  let weekEvents = 0, weekSupSlots = 0;
  for (const d of DAYS) {
    const ev = [], sup = [];
    for (let i = 0; i < N; i++) {
      const e = DEM[d][i];
      ev.push(e);
      const s = ftCov[d][i] + (includePT ? RAW.pt[d][i] : 0);
      sup.push(s);
      weekEvents += e; weekSupSlots += s;
    }
    perDay[d] = { ev, sup };
  }
  let weekScore = 0;
  for (const d of DAYS) {
    const p = perDay[d];
    const dayEv = p.ev.reduce((a, b) => a + b, 0);
    const daySupSlots = p.sup.reduce((a, b) => a + b, 0);
    const [s0, s1] = SPANS[d];
    let dayScore = 0;
    const target = [];
    for (let i = 0; i < N; i++) {
      const dSh = dayEv > 0 ? p.ev[i] / dayEv : 0;
      const sSh = daySupSlots > 0 ? p.sup[i] / daySupSlots : 0;
      dayScore += Math.min(dSh, sSh);
      target.push(dSh * daySupSlots);
    }
    for (let i = 0; i < N; i++)
      weekScore += Math.min(p.ev[i] / weekEvents, p.sup[i] / weekSupSlots);
    const gaps = [];
    let cur = null;
    for (let i = 0; i < N; i++) {
      const dSh = dayEv > 0 ? p.ev[i] / dayEv : 0;
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
      dayEv, daySupSlots, dayScore, target, gaps, floorViol, fleetViol,
      supVH: daySupSlots / 12,
      misallocVH: (1 - dayScore) * daySupSlots / 12,
      peakSup: Math.max(...p.sup),
    });
  }
  let weekSupVH = 0;
  for (const d of DAYS) weekSupVH += perDay[d].supVH;
  for (const d of DAYS) {
    perDay[d].demandShare = perDay[d].dayEv / weekEvents;
    perDay[d].resourceShare = perDay[d].supVH / weekSupVH;
  }
  return { perDay, weekScore, weekSupVH };
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
const BRK_SLIDES = [-90, -60, -45, -30, -15, 15, 30, 45, 60, 90];

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
  let weekEv = 0, weekSup = 0;
  for (const d of DAYS) {
    weekEv += eng.perDay[d].dayEv;
    weekSup += eng.perDay[d].daySupSlots;
  }
  const termBase = {};
  for (const d of DAYS) {
    let t = 0;
    const p = eng.perDay[d];
    for (let i = 0; i < N; i++) t += Math.min(p.ev[i] / weekEv, p.sup[i] / weekSup);
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
          term += Math.min(p.ev[i] / weekEv, ns / weekSup);
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
function generateBoard(tenTarget, nPackages, rules, glob, DEM, spans, minVeh, includePT) {
  let evaluated = 0;
  let weekEv = 0;
  for (const d of DAYS) weekEv += DEM[d].reduce((a, b) => a + b, 0);

  const sup = {};
  for (const d of DAYS) sup[d] = includePT ? RAW.pt[d].slice() : new Array(N).fill(0);
  const ptSlots = includePT ? DAYS.reduce((a, d) => a + RAW.pt[d].reduce((x, y) => x + y, 0), 0) : 0;
  const planned = ptSlots + nPackages * 460;
  const target = {};
  for (const d of DAYS) {
    target[d] = [];
    for (let i = 0; i < N; i++) target[d].push((DEM[d][i] / weekEv) * planned);
  }

  const idx = (t) => Math.max(0, Math.min(N, Math.round((t - T0) / 5)));

  // candidates: type × start × (break length × break position, where the type takes one)
  const cands = [];
  for (const [t, R] of Object.entries(rules)) {
    const startLo = Math.ceil(R.s[0] / 5) * 5;
    if (!R.brk) {
      const spread = R.work;
      if (spread < R.spr[0] || spread > R.spr[1]) continue;
      for (let s = startLo; s <= R.s[1]; s += 5) {
        const e = s + spread;
        if (e < R.e[0] || e > R.e[1]) continue;
        cands.push({ type: t, s, e, b: null, work: R.work, is10: R.work === 600, startSlot: idx(s) });
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
            cands.push({ type: t, s, e, b: [s + off, s + off + bl], work: R.work, is10: R.work === 600, startSlot: idx(s) });
          }
        }
      }
    }
  }

  const patterns = { 5: [], 4: [] };
  for (let st = 0; st < 7; st++) {
    patterns[5].push(DAYS.filter((_, i) => i !== st && i !== (st + 1) % 7));
    patterns[4].push(DAYS.filter((_, i) => i !== st && i !== (st + 1) % 7 && i !== (st + 2) % 7));
  }

  const maxPull = glob.maxPullout || 0;
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
        let g = Math.max(0, Math.min(1, target[d][i] - sup[d][i]));
        const t = SLOT(i);
        if (t >= s0 && t < s1 && sup[d][i] < minVeh) g += 0.5;
        pg[i + 1] = pg[i] + g;
        pc[i + 1] = pc[i] + (glob.maxFleet > 0 && sup[d][i] >= glob.maxFleet ? 1 : 0);
      }
      PG[d] = pg; PC[d] = pc;
    }
    const evalDay = (c, d) => {
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
    const pick = (only10) => {
      let best = null, bestVal = -Infinity;
      for (const c of cands) {
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
          if (total > bestVal) { bestVal = total; best = { c, days }; }
        }
      }
      return best;
    };
    let best = null;
    if (used10 < tenTarget) best = pick(true) || pick(false);
    else best = pick(false);
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

  const segs = packs.map((o, i) => ({
    id: 100000 + i, shift: 7101 + i, run: "G" + (i + 1), type: o.type,
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

function optimizeToConvergence(board0, engine0Args, rules, glob, maxIter = 25) {
  // engine0Args = (DEM, includePT, minVeh, spans, maxFleet)
  const [DEM, includePT, minVeh, spans, maxFleet] = engine0Args;
  let board = board0.map((s) => ({ ...s, b: s.b ? [...s.b] : null, days: [...s.days] }));
  let applied = 0, iter = 0, evaluated = 0;
  while (iter < maxIter) {
    iter++;
    const eng = computeEngine(DEM, buildSupply(board), includePT, minVeh, spans, maxFleet);
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
  // start-time consistency within the package
  const startsArr = [...daysWorked].map((d) => byDay[d].s);
  if (startsArr.length > 1 && glob.maxStartVar) {
    const varMin = Math.max(...startsArr) - Math.min(...startsArr);
    if (varMin > glob.maxStartVar)
      issues.push(`Report times vary ${(varMin / 60).toFixed(1)}h across the week (max ${(glob.maxStartVar / 60).toFixed(1)}h)`);
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
  if (nextShift < 8101) nextShift = 8101;
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
  const maxVar = glob.maxStartVar || 60;
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
  const ev = {};
  for (const d of DAYS) {
    ev[d] = DEM[d];
    weekEv += DEM[d].reduce((a, b) => a + b, 0);
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
      for (const dd of sg.days) if (!(sg.id === exceptId && dd === exceptDay)) arr.push(sg.s);
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
          const all = [...sibs, s2];
          if (Math.max(...all) - Math.min(...all) > maxVar) continue;
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

/* ---------- demand sketcher ---------- */
const CTRL_TIMES = Array.from({ length: 40 }, (_, k) => 300 + k * 30);
const TPL = {
  weekday: [8,10,14,20,30,42,55,65,70,68,62,58,55,54,55,58,62,68,75,85,95,100,96,85,72,60,50,42,36,30,25,20,16,13,10,8,6,5,4,3],
  hump:    [4,5,7,10,14,20,28,36,45,54,62,70,76,80,82,82,80,76,70,64,58,52,46,40,35,30,26,22,18,15,12,10,8,6,5,4,3,3,2,2],
  flat:    Array(40).fill(50),
};
const CURVE_DAYS = { Weekday: ["Monday","Tuesday","Wednesday","Thursday","Friday"], Saturday: ["Saturday"], Sunday: ["Sunday"] };

function sketchToEv(raw, trips) {
  const ev = new Array(N);
  let sumV = 0;
  for (let i = 0; i < N; i++) {
    const t = SLOT(i);
    const k = Math.min(38, Math.floor((t - 300) / 30));
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

/* ---------- coverage chart ---------- */
function CoverageChart({ P, day, minVeh, fleetCap, showBookout, height = 320, selBand }) {
  const data = useMemo(() => {
    const bk = RAW.bookout[day];
    const bkMap = {};
    if (bk) for (const [t, b] of bk) bkMap[t] = b;
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
        ev: P.ev[i],
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
          formatter={(v, name) => [v, { target: "Demand-aligned target", sup: "Supply", covered: "Aligned", bookout: "Observed (sample)", gap: "Target (underweighted)" }[name] || name]}
          labelFormatter={(l, pl) => {
            const r = pl && pl[0] && pl[0].payload;
            return r ? `${l} · ${r.ev.toFixed(1)} events/hr` : l;
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
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---------- main ---------- */
export default function App() {
  const [tab, setTab] = useState("coverage");
  const [day, setDay] = useState("Wednesday");
  const [showBookout, setShowBookout] = useState(false);
  const [includePT, setIncludePT] = useState(true);
  const [totalSigned, setTotalSigned] = useState(50);
  const [blockSize, setBlockSize] = useState(10);
  const [board, setBoard] = useState(() => RAW.segments.map(cloneSeg));
  const [rules, setRules] = useState(() => JSON.parse(JSON.stringify(DEFAULT_RULES)));
  const [glob, setGlob] = useState(() => JSON.parse(JSON.stringify(DEFAULT_GLOBAL)));
  const [spans, setSpans] = useState(() => JSON.parse(JSON.stringify(DEFAULT_SPANS)));
  const [newType, setNewType] = useState("");
  const [demSource, setDemSource] = useState("imported");
  const [curveTab, setCurveTab] = useState("Weekday");
  const [sketch, setSketch] = useState({ Weekday: [...TPL.weekday], Saturday: [...TPL.hump], Sunday: [...TPL.hump] });
  const [trips, setTrips] = useState({ Weekday: 1600, Saturday: 700, Sunday: 600 });
  const [sugs, setSugs] = useState(null);
  const [buildN, setBuildN] = useState(100);
  const [builds, setBuilds] = useState(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [sweep, setSweep] = useState(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineResult, setRefineResult] = useState(null);
  const [fixResult, setFixResult] = useState(null);
  const [optBusy, setOptBusy] = useState(false);
  const [optResult, setOptResult] = useState(null);
  const [sugsStale, setSugsStale] = useState(false);
  const fileRef = useRef(null);
  const [hist, setHist] = useState([]);
  const [selId, setSelId] = useState(null);
  const nextId = useRef(RAW.segments.length + 1000);
  const designed = totalSigned - blockSize;

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
    setBoard(RAW.segments.map(cloneSeg));
    setSelId(null);
  };

  const DEM = useMemo(() => {
    if (demSource === "imported") return IMPORTED_DEM;
    const o = {};
    for (const [curve, days] of Object.entries(CURVE_DAYS)) {
      const ev = sketchToEv(sketch[curve], trips[curve]);
      for (const d of days) o[d] = ev;
    }
    return o;
  }, [demSource, sketch, trips]);

  const saveProject = () => {
    const payload = {
      v: 1, savedAt: new Date().toISOString(),
      demSource, sketch, trips, board, rules, glob, spans,
      totalSigned, blockSize, includePT,
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
      ["Demand source", demSource],
      [],
      ["Day", "Demand %", "Resource %", "Coverage score"]];
    for (const d of DAYS) {
      const p = eng.perDay[d];
      sum.push([d, +(p.demandShare * 100).toFixed(1), +(p.resourceShare * 100).toFixed(1), +(p.dayScore * 100).toFixed(1)]);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(sum);
    ws2["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Summary");
    XLSX.writeFile(wb, "signup-board.xlsx");
  };

  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        if (!p || !Array.isArray(p.board)) throw new Error("bad file");
        setBoard(p.board.map(cloneSeg));
        if (p.rules) setRules(p.rules);
        if (p.glob) setGlob({ minVeh: p.floorVal ?? DEFAULT_GLOBAL.minVeh, ...p.glob });
        if (p.spans) setSpans(p.spans);
        if (p.sketch) setSketch(p.sketch);
        if (p.trips) setTrips(p.trips);
        if (p.demSource) setDemSource(p.demSource);
        if (p.totalSigned != null) setTotalSigned(p.totalSigned);
        if (p.blockSize != null) setBlockSize(p.blockSize);
        if (p.includePT != null) setIncludePT(p.includePT);
        setHist([]); setSelId(null); setSugs(null); setSugsStale(false);
      } catch (err) {
        alert("Could not read that project file.");
      }
    };
    rd.readAsText(file);
  };

  const ftCov = useMemo(() => buildSupply(board), [board]);
  const eng = useMemo(() => computeEngine(DEM, ftCov, includePT, glob.minVeh, spans, glob.maxFleet), [DEM, ftCov, includePT, glob.minVeh, spans, glob.maxFleet]);
  const base = useMemo(() => computeEngine(DEM, buildSupply(RAW.segments), includePT, glob.minVeh, spans, glob.maxFleet), [DEM, includePT, glob.minVeh, spans, glob.maxFleet]);
  const P = eng.perDay[day];

  const changedCount = useMemo(() => {
    let n = 0;
    const ids = new Set();
    for (const s of board) {
      ids.add(s.id);
      const o = ORIGINAL.get(s.id);
      if (!o) { n++; continue; }
      if (o.s !== s.s || o.e !== s.e || o.type !== s.type ||
        JSON.stringify(o.b) !== JSON.stringify(s.b) || o.days.join() !== s.days.join()) n++;
    }
    for (const id of ORIGINAL.keys()) if (!ids.has(id)) n++;
    return n;
  }, [board]);

  const distinctShifts = useMemo(() => new Set(board.map((s) => s.shift)).size, [board]);
  const tenCount = useMemo(() => {
    const s = new Set();
    for (const sg of board) {
      const R = rules[sg.type];
      if (R && R.work === 600) s.add(sg.shift);
    }
    return s.size;
  }, [board, rules]);
  const flagCount = useMemo(() => board.filter((sg) => validateSeg(sg, rules, glob).length > 0).length, [board, rules, glob]);

  const daySegs = useMemo(() => {
    const list = board.filter((sg) => sg.days.includes(day));
    list.sort((a, b) =>
      (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (a.s - b.s) || (a.shift - b.shift));
    return list;
  }, [board, day]);

  const sel = selId != null ? board.find((s) => s.id === selId) : null;
  const selIssues = sel ? validateSeg(sel, rules, glob) : [];

  const patchSel = (patch) => {
    if (!sel) return;
    mutate((b) => b.map((s) => (s.id === sel.id ? { ...cloneSeg(s), ...patch } : s)));
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
  const duplicateSel = () => {
    if (!sel) return;
    const maxShift = Math.max(...board.map((s) => s.shift));
    const id = nextId.current++;
    const copy = { ...cloneSeg(sel), id, shift: maxShift + 1, run: "NEW" };
    mutate((b) => [...b, copy]);
    setSelId(id);
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
    const o = ORIGINAL.get(sel.id);
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
    const o = ORIGINAL.get(sel.id);
    if (!o) return false;
    return o.s !== sel.s || o.e !== sel.e || o.type !== sel.type ||
      JSON.stringify(o.b) !== JSON.stringify(sel.b) || o.days.join() !== sel.days.join();
  })() : false;

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
        .ganttrow { display:flex; align-items:center; gap:6px; height:20px; cursor:pointer; }
        .glabel { font-size:10.5px; width:118px; flex:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums; }
        .gtrack { position:relative; flex:1; height:14px; background:#EFF3F4; }
        .gbar { position:absolute; top:0; height:14px; border-radius:2px; }
        .gbrk { position:absolute; top:0; height:14px; background:repeating-linear-gradient(45deg,#fff,#fff 3px,#AEBAC0 3px,#AEBAC0 6px); border-left:1px solid rgba(0,0,0,.35); border-right:1px solid rgba(0,0,0,.35); }
        .daychip { cursor:pointer; padding:5px 8px; border:1px solid #B9C6CC; font-size:11.5px; border-radius:2px; user-select:none; }
        .daychip.on { background:${supplyTeal}; color:#fff; border-color:${supplyTeal}; }
        .kpistrip { position:sticky; top:0; z-index:5; display:flex; gap:14px; align-items:center; flex-wrap:wrap; background:${ink}; color:#fff; padding:8px 14px; margin-bottom:12px; }
        .kpi { display:flex; flex-direction:column; }
        .kpi .l { font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; opacity:.7; }
        .kpi .v { font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1.1; }
        @media (max-width:640px){ .hdr-title{font-size:24px !important;} .glabel{width:84px;} }
      `}</style>

      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "16px 12px 40px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", borderBottom: `3px solid ${ink}`, paddingBottom: 10 }}>
          <div className="hdr-title" style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 30 }}>
            SIGNUP WORKBENCH
          </div>
          <div style={{ marginLeft: "auto", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 600 }}>
            <span style={{ fontSize: 11, verticalAlign: "middle", padding: "2px 7px", marginRight: 8, borderRadius: 2, background: demSource === "sketched" ? demandAmber : supplyTeal, color: "#fff", letterSpacing: ".06em" }}>
              {demSource === "sketched" ? "SKETCHED DEMAND" : "IMPORTED DEMAND"}
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

        {/* tabs */}
        <div style={{ display: "flex", gap: 6, margin: "12px 0", flexWrap: "wrap" }}>
          <div className={"tabbtn" + (tab === "rules" ? " on" : "")} onClick={() => setTab("rules")}>RULES</div>
          <div className={"tabbtn" + (tab === "demand" ? " on" : "")} onClick={() => setTab("demand")}>DEMAND</div>
          <div className={"tabbtn" + (tab === "build" ? " on" : "")} onClick={() => setTab("build")}>AUTO-BUILD</div>
          <div className={"tabbtn" + (tab === "coverage" ? " on" : "")} onClick={() => setTab("coverage")}>COVERAGE</div>
          <div className={"tabbtn" + (tab === "board" ? " on" : "")} onClick={() => setTab("board")}>BOARD DESIGNER</div>
          <div className={"tabbtn" + (tab === "pack" ? " on" : "")} onClick={() => setTab("pack")}>PACKAGING</div>
          <div className={"tabbtn" + (tab === "suggest" ? " on" : "")} onClick={() => setTab("suggest")}>SUGGESTIONS</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={exportBoard}>Export board</button>
            <button style={nudgeBtn} onClick={saveProject}>Save project</button>
            <button style={nudgeBtn} onClick={() => fileRef.current && fileRef.current.click()}>Load project</button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { if (e.target.files && e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ""; }} />
          </div>
          {tab === "board" && (
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...nudgeBtn, opacity: hist.length ? 1 : 0.4 }} onClick={undo} disabled={!hist.length}>↶ Undo</button>
              <button style={{ ...nudgeBtn, borderColor: changedCount ? demandAmber : "#B9C6CC", opacity: changedCount ? 1 : 0.4 }} onClick={resetAll} disabled={!changedCount}>Reset board</button>
              {flagCount > 0 && (
                <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixAll}>
                  Fix all flags ({flagCount})
                </button>
              )}
              <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink }} onClick={addShift}>+ Add shift</button>
            </div>
          )}
        </div>

        {/* envelope */}
        <div style={{ background: ink, color: "#fff", padding: "10px 14px", marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 600 }}>SIGNUP ENVELOPE</div>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
              Total signed
              <input type="number" inputMode="numeric" min={1} max={400} value={totalSigned}
                onChange={(e) => setTotalSigned(parseInt(e.target.value || "0"))} style={numInput} />
            </label>
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
              Extra board
              <input type="number" inputMode="numeric" min={0} max={totalSigned} value={blockSize}
                onChange={(e) => setBlockSize(parseInt(e.target.value || "0"))} style={numInput} />
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

        {/* day paddles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: 5, marginBottom: 12 }}>
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

        {tab === "demand" && (
          <>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>Demand source</div>
              <label style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={demSource === "imported"} onChange={() => setDemSource("imported")} />
                Imported demand model
              </label>
              <label style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={demSource === "sketched"} onChange={() => setDemSource("sketched")} />
                Sketched demand
              </label>
              <div style={{ fontSize: 12, color: "#5B6B75", flexBasis: "100%" }}>
                No data export needed to get started: tell the tool roughly how many trips you run, then shape the curve by feel. Every screen scores against whichever source is active, and the badge in the header always shows which one that is. Import real data later without losing anything.
              </div>
            </div>

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", opacity: demSource === "sketched" ? 1 : 0.55 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                {Object.keys(CURVE_DAYS).map((c) => (
                  <div key={c} className={"tabbtn" + (curveTab === c ? " on" : "")} style={{ padding: "6px 14px", fontSize: 15 }}
                    onClick={() => setCurveTab(c)}>
                    {c.toUpperCase()}
                  </div>
                ))}
                <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  Trips per {curveTab === "Weekday" ? "weekday" : curveTab}
                  <input type="number" inputMode="numeric" min={0} value={trips[curveTab]}
                    onChange={(e) => setTrips((t) => ({ ...t, [curveTab]: parseInt(e.target.value || "0") }))}
                    style={numInput} />
                </label>
              </div>

              <Sketcher raw={sketch[curveTab]} trips={trips[curveTab]}
                setRaw={(fn) => setSketch((s) => ({ ...s, [curveTab]: typeof fn === "function" ? fn(s[curveTab]) : fn }))} />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#5B6B75" }}>Start from:</span>
                <button style={nudgeBtn} onClick={() => setSketch((s) => ({ ...s, [curveTab]: [...TPL.weekday] }))}>Weekday pattern</button>
                <button style={nudgeBtn} onClick={() => setSketch((s) => ({ ...s, [curveTab]: [...TPL.hump] }))}>Midday hump</button>
                <button style={nudgeBtn} onClick={() => setSketch((s) => ({ ...s, [curveTab]: [...TPL.flat] }))}>Flat</button>
                {(() => {
                  const ev = sketchToEv(sketch[curveTab], trips[curveTab]);
                  const tot = ev.reduce((a, b) => a + b, 0);
                  let pk = 0, pkI = 0, am = 0;
                  for (let i = 0; i < N; i++) {
                    if (ev[i] > pk) { pk = ev[i]; pkI = i; }
                    if (SLOT(i) < 720) am += ev[i];
                  }
                  return (
                    <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#41525C" }}>
                      Peak {fmt(SLOT(pkI))} · {tot > 0 ? ((am / tot) * 100).toFixed(0) : 0}% of demand before noon · applies to {CURVE_DAYS[curveTab].length} day{CURVE_DAYS[curveTab].length > 1 ? "s" : ""}
                    </span>
                  );
                })()}
              </div>
              {demSource !== "sketched" && (
                <div style={{ fontSize: 12.5, color: demandAmber, marginTop: 8 }}>
                  Sketch freely — switch the source above to score the board against it.
                </div>
              )}
            </div>
          </>
        )}

        {tab === "build" && (
          <>
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Generate a starting board from the rules and demand
                </div>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  Weekly packages to build
                  <input type="number" inputMode="numeric" min={1} max={500} value={buildN}
                    onChange={(e) => setBuildN(parseInt(e.target.value || "0"))} style={numInput} />
                </label>
                <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink, opacity: buildBusy ? 0.5 : 1 }} disabled={buildBusy}
                  onClick={() => {
                    setBuildBusy(true);
                    setTimeout(() => {
                      const a = generateBoard(glob.max10, buildN, rules, glob, DEM, spans, glob.minVeh, includePT);
                      const b = generateBoard(0, buildN, rules, glob, DEM, spans, glob.minVeh, includePT);
                      const score = (segs) => computeEngine(DEM, buildSupply(segs), includePT, glob.minVeh, spans, glob.maxFleet).weekScore;
                      setBuilds({ ten: { ...a, score: score(a.segs) }, value: { ...b, score: score(b.segs) } });
                      setBuildBusy(false);
                    }, 30);
                  }}>
                  {buildBusy ? "Generating…" : "Generate both modes"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 6 }}>
                Builds whole weekly packages: each placement chooses a shift type, a start time on the 5-minute grid, and a consecutive days-off pattern together, so every generated shift is signable by construction — consistent report times all week, legal rest, no orphan runs. <b>Fill mode</b> commits the full 10-hour allowance before any 8-hour work; <b>value mode</b> lets the coverage score decide the mix. Break-taking types are explored at every legal length (30 min to 4 h) and position, so long midday breaks that stretch a shift across both peaks are found automatically. The fleet cap, minimum-vehicle floor, and sign-in stagger steer every placement. Set the count to your designed-run envelope ({designed} currently). Loading a build replaces the current board — save your project first.
              </div>
            </div>

            {builds && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
                {[["ten", "Fill the 10-hour allowance first"], ["value", "Best value — the score picks the mix"]].map(([m, title]) => {
                  const B = builds[m];
                  return (
                    <div key={m} style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px" }}>
                      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 600 }}>{title}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
                        <Stat label="Weekly coverage score" value={`${(B.score * 100).toFixed(1)}%`} sub={`${(B.evaluated || 0).toLocaleString()} placements evaluated`} tone={supplyTeal} />
                        <Stat label="Paid hours / week" value={B.paidHours.toFixed(0)} tone={targetInk} />
                        <Stat label="10-hour packages" value={B.used10} sub={`cap ${glob.max10}`} tone={demandAmber} />
                      </div>
                      <div style={{ fontSize: 12.5, color: "#41525C" }}>
                        Mix: {Object.entries(B.mix).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ")}
                      </div>
                      <button style={{ ...nudgeBtn, marginTop: 10, background: supplyTeal, color: "#fff", borderColor: supplyTeal }}
                        onClick={() => {
                          mutate(() => B.segs.map(cloneSeg));
                          setSelId(null);
                          setTab("board");
                        }}>
                        Load this board into the Designer
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {builds && (
              <div style={{ fontSize: 12.5, color: "#5B6B75", marginTop: 12 }}>
                Every package costs the same 40 paid hours (5×8h or 4×10h), so the real trade is coverage vs the four-day weeks operators value: filling the allowance uses {builds.ten.used10} ten-hour packages at {(builds.ten.score * 100).toFixed(1)}% coverage; letting the score choose lands on {builds.value.used10} at {(builds.value.score * 100).toFixed(1)}%. Generated boards arrive fully packaged — check them on the Packaging tab. Reset board always returns to the loaded signup.
              </div>
            )}

            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 14px", marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600 }}>
                  Sweep the 10-hour mix
                </div>
                <button style={{ ...nudgeBtn, background: ink, color: "#fff", borderColor: ink, opacity: sweepBusy ? 0.5 : 1 }} disabled={sweepBusy}
                  onClick={() => {
                    setSweepBusy(true);
                    setTimeout(() => {
                      const targets = [];
                      const step = Math.max(1, Math.round(glob.max10 / 6));
                      for (let t = 0; t <= glob.max10; t += step) targets.push(t);
                      if (targets[targets.length - 1] !== glob.max10) targets.push(glob.max10);
                      const rows = targets.map((t) => {
                        const g = generateBoard(t, buildN, rules, glob, DEM, spans, glob.minVeh, includePT);
                        const score = computeEngine(DEM, buildSupply(g.segs), includePT, glob.minVeh, spans, glob.maxFleet).weekScore;
                        return { target: t, ...g, score };
                      });
                      rows.sort((a, b) => b.score - a.score);
                      setSweep(rows);
                      setSweepBusy(false);
                    }, 30);
                  }}>
                  {sweepBusy ? "Sweeping — this one takes a while…" : "Run sweep (7 full builds)"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#5B6B75", marginTop: 4 }}>
                The builder is greedy — strong but myopic — and the 10-hour count is the board's key structural choice, so neither fixed policy is guaranteed best. The sweep builds a complete board at each 10-hour target and ranks them, spending real compute to search the structure space instead of trusting one trajectory. Deep optimize the winner afterward for the full treatment.
              </div>
              {sweep && (
                <table className="shares" style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
                  <thead><tr><th>10h target</th><th>10h built</th><th>Coverage</th><th>Placements evaluated</th><th></th></tr></thead>
                  <tbody>
                    {sweep.map((r, i) => (
                      <tr key={r.target} style={{ background: i === 0 ? "#F2F8F7" : "transparent" }}>
                        <td>{r.target}</td>
                        <td>{r.used10}</td>
                        <td style={{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? supplyTeal : ink }}>{(r.score * 100).toFixed(2)}%{i === 0 ? " ← best" : ""}</td>
                        <td>{(r.evaluated || 0).toLocaleString()}</td>
                        <td style={{ textAlign: "right" }}>
                          <button style={{ ...nudgeBtn, padding: "4px 10px", fontSize: 12 }}
                            onClick={() => { mutate(() => r.segs.map(cloneSeg)); setSelId(null); setTab("pack"); }}>
                            Load
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {tab === "coverage" && (
          <>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", background: card, border: "1px solid #E2E8EA", padding: "10px 14px", marginBottom: 12 }}>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
                <input type="checkbox" checked={includePT} onChange={(e) => setIncludePT(e.target.checked)} />
                Include supplemental runs (part-time board)
              </label>
              <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
                <input type="checkbox" checked={showBookout} onChange={(e) => setShowBookout(e.target.checked)} />
                Observed vehicles{RAW.bookout[day] ? "" : " (none this day)"}
              </label>
            </div>

            <details style={{ background: "#F7FAF9", border: "1px solid #DCE7E4", padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16 }}>
                What do these numbers mean?
              </summary>
              <div style={{ marginTop: 8, lineHeight: 1.55, color: "#33434D" }}>
                <b>Coverage score</b> answers one question: of all the trip demand in the period, what share happens while your service hours are proportionally in place to serve it? 100% would mean your hours perfectly trace the demand pattern — impossible in practice, since shifts come in fixed lengths with rules. Use the score to compare boards: higher means hours better matched to demand.<br /><br />
                On each day tile, <b>demand</b> is that day's share of the week's trips, and <b>cov</b> is that day's coverage score. In the chart, the dark line is the <b>demand-aligned target</b> — your own hours redrawn to follow demand exactly. <b>Red</b> = you're lighter than demand suggests at that time. <b>Teal above the line</b> = heavier than demand suggests (those hours earn no score). <b>Misplaced hours</b> totals the hours sitting in the heavy zones.
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
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={glob.maxFleet} showBookout={showBookout} height={340} />
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
                      Worth {(g.weight * 100).toFixed(2)} points of {day}'s score. Open the Board Designer to move work here.
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
          </>
        )}

        {tab === "board" && (
          <>
            {/* KPI strip */}
            <div className="kpistrip">
              <div className="kpi"><span className="l">{day} coverage</span><span className="v" style={{ color: P.dayScore >= 0.9 ? "#7FD1C0" : "#F5C16C" }}>{(P.dayScore * 100).toFixed(1)}%</span></div>
              <div className="kpi"><span className="l">vs signed</span><span className="v" style={{ color: dayDelta >= 0 ? "#7FD1C0" : "#F09E93" }}>{dayDelta >= 0 ? "+" : ""}{dayDelta.toFixed(2)}</span></div>
              <div className="kpi"><span className="l">week</span><span className="v">{(eng.weekScore * 100).toFixed(1)}%</span></div>
              <div className="kpi"><span className="l">misplaced</span><span className="v">{P.misallocVH.toFixed(0)} vh</span></div>
              <div className="kpi"><span className="l">peak / fleet</span><span className="v" style={{ color: P.peakSup > glob.maxFleet ? "#F09E93" : "#fff" }}>{P.peakSup}/{glob.maxFleet}</span></div>
              <div className="kpi"><span className="l">rule flags</span><span className="v" style={{ color: flagCount ? "#F09E93" : "#7FD1C0" }}>{flagCount}</span></div>
              <div className="kpi"><span className="l">10-hour</span><span className="v" style={{ color: tenCount > glob.max10 ? "#F09E93" : "#fff" }}>{tenCount}/{glob.max10}</span></div>
              <div className="kpi"><span className="l">runs</span><span className="v">{distinctShifts}</span></div>
              <div className="kpi"><span className="l">changes</span><span className="v">{changedCount}</span></div>
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
              <div style={{ background: card, border: `1px solid ${selIssues.length ? gapRed : "#E2E8EA"}`, padding: "12px 14px", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700 }}>
                    Shift {sel.shift} · Run {sel.run}
                  </div>
                  <select value={sel.type} onChange={(e) => setType(e.target.value)}>
                    {Object.keys(rules).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span style={{ fontSize: 12, color: "#5B6B75" }}>{sel.splitType}</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={nudgeBtn} onClick={duplicateSel}>Duplicate</button>
                    <button style={{ ...nudgeBtn, borderColor: gapRed, color: gapRed }} onClick={removeSel}>Remove</button>
                    {selIssues.length > 0 && <button style={{ ...nudgeBtn, background: gapRed, color: "#fff", borderColor: gapRed }} onClick={fixSel}>Fix violations</button>}
                    {isChanged && <button style={{ ...nudgeBtn, borderColor: demandAmber }} onClick={resetSel}>Reset</button>}
                    <button style={nudgeBtn} onClick={() => setSelId(null)}>Close</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
                  <Nudge label="Start" value={fmt(sel.s)}
                    onDec={() => patchSel({ s: sel.s - 5 })} onInc={() => patchSel({ s: sel.s + 5 })} />
                  <Nudge label="End" value={fmt(sel.e)}
                    onDec={() => patchSel({ e: sel.e - 5 })} onInc={() => patchSel({ e: sel.e + 5 })} />
                  <Nudge label="Whole shift" value={`${((sel.e - sel.s) / 60).toFixed(2)}h`}
                    onDec={() => patchSel({ s: sel.s - 5, e: sel.e - 5, b: sel.b ? [sel.b[0] - 5, sel.b[1] - 5] : null })}
                    onInc={() => patchSel({ s: sel.s + 5, e: sel.e + 5, b: sel.b ? [sel.b[0] + 5, sel.b[1] + 5] : null })} />
                  {sel.b && (
                    <>
                      <Nudge label={`Break start`} value={fmt(sel.b[0])}
                        onDec={() => shiftBreak(-5)} onInc={() => shiftBreak(5)} />
                      <Nudge label={`Break length`} value={`${sel.b[1] - sel.b[0]}m`}
                        onDec={() => patchSel({ b: [sel.b[0], sel.b[1] - 5] })} onInc={() => patchSel({ b: [sel.b[0], sel.b[1] + 5] })} />
                    </>
                  )}
                  <button style={nudgeBtn} onClick={toggleBreak}>{sel.b ? "Remove break" : "Add break"}</button>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#5B6B75" }}>Works:</span>
                  {DAYS.map((d) => (
                    <span key={d} className={"daychip" + (sel.days.includes(d) ? " on" : "")} onClick={() => toggleDay(d)}>
                      {d.slice(0, 2).toUpperCase()}
                    </span>
                  ))}
                </div>
                {selIssues.length > 0 && (
                  <div style={{ marginTop: 10, borderLeft: `3px solid ${gapRed}`, background: "#FDF6F5", padding: "6px 10px" }}>
                    {selIssues.map((iss, i) => <div key={i} style={{ fontSize: 12.5, color: gapRed }}>⚠ {iss}</div>)}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ background: "#EEF4F5", border: "1px dashed #B9C6CC", padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#41525C" }}>
                Tap any bar to open it: nudge times, move breaks, change type, toggle working days, duplicate or remove. "+ Add shift" creates a new AX split shift on {day} to shape from scratch. Every change re-scores instantly; Undo and Reset are always available.
              </div>
            )}

            {/* gantt */}
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 10px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600 }}>
                  {day} board — {daySegs.length} working segments
                </div>
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
                {daySegs.map((sg) => {
                  const bad = validateSeg(sg, rules, glob).length > 0;
                  const isSel = sg.id === selId;
                  const brkMin = sg.b ? sg.b[1] - sg.b[0] : 0;
                  const workHrs = ((sg.e - sg.s - brkMin) / 60).toFixed(2);
                  const barTitle = `${fmt(sg.s)}–${fmt(sg.e)} · ${workHrs}h working${sg.b ? ` · ${brkMin}m break (${fmt(sg.b[0])}–${fmt(sg.b[1])})` : ""}`;
                  return (
                    <div key={sg.id} className="ganttrow" onClick={() => setSelId(sg.id)}>
                      <div className="glabel" style={{ fontWeight: isSel ? 700 : 400, color: bad ? gapRed : undefined }}>
                        {sg.shift}·{sg.run} {sg.type}
                      </div>
                      <div className="gtrack" title={barTitle}>
                        {[360, 600, 840, 1080, 1320].map((m) => (
                          <div key={m} style={{ position: "absolute", left: `${pctPos(m)}%`, top: 0, bottom: 0, width: 1, background: "#E2E8EA" }} />
                        ))}
                        <div className="gbar" style={{
                          left: `${pctPos(sg.s)}%`, width: `${pctPos(Math.min(sg.e, T1)) - pctPos(sg.s)}%`,
                          background: TYPE_COLOR[sg.type] || ink,
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
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                {TYPE_ORDER.filter(t => daySegs.some(s => s.type === t)).map(t => (
                  <span key={t} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 12, height: 10, background: TYPE_COLOR[t], display: "inline-block", borderRadius: 2 }} />{t}
                  </span>
                ))}
                <span style={{ fontSize: 11, color: "#5B6B75" }}>hatched notch = break · red outline = rule flag · hover a bar for hours</span>
              </div>
            </div>

            {/* live coverage */}
            <div style={{ background: card, border: "1px solid #E2E8EA", padding: "12px 4px 4px" }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, padding: "0 10px 6px" }}>
                Live {day} coverage
              </div>
              <CoverageChart P={P} day={day} minVeh={glob.minVeh} fleetCap={glob.maxFleet} showBookout={showBookout} height={280}
                selBand={sel ? [sel.s, sel.e] : null} />
              <div style={{ fontSize: 11.5, color: "#5B6B75", padding: "2px 10px 10px" }}>
                Dashed lines mark the selected shift. The KPI strip stays pinned while you scroll.
              </div>
            </div>
          </>
        )}
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
              <div className="kpistrip">
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
                        const after = computeEngine(DEM, buildSupply(r.board), includePT, glob.minVeh, spans, glob.maxFleet).weekScore;
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
                Each row is one signable weekly package. <b>Refine day-to-day times</b> nudges individual days of a package (within the report-time variation rule) wherever a single day's demand justifies a slightly different start — the source of day-variant rows like a 07:20 Sunday inside a 07:30 week. Auto-packaging appears when the board contains loose single-day runs. Rest, consecutive-day, and variation rules come from the Rules tab. Tap a row to inspect; edit times or working days in the Board Designer.
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
                          <span style={{ fontSize: 10.5, padding: "1px 6px", background: TYPE_COLOR[segs[0].type] || ink, color: "#fff", borderRadius: 2 }}>{segs[0].type}</span>
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
                      const after = computeEngine(DEM, buildSupply(r.board), includePT, glob.minVeh, spans, glob.maxFleet).weekScore;
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
                        — candidates for a slide or retype in the Board Designer.
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
                Every number here drives validation and scoring live. Edits flag existing shifts immediately — nothing is blocked, only flagged.
              </div>
              <button style={{ ...nudgeBtn, marginLeft: "auto", borderColor: demandAmber }}
                onClick={() => {
                  setRules(JSON.parse(JSON.stringify(DEFAULT_RULES)));
                  setGlob(JSON.parse(JSON.stringify(DEFAULT_GLOBAL)));
                  setSpans(JSON.parse(JSON.stringify(DEFAULT_SPANS)));
                }}>
                Reset to CA defaults
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
                          <span style={{ fontSize: 12, padding: "2px 8px", background: TYPE_COLOR[t] || ink, color: "#fff", borderRadius: 2, fontWeight: 600 }}>{t}</span>
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
                          {inUse === 0 && (
                            <button style={{ ...nudgeBtn, padding: "3px 8px", fontSize: 12, color: gapRed, borderColor: gapRed }}
                              onClick={() => setRules((old) => { const n = { ...old }; delete n[t]; return n; })}>
                              remove
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  Currently {tenCount} ten-hour shifts on the board{tenCount > glob.max10 ? " — over the cap" : ""}.
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
                  <span>Max report-time variation in a package (h)</span>
                  <NumField value={glob.maxStartVar / 60} step={0.25} onCommit={(v) => setGlob((g) => ({ ...g, maxStartVar: Math.round(v * 60) }))} />
                </div>
                <div style={{ fontSize: 11.5, color: "#5B6B75", marginTop: 10 }}>
                  Checked on every weekly package in the Packaging tab; the auto-builder satisfies all three by construction.
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
                  The minimum-vehicles rule applies inside the span; the demand model itself is unaffected.
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
