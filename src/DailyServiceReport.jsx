import React, { useState, useMemo, useEffect } from "react";
import { Stat } from "./App.jsx";
import { PhaseStrip } from "./CallCentre.jsx";
import {
  buildProjection, splitDay, avgTripsByDow, hoursByDowFromMarketShare,
  yearsPresent, dowOfIso, monthOfIso, MONTHS, DOW_SHORT,
} from "./AnnualPlan.jsx";
import { DAILYSERVICE_SAMPLE } from "./dailyServiceSampleData.js";
import { useAccountProject, useSignupList, SaveStatus, AccountChip, SignupSwitcher } from "./useAccountProject.jsx";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

/* Daily Service Report — v1: a day-by-day, per-provider BUDGET calendar, imported from a saved
   Annual Plan signup. Reviewed against a real 2026 DATS Daily Service Report export, which is a
   before (budgeted) / after (actual) tracker per service day; v1 here is deliberately the
   budgeted half only — actuals entry is the natural v2 once this baseline exists, same
   "total-trips-first" sequencing this project has used throughout. Import is a snapshot, not a
   live link: Annual Plan is itself a working document that changes over the year, so this module
   holds a deliberate, re-importable copy rather than always-current coupling. */

const text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", gapRed = "var(--gap-red)", sampleGray = "var(--sample-gray)";

const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "5px 10px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const primaryBtn = { ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal };
const cardStyle = { background: card, border: "1px solid var(--border)", padding: "14px 16px", marginBottom: 14 };
const hTitle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 10 };
const thStyle = { textAlign: "left", padding: "5px 8px", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 11.5, color: sampleGray, whiteSpace: "nowrap" };
const tdStyle = { padding: "3px 8px", whiteSpace: "nowrap" };

const clone = (o) => JSON.parse(JSON.stringify(o));

function effectiveProviders(providers, avgDemandByDow) {
  return providers.map((p) => (
    p.role === "capacity" && p.hoursMode === "share"
      ? { ...p, hoursByDow: hoursByDowFromMarketShare(avgDemandByDow, p.marketSharePct, p.productivityWeekday, p.productivityWeekend) }
      : p
  ));
}

// Recomputes a full day-by-day-by-provider budget from a saved Annual Plan payload — the exact
// same computation Annual Plan's own Split/Budget tabs run (buildProjection -> splitDay per day),
// just materialized per day instead of rolled into months. holidaysHistoryByYear/holidaysPlan
// must already be resolved real lookups — the caller (importBudget below) awaits the
// date-holidays import inline before calling this, so there's no lazy-load staleness window.
function computeDays(planPayload, holidaysHistoryByYear, holidaysPlan) {
  const { history, planYear, growthPct, providers, dayOverrides } = planPayload;
  const { projected } = buildProjection(history, planYear, growthPct, holidaysHistoryByYear, holidaysPlan, dayOverrides || {});
  const avgDemandByDow = avgTripsByDow(projected);
  const effProviders = effectiveProviders(providers, avgDemandByDow);
  const holidaySet = new Set((holidaysPlan || []).map((h) => h.date));
  const holidayNameByDate = new Map((holidaysPlan || []).map((h) => [h.date, h.name]));
  const days = {};
  for (const iso of Object.keys(projected)) {
    const dow = dowOfIso(iso);
    const trips = projected[iso];
    const { rows, unaccommodated } = splitDay(trips, dow, effProviders, holidaySet.has(iso));
    const byProvider = {};
    for (const r of rows) byProvider[r.id] = { name: r.name, role: r.role, trips: r.trips, hours: r.hours, cost: r.cost };
    days[iso] = { dow, holidayName: holidayNameByDate.get(iso) || null, trips, unaccommodated, byProvider };
  }
  return days;
}

