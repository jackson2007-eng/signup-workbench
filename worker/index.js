import { hashPassword, verifyPassword, createSession, destroySession, readSession, parseCookie, sessionCookie, isSameOrigin, newToken } from "./auth.js";
import {
  getUserByUsername, getUserById, getUserByEmail, createPendingUser, listPendingUsers, approveUser, rejectUser,
  setUserPassword, listProjects, getProjectById, createProject, updateProjectPayload,
  renameProject, deleteProject, listAgencies, createAgency, listApprovedUsers, setUserAgency,
  setAgencyLogo, clearAgencyLogo, getAgencyLogo,
} from "./db.js";
import { sendPasswordResetEmail } from "./email.js";

const PROJECT_KINDS = new Set(["resourcing", "callcentre", "dispatch", "annualplan", "vacationplan"]);
const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
const MAX_LOGO_BYTES = 300 * 1024;
const REQUEST_ACCESS_LIMIT_PER_DAY = 10;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_IP_FAILURE_LIMIT = 25; // looser than the per-username cap — one IP can be a whole agency's office
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
const FORGOT_PASSWORD_LIMIT_PER_DAY = 5;
const RESET_PASSWORD_LIMIT_PER_DAY = 20; // defense-in-depth only — the 32-byte token is the real gate
const RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour, single-use

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
}
function badRequest(message) { return json({ error: message }, { status: 400 }); }
function unauthorized() { return json({ error: "Not signed in." }, { status: 401 }); }
function forbidden(message) { return json({ error: message || "Not allowed." }, { status: 403 }); }
function notFound() { return json({ error: "Not found." }, { status: 404 }); }

// Best-effort per-IP/per-username throttling via KV counters. This itself spends KV write
// budget, which is an accepted tradeoff at pilot-scale threat level (see plan doc).
async function throttle(env, key, limit, windowSeconds) {
  const count = Number((await env.SESSIONS.get(key)) || "0");
  if (count >= limit) return false;
  await env.SESSIONS.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}

