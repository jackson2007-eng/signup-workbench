import React, { useState, useEffect, useRef } from "react";
import App from "./App.jsx";
import CallCentre from "./CallCentre.jsx";
import Dispatch from "./Dispatch.jsx";
import AnnualPlan from "./AnnualPlan.jsx";
import VacationPlan from "./VacationPlan.jsx";

const ink = "var(--chrome)", text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  demandAmber = "var(--demand-amber)", supplyTeal = "var(--supply-teal)", bookoutViolet = "var(--bookout-violet)",
  sampleGray = "var(--sample-gray)";

// Tool registry — single source of truth for the rail, the tab strip, the Home dashboard cards,
// and the path<->kind lookups main.jsx needs for auth-gating. Each tool component already takes
// {onHome, user, logout} (built for the old one-page-at-a-time router), so mounting them here
// under the shell needs zero changes to any of the five module files.
export const TOOLS = [
  { kind: "resourcing", path: "/resourcing", code: "RES", label: "Resourcing", tag: "Operator & vehicle signups", accent: supplyTeal, Comp: App },
  { kind: "callcentre", path: "/callcentre", code: "CC", label: "Call Centre", tag: "Booking & information lines", accent: bookoutViolet, Comp: CallCentre },
  { kind: "dispatch", path: "/dispatch", code: "DSP", label: "Dispatch", tag: "Concurrent workload", accent: demandAmber, Comp: Dispatch },
  { kind: "annualplan", path: "/annualplan", code: "ASP", label: "Annual Plan", tag: "Trip forecast & capacity split", accent: bookoutViolet, Comp: AnnualPlan },
  { kind: "vacation", path: "/vacation", code: "VAC", label: "Vacation", tag: "Seniority bidding & caps", accent: demandAmber, Comp: VacationPlan },
];
const KIND_TO_TOOL = Object.fromEntries(TOOLS.map((t) => [t.kind, t]));
const PATH_TO_KIND = Object.fromEntries(TOOLS.map((t) => [t.path, t.kind]));

