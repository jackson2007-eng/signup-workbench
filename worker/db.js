// Small D1 query helpers. The Worker's route handlers call these rather than embedding SQL
// inline — keeps worker/index.js focused on routing/auth-checking, not query construction.

export async function getUserByUsername(env, username) {
  return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
}

export async function getUserById(env, id) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function createPendingUser(env, { username, hash, salt, iterations, name, email, agency, message }) {
  const existing = await getUserByUsername(env, username);
  if (existing) throw new Error("That username is already taken.");
  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt, password_iterations, contact_name, contact_email, agency, request_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(username, hash, salt, iterations, name, email, agency, message || null).run();
}

export async function listPendingUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, username, contact_name, contact_email, agency, request_message, created_at
     FROM users WHERE status = 'pending' ORDER BY created_at ASC`
  ).all();
  return results;
}

export async function approveUser(env, id, approvedByUserId) {
  await env.DB.prepare(
    `UPDATE users SET status = 'approved', approved_at = datetime('now'), approved_by = ? WHERE id = ?`
  ).bind(approvedByUserId, id).run();
}

export async function rejectUser(env, id) {
  await env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE id = ?`).bind(id).run();
}

export async function setUserPassword(env, id, { hash, salt, iterations }) {
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?`
  ).bind(hash, salt, iterations, id).run();
}

export async function getProject(env, userId, kind) {
  return env.DB.prepare("SELECT payload, updated_at FROM projects WHERE user_id = ? AND kind = ?").bind(userId, kind).first();
}

export async function upsertProject(env, userId, kind, payloadJson) {
  await env.DB.prepare(
    `INSERT INTO projects (user_id, kind, payload, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).bind(userId, kind, payloadJson).run();
}
