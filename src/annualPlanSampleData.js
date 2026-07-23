// Sample data for the Annual Service Plan module. Synthetic (no real agency data): a full prior
// year of daily trip totals with the day-of-week seasonality real demand-response ridership shows
// (weekdays far busier than Saturday, Saturday busier than Sunday), plus a mild slow-season dip
// in summer — enough shape for the growth-projection and capacity-split math to have something
// realistic to chew on.
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

function buildHistoryYear(year) {
  const n = daysInYear(year);
  const out = {};
  for (let i = 0; i < n; i++) {
    const iso = isoForDayOfYear(year, i);
    const dow = new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
    const base = dow === 0 ? 1250 : dow === 6 ? 1500 : 3350; // Sun / Sat / weekday
    // mild summer dip (day ~180-240) and a small winter dip around the holidays
    const summer = 1 - 0.08 * Math.exp(-((i - 205) ** 2) / (2 * 40 * 40));
    const winter = 1 - 0.06 * Math.exp(-((i - 358) ** 2) / (2 * 12 * 12)) - 0.06 * Math.exp(-((i + 5) ** 2) / (2 * 12 * 12));
    const noise = 1 + (Math.sin(i * 12.9) * 0.5 + 0.5 - 0.5) * 0.04; // small deterministic wobble, no RNG
    out[iso] = Math.max(0, Math.round(base * summer * winter * noise));
  }
  return out;
}

const HISTORY_YEAR = 2025;
export const ANNUALPLAN_SAMPLE = {
  historyYear: HISTORY_YEAR,
  history: buildHistoryYear(HISTORY_YEAR),
  planYear: HISTORY_YEAR + 1,
  growthPct: 4,
  jurisdiction: { country: "CA", region: "AB" },
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
