import React, { useEffect, useState } from "react";
import { DARK_MODE_ENABLED } from "./themeFlag.js";

const text = "var(--text)", paper = "var(--paper)", card = "var(--card)",
  supplyTeal = "var(--supply-teal)", gapRed = "var(--gap-red, #C0392B)", sampleGray = "var(--sample-gray)";

// Same theme-var block every top-level page defines locally (no shared global stylesheet in
// this app) — matches Landing.jsx/AnnualPlan.jsx/etc. exactly, so auth pages theme correctly
// even when reached directly (e.g. a bookmarked /signin link) before any module has run.
function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (!DARK_MODE_ENABLED) return "light";
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { localStorage.setItem("theme", theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  return [theme, setTheme];
}

const themeCss = `@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
  * { box-sizing: border-box; }
  :root {
    --paper: #F4F6F7; --card: #FFFFFF; --chrome: #182430; --text: #182430;
    --demand-amber: #D98324; --supply-teal: #0F7B7A; --gap-red: #C0392B; --bookout-violet: #6C5B9E;
    --sample-gray: #5B6B75; --border: #E2E8EA; --border-light: #E8ECEE; --border-input: #CBD5DA; --text-mid: #41525C;
  }
  [data-theme="dark"] {
    --paper: #12181D; --card: #1B242B; --chrome: #0B1014; --text: #E7ECEF;
    --demand-amber: #E8A552; --supply-teal: #2FB3AC; --gap-red: #E27A70; --bookout-violet: #A594D1;
    --sample-gray: #8B9AA5; --border: #2A343C; --border-light: #333F47; --border-input: #3A454D; --text-mid: #A9B6BF;
  }
  body { background: var(--paper); }
  input[type=text], input[type=email], input[type=password] { background: var(--card); color: var(--text); border: 1px solid var(--border-input); }
`;

const fieldStyle = { width: "100%", padding: "9px 10px", fontSize: 14, borderRadius: 2, marginTop: 4, marginBottom: 14 };
const labelStyle = { display: "block", fontSize: 12.5, fontWeight: 600, color: sampleGray, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: ".02em" };
const primaryBtn = { width: "100%", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 600, padding: "10px 12px", background: supplyTeal, color: "#fff", border: "none", borderRadius: 2, cursor: "pointer" };
const nudgeBtn = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 600, padding: "4px 9px", background: card, border: "1px solid var(--border-input)", color: text, cursor: "pointer", borderRadius: 2 };
const cardTitleStyle = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, marginBottom: 10 };
const mutedStyle = { fontSize: 13, color: sampleGray };
const rowCardStyle = { border: "1px solid var(--border-light)", borderRadius: 2, padding: "12px 14px" };
const agencyChipStyle = { fontSize: 12, fontWeight: 600, padding: "4px 9px", background: "var(--paper)", border: "1px solid var(--border-light)", borderRadius: 2, color: text };
const selectStyle = { padding: "5px 7px", fontSize: 12.5, border: "1px solid var(--border-input)", background: card, color: text, borderRadius: 2 };

