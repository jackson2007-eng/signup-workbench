import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Landing from "./Landing.jsx";

// Minimal path router — no library. "/" (and anything unrecognized) shows the toolkit hub;
// "/resourcing" is the operator module. history.pushState + popstate keep the URL honest so
// deep links and the browser back button work (Cloudflare serves index.html for any path via
// the single-page-application asset fallback in wrangler.jsonc).
function Root() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  if (path === "/resourcing") return <App onHome={() => navigate("/")} />;
  return <Landing navigate={navigate} />;
}

createRoot(document.getElementById("root")).render(<Root />);
