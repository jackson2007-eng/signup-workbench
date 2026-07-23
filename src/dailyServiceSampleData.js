// Sample data for the Daily Service Report module. Rather than hand-crafting fake day-by-day
// numbers, this reuses the real Annual Plan sample data (annualPlanSampleData.js) and Annual
// Plan's own exported engine functions (buildProjection/splitDay/avgTripsByDow/
// hoursByDowFromMarketShare) to generate a genuine day-by-day-by-provider budget — the same
// computation a live "Import budget" click runs against a real saved Annual Plan, just against
// the canned sample instead. Holidays are passed in empty ({}/[]) so this file stays synchronous
// and safely eager-importable, matching annualPlanSampleData.js's own documented doctrine of no
// date-holidays import at eager-load time; a live import always supplies real holidays.
import { ANNUALPLAN_SAMPLE } from "./annualPlanSampleData.js";
import { buildProjection, splitDay, avgTripsByDow, hoursByDowFromMarketShare, dowOfIso } from "./AnnualPlan.jsx";

function effectiveProviders(providers, avgDemandByDow) {
  return providers.map((p) => (
    p.role === "capacity" && p.hoursMode === "share"
      ? { ...p, hoursByDow: hoursByDowFromMarketShare(avgDemandByDow, p.marketSharePct, p.productivityWeekday, p.productivityWeekend) }
      : p
  ));
}

function buildSampleDays() {
  const { history, planYear, growthPct, providers, dayOverrides } = ANNUALPLAN_SAMPLE;
  const { projected } = buildProjection(history, planYear, growthPct, {}, [], dayOverrides || {});
  const avgDemandByDow = avgTripsByDow(projected);
  const effProviders = effectiveProviders(providers, avgDemandByDow);
  const days = {};
  for (const iso of Object.keys(projected)) {
    const dow = dowOfIso(iso);
    const trips = projected[iso];
    const { rows, unaccommodated } = splitDay(trips, dow, effProviders, false);
    const byProvider = {};
    for (const r of rows) byProvider[r.id] = { name: r.name, role: r.role, trips: r.trips, hours: r.hours, cost: r.cost };
    days[iso] = { dow, holidayName: null, trips, unaccommodated, byProvider };
  }
  return days;
}

export const DAILYSERVICE_SAMPLE = {
  source: { planId: null, planName: "Sample Annual Plan", planYear: ANNUALPLAN_SAMPLE.planYear, importedAt: null, sample: true },
  days: buildSampleDays(),
};
