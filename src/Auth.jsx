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

export function Admin({ navigate }) {
  const [pending, setPending] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const refresh = () => fetch("/api/admin/pending", { credentials: "include" }).then((r) => r.json()).then((d) => setPending(d.users || []));
  useEffect(() => { refresh(); }, []);

  const act = async (id, action) => {
    setBusyId(id);
    try {
      await fetch(`/api/admin/users/${id}/${action}`, { method: "POST", credentials: "include" });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AuthShell navigate={navigate} title="Pending access requests" subtitle="Approve or reject accounts requesting access to the toolkit." wide>
      {pending == null && <div style={{ fontSize: 13, color: sampleGray }}>Loading…</div>}
      {pending && pending.length === 0 && <div style={{ fontSize: 13, color: sampleGray }}>No pending requests.</div>}
      {pending && pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {pending.map((u) => (
            <div key={u.id} style={{ border: "1px solid var(--border-light)", borderRadius: 2, padding: "12px 14px" }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{u.contact_name} <span style={{ fontWeight: 400, color: sampleGray, fontSize: 12.5 }}>({u.username})</span></div>
              <div style={{ fontSize: 12.5, color: sampleGray, marginTop: 2 }}>{u.agency} · {u.contact_email}</div>
              {u.request_message && <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>{u.request_message}</div>}
              <div style={{ fontSize: 11, color: sampleGray, marginTop: 6 }}>Requested {u.created_at}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button disabled={busyId === u.id} style={{ ...nudgeBtn, background: supplyTeal, color: "#fff", borderColor: supplyTeal }} onClick={() => act(u.id, "approve")}>Approve</button>
                <button disabled={busyId === u.id} style={{ ...nudgeBtn, color: gapRed, borderColor: gapRed }} onClick={() => act(u.id, "reject")}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AuthShell>
  );
}
