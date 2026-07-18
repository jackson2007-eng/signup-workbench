// Sample data for the Dispatch Desks module. Shares the operator tool's 5-minute, 7-day grid
// (246 slots from 05:00) so it can reuse the same coverage engine.
//
// Unlike the operator Signup Workbench (demand = trips) or Call Centre Staffing (demand = active
// calls), Dispatch frames demand as `operators` — a concurrency curve of how many field
// operators/vehicles are actively on the road at each interval. Dispatch-desk workload tracks
// that concurrent field activity, not ridership or call volume. This is synthetic (no real agency
// data), shaped as two paratransit pull-out/pull-in peaks (~07:45 AM, ~16:15 PM) over a sustained
// midday plateau, rather than the single midday hump a call-centre curve has.
function gauss(t, center, width, amp) {
  const z = (t - center) / width;
  return amp * Math.exp(-0.5 * z * z);
}
function buildOperatorsDay(scale) {
  const arr = [];
  for (let i = 0; i < 246; i++) {
    const t = 300 + i * 5;
    const plateau = gauss(t, 735, 260, 17);  // broad midday sustain, centered ~12:15
    const amPeak = gauss(t, 465, 65, 16);    // 07:45 pull-out peak
    const pmPeak = gauss(t, 975, 80, 15);    // 16:15 pull-in peak
    arr.push(Math.round(Math.max(0, (plateau + amPeak + pmPeak) * scale) * 100) / 100);
  }
  return arr;
}
const operators = {
  Sunday: buildOperatorsDay(0.35),
  Monday: buildOperatorsDay(1),
  Tuesday: buildOperatorsDay(1),
  Wednesday: buildOperatorsDay(1),
  Thursday: buildOperatorsDay(1),
  Friday: buildOperatorsDay(1),
  Saturday: buildOperatorsDay(0.5),
};

// Two full-time dispatcher shift types (8h + paid break) covering the AM and PM pull-out/pull-in
// peaks. Part-time types (below, in ptRules) are a separate classification set, same split as the
// Signup Workbench's FT/PT feature.
const rules = {
  DSAM: { s: [330, 450], e: [810, 930], spr: [480, 510], work: 480, brk: true },   // 05:30-07:30 start
  DSPM: { s: [810, 930], e: [1290, 1410], spr: [480, 510], work: 480, brk: true }, // 13:30-15:30 start
};

// Part-time dispatcher types (4h, no break). `days` = which days each type is available to work —
// a part-time shift works all of its available days at once (no 40-hour-week/days-off rotation),
// same convention as App.jsx's PT machinery.
const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ptRules = {
  DSPTAM: { s: [360, 540], e: [600, 780], spr: [240, 240], work: 240, brk: false, days: [...WD] },
  DSPTPM: { s: [930, 1110], e: [1170, 1350], spr: [240, 240], work: 240, brk: false, days: [...WD] },
};
const ptEnabled = true;
const ptCount = 4;

const typeColors = { DSAM: "#0F7B7A", DSPM: "#2E86AB", DSPTAM: "#6C5B9E", DSPTPM: "#B07D2B" };

// Trimmed board-limits/packaging config, same neutralization pattern as Call Centre's `global`:
// no fleet cap, no sign-in stagger, no recycling/occupancy/off-peak/deadhead. `ratioPerDispatcher`
// and `minOnDuty` replace Call Centre's Erlang-C fields — dispatch sizing is a capacity ratio
// (how many concurrent operators one dispatcher can competently cover), not a call-queue model.
const global = {
  brkLen: [30, 60], brkAfter: [180, 300],
  max10: 0, min10: 0, maxSpread: 600,
  maxFleet: 0, minVeh: 1, maxPullout: 0,
  minRest: 600, maxConsec: 5,
  maxStartVarWeekday: 60, maxStartVarWeekend: 120, maxStartVarCross: 120,
  shiftSeriesBase: 9000,
  deadheadOutMin: 0, deadheadInMin: 0,
  offPeakBias: 0, coveragePriority: 0, scheduleStability: 3,
  weekendGroup: ["Saturday", "Sunday"],
  recycleEnabled: false, recycleTurnaround: 15, recycleWindow: [795, 900], recycleCount: 15,
  occupancyTarget: false,
  ratioPerDispatcher: 8, minOnDuty: 1,
};

// Hours of operation per day (service span). Schedules can't start before open or end after close.
const spans = {
  Sunday: [420, 1260], Monday: [300, 1470], Tuesday: [300, 1470], Wednesday: [300, 1470],
  Thursday: [300, 1470], Friday: [300, 1470], Saturday: [420, 1380],
};

// A small starter roster (FT weekly 5-day packages + PT single-window shifts). Dispatchers get
// filled in later; this is the shape of the schedule, not people. b = [breakStart, breakEnd].
const board = [
  { id: 1, shift: 9001, run: "9001", type: "DSAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 360, e: 870, b: [600, 630] },
  { id: 2, shift: 9002, run: "9002", type: "DSAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 390, e: 900, b: [630, 660] },
  { id: 3, shift: 9003, run: "9003", type: "DSAM", daysOff: "SU-MO", splitType: "Straight", days: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], s: 420, e: 930, b: [660, 690] },
  { id: 4, shift: 9004, run: "9004", type: "DSPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 840, e: 1350, b: [1080, 1110] },
  { id: 5, shift: 9005, run: "9005", type: "DSPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 870, e: 1380, b: [1110, 1140] },
  { id: 6, shift: 9006, run: "9006", type: "DSPM", daysOff: "FR-SA", splitType: "Straight", days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], s: 810, e: 1320, b: [1050, 1080] },
  { id: 7, shift: 9007, run: "9007", type: "DSPTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 390, e: 630, b: null },
  { id: 8, shift: 9008, run: "9008", type: "DSPTAM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 450, e: 690, b: null },
  { id: 9, shift: 9009, run: "9009", type: "DSPTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 990, e: 1230, b: null },
  { id: 10, shift: 9010, run: "9010", type: "DSPTPM", daysOff: "SU-SA", splitType: "Straight", days: WD, s: 1050, e: 1290, b: null },
];

export const DISPATCH_SAMPLE = { operators, rules, ptRules, ptEnabled, ptCount, typeColors, glob: global, spans, board };