export default function DailyServiceReport({ onHome, user, logout }) {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { localStorage.setItem("theme", theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  const [tab, setTab] = useState("setup");
  const [source, setSource] = useState(() => clone(DAILYSERVICE_SAMPLE.source));
  const [days, setDays] = useState(() => clone(DAILYSERVICE_SAMPLE.days));
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);

  const { items: annualPlanSignups } = useSignupList("annualplan");
  const [selectedPlanId, setSelectedPlanId] = useState("");

  const importBudget = async () => {
    if (!selectedPlanId) return;
    if (source && source.planId && !source.sample) {
      const ok = window.confirm(`This will replace the currently imported budget (from "${source.planName}") with a fresh import. Continue?`);
      if (!ok) return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch(`/api/projects/annualplan/${selectedPlanId}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data.payload) throw new Error("Could not load that Annual Plan signup.");
      const p = data.payload;
      // Awaited inline in this one-shot click handler, not a background lazy-load gated by tab
      // visibility — that gating was exactly the bug behind the market-share feature's holiday
      // discrepancy (numbers computed before the import resolved). A user-triggered import can
      // just wait for it.
      const HD = (await import("date-holidays")).default;
      const jurisdiction = p.jurisdiction || { country: "CA", region: "" };
      const holidaysFor = (year) => {
        const hd = new HD(jurisdiction.country, jurisdiction.region || undefined);
        return hd.getHolidays(year).filter((h) => h.type === "public").map((h) => ({ date: h.date.slice(0, 10), name: h.name }));
      };
      const historyYears = yearsPresent(p.history || {});
      const holidaysHistoryByYear = {};
      for (const y of historyYears) holidaysHistoryByYear[y] = holidaysFor(y);
      const holidaysPlan = holidaysFor(p.planYear);
      const newDays = computeDays(p, holidaysHistoryByYear, holidaysPlan);
      const plan = (annualPlanSignups || []).find((s) => s.id === Number(selectedPlanId));
      setDays(newDays);
      setSource({
        planId: Number(selectedPlanId), planName: plan ? plan.name : `Plan #${selectedPlanId}`,
        planYear: p.planYear, importedAt: new Date().toISOString(), sample: false,
      });
    } catch (e) {
      setImportError(e.message || "Could not import that plan.");
    } finally {
      setImporting(false);
    }
  };

  const annualTrips = useMemo(() => Object.values(days).reduce((s, d) => s + d.trips, 0), [days]);
  // Provider column order follows splitDay's own list order (capacity providers first, in list
  // order, then remainder providers) — reliable here because a single imported snapshot uses the
  // same provider list on every day, and object key insertion order is preserved for the
  // non-numeric ids this app uses.
  const providerIds = useMemo(() => {
    const firstIso = Object.keys(days)[0];
    return firstIso ? Object.keys(days[firstIso].byProvider || {}) : [];
  }, [days]);
  const providerMeta = useMemo(() => {
    const meta = {};
    for (const d of Object.values(days)) for (const [id, p] of Object.entries(d.byProvider || {})) meta[id] = { name: p.name, role: p.role };
    return meta;
  }, [days]);

  const buildPayload = () => ({ kind: "dailyservice", source, days });
  const applyPayload = (p) => {
        if (p.source !== undefined) setSource(p.source);
        if (p.days) setDays(p.days);
  };
  const payloadJson = useMemo(() => JSON.stringify(buildPayload()), [source, days]);
  const { items: signups, create: createSignup, rename: renameSignup, remove: removeSignup } = useSignupList("dailyservice");
  const [projectId, setProjectId] = useState(null);
  useEffect(() => {
    if (!signups || projectId) return;
    if (signups.length) setProjectId(signups[0].id);
    else createSignup({ name: "My Daily Service Report" }).then(setProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signups]);
  const saveStatus = useAccountProject("dailyservice", projectId, payloadJson, applyPayload);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --supply-teal: #0F7B7A; --gap-red: #C0392B; --bookout-violet: #6C5B9E;
          --sample-gray: #5B6B75; --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #CBD5DA;
          --tint-neutral-b: #EEF4F5; --tint-teal-b: #EEF6F6; --tint-red: #FBEDEB; --tint-amber-b: #FBF3E9;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --supply-teal: #2FB3AC; --gap-red: #E27A70; --bookout-violet: #A594D1;
          --sample-gray: #8B9AA5; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D;
          --tint-neutral-b: #1C262B; --tint-teal-b: #172227; --tint-red: #2E1714; --tint-amber-b: #2A2115;
        }
        body { background: var(--paper); }
        .dsrnav { cursor:pointer; padding:9px 16px; font-family:'Barlow Condensed',sans-serif; font-weight:600; font-size:15px; letter-spacing:.03em; border-bottom:3px solid transparent; color:var(--sample-gray); }
        .dsrnav.on { color:${text}; border-bottom-color:${supplyTeal}; }
        select { background: var(--card); color: var(--text); border:1px solid var(--border-input); }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onHome} style={{ ...nudgeBtn, fontSize: 12 }}>‹ Transit Operations Toolkit</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700 }}>DAILY SERVICE REPORT</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: sampleGray }}>{source.planYear} budgeted trips <b style={{ color: text, fontSize: 15 }}>{annualTrips.toLocaleString()}</b></div>
            <SignupSwitcher label="Report" projectId={projectId} items={signups} onSwitch={setProjectId}
              onCreate={async (vals) => setProjectId(await createSignup(vals))}
              onRename={renameSignup}
              onDelete={(id) => { removeSignup(id); if (id === projectId) setProjectId(null); }} />
            <SaveStatus status={saveStatus} />
            <AccountChip user={user} logout={logout} />
            {DARK_MODE_ENABLED && (
              <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle light/dark mode"
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", padding: "5px 8px", background: "none", border: "1px solid var(--border-input)", borderRadius: 2, color: sampleGray, cursor: "pointer" }}>
                {theme === "dark" ? "☀ Light" : "☾ Dark"}
              </button>
            )}
          </div>
        </div>

        <PhaseStrip tab={tab} setTab={setTab} navClass="dsrnav" groups={[
          { phase: "PHASE 1 · SETUP", tabs: [{ key: "setup", label: "SETUP" }] },
          { phase: "PHASE 2 · REVIEW", tabs: [{ key: "calendar", label: "DAILY CALENDAR" }] },
        ]} />

        {tab === "setup" && (
          <SetupTab {...{
            source, annualPlanSignups, selectedPlanId, setSelectedPlanId, importBudget,
            importing, importError, providerIds, providerMeta,
          }} />
        )}
        {tab === "calendar" && (
          <CalendarTab {...{ source, days, providerIds, providerMeta }} />
        )}
      </div>
    </div>
  );
}

