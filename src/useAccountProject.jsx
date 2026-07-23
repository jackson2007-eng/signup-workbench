import React, { useState, useEffect, useRef } from "react";

// Shared account-backed persistence, identical across all 5 modules (each has the same
// buildPayload/applyPayload shape already, from the pre-accounts Save/Load-to-file design —
// this hook just retargets the transport to the account API instead of a Blob download).
//
// A module can hold many named, datable signups (see useSignupList below) — this hook persists
// exactly one of them, identified by `projectId`. Loads that signup's payload whenever
// `projectId` changes (applying it via `applyPayload`, unchanged from each module's own former
// loadProject logic), then debounced-autosaves `payloadJson` (a JSON *string* — pass
// `JSON.stringify(buildPayload())`, computed fresh each render; comparing by string value
// rather than object identity is what lets the effect dependency actually detect "nothing
// changed" instead of firing every render).
//
// Autosave is gated behind the current projectId's load having finished — without that guard,
// a module's in-memory state from the *previous* signup (still rendered while the new one's GET
// is in flight) could race ahead and get saved into the newly-selected signup.
export function useAccountProject(kind, projectId, payloadJson, applyPayload) {
  const [status, setStatus] = useState("idle"); // 'idle' | 'loading' | 'saving' | 'saved' | 'error'
  const loadedRef = useRef(false);
  const applyRef = useRef(applyPayload);
  applyRef.current = applyPayload;

  // Captured once, on this hook's very first run (before any signup has loaded/applied
  // anything), from whatever payloadJson looks like at that moment — i.e. the module's pure
  // useState-initializer defaults (sample data, default rules, etc.). Used to reset the module
  // when switching to a signup with no saved payload yet, so a brand-new signup doesn't keep
  // showing whatever the previously-open signup left behind.
  const defaultPayloadRef = useRef(null);
  if (defaultPayloadRef.current === null) defaultPayloadRef.current = JSON.parse(payloadJson);

  useEffect(() => {
    loadedRef.current = false;
    if (!projectId) return;
    setStatus("loading");
    let cancelled = false;
    fetch(`/api/projects/${kind}/${projectId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) applyRef.current(data.payload || defaultPayloadRef.current); })
      .catch(() => {})
      .finally(() => { if (!cancelled) { loadedRef.current = true; setStatus("idle"); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, projectId]);

  useEffect(() => {
    if (!projectId || !loadedRef.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      fetch(`/api/projects/${kind}/${projectId}`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: payloadJson,
      }).then((r) => setStatus(r.ok ? "saved" : "error")).catch(() => setStatus("error"));
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, projectId]);

  return status;
}

// The list of a kind's saved signups for the signed-in user, plus create/rename/delete. A
// module pairs this with useAccountProject: pick a projectId from `items` (or create the
// user's first one), then hand that id to useAccountProject to actually load/save it.
export function useSignupList(kind) {
  const [items, setItems] = useState(null); // null while the initial list fetch is in flight

  const refresh = () =>
    fetch(`/api/projects/${kind}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setItems(d.projects || []));

  useEffect(() => { refresh(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async ({ name, startDate, endDate }) => {
    const r = await fetch(`/api/projects/${kind}`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startDate, endDate }),
    });
    const data = await r.json();
    await refresh();
    return data.id;
  };

  const rename = async (id, { name, startDate, endDate }) => {
    await fetch(`/api/projects/${kind}/${id}`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startDate, endDate }),
    });
    await refresh();
  };

  const remove = async (id) => {
    await fetch(`/api/projects/${kind}/${id}`, { method: "DELETE", credentials: "include" });
    await refresh();
  };

  return { items, refresh, create, rename, remove };
}

const LABEL = { loading: "Loading your saved data…", idle: "", saving: "Saving…", saved: "Saved", error: "Save failed — check your connection" };
const COLOR = { loading: "var(--sample-gray)", idle: "var(--sample-gray)", saving: "var(--sample-gray)", saved: "var(--supply-teal)", error: "var(--gap-red, #C0392B)" };

export function SaveStatus({ status }) {
  const label = LABEL[status];
  if (!label) return null;
  return <span style={{ fontSize: 11, color: COLOR[status], fontWeight: 600 }}>{label}</span>;
}

