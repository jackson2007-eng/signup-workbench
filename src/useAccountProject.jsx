import React, { useState, useEffect, useRef } from "react";

// Shared account-backed persistence, identical across all 5 modules (each has the same
// buildPayload/applyPayload shape already, from the pre-accounts Save/Load-to-file design —
// this hook just retargets the transport to the account API instead of a Blob download).
//
// Loads the signed-in user's saved payload for `kind` on mount (applying it via
// `applyPayload`, unchanged from each module's own former loadProject logic), then debounced-
// autosaves `payloadJson` (a JSON *string* — pass `JSON.stringify(buildPayload())`, computed
// fresh each render; comparing by string value rather than object identity is what lets the
// effect dependency actually detect "nothing changed" instead of firing every render).
//
// Autosave is gated behind the mount-time load having finished — without that guard, the
// module's initial default/sample state (rendered before the GET resolves) could race ahead
// and overwrite real saved data with defaults.
export function useAccountProject(kind, payloadJson, applyPayload) {
  const [status, setStatus] = useState("loading"); // 'loading' | 'idle' | 'saving' | 'saved' | 'error'
  const loadedRef = useRef(false);
  const applyRef = useRef(applyPayload);
  applyRef.current = applyPayload;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${kind}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && data.payload) applyRef.current(data.payload); })
      .catch(() => {})
      .finally(() => { if (!cancelled) { loadedRef.current = true; setStatus("idle"); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    if (!loadedRef.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      fetch(`/api/projects/${kind}`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: payloadJson,
      }).then((r) => setStatus(r.ok ? "saved" : "error")).catch(() => setStatus("error"));
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson]);

  return status;
}

const LABEL = { loading: "Loading your saved data…", idle: "", saving: "Saving…", saved: "Saved", error: "Save failed — check your connection" };
const COLOR = { loading: "var(--sample-gray)", idle: "var(--sample-gray)", saving: "var(--sample-gray)", saved: "var(--supply-teal)", error: "var(--gap-red, #C0392B)" };

export function SaveStatus({ status }) {
  const label = LABEL[status];
  if (!label) return null;
  return <span style={{ fontSize: 11, color: COLOR[status], fontWeight: 600 }}>{label}</span>;
}

// Small "Signed in as X · Log out" chip, same across all 5 modules.
export function AccountChip({ user, logout }) {
  if (!user) return null;
  return (
    <span style={{ fontSize: 11, color: "var(--sample-gray)" }}>
      {user.username}
      {" · "}
      <span style={{ cursor: "pointer", textDecoration: "underline" }} onClick={logout}>Log out</span>
    </span>
  );
}