/* ================= SETUP ================= */
function SetupTab({ source, annualPlanSignups, selectedPlanId, setSelectedPlanId, importBudget, importing, importError, providerIds, providerMeta }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>Import from Annual Plan</div>
        <div style={{ fontSize: 12.5, color: sampleGray, marginBottom: 12 }}>
          Pick one of your saved Annual Plan signups and import its budget — a snapshot, not a
          live link, so it only updates when you import again. Re-importing replaces the whole
          calendar with a fresh copy of that plan's current numbers.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 2, fontSize: 13 }}>
            <option value="">Choose an Annual Plan signup…</option>
            {annualPlanSignups === null && <option disabled>Loading your signups…</option>}
            {annualPlanSignups && annualPlanSignups.length === 0 && <option disabled>No saved Annual Plan signups yet</option>}
            {annualPlanSignups && annualPlanSignups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button style={primaryBtn} disabled={!selectedPlanId || importing} onClick={importBudget}>
            {importing ? "Importing…" : "Import budget"}
          </button>
        </div>
        {importError && (
          <div style={{ fontSize: 12, color: gapRed, background: "var(--tint-red, #F6E4E1)", border: "1px solid var(--border-light)", padding: "6px 10px", marginTop: 10 }}>
            {importError}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={hTitle}>Currently imported</div>
        {source.sample && (
          <div style={{ fontSize: 12, color: sampleGray, background: "var(--tint-neutral-b)", border: "1px solid var(--border-light)", padding: "6px 10px", marginBottom: 12 }}>
            Showing sample data — import a real Annual Plan signup above to replace it.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <Stat label="Source plan" value={source.planName || "—"} />
          <Stat label="Plan year" value={source.planYear || "—"} />
          <Stat label="Imported" value={source.sample ? "Sample data" : (source.importedAt ? new Date(source.importedAt).toLocaleString() : "—")} />
        </div>
        {providerIds.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {providerIds.map((id) => (
              <span key={id} style={{ fontSize: 11.5, padding: "3px 9px", background: "var(--tint-teal-b)", border: "1px solid var(--border-light)", color: supplyTeal, fontWeight: 600 }}>
                {providerMeta[id]?.name || id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= DAILY CALENDAR ================= */
function CalendarTab({ source, days, providerIds, providerMeta }) {
  const dayRows = useMemo(() => Object.keys(days).sort().map((iso) => ({ iso, month: monthOfIso(iso), ...days[iso] })), [days]);
  return (
    <div>
      <div style={cardStyle}>
        <div style={hTitle}>{source.planYear} day-by-day budget</div>
        <div style={{ fontSize: 11.5, color: sampleGray, marginBottom: 10, lineHeight: 1.5 }}>
          Every day of the imported plan, split across providers exactly as Annual Plan's own
          Split/Budget tabs compute it — capacity providers take trips up to scheduled hours ×
          productivity in list order, remainder providers absorb what's left. Unaccommodated
          demand is flagged, never hidden.
        </div>
        <div style={{ overflowX: "auto", maxHeight: 620, overflowY: "auto", border: "1px solid var(--border-light)" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--border)", background: card, position: "sticky", top: 0, zIndex: 1 }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Day</th>
                <th style={thStyle}>Holiday</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Total trips</th>
                <th style={{ ...thStyle, textAlign: "right", color: gapRed }}>Unaccommodated</th>
                {providerIds.map((id) => (
                  <React.Fragment key={id}>
                    <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} trips</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} hrs</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>{providerMeta[id]?.name} cost</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((label, mi) => (
                <React.Fragment key={label}>
                  <tr>
                    <td colSpan={5 + providerIds.length * 3} style={{ background: "var(--tint-neutral-b)", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 12.5, padding: "5px 8px", position: "sticky", top: 27, zIndex: 1 }}>
                      {label} {source.planYear}
                    </td>
                  </tr>
                  {dayRows.filter((r) => r.month === mi).map((r) => (
                    <tr key={r.iso} style={{ borderBottom: "1px solid var(--border-light)" }}>
                      <td style={tdStyle}>{r.iso}</td>
                      <td style={tdStyle}>{DOW_SHORT[r.dow]}</td>
                      <td style={{ ...tdStyle, color: r.holidayName ? gapRed : sampleGray }}>{r.holidayName || ""}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{Math.round(r.trips).toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: r.unaccommodated > 0 ? gapRed : sampleGray }}>{r.unaccommodated > 0 ? Math.round(r.unaccommodated).toLocaleString() : "—"}</td>
                      {providerIds.map((id) => {
                        const p = r.byProvider[id];
                        return (
                          <React.Fragment key={id}>
                            <td style={{ ...tdStyle, textAlign: "right" }}>{p ? Math.round(p.trips).toLocaleString() : "—"}</td>
                            <td style={{ ...tdStyle, textAlign: "right", color: sampleGray }}>{p && p.hours != null ? Math.round(p.hours).toLocaleString() : "—"}</td>
                            <td style={{ ...tdStyle, textAlign: "right", color: sampleGray }}>{p ? `$${Math.round(p.cost).toLocaleString()}` : "—"}</td>
                          </React.Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