async function requireUser(request, env) {
  const token = parseCookie(request, "session");
  const session = await readSession(env, token);
  if (!session) return null;
  const user = await getUserById(env, session.userId);
  if (!user || user.status !== "approved") return null;
  return user;
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/me" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return json({ authenticated: false });
    return json({ authenticated: true, user: { username: user.username, isAdmin: !!user.is_admin, agencyName: user.agency_name } });
  }

  if (path === "/api/request-access" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ok = await throttle(env, `throttle:request-access:${ip}`, REQUEST_ACCESS_LIMIT_PER_DAY, 60 * 60 * 24);
    if (!ok) return json({ error: "Too many requests. Please try again tomorrow, or contact us directly." }, { status: 429 });

    const body = await request.json().catch(() => null);
    if (!body) return badRequest("Invalid request body.");
    const { username, password, name, email, agency, message } = body;
    if (!username || !password || !name || !email || !agency) return badRequest("Username, password, name, email, and agency are all required.");
    if (String(password).length < 8) return badRequest("Password must be at least 8 characters.");
    try {
      const { hash, salt, iterations } = await hashPassword(password);
      await createPendingUser(env, { username: String(username).trim(), hash, salt, iterations, name, email, agency, message });
    } catch (e) {
      return badRequest(e.message || "Could not submit that request.");
    }
    return json({ ok: true });
  }

  if (path === "/api/login" && method === "POST") {
    if (!isSameOrigin(request)) return forbidden();
    const body = await request.json().catch(() => null);
    if (!body || !body.username || !body.password) return badRequest("Username and password are required.");

    // Per-IP cap in addition to the per-username one below — without it, an attacker can
    // brute-force many different usernames from a single IP without ever tripping any one
    // username's limit.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipOk = await throttle(env, `throttle:login-ip:${ip}`, LOGIN_IP_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_SECONDS);
    if (!ipOk) return json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 429 });

    const failKey = `throttle:login:${String(body.username).toLowerCase()}`;
    const attemptsOk = await throttle(env, failKey, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_SECONDS);
    if (!attemptsOk) return json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 429 });

    const user = await getUserByUsername(env, body.username);
    if (!user) return json({ error: "Incorrect username or password." }, { status: 401 });
    const valid = await verifyPassword(body.password, user.password_hash, user.password_salt, user.password_iterations);
    if (!valid) return json({ error: "Incorrect username or password." }, { status: 401 });
    if (user.status !== "approved") return json({ error: "Your account is not yet approved. You'll be able to sign in once it is." }, { status: 403 });

    const token = await createSession(env, user.id);
    return json({ ok: true, user: { username: user.username, isAdmin: !!user.is_admin, agencyName: user.agency_name } }, { headers: { "Set-Cookie": sessionCookie(token) } });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = parseCookie(request, "session");
    await destroySession(env, token);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(null, { clear: true }) } });
  }

  // Never reveals whether the submitted email matched an account — same response either way, so
  // this can't be used to enumerate registered emails. Send failures are logged in email.js but
  // don't change the response.
  if (path === "/api/forgot-password" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ok = await throttle(env, `throttle:forgot-password:${ip}`, FORGOT_PASSWORD_LIMIT_PER_DAY, 60 * 60 * 24);
    if (!ok) return json({ error: "Too many requests. Please try again tomorrow." }, { status: 429 });

    const body = await request.json().catch(() => null);
    const email = String(body?.email || "").trim();
    if (!email) return badRequest("An email is required.");

    const user = await getUserByEmail(env, email);
    if (user) {
      const token = newToken();
      await env.SESSIONS.put(`reset:${token}`, JSON.stringify({ userId: user.id }), { expirationTtl: RESET_TOKEN_TTL_SECONDS });
      const resetUrl = `${new URL(request.url).origin}/reset-password?token=${token}`;
      await sendPasswordResetEmail(env, { to: user.contact_email, resetUrl });
    }
    return json({ ok: true, message: "If an account exists for that email, we've sent a reset link." });
  }

  if (path === "/api/reset-password" && method === "POST") {
    if (!isSameOrigin(request)) return forbidden();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ok = await throttle(env, `throttle:reset-password:${ip}`, RESET_PASSWORD_LIMIT_PER_DAY, 60 * 60 * 24);
    if (!ok) return json({ error: "Too many attempts. Please try again tomorrow." }, { status: 429 });

    const body = await request.json().catch(() => null);
    const token = String(body?.token || "");
    const newPassword = String(body?.newPassword || "");
    if (!token) return badRequest("Missing reset token.");
    if (newPassword.length < 8) return badRequest("Password must be at least 8 characters.");

    const raw = await env.SESSIONS.get(`reset:${token}`);
    if (!raw) return badRequest("This reset link is invalid or has expired. Request a new one.");
    const { userId } = JSON.parse(raw);

    const { hash, salt, iterations } = await hashPassword(newPassword);
    await setUserPassword(env, userId, { hash, salt, iterations });
    await env.SESSIONS.delete(`reset:${token}`);
    // Known v1 limitation: this doesn't invalidate the user's other active sessions elsewhere —
    // there's no reverse index from userId to their session tokens.
    return json({ ok: true });
  }

  // Everything below requires a signed-in, approved user.
  const user = await requireUser(request, env);

  // List/create: GET returns metadata only (no payload — lists can hold many signups, and the
  // switcher/dialog only ever need name/dates/timestamps). POST creates a new, empty signup and
  // returns its id; the caller then GET/PUTs /api/projects/:kind/:id like any other signup.
  const listMatch = path.match(/^\/api\/projects\/([a-z]+)$/);
  if (listMatch) {
    if (!user) return unauthorized();
    if (!user.agency_id) return forbidden("No agency assigned yet — contact your admin.");
    const kind = listMatch[1];
    if (!PROJECT_KINDS.has(kind)) return badRequest("Unknown project kind.");
    if (method === "GET") {
      return json({ projects: await listProjects(env, user.agency_id, kind) });
    }
    if (method === "POST") {
      if (!isSameOrigin(request)) return forbidden();
      const body = await request.json().catch(() => null);
      if (!body || !String(body.name || "").trim()) return badRequest("A name is required.");
      const id = await createProject(env, user.agency_id, kind, {
        name: String(body.name).trim(), startDate: body.startDate || null, endDate: body.endDate || null,
      });
      return json({ id });
    }
  }

  // One signup: load/save its payload, rename/redate it, or delete it. Every db.js call below
  // binds user.agency_id (from the session-resolved user) and the URL's kind alongside the id,
  // so a signup can only ever be read/written/renamed/deleted by someone at the same agency —
  // and never through the wrong kind's URL even for that agency's own data.
  const itemMatch = path.match(/^\/api\/projects\/([a-z]+)\/(\d+)$/);
  if (itemMatch) {
    if (!user) return unauthorized();
    if (!user.agency_id) return forbidden("No agency assigned yet — contact your admin.");
    const kind = itemMatch[1];
    const id = Number(itemMatch[2]);
    if (!PROJECT_KINDS.has(kind)) return badRequest("Unknown project kind.");
    if (method === "GET") {
      const row = await getProjectById(env, user.agency_id, kind, id);
      if (!row) return notFound();
      return json({
        id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date,
        payload: row.payload ? JSON.parse(row.payload) : null, updatedAt: row.updated_at,
      });
    }
    if (method === "PUT") {
      if (!isSameOrigin(request)) return forbidden();
      const body = await request.json().catch(() => null);
      if (body == null) return badRequest("Invalid payload.");
      const ok = await updateProjectPayload(env, user.agency_id, kind, id, JSON.stringify(body));
      if (!ok) return notFound();
      return json({ ok: true });
    }
    if (method === "PATCH") {
      if (!isSameOrigin(request)) return forbidden();
      const body = await request.json().catch(() => null);
      if (!body || !String(body.name || "").trim()) return badRequest("A name is required.");
      const ok = await renameProject(env, user.agency_id, kind, id, {
        name: String(body.name).trim(), startDate: body.startDate || null, endDate: body.endDate || null,
      });
      if (!ok) return notFound();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      if (!isSameOrigin(request)) return forbidden();
      const ok = await deleteProject(env, user.agency_id, kind, id);
      if (!ok) return notFound();
      return json({ ok: true });
    }
  }

  if (path === "/api/admin/pending" && method === "GET") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    return json({ users: await listPendingUsers(env) });
  }

  if (path === "/api/admin/users" && method === "GET") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    return json({ users: await listApprovedUsers(env) });
  }

  if (path === "/api/admin/agencies" && method === "GET") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    return json({ agencies: await listAgencies(env) });
  }

  if (path === "/api/admin/agencies" && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    const body = await request.json().catch(() => null);
    const name = String(body?.name || "").trim();
    if (!name) return badRequest("An agency name is required.");
    try {
      const id = await createAgency(env, name);
      return json({ id, name });
    } catch (e) {
      return badRequest(e.message || "Could not create that agency.");
    }
  }

  // Logo upload: admin-only (agency creation/management is already admin-gated), base64 image
  // capped at ~300KB decoded so a full-size photo doesn't bloat D1 — plenty for a small
  // wordmark/crest, which is what a header logo actually needs.
  const agencyLogoMatch = path.match(/^\/api\/admin\/agencies\/(\d+)\/logo$/);
  if (agencyLogoMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    const body = await request.json().catch(() => null);
    const data = String(body?.data || "");
    const mime = String(body?.mime || "");
    if (!ALLOWED_LOGO_MIME.has(mime)) return badRequest("Logo must be a PNG, JPEG, WebP, GIF, or SVG image.");
    if (!data) return badRequest("No image data received.");
    if (data.length * 0.75 > MAX_LOGO_BYTES) return badRequest("Logo is too large — please use an image under 300KB.");
    await setAgencyLogo(env, Number(agencyLogoMatch[1]), data, mime);
    return json({ ok: true });
  }
  if (agencyLogoMatch && method === "DELETE") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    await clearAgencyLogo(env, Number(agencyLogoMatch[1]));
    return json({ ok: true });
  }
  // Admin preview by id (unlike /api/agency-logo below, which only ever serves the caller's own
  // agency) — an admin managing agencies isn't necessarily a member of the one they're editing.
  if (agencyLogoMatch && method === "GET") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    const logo = await getAgencyLogo(env, Number(agencyLogoMatch[1]));
    if (!logo || !logo.logo_data) return notFound();
    const bytes = Uint8Array.from(atob(logo.logo_data), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": logo.logo_mime || "image/png", "Cache-Control": "private, max-age=300" } });
  }

  // Any signed-in, approved user can view their own agency's logo (not admin-gated — everyone at
  // the agency sees the branding). Served as an image, not JSON, so it's cacheable and doesn't
  // bloat /api/me or the login response on every page load.
  if (path === "/api/agency-logo" && method === "GET") {
    if (!user) return unauthorized();
    if (!user.agency_id) return notFound();
    const logo = await getAgencyLogo(env, user.agency_id);
    if (!logo || !logo.logo_data) return notFound();
    const bytes = Uint8Array.from(atob(logo.logo_data), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": logo.logo_mime || "image/png", "Cache-Control": "private, max-age=3600" } });
  }

  const setAgencyMatch = path.match(/^\/api\/admin\/users\/(\d+)\/set-agency$/);
  if (setAgencyMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    const body = await request.json().catch(() => null);
    const agencyId = Number(body?.agencyId);
    if (!agencyId) return badRequest("An agency is required.");
    await setUserAgency(env, Number(setAgencyMatch[1]), agencyId);
    return json({ ok: true });
  }

  // Approving now requires an agency in the same step — either an existing one (agencyId) or a
  // brand-new one created inline (newAgencyName) — so no user is ever left approved-but-
  // unassigned. See the plan doc: this was a deliberate product decision, not an oversight.
  const approveMatch = path.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
  if (approveMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    const body = await request.json().catch(() => null);
    let agencyId = Number(body?.agencyId) || null;
    const newAgencyName = String(body?.newAgencyName || "").trim();
    if (!agencyId && !newAgencyName) return badRequest("An agency is required to approve this request.");
    if (!agencyId && newAgencyName) {
      try {
        agencyId = await createAgency(env, newAgencyName);
      } catch (e) {
        return badRequest(e.message || "Could not create that agency.");
      }
    }
    await approveUser(env, Number(approveMatch[1]), user.id, agencyId);
    return json({ ok: true });
  }

  const rejectMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reject$/);
  if (rejectMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    await rejectUser(env, Number(rejectMatch[1]));
    return json({ ok: true });
  }

  const resetMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (resetMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    const tempPassword = crypto.randomUUID().slice(0, 12);
    const { hash, salt, iterations } = await hashPassword(tempPassword);
    await setUserPassword(env, Number(resetMatch[1]), { hash, salt, iterations });
    return json({ ok: true, tempPassword });
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
