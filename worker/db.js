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

// projects: many named, datable signups per (user, kind) — every query below binds user_id
// from the session-derived caller, never a client-supplied value. That's the load-bearing IDOR
// guard now that ids are visible/sequential across the whole table, not implicitly scoped by a
// (user_id, kind) composite key the way the old single-row-per-kind design was.

export async function listProjects(env, userId, kind) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, start_date, end_date, created_at, updated_at FROM projects
     WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC`
  ).bind(userId, kind).all();
  return results;
}

export async function getProjectById(env, userId, kind, id) {
  return env.DB.prepare(
    `SELECT id, name, start_date, end_date, payload, updated_at FROM projects
     WHERE id = ? AND user_id = ? AND kind = ?`
  ).bind(id, userId, kind).first();
}

export async function createProject(env, userId, kind, { name, startDate, endDate }) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO projects (user_id, kind, name, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, kind, name, startDate || null, endDate || null).run();
  return meta.last_row_id;
}

export async function updateProjectPayload(env, userId, kind, id, payloadJson) {
  const { meta } = await env.DB.prepare(
    `UPDATE projects SET payload = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND kind = ?`
  ).bind(payloadJson, id, userId, kind).run();
  return meta.changes > 0;
}

export async function renameProject(env, userId, kind, id, { name, startDate, endDate }) {
  const { meta } = await env.DB.prepare(
    `UPDATE projects SET name = ?, start_date = ?, end_date = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND kind = ?`
  ).bind(name, startDate || null, endDate || null, id, userId, kind).run();
  return meta.changes > 0;
}

export async function deleteProject(env, userId, kind, id) {
  const { meta } = await env.DB.prepare(
    `DELETE FROM projects WHERE id = ? AND user_id = ? AND kind = ?`
  ).bind(id, userId, kind).run();
  return meta.changes > 0;
}
