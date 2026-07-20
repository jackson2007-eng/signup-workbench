import React, { useState, useEffect } from "react";

/* ---------- Free / Premium / Enterprise tier scaffolding ----------
   Dark-launched: ENFORCEMENT_ENABLED stays false until pricing/checkout ships. While false,
   hasFeature() always returns true, so every gate wired up against this module is currently a
   no-op — every module behaves exactly as it does today. Flipping this one constant is the
   entire "go live" step; no other code changes should be needed at that point.

   Tier plan (see ROADMAP.md "Commercialization"): Free = full manual tools, indefinitely
   (Rules, sketch-only Demand, manual Shift Builder, full Coverage scoring — none of that is
   gated at all, by design). Premium adds real-data upload, auto-generate, the optimizer
   suite, Packaging, and — the actual trigger — Save/Load project and Export. Enterprise adds
   accounts (parked, phase 2) on top of Premium. */

export const ENFORCEMENT_ENABLED = false;

export const TIERS = { FREE: "free", PREMIUM: "premium", ENTERPRISE: "enterprise" };

// One key per gated action, matched 1:1 to ROADMAP.md's Commercialization tier table.
export const FEATURES = {
  PROJECT_FILES: "projectFiles", // Save/Load project
  EXPORT: "export",              // Export board / schedule
  UPLOAD_DATA: "uploadData",     // real demand/signup/operator data upload
  AUTO_BUILD: "autoBuild",       // Signup Builder / Build tab generate
  OPTIMIZER: "optimizer",        // Suggestions, Deep Optimize, Retime, Optimization monitor
  PACKAGING: "packaging",        // Packaging tab auto-package
};

const FEATURE_LABELS = {
  [FEATURES.PROJECT_FILES]: "saving and loading projects",
  [FEATURES.EXPORT]: "exporting a completed schedule",
  [FEATURES.UPLOAD_DATA]: "uploading your own data",
  [FEATURES.AUTO_BUILD]: "auto-generating a schedule",
  [FEATURES.OPTIMIZER]: "the optimizer suite",
  [FEATURES.PACKAGING]: "the packaging tools",
};

// Free tier has none of the gated features — they simply aren't in the Premium set's absence.
const PREMIUM_FEATURES = new Set(Object.values(FEATURES));

export function hasFeature(tier, feature) {
  if (!ENFORCEMENT_ENABLED) return true;
  return tier === TIERS.PREMIUM || tier === TIERS.ENTERPRISE ? PREMIUM_FEATURES.has(feature) : false;
}

// Same pattern as the existing `theme` hook (App.jsx/CallCentre.jsx/Dispatch.jsx/Landing.jsx):
// per-component useState + useEffect against a shared localStorage key, no context provider —
// this app has no global React context anywhere, so tier state follows that convention too.
export function useTier() {
  const [tier, setTier] = useState(() => localStorage.getItem("tier") || TIERS.FREE);
  useEffect(() => { localStorage.setItem("tier", tier); }, [tier]);
  return [tier, setTier];
}

// Generic "this is a Premium feature" dialog. Never renders while ENFORCEMENT_ENABLED is
// false (every hasFeature() check passes, so nothing ever sets a truthy `feature`), but built
// now so flipping enforcement later needs no further UI work.
export function UpgradeModal({ feature, onClose }) {
  if (!feature) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000 }}>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,16,22,0.68)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 360,
        background: "var(--card)", border: "1px solid var(--border)", borderRadius: 4,
        boxShadow: "0 14px 36px rgba(0,0,0,0.32)", padding: "18px 20px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, color: "var(--text)" }}>
            Premium feature
          </div>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 18, color: "var(--muted-light)", cursor: "pointer", lineHeight: 1, padding: 2 }}>
            ×
          </button>
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-dark)", marginBottom: 16 }}>
          {FEATURE_LABELS[feature] || "This feature"} is part of a paid plan. Upgrade to unlock it for your account.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "6px 12px", border: "1px solid var(--border-input)", background: "var(--card)", color: "var(--text)", cursor: "pointer", borderRadius: 2 }}>
            Not now
          </button>
          <button onClick={onClose} style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 600, padding: "6px 12px", border: "1px solid var(--supply-teal)", background: "var(--supply-teal)", color: "#fff", cursor: "pointer", borderRadius: 2 }}>
            See plans
          </button>
        </div>
      </div>
    </div>
  );
}
