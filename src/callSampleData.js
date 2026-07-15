// Synthetic sample data for the Call Centre Staffing module. Shares the operator tool's 5-minute,
// 7-day grid (N=246 slots from 05:00) so it can reuse the same coverage engine. No real data.
const N = 246, T0 = 300;
const DAY_ORDER = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Active calls = calls in queue + calls speaking with an agent, per 5-minute interval. Bimodal on
// weekdays (mid-morning + early-afternoon peaks), much lighter on weekends. Zero outside operating
// hours. Amplitudes are illustrative concurrency counts, not a real forecast.
const DAY_WEIGHT = { Sunday: 0.42, Monday: 1.0, Tuesday: 1.03, Wednesday: 1.06, Thursday: 1.02, Friday: 0.95, Saturday: 0.5 };
const bell = (t, mu, sigma, amp) => amp * Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma));
function callCurve(w) {
  const arr = [];
  for (let i = 0; i < N; i++) {
    const t = T0 + i * 5;
    let v = 0;
    if (t >= 360 && t <= 1320) { // 06:00–22:00 operating window
      v = bell(t, 615, 95, 26)    // ~10:15 morning peak
        + bell(t, 860, 115, 31)   // ~14:20 afternoon peak
        + 7;                       // steady base load while open
    }
    arr.push(Math.max(0, Math.round(v * w * 100) / 100));
  }
  return arr;
}
const calls = {};
for (const d of DAY_ORDER) calls[d] = callCurve(DAY_WEIGHT[d]);

// Four generic shift types. Full-time = 8h work (+ paid break); part-time = 4h, no break. Times are
// minutes from midnight on the same grid; editable in the Rules tab.
const rules = {
  FTAM: { s: [360, 480], e: [840, 960], spr: [480, 510], work: 480, brk: true },   // 06:00–08:00 start
  FTPM: { s: [720, 840], e: [1200, 1320], spr: [480, 510], work: 480, brk: true }, // 12:00–14:00 start
  PTAM: { s: [360, 540], e: [600, 780], spr: [240, 240], work: 240, brk: false },  // morning 4h
  PTPM: { s: [900, 1080], e: [1140, 1320], spr: [240, 240], work: 240, brk: false },// evening 4h
};

const typeColors = { FTAM: "#0F7B7A", FTPM: "#2E86AB", PTAM: "#6C5B9E", PTPM: "#B07D2B" };

// Trimmed board-limits/packaging config. Vehicle-specific knobs are neutralized so the shared engine
// reduces to plain scale-free coverage: no fleet cap, no sign-in stagger, no recycling/occupancy/
// off-peak/deadhead. minVeh is the minimum-agents floor; packaging keeps weekly days-off rules.
const global = {
  brkLen: [30, 60], brkAfter: [180, 300],
  max10: 0, min10: 0, maxSpread: 600,
  maxFleet: 0, minVeh: 2, maxPullout: 0,
  minRest: 600, maxConsec: 5,
  maxStartVarWeekday: 60, maxStartVarWeekend: 120, maxStartVarCross: 120,
  shiftSeriesBase: 7000,
  deadheadOutMin: 0, deadheadInMin: 0,
  offPeakBias: 0, coveragePriority: 0,
  weekendGroup: ["Saturday", "Sunday"],
  recycleEnabled: false, recycleTurnaround: 15, recycleWindow: [795, 900], recycleCount: 15,
  occupancyTarget: false,
};

// Hours of operation per day (service span). Schedules can't start before open or end after close.
const spans = {
  Sunday: [480, 1200], Monday: [360, 1320], Tuesday: [360, 1320], Wednesday: [360, 1320],
  Thursday: [360, 1320], Friday: [360, 1320], Saturday: [480, 1200],
};

const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
// A small starter roster (weekly 5-day packages, 2 days off). Agents get filled in later; this is the
// shape of the schedule, not people. b = [breakStart, breakEnd] for full-time straight-with-break.
const board = [
  { id: 1, shift: 7001, run: "7001", type: "FTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 360, e: 870, b: [600, 630] },
  { id: 2, shift: 7002, run: "7002", type: "FTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 390, e: 900, b: [630, 660] },
  { id: 3, shift: 7003, run: "7003", type: "FTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 420, e: 930, b: [660, 690] },
  { id: 4, shift: 7004, run: "7004", type: "FTAM", daysOff: "SU-MO", splitType: "Straight", days: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], s: 450, e: 960, b: [690, 720] },
  { id: 5, shift: 7005, run: "7005", type: "FTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 780, e: 1290, b: [1020, 1050] },
  { id: 6, shift: 7006, run: "7006", type: "FTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 810, e: 1320, b: [1050, 1080] },
  { id: 7, shift: 7007, run: "7007", type: "FTPM", daysOff: "FR-SA", splitType: "Straight", days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], s: 750, e: 1260, b: [990, 1020] },
  { id: 8, shift: 7008, run: "7008", type: "PTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 480, e: 720, b: null },
  { id: 9, shift: 7009, run: "7009", type: "PTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 540, e: 780, b: null },
  { id: 10, shift: 7010, run: "7010", type: "PTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 960, e: 1200, b: null },
  { id: 11, shift: 7011, run: "7011", type: "PTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 1020, e: 1260, b: null },
  { id: 12, shift: 7012, run: "7012", type: "FTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 480, e: 990, b: [720, 750] },
];

export const CALL_SAMPLE = { calls, rules, global, spans, board, typeColors };
