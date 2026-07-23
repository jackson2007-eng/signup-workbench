// Password hashing (PBKDF2 via Web Crypto SubtleCrypto — available natively in Workers, no
// npm bcrypt needed) and session management (opaque token in KV + HttpOnly cookie). Sessions
// are deliberately NOT self-contained JWTs: an opaque token means a session can be killed
// server-side (logout, admin-disable) by deleting one KV key, with no signing-key management.

const PBKDF2_ITERATIONS = 210000; // OWASP current recommendation for PBKDF2-HMAC-SHA256
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_REFRESH_THRESHOLD_SECONDS = 60 * 60 * 24 * 7; // re-issue TTL once under 7 days left

function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveBits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, keyMaterial, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return { hash: toBase64(derived), salt: toBase64(salt), iterations: PBKDF2_ITERATIONS };
}

// Constant-time comparison — never use `===`/string equality on secret-derived values, since
// short-circuiting on the first differing byte leaks timing information about the secret.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, storedHashB64, storedSaltB64, iterations) {
  const derived = await deriveBits(password, fromBase64(storedSaltB64), iterations);
  return timingSafeEqual(derived, fromBase64(storedHashB64));
}

function newToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(env, userId) {
  const token = newToken();
  await env.SESSIONS.put(`session:${token}`, JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function destroySession(env, token) {
  if (token) await env.SESSIONS.delete(`session:${token}`);
}

// Returns { userId } or null. Opportunistically refreshes the KV TTL only when it's getting
// low — refreshing on every request would blow through KV's 1,000-writes/day free-tier cap;
// this bounds writes to roughly one per active session per week instead.
export async function readSession(env, token) {
  if (!token) return null;
  const raw = await env.SESSIONS.get(`session:${token}`);
  if (!raw) return null;
  const data = JSON.parse(raw);
  const ageSeconds = (Date.now() - data.createdAt) / 1000;
  if (SESSION_TTL_SECONDS - ageSeconds < SESSION_REFRESH_THRESHOLD_SECONDS) {
    data.createdAt = Date.now();
    await env.SESSIONS.put(`session:${token}`, JSON.stringify(data), { expirationTtl: SESSION_TTL_SECONDS });
  }
  return { userId: data.userId };
}

export function parseCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// No `Domain=` attribute: *.workers.dev is on the Public Suffix List, so setting an explicit
// Domain is a real footgun (the cookie can silently fail to be accepted). Host-only is correct.
export function sessionCookie(token, { clear = false } = {}) {
  const maxAge = clear ? 0 : SESSION_TTL_SECONDS;
  const value = clear ? "" : token;
  return `session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// Cheap defense-in-depth against cross-site mutation requests, on top of SameSite=Lax.
export function isSameOrigin(request) {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";
  const origin = request.headers.get("Origin");
  if (!origin) return true; // no Origin header (e.g. same-origin GET) — nothing to check
  return origin === new URL(request.url).origin;
}
