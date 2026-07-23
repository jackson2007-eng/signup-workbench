import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import CallCentre from "./CallCentre.jsx";
import Dispatch from "./Dispatch.jsx";
import AnnualPlan from "./AnnualPlan.jsx";
import VacationPlan from "./VacationPlan.jsx";
import Landing from "./Landing.jsx";
import { SignIn, RequestAccess, Admin } from "./Auth.jsx";

// Minimal path router — no library. history.pushState + popstate keep the URL honest so deep
// links and the browser back button work (Cloudflare serves index.html for any path via the
// single-page-application asset fallback in wrangler.jsonc). Tracks pathname+search as one
// string so `next=` redirects (e.g. /signin?next=/annualplan) work without extra state.
const PROTECTED = { "/resourcing": App, "/callcentre": CallCentre, "/dispatch": Dispatch, "/annualplan": AnnualPlan, "/vacation": VacationPlan };

function AuthLoading() {
  return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#5B6B75" }}>Loading…</div>;
}
function ApiUnreachable() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#5B6B75", padding: 20, textAlign: "center" }}>
      Can't reach the API. If you're running <code>npm run dev</code>, use <code>npm run dev:api</code> instead — the plain frontend-only dev server doesn't have a backend.
    </div>
  );
}

function Root() {
  const [url, setUrl] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setUrl(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState({}, "", to);
    setUrl(to);
    window.scrollTo(0, 0);
  };
  const qIdx = url.indexOf("?");
  const path = qIdx < 0 ? url : url.slice(0, qIdx);
  const params = new URLSearchParams(qIdx < 0 ? "" : url.slice(qIdx));

  // authState: 'loading' (checking /api/me) | 'unreachable' (no backend, e.g. plain `vite dev`)
  // | 'anon' | 'authed'. Fetched once here and threaded down as props, same pattern as
  // `navigate` already is — this app has no global React context anywhere, by design.
  const [authState, setAuthState] = useState("loading");
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) { setUser(data.user); setAuthState("authed"); }
        else setAuthState("anon");
      })
      .catch(() => setAuthState("unreachable"));
  }, []);
  const logout = () => {
    fetch("/api/logout", { method: "POST", credentials: "include" }).finally(() => {
      setUser(null);
      setAuthState("anon");
      navigate("/");
    });
  };
  const onSignedIn = (u) => { setUser(u); setAuthState("authed"); };

  const needsAuth = !!PROTECTED[path];
  useEffect(() => {
    if (needsAuth && authState === "anon") navigate(`/signin?next=${encodeURIComponent(path)}`);
  }, [needsAuth, authState, path]);
  useEffect(() => {
    if (path !== "/admin") return;
    if (authState === "anon") navigate(`/signin?next=${encodeURIComponent(path)}`);
    else if (authState === "authed" && !user?.isAdmin) navigate("/");
  }, [path, authState, user]);

  if (needsAuth) {
    if (authState === "loading") return <AuthLoading />;
    if (authState === "unreachable") return <ApiUnreachable />;
    if (authState !== "authed") return <AuthLoading />; // redirect effect above is about to fire
    const Comp = PROTECTED[path];
    return <Comp onHome={() => navigate("/")} user={user} logout={logout} />;
  }

  if (path === "/signin") return <SignIn navigate={navigate} params={params} onSignedIn={onSignedIn} />;
  if (path === "/request-access") return <RequestAccess navigate={navigate} />;
  if (path === "/admin") {
    if (authState === "loading") return <AuthLoading />;
    if (authState !== "authed" || !user?.isAdmin) return <AuthLoading />; // redirect effect above
    return <Admin navigate={navigate} />;
  }
  return <Landing navigate={navigate} authState={authState} user={user} logout={logout} />;
}

createRoot(document.getElementById("root")).render(<Root />);
