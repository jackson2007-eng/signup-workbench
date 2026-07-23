// Synthetic sample data for the Vacation Signup Planner. Modelled on the mechanism in a real
// DATS operator vacation sign-up sheet (seniority-ordered bidding: each operator has a vacation
// entitlement in whole weeks, and each calendar week of the vacation year has a maximum number
// of operators who can be off simultaneously) — but no real names, badge numbers, or actual
// entitlement/cap figures are used here. Labels are just "Operator N" in seniority order
// (most senior first), and every number is made up for demo purposes.

function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKS_ENTITLED_PATTERN = [6, 5, 4, 5, 6, 4, 5, 6, 5, 4, 3, 5, 6, 4, 5, 9, 5, 4, 6, 5];
function buildOperators(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: "op" + (i + 1), label: `Operator ${i + 1}`, weeksEntitled: WEEKS_ENTITLED_PATTERN[i % WEEKS_ENTITLED_PATTERN.length] });
  }
  return out;
}

const YEAR_START = "2026-04-05"; // a Sunday, matching the toolkit's Sunday-first week convention
const WEEK_COUNT = 52;
const HEADCOUNT = 60;
const BASE_PCT = 14; // baseline max % of the roster allowed off in any one week
const REDUCED_PCT = 5; // tighter % during summer prime time / holiday-adjacent weeks
const SUMMER_START = "2026-07-13";
const SUMMER_END = "2026-08-30";
// two illustrative "holiday-adjacent" weeks with a tighter cap, standing in for the real
// sheet's Christmas/New Year treatment without depending on a live holiday lookup here
const REDUCED_WEEK_INDEXES = new Set([12, 38]);

function buildCaps() {
  const caps = [];
  for (let i = 0; i < WEEK_COUNT; i++) {
    const start = addDaysISO(YEAR_START, i * 7);
    const end = addDaysISO(start, 6);
    const inSummer = start <= SUMMER_END && end >= SUMMER_START;
    const reduced = inSummer || REDUCED_WEEK_INDEXES.has(i);
    caps.push(Math.floor((HEADCOUNT * (reduced ? REDUCED_PCT : BASE_PCT)) / 100));
  }
  return caps;
}

export const VACATIONPLAN_SAMPLE = {
  operators: buildOperators(50),
  yearStart: YEAR_START,
  weekCount: WEEK_COUNT,
  caps: buildCaps(),
  suggestParams: { headcount: HEADCOUNT, basePct: BASE_PCT, reducedPct: REDUCED_PCT },
  summerStart: SUMMER_START,
  summerEnd: SUMMER_END,
  jurisdiction: { country: "CA", region: "AB" },
};
