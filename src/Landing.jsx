import React from "react";

const ink = "#182430", paper = "#F4F6F7", card = "#FFFFFF",
  demandAmber = "#D98324", supplyTeal = "#0F7B7A", bookoutViolet = "#6C5B9E", sampleGray = "#5B6B75";

const MODULES = [
  {
    key: "resourcing", path: "/resourcing", status: "live", accent: supplyTeal,
    title: "Operator & Vehicle Resourcing",
    tag: "Signups · shift bids · vehicle demand",
    body: "Design operator signups against real ridership demand. Score coverage, auto-build or retime the board, optimize continuously, and hand off a clean, rule-checked signup.",
  },
  {
    key: "callcentre", path: null, status: "roadmap", accent: bookoutViolet,
    title: "Call Centre Staffing",
    tag: "Booking & information lines",
    body: "Shape agent schedules against call-arrival curves and handle times, with the same coverage engine sized for service-level targets instead of vehicles.",
  },
  {
    key: "dispatch", path: null, status: "roadmap", accent: demandAmber,
    title: "Dispatch Desks",
    tag: "Concurrent workload",
    body: "Size and time dispatcher desks against concurrent-incident load through the day, so the control room is staffed to the shape of real demand.",
  },
];

export default function Landing({ navigate }) {
  return (
    <div style={{ minHeight: "100vh", background: paper, color: ink, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .modcard { transition: transform .12s ease, box-shadow .12s ease; }
        .modcard.live { cursor: pointer; }
        .modcard.live:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(24,36,48,.13); }
      `}</style>

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 20px" }}>
        {/* masthead */}
        <div style={{ borderBottom: `3px solid ${ink}`, padding: "40px 0 18px", marginBottom: 32 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12.5, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase", color: sampleGray }}>
            Transit Operations Toolkit
          </div>
          <div style={{ fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif", fontWeight: 700, fontSize: 46, lineHeight: 1.02, marginTop: 4, maxWidth: 780 }}>
            Shape your workforce to the shape of demand.
          </div>
          <div style={{ fontSize: 15.5, color: "#41525C", marginTop: 12, maxWidth: 680, lineHeight: 1.55 }}>
            A shared coverage engine that matches staffing to demand — one methodology, purpose-built modules for the different fronts of transit operations. Choose the tool you're here for.
          </div>
        </div>

        {/* module grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginBottom: 40 }}>
          {MODULES.map((m) => {
            const live = m.status === "live";
            return (
              <div key={m.key} className={"modcard" + (live ? " live" : "")}
                onClick={live ? () => navigate(m.path) : undefined}
                style={{
                  background: card, border: `1px solid ${live ? "#E2E8EA" : "#E8ECEE"}`,
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
                <div style={{ fontSize: 13.5, color: "#41525C", lineHeight: 1.5, marginTop: 8, flex: 1 }}>
                  {m.body}
                </div>
                <div style={{ marginTop: 16, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 15, color: live ? m.accent : sampleGray }}>
                  {live ? "Open tool ›" : "In development"}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid #E2E8EA", padding: "16px 0 40px", fontSize: 12, color: sampleGray, lineHeight: 1.55 }}>
          Currently in use as an internal operations tool for the City of Edmonton. Each module keeps its own data templates and uploads while sharing one coverage-scoring and optimization engine underneath.
        </div>
      </div>
    </div>
  );
}