// Simple two-primitive-per-shape line icons (stroke=currentColor, so railBtnStyle's active/
// inactive color just works) — kept deliberately plain to match the app's flat, HASTUS-inspired
// aesthetic rather than pulling in an icon library for an 8-item rail.
const svgProps = { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
const ICONS = {
  home: <svg {...svgProps}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9h5v-5.5h2V19h5v-9" /></svg>,
  resourcing: <svg {...svgProps}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.2" /><path d="M12 6.2v3.6M8.4 15.8l2.6-2.1M15.6 15.8l-2.6-2.1" /></svg>,
  callcentre: <svg {...svgProps}><path d="M4 13v-1a8 8 0 0 1 16 0v1" /><rect x="3" y="13" width="4" height="6" rx="1.4" /><rect x="17" y="13" width="4" height="6" rx="1.4" /><path d="M19 19v1a3 3 0 0 1-3 3h-2" /></svg>,
  dispatch: <svg {...svgProps}><circle cx="12" cy="12" r="1.8" /><path d="M8.7 8.7a5 5 0 0 0 0 6.6M15.3 8.7a5 5 0 0 1 0 6.6M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></svg>,
  annualplan: <svg {...svgProps}><rect x="4" y="5.5" width="16" height="15" rx="1.5" /><path d="M4 10h16M8 3.5v4M16 3.5v4" /><path d="M8.5 14.7l2 2 4.5-5" /></svg>,
  vacation: <svg {...svgProps}><circle cx="12" cy="12" r="4.2" /><path d="M12 3.5v2.2M12 18.3v2.2M4.6 12H6.8M17.2 12h2.2M6.5 6.5l1.5 1.5M16 16l1.5 1.5M17.5 6.5 16 8M8 16l-1.5 1.5" /></svg>,
  admin: <svg {...svgProps}><path d="M12 3.5 5 6v6c0 4.5 3 7.5 7 8.5 4-1 7-4 7-8.5V6l-7-2.5Z" /><path d="M9 12l2 2 4-4.5" /></svg>,
  logout: <svg {...svgProps}><path d="M10 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" /><path d="M16 15l4-3-4-3M20 12H9" /></svg>,
};

function railBtnStyle(active, accent) {
  return {
    width: 46, height: 42, display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", border: "none", background: active ? accent : "transparent",
    color: active ? "#fff" : "#8CA0AC", borderRadius: 3,
  };
}

function Rail({ activeKind, onOpen, user, isAdmin, navigate, logout }) {
  return (
    <div style={{ width: 64, flex: "none", background: "#101820", display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 9px", gap: 6, height: "100vh", overflowY: "auto" }}>
      <div onClick={() => onOpen("home")} title="Home" style={{ ...railBtnStyle(activeKind === "home", supplyTeal), marginBottom: 4 }}>
        {ICONS.home}
      </div>
      <div style={{ width: 32, borderTop: "1px solid #26323C", margin: "2px 0 8px" }} />
      {TOOLS.map((t) => (
        <div key={t.kind} onClick={() => onOpen(t.kind)} title={t.label} style={railBtnStyle(activeKind === t.kind, t.accent)}>
          {ICONS[t.kind]}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {isAdmin && (
        <div onClick={() => navigate("/admin")} title="Admin" style={railBtnStyle(false, bookoutViolet)}>{ICONS.admin}</div>
      )}
      <div style={{ width: 32, borderTop: "1px solid #26323C", margin: "8px 0 8px" }} />
      <div title={user?.username} style={{ fontSize: 9.5, color: "#7C8B96", textAlign: "center", lineHeight: 1.3, marginBottom: 6, wordBreak: "break-all", padding: "0 2px" }}>
        {user?.username}
      </div>
      <div onClick={logout} title="Log out" style={railBtnStyle(false, "#C0392B")}>{ICONS.logout}</div>
    </div>
  );
}

function TabStrip({ openKinds, activeKind, onSelect, onClose }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", background: card, borderBottom: "1px solid var(--border)", height: 38, flex: "none", overflowX: "auto" }}>
      {openKinds.map((kind) => {
        const label = kind === "home" ? "Home" : KIND_TO_TOOL[kind].label;
        const active = kind === activeKind;
        return (
          <div key={kind} onClick={() => onSelect(kind)}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "0 14px", cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13.5, fontWeight: 600,
              color: active ? text : sampleGray, background: active ? paper : "transparent",
              borderRight: "1px solid var(--border)", borderBottom: active ? `2px solid ${ink}` : "2px solid transparent",
              whiteSpace: "nowrap",
            }}>
            {label}
            {kind !== "home" && (
              <span onClick={(e) => { e.stopPropagation(); onClose(kind); }}
                style={{ fontSize: 13, color: sampleGray, padding: "0 2px", lineHeight: 1 }}>×</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HomeDashboard({ onOpen, user }) {
  return (
    <div style={{ padding: "28px 26px", maxWidth: 980 }}>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: sampleGray }}>
        Paratransit Companion
      </div>
      <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 30, marginTop: 4, marginBottom: 4 }}>
        Welcome back{user?.username ? `, ${user.username}` : ""}.
      </div>
      <div style={{ fontSize: 14, color: "var(--text-mid)", marginBottom: 26, maxWidth: 620, lineHeight: 1.5 }}>
        Pick a tool to open it. Everything you open stays open in its own tab, so you can switch
        between tools without losing your place in any of them.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {TOOLS.map((t) => (
          <div key={t.kind} onClick={() => onOpen(t.kind)}
            style={{ cursor: "pointer", background: card, border: "1px solid var(--border)", borderTop: `4px solid ${t.accent}`, padding: "16px 18px" }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: sampleGray }}>
              {t.tag}
            </div>
            <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 21, marginTop: 6 }}>
              {t.label}
            </div>
            <div style={{ marginTop: 10, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 13.5, color: t.accent }}>
              Open ›
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Shell({ path, navigate, user, logout }) {
  const initialKind = path === "/" ? "home" : PATH_TO_KIND[path] || "home";
  const [activeKind, setActiveKind] = useState(initialKind);
  const [openKinds, setOpenKinds] = useState(initialKind === "home" ? ["home"] : ["home", initialKind]);

  // Keeps the tab set in sync with the URL for cases the rail/tab clicks don't drive directly —
  // browser back/forward (popstate) and any other caller of navigate() (e.g. a deep link).
  useEffect(() => {
    const kind = path === "/" ? "home" : PATH_TO_KIND[path];
    if (!kind) return;
    setActiveKind(kind);
    setOpenKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
  }, [path]);

  const paneRef = useRef(null);
  const openTool = (kind) => {
    setActiveKind(kind);
    setOpenKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
    navigate(kind === "home" ? "/" : KIND_TO_TOOL[kind].path);
    if (paneRef.current) paneRef.current.scrollTop = 0;
  };

  const closeTab = (kind) => {
    if (kind === "home") return;
    const next = openKinds.filter((k) => k !== kind);
    setOpenKinds(next);
    if (activeKind === kind) {
      const fallback = next[next.length - 1] || "home";
      setActiveKind(fallback);
      navigate(fallback === "home" ? "/" : KIND_TO_TOOL[fallback].path);
    }
  };

  return (
    // Fixed-height shell (not minHeight) with overflow hidden on the row: the rail and tab
    // strip stay pinned regardless of how tall a mounted tool's own content is, and only the
    // pane below scrolls. Every tool component still renders its own internal position:sticky
    // chrome (KPI strips, phase banners) — those keep working since sticky just needs *a*
    // scrolling ancestor, and the pane is now that ancestor instead of the window.
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root, [data-theme="light"] {
          --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
          --demand-amber: #D98324; --target-ink: #233746; --supply-teal: #0F7B7A;
          --gap-red: #C0392B; --bookout-violet: #6C5B9E; --sample-gray: #5B6B75;
          --border: #E2E8EA; --border-light: #D7DFE2; --border-input: #B9C6CC;
          --muted: #5B6B75; --muted-light: #8899A3; --text-mid: #41525C; --text-dark: #33434D;
          --row-border: #E7EDEF; --track-bg: #EFF3F4;
          --tint-neutral: #FBFCFC; --tint-neutral-b: #EEF4F5;
          --tint-teal-a: #EAF4F3; --tint-teal-b: #F7FAF9; --tint-teal-c: #F2F8F7; --tint-teal-d: #EAF3F3;
          --tint-amber-a: #FBF1E6; --tint-amber-b: #FDF3E7; --tint-amber-c: #FDF8EF;
          --tint-red-a: #FBEDEB; --tint-red-b: #FDF6F5;
          --tint-blue-bg: #EAF1FB; --border-blue: #BBD3EC; --text-blue: #185FA5;
          --border-teal-b: #DCE7E4; --row-border-b: #EDF1F3;
        }
      `}</style>
      <Rail activeKind={activeKind} onOpen={openTool} user={user} isAdmin={!!user?.isAdmin} navigate={navigate} logout={logout} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100vh" }}>
        <TabStrip openKinds={openKinds} activeKind={activeKind} onSelect={openTool} onClose={closeTab} />
        <div ref={paneRef} style={{ flex: 1, position: "relative", background: paper, overflowY: "auto" }}>
          <div style={{ display: activeKind === "home" ? "block" : "none" }}>
            <HomeDashboard onOpen={openTool} user={user} />
          </div>
          {TOOLS.filter((t) => openKinds.includes(t.kind)).map((t) => {
            const Comp = t.Comp;
            return (
              <div key={t.kind} style={{ display: activeKind === t.kind ? "block" : "none" }}>
                <Comp onHome={() => openTool("home")} user={user} logout={logout} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