// Small "Signed in as X · agency · Log out" chip, same across all 5 modules. Showing the agency
// name here matters now that saved data is shared agency-wide, not per-user — always worth
// knowing whose data you're looking at.
export function AccountChip({ user, logout }) {
  if (!user) return null;
  return (
    <span style={{ fontSize: 11, color: "var(--sample-gray)" }}>
      {user.username}
      {user.agencyName ? ` · ${user.agencyName}` : ""}
      {" · "}
      <span style={{ cursor: "pointer", textDecoration: "underline" }} onClick={logout}>Log out</span>
    </span>
  );
}

const switcherBtn = {
  fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11.5, fontWeight: 600, padding: "5px 9px",
  background: "var(--card)", border: "1px solid var(--border-input, var(--border))", color: "var(--text)",
  cursor: "pointer", borderRadius: 2,
};
const dialogField = { width: "100%", padding: "8px 9px", fontSize: 13.5, borderRadius: 2, marginTop: 4, marginBottom: 12, background: "var(--card)", color: "var(--text)", border: "1px solid var(--border-input, var(--border))" };
const dialogLabel = { display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--sample-gray)", fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: ".02em" };

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SignupDialog({ mode, label, initial, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [startDate, setStartDate] = useState(initial?.start_date || initial?.startDate || "");
  const [endDate, setEndDate] = useState(initial?.end_date || initial?.endDate || "");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), startDate: startDate || null, endDate: endDate || null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onCancel}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ background: "var(--card)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 2, padding: "22px 24px", width: 360, maxWidth: "90vw", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 19, marginBottom: 16 }}>
          {mode === "create" ? `New ${label}` : `Rename ${label}`}
        </div>
        <label style={dialogLabel}>Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={dialogField} required />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={dialogLabel}>Start date (optional)</label>
            <input type="date" value={startDate || ""} onChange={(e) => setStartDate(e.target.value)} style={dialogField} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={dialogLabel}>End date (optional)</label>
            <input type="date" value={endDate || ""} onChange={(e) => setEndDate(e.target.value)} style={dialogField} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={switcherBtn}>Cancel</button>
          <button type="submit" disabled={busy} style={{ ...switcherBtn, background: "var(--supply-teal)", color: "#fff", borderColor: "var(--supply-teal)", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Header control: current signup's name in a dropdown (switch to any other saved signup for
// this kind), "+ New" (opens SignupDialog in create mode), and Rename/Delete for the current
// one. `items` is the array from useSignupList; `onCreate`/`onRename`/`onDelete` are that same
// hook's create/rename/remove, already bound to `kind` by the caller.
export function SignupSwitcher({ label, projectId, items, onSwitch, onCreate, onRename, onDelete }) {
  const [dialog, setDialog] = useState(null); // null | "create" | "rename"
  if (!items) return null;
  const current = items.find((i) => i.id === projectId);

  const optionLabel = (i) => {
    const s = fmtDate(i.start_date), e = fmtDate(i.end_date);
    return s || e ? `${i.name} (${s || "?"}–${e || "?"})` : i.name;
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select value={projectId || ""} onChange={(e) => onSwitch(Number(e.target.value))}
          style={{ padding: "5px 7px", border: "1px solid var(--border-input, var(--border))", background: "var(--card)", color: "var(--text)", fontSize: 12.5, borderRadius: 2, maxWidth: 240 }}>
          {items.map((i) => <option key={i.id} value={i.id}>{optionLabel(i)}</option>)}
        </select>
        <button type="button" onClick={() => setDialog("create")} style={switcherBtn}>+ New {label}</button>
        {current && <button type="button" onClick={() => setDialog("rename")} style={switcherBtn}>Rename</button>}
        {current && items.length > 1 && (
          <button type="button" style={{ ...switcherBtn, color: "var(--gap-red, #C0392B)" }}
            onClick={() => { if (window.confirm(`Delete "${current.name}"? This can't be undone.`)) onDelete(current.id); }}>
            Delete
          </button>
        )}
      </div>
      {dialog && (
        <SignupDialog
          mode={dialog}
          label={label}
          initial={dialog === "rename" ? current : null}
          onCancel={() => setDialog(null)}
          onSubmit={async (vals) => {
            if (dialog === "create") await onCreate(vals);
            else await onRename(current.id, vals);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
