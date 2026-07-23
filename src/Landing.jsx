import React, { useEffect, useState } from "react";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

const ink = "var(--chrome)", text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  demandAmber = "var(--demand-amber)", supplyTeal = "var(--supply-teal)", bookoutViolet = "var(--bookout-violet)",
  sampleGray = "var(--sample-gray)";

const MODULES = [
  {
    key: "resourcing", path: "/resourcing", status: "live", accent: supplyTeal,
    title: "Operator & Vehicle Resourcing",
    tag: "Signups · shift bids · vehicle demand",
    body: "Design operator signups against real ridership demand. Score coverage, auto-build or retime the board, optimize continuously, and hand off a clean, rule-checked signup.",
  },
  {
    key: "callcentre", path: "/callcentre", status: "live", accent: bookoutViolet,
    title: "Call Centre Staffing",
    tag: "Booking & information lines",
    body: "Shape agent schedules against active-call curves with the same coverage engine, sized against calls in queue and in service instead of vehicles.",
  },
  {
    key: "dispatch", path: "/dispatch", status: "live", accent: demandAmber,
    title: "Dispatch Desks",
    tag: "Concurrent workload",
    body: "Size and time dispatcher desks against concurrent-incident load through the day, so the control room is staffed to the shape of real demand.",
  },
  {
    key: "annualplan", path: "/annualplan", status: "live", accent: bookoutViolet,
    title: "Annual Service Plan",
    tag: "Trip forecast · provider capacity split",
    body: "Project next year's daily trips from prior-year history and a growth rate, then split projected demand across in-house, dedicated-contractor, and non-dedicated providers by scheduled hours and productivity.",
  },
  {
    key: "vacation", path: "/vacation", status: "live", accent: demandAmber,
    title: "Vacation Signup Planner",
    tag: "Seniority bidding · weekly caps",
    body: "Plan a seniority-ordered vacation sign-up: roster each operator's entitlement in weeks, set a maximum-off cap per week of the year, and auto-balance who gets which weeks against those caps.",
  },
];

export default function Landing({ navigate, authState }) {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --supply-teal: #0F7B7A; --bookout-violet: #6C5B9E; --sample-gray: #5B6B75;
          --border: #E2E8EA; --border-light: #E8ECEE; --text-mid: #41525C;
        }
        [data-theme="dark"] {
          --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
          --demand-amber: #E8A552; --supply-teal: #2FB3AC; --bookout-violet: #A594D1; --sample-gray: #8B9AA5;
          --border: #2A343C; --border-light: #333F47; --text-mid: #A9B6BF;
        }
        body { background: var(--paper); }
        .modcard { transition: transform .12s ease, box-shadow .12s ease; }
        .modcard.live { cursor: pointer; }
        .modcard.live:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,.25); }
      `}</style>

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 20px" }}>
        {/* masthead */}
        <div style={{ borderBottom: `3px solid ${ink}`, padding: "40px 0 18px", marginBottom: 32, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12.5, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase", color: sampleGray }}>
              Paratransit Companion
            </div>
            <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 46, lineHeight: 1.02, marginTop: 4, maxWidth: 780 }}>
              Shape your workforce to the shape of demand.
            </div>
            <div style={{ fontSize: 15.5, color: "var(--text-mid)", marginTop: 12, maxWidth: 680, lineHeight: 1.55 }}>
              Planning tools for paratransit agencies — resourcing, budget, and day-to-day operations, all built on one shared coverage engine. Sign in to your agency's workspace, or request access to get started.
            </div>
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8 }}>
            {DARK_MODE_ENABLED && (
              <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle light/dark mode"
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", padding: "6px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 2, color: sampleGray, cursor: "pointer" }}>
                {theme === "dark" ? "☀ Light" : "☾ Dark"}
              </button>
            )}
            {authState === "authed" ? (
              <button onClick={() => navigate("/")}
                style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "7px 14px", background: supplyTeal, border: `1px solid ${supplyTeal}`, borderRadius: 2, color: "#fff", cursor: "pointer" }}>
                Open your tools
              </button>
            ) : (
              <>
                <button onClick={() => navigate("/signin")}
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "7px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 2, color: text, cursor: "pointer" }}>
                  Sign in
                </button>
                <button onClick={() => navigate("/request-access")}
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "7px 14px", background: supplyTeal, border: `1px solid ${supplyTeal}`, borderRadius: 2, color: "#fff", cursor: "pointer" }}>
                  Request access
                </button>
              </>
            )}
          </div>
        </div>

        {/* module grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginBottom: 40 }}>
          {MODULES.map((m) => {
            const live = m.status === "live";
            return (
              <div key={m.key} className={"modcard" + (live ? " live" : "")}
                onClick={live ? () => navigate(authState === "authed" ? m.path : `/signin?next=${encodeURIComponent(m.path)}`) : undefined}
                style={{
                  background: card, border: `1px solid ${live ? "var(--border)" : "var(--border-light)"}`,
                  borderTop: `4px solid ${m.accent}`, padding: "18px 20px 20px",
                  opacity: live ? 1 : 0.72, display: "flex", flexDirection: "column",
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: sampleGray }}>
                    {m.tag}
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".07em", padding: "2px 7px", borderRadius: 2, color: "#fff", background: live ? supplyTeal : sampleGray }}>
                    {live ? "AVAILABLE" : "ROADMAP"}
                  </span>
                </div>
                <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 25, lineHeight: 1.08, marginTop: 8 }}>
                  {m.title}
                </div>
                <div style={{ fontSize: 13.5, color: "var(--text-mid)", lineHeight: 1.5, marginTop: 8, flex: 1 }}>
                  {m.body}
                </div>
                <div style={{ marginTop: 16, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 15, color: live ? m.accent : sampleGray }}>
                  {live ? (authState === "authed" ? "Open tool ›" : "Sign in to open ›") : "In development"}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: "16px 0 40px", fontSize: 12, color: sampleGray, lineHeight: 1.55 }}>
          Each module keeps its own data templates and uploads while sharing one coverage-scoring and optimization engine underneath. Built for paratransit and microtransit agencies —{" "}
          {authState !== "authed" && (
            <span style={{ color: supplyTeal, cursor: "pointer", fontWeight: 600 }} onClick={() => navigate("/request-access")}>request access</span>
          )}
          {authState !== "authed" && " "}if your agency would like to start using these tools.
        </div>
      </div>
    </div>
  );
}
