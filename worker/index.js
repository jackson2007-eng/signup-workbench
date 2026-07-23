import { hashPassword, verifyPassword, createSession, destroySession, readSession, parseCookie, sessionCookie, isSameOrigin } from "./auth.js";
import {
  getUserByUsername, getUserById, createPendingUser, listPendingUsers, approveUser, rejectUser,
  setUserPassword, getProject, upsertProject,
} from "./db.js";

const PROJECT_KINDS = new Set(["resourcing", "callcentre", "dispatch", "annualplan", "vacationplan"]);
const REQUEST_ACCESS_LIMIT_PER_DAY = 10;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_IP_FAILURE_LIMIT = 25; // looser than the per-username cap — one IP can be a whole agency's office
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
}
function badRequest(message) { return json({ error: message }, { status: 400 }); }
function unauthorized() { return json({ error: "Not signed in." }, { status: 401 }); }
function forbidden() { return json({ error: "Not allowed." }, { status: 403 }); }

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
    return json({ authenticated: true, user: { username: user.username, isAdmin: !!user.is_admin } });
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
    return json({ ok: true, user: { username: user.username, isAdmin: !!user.is_admin } }, { headers: { "Set-Cookie": sessionCookie(token) } });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = parseCookie(request, "session");
    await destroySession(env, token);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(null, { clear: true }) } });
  }

  // Everything below requires a signed-in, approved user.
  const user = await requireUser(request, env);

  const projectMatch = path.match(/^\/api\/projects\/([a-z]+)$/);
  if (projectMatch) {
    if (!user) return unauthorized();
    const kind = projectMatch[1];
    if (!PROJECT_KINDS.has(kind)) return badRequest("Unknown project kind.");
    if (method === "GET") {
      const row = await getProject(env, user.id, kind);
      return json({ payload: row ? JSON.parse(row.payload) : null, updatedAt: row ? row.updated_at : null });
    }
    if (method === "PUT") {
      if (!isSameOrigin(request)) return forbidden();
      const body = await request.json().catch(() => null);
      if (body == null) return badRequest("Invalid payload.");
      await upsertProject(env, user.id, kind, JSON.stringify(body));
      return json({ ok: true });
    }
  }

  if (path === "/api/admin/pending" && method === "GET") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    return json({ users: await listPendingUsers(env) });
  }

  const approveMatch = path.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
  if (approveMatch && method === "POST") {
    if (!user) return unauthorized();
    if (!user.is_admin) return forbidden();
    if (!isSameOrigin(request)) return forbidden();
    await approveUser(env, Number(approveMatch[1]), user.id);
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

  return json({ error: "Not found." }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