function AuthShell({ navigate, title, subtitle, children, wide }) {
  const [theme, setTheme] = useTheme();
  return (
    <div data-theme={theme} style={{ minHeight: "100vh", background: paper, color: text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{themeCss}</style>
      <div style={{ maxWidth: wide ? 720 : 400, margin: "0 auto", padding: "18px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 30 }}>
          <button onClick={() => navigate("/")} style={{ ...nudgeBtn, fontSize: 12 }}>‹ Paratransit Companion</button>
          {DARK_MODE_ENABLED && (
            <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} style={{ ...nudgeBtn, marginLeft: "auto" }}>
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </button>
          )}
        </div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13.5, color: sampleGray, marginBottom: 22, lineHeight: 1.5 }}>{subtitle}</div>}
        <div style={{ background: card, border: "1px solid var(--border)", padding: "22px 24px", marginTop: subtitle ? 0 : 18 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SignIn({ navigate, params, onSignedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Could not sign in."); return; }
      onSignedIn(data.user);
      navigate(params.get("next") || "/");
    } catch (e) {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell navigate={navigate} title="Sign in">
      <form onSubmit={submit}>
        <label style={labelStyle}>Username</label>
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus style={fieldStyle} required />
        <label style={labelStyle}>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={fieldStyle} required />
        {error && <div style={{ fontSize: 12.5, color: gapRed, marginBottom: 14 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <div style={{ fontSize: 12.5, color: sampleGray, marginTop: 16, textAlign: "center" }}>
        Don't have access yet?{" "}
        <span style={{ color: supplyTeal, cursor: "pointer", fontWeight: 600 }} onClick={() => navigate("/request-access")}>Request access</span>
      </div>
    </AuthShell>
  );
}

export function RequestAccess({ navigate }) {
  const [form, setForm] = useState({ username: "", password: "", name: "", email: "", agency: "", message: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/request-access", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Could not submit that request."); return; }
      setDone(true);
    } catch (e) {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthShell navigate={navigate} title="Request received">
        <div style={{ fontSize: 14, lineHeight: 1.6 }}>
          Thanks — your request is in. Once it's approved you'll be able to sign in with the
          username and password you just set.
        </div>
        <button style={{ ...primaryBtn, marginTop: 18 }} onClick={() => navigate("/signin")}>Go to sign in</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell navigate={navigate} title="Request access" subtitle="Tell us a bit about you and your agency, and choose the username/password you'll sign in with once approved.">
      <form onSubmit={submit}>
        <label style={labelStyle}>Your name</label>
        <input type="text" value={form.name} onChange={set("name")} style={fieldStyle} required />
        <label style={labelStyle}>Work email</label>
        <input type="email" value={form.email} onChange={set("email")} style={fieldStyle} required />
        <label style={labelStyle}>Agency</label>
        <input type="text" value={form.agency} onChange={set("agency")} style={fieldStyle} required />
        <label style={labelStyle}>Anything else we should know? (optional)</label>
        <textarea value={form.message} onChange={set("message")} rows={3}
          style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }} />
        <label style={labelStyle}>Choose a username</label>
        <input type="text" value={form.username} onChange={set("username")} style={fieldStyle} required />
        <label style={labelStyle}>Choose a password (8+ characters)</label>
        <input type="password" value={form.password} onChange={set("password")} minLength={8} style={fieldStyle} required />
        {error && <div style={{ fontSize: 12.5, color: gapRed, marginBottom: 14 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>{busy ? "Submitting…" : "Submit request"}</button>
      </form>
    </AuthShell>
  );
}

// Inline agency picker shown when an admin clicks "Approve" — approving now requires assigning
// an agency in the same step, so a user is never left approved-but-unassigned. Pick an existing
// agency or type a brand-new one; either way "Confirm approve" fires a single approve call.
function PendingRow({ u, agencies, busy, onApprove, onReject }) {
  const [choosing, setChoosing] = useState(false);
  const [agencyId, setAgencyId] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState("");

  const confirm = () => {
    if (creatingNew) {
      if (!newName.trim()) return;
      onApprove(u.id, null, newName.trim());
    } else {
      if (!agencyId) return;
      onApprove(u.id, Number(agencyId), null);
    }
    setChoosing(false);
  };

  return (
    <div style={rowCardStyle}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{u.contact_name} <span style={{ fontWeight: 400, color: sampleGray, fontSize: 12.5 }}>({u.username})</span></div>
      <div style={{ fontSize: 12.5, color: sampleGray, marginTop: 2 }}>{u.agency} · {u.contact_email}</div>
      {u.request_message && <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>{u.request_message}</div>}
      <div style={{ fontSize: 11, color: sampleGray, marginTop: 6 }}>Requested {u.created_at}</div>

      {!choosing && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button disabled={busy} style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={() => setChoosing(true)}>Approve</button>
          <button disabled={busy} style={{ ...nudgeBtn, color: gapRed, borderColor: gapRed }} onClick={() => onReject(u.id)}>Reject</button>
        </div>
      )}
      {choosing && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--paper)", border: "1px solid var(--border-light)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Assign to an agency to approve:</div>
          {!creatingNew ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)} style={selectStyle}>
                <option value="">Choose agency…</option>
                {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <span style={{ fontSize: 12, color: supplyTeal, cursor: "pointer", fontWeight: 600 }} onClick={() => setCreatingNew(true)}>+ New agency…</span>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input type="text" placeholder="New agency name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ ...fieldStyle, marginBottom: 0, width: 200 }} autoFocus />
              <span style={{ fontSize: 12, color: sampleGray, cursor: "pointer", textDecoration: "underline" }} onClick={() => setCreatingNew(false)}>choose existing instead</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button disabled={busy} style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={confirm}>Confirm approve</button>
            <button disabled={busy} style={nudgeBtn} onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Admin({ navigate }) {
  const [pending, setPending] = useState(null);
  const [members, setMembers] = useState(null);
  const [agencies, setAgencies] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [newAgencyName, setNewAgencyName] = useState("");
  const [agencyBusy, setAgencyBusy] = useState(false);

  const refreshPending = () => fetch("/api/admin/pending", { credentials: "include" }).then((r) => r.json()).then((d) => setPending(d.users || []));
  const refreshMembers = () => fetch("/api/admin/users", { credentials: "include" }).then((r) => r.json()).then((d) => setMembers(d.users || []));
  const refreshAgencies = () => fetch("/api/admin/agencies", { credentials: "include" }).then((r) => r.json()).then((d) => setAgencies(d.agencies || []));
  useEffect(() => { refreshPending(); refreshMembers(); refreshAgencies(); }, []);

  const createAgency = async (e) => {
    e.preventDefault();
    if (!newAgencyName.trim()) return;
    setAgencyBusy(true);
    try {
      const res = await fetch("/api/admin/agencies", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newAgencyName.trim() }),
      });
      const data = await res.json();
      if (res.ok) { setNewAgencyName(""); await refreshAgencies(); }
      else alert(data.error || "Could not create that agency.");
    } finally {
      setAgencyBusy(false);
    }
  };

  const approve = async (id, agencyId, newAgencyNameForRow) => {
    setBusyId(id);
    try {
      await fetch(`/api/admin/users/${id}/approve`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyId, newAgencyName: newAgencyNameForRow }),
      });
      await Promise.all([refreshPending(), refreshMembers(), refreshAgencies()]);
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id) => {
    setBusyId(id);
    try {
      await fetch(`/api/admin/users/${id}/reject`, { method: "POST", credentials: "include" });
      await refreshPending();
    } finally {
      setBusyId(null);
    }
  };

  const reassign = async (id, agencyId) => {
    setBusyId(id);
    try {
      await fetch(`/api/admin/users/${id}/set-agency`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyId }),
      });
      await refreshMembers();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AuthShell navigate={navigate} title="Admin" subtitle="Manage agencies, approve access requests, and reassign team members." wide>
      <div style={{ marginBottom: 26 }}>
        <div style={cardTitleStyle}>Agencies</div>
        {agencies == null && <div style={mutedStyle}>Loading…</div>}
        {agencies && agencies.length === 0 && <div style={mutedStyle}>No agencies yet — create one below.</div>}
        {agencies && agencies.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {agencies.map((a) => <span key={a.id} style={agencyChipStyle}>{a.name}</span>)}
          </div>
        )}
        <form onSubmit={createAgency} style={{ display: "flex", gap: 8 }}>
          <input type="text" placeholder="New agency name" value={newAgencyName} onChange={(e) => setNewAgencyName(e.target.value)} style={{ ...fieldStyle, marginBottom: 0, flex: 1, maxWidth: 280 }} />
          <button type="submit" disabled={agencyBusy} style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }}>{agencyBusy ? "Creating…" : "Create agency"}</button>
        </form>
      </div>

      <div style={{ marginBottom: 26 }}>
        <div style={cardTitleStyle}>Pending access requests</div>
        {pending == null && <div style={mutedStyle}>Loading…</div>}
        {pending && pending.length === 0 && <div style={mutedStyle}>No pending requests.</div>}
        {pending && pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {pending.map((u) => (
              <PendingRow key={u.id} u={u} agencies={agencies || []} busy={busyId === u.id} onApprove={approve} onReject={reject} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={cardTitleStyle}>Team members</div>
        {members == null && <div style={mutedStyle}>Loading…</div>}
        {members && members.length === 0 && <div style={mutedStyle}>No approved users yet.</div>}
        {members && members.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {members.map((m) => (
              <div key={m.id} style={rowCardStyle}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                  {m.contact_name} <span style={{ fontWeight: 400, color: sampleGray, fontSize: 12 }}>({m.username}{m.is_admin ? " · admin" : ""})</span>
                </div>
                <div style={{ fontSize: 12, color: sampleGray, marginTop: 2 }}>{m.contact_email}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: sampleGray }}>Agency:</span>
                  <select value={m.agency_id || ""} disabled={busyId === m.id} onChange={(e) => reassign(m.id, Number(e.target.value))} style={selectStyle}>
                    {(agencies || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AuthShell>
  );
}
