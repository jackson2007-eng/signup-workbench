// Sample data for the Annual Service Plan module. Synthetic (no real agency data): five prior
// years of daily trip totals with the day-of-week seasonality real demand-response ridership shows
// (weekdays far busier than Saturday, Saturday busier than Sunday), a mild slow-season dip in
// summer, statutory holidays running well below even a normal Sunday (see statHolidayDates below —
// most demand-response trips are medical/work/school and simply don't happen on a stat holiday),
// and a small consistent year-over-year uplift so the multi-year predictive blend in
// AnnualPlan.jsx's HistoryTab has real trend signal to demonstrate out of the box.
function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function daysInYear(y) {
  return isLeap(y) ? 366 : 365;
}
// ISO date string for the nth day (0-indexed) of year y.
function isoForDayOfYear(y, n) {
  const d = new Date(Date.UTC(y, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Alberta/Canada's ~10 statutory holidays, computed with plain date math (no date-holidays import
// here — that package is deliberately lazy-loaded elsewhere in this module's suite so it doesn't
// bloat the main chunk; this file is imported eagerly). Verified to match date-holidays' own
// CA/AB output exactly for 2021-2026. Only calibrated for the sample data's own default
// jurisdiction (CA/AB, matching ANNUALPLAN_SAMPLE.jurisdiction below) — a real upload's holiday
// suppression comes from the agency's own actual reported numbers, never guessed at.
function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) return d.getUTCDate(); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
// The Monday strictly before the given month/day (e.g. Victoria Day = the Monday before May 25).
function mondayBefore(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  const back = ((d.getUTCDay() - 1 + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}
// Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — Easter Sunday for a given year.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}
function statHolidayDates(year) {
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const iso = (d) => d.toISOString().slice(0, 10);
  return new Set([
    iso(new Date(Date.UTC(year, 0, 1))),                                      // New Year's Day
    iso(new Date(Date.UTC(year, 1, nthWeekdayOfMonth(year, 1, 1, 3)))),        // Family Day
    iso(goodFriday),
    iso(mondayBefore(year, 4, 25)),                                           // Victoria Day
    iso(new Date(Date.UTC(year, 6, 1))),                                      // Canada Day
    iso(new Date(Date.UTC(year, 8, nthWeekdayOfMonth(year, 8, 1, 1)))),        // Labour Day
    iso(new Date(Date.UTC(year, 9, nthWeekdayOfMonth(year, 9, 1, 2)))),        // Thanksgiving
    iso(new Date(Date.UTC(year, 10, 11))),                                    // Remembrance Day
    iso(new Date(Date.UTC(year, 11, 25))),                                    // Christmas Day
    iso(new Date(Date.UTC(year, 11, 26))),                                    // Boxing Day
  ]);
}

// `scale` lets earlier years sit below the most recent year's pattern (see buildMultiYearHistory)
// without duplicating the day-of-week/seasonality shape per year.
function buildHistoryYear(year, scale = 1) {
  const n = daysInYear(year);
  const holidays = statHolidayDates(year);
  const out = {};
  for (let i = 0; i < n; i++) {
    const iso = isoForDayOfYear(year, i);
    const dow = new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
    // Stat holidays run well below even a normal Sunday — most trip purposes simply don't happen.
    const base = holidays.has(iso) ? 950 : dow === 0 ? 1250 : dow === 6 ? 1500 : 3350; // holiday / Sun / Sat / weekday
    // mild summer dip (day ~180-240) and a small winter dip around the holidays
    const summer = 1 - 0.08 * Math.exp(-((i - 205) ** 2) / (2 * 40 * 40));
    const winter = 1 - 0.06 * Math.exp(-((i - 358) ** 2) / (2 * 12 * 12)) - 0.06 * Math.exp(-((i + 5) ** 2) / (2 * 12 * 12));
    const noise = 1 + (Math.sin(i * 12.9) * 0.5 + 0.5 - 0.5) * 0.04; // small deterministic wobble, no RNG
    out[iso] = Math.max(0, Math.round(base * summer * winter * noise * scale));
  }
  return out;
}

const HISTORY_YEAR = 2025;
const HISTORY_YEARS_LOADED = 5; // matches MAX_HISTORY_YEARS in AnnualPlan.jsx
const ANNUAL_UPLIFT = 1.02; // ~2%/yr synthetic ridership growth between loaded years
// Five years (2021-2025), most recent unchanged from before this feature, earlier years scaled
// down by the uplift so the recency-weighted blend has a real trend to pick up on.
function buildMultiYearHistory() {
  let history = {};
  for (let i = 0; i < HISTORY_YEARS_LOADED; i++) {
    history = { ...history, ...buildHistoryYear(HISTORY_YEAR - i, ANNUAL_UPLIFT ** -i) };
  }
  return history;
}

export const ANNUALPLAN_SAMPLE = {
  historyYear: HISTORY_YEAR,
  history: buildMultiYearHistory(),
  planYear: HISTORY_YEAR + 1,
  growthPct: 4,
  jurisdiction: { country: "CA", region: "AB" },
  dayOverrides: {},
  providers: [
    {
      id: "inhouse", name: "In-house (direct-operated)", role: "capacity",
      hoursByDow: [420, 620, 620, 620, 620, 620, 460], // Sun..Sat, daily scheduled service hours
      productivityWeekday: 2.1, productivityWeekend: 1.95, hourlyRate: 60,
    },
    {
      id: "dedicated", name: "Dedicated contractor", role: "capacity",
      hoursByDow: [260, 520, 520, 520, 520, 520, 340],
      productivityWeekday: 2.2, productivityWeekend: 2.0, hourlyRate: 48,
    },
    {
      id: "nondedicated", name: "Non-dedicated (taxi / vehicle-for-hire)", role: "remainder",
      share: 100, perTripRate: 24,
    },
  ],
};
