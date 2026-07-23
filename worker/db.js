// Small D1 query helpers. The Worker's route handlers call these rather than embedding SQL
// inline — keeps worker/index.js focused on routing/auth-checking, not query construction.

// Both joined to agencies so the session-resolved user always carries its agency's name in one
// query (agency_name is null for a pending user, who has no agency_id yet).
const USER_SELECT = `SELECT users.*, agencies.name AS agency_name FROM users
  LEFT JOIN agencies ON agencies.id = users.agency_id`;

export async function getUserByUsername(env, username) {
  return env.DB.prepare(`${USER_SELECT} WHERE users.username = ?`).bind(username).first();
}

export async function getUserById(env, id) {
  return env.DB.prepare(`${USER_SELECT} WHERE users.id = ?`).bind(id).first();
}

// Only approved users are eligible for password reset — a pending user has no working login yet.
export async function getUserByEmail(env, email) {
  return env.DB.prepare(`${USER_SELECT} WHERE LOWER(users.contact_email) = LOWER(?) AND users.status = 'approved'`).bind(email).first();
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

export async function approveUser(env, id, approvedByUserId, agencyId) {
  await env.DB.prepare(
    `UPDATE users SET status = 'approved', approved_at = datetime('now'), approved_by = ?, agency_id = ? WHERE id = ?`
  ).bind(approvedByUserId, agencyId, id).run();
}

export async function rejectUser(env, id) {
  await env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE id = ?`).bind(id).run();
}

export async function setUserPassword(env, id, { hash, salt, iterations }) {
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?`
  ).bind(hash, salt, iterations, id).run();
}

export async function setUserAgency(env, id, agencyId) {
  await env.DB.prepare(`UPDATE users SET agency_id = ? WHERE id = ?`).bind(agencyId, id).run();
}

export async function listApprovedUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT users.id, users.username, users.contact_name, users.contact_email, users.is_admin,
            users.agency_id, agencies.name AS agency_name
     FROM users LEFT JOIN agencies ON agencies.id = users.agency_id
     WHERE users.status = 'approved' ORDER BY users.username COLLATE NOCASE`
  ).all();
  return results;
}

// agencies: the data-sharing unit every approved user belongs to (see projects below).
export async function listAgencies(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, (logo_data IS NOT NULL) AS has_logo FROM agencies ORDER BY name COLLATE NOCASE`
  ).all();
  return results;
}

export async function createAgency(env, name) {
  const existing = await env.DB.prepare(`SELECT id FROM agencies WHERE name = ?`).bind(name).first();
  if (existing) throw new Error("An agency with that name already exists.");
  const { meta } = await env.DB.prepare(`INSERT INTO agencies (name) VALUES (?)`).bind(name).run();
  return meta.last_row_id;
}

export async function setAgencyLogo(env, agencyId, data, mime) {
  await env.DB.prepare(`UPDATE agencies SET logo_data = ?, logo_mime = ? WHERE id = ?`).bind(data, mime, agencyId).run();
}

export async function clearAgencyLogo(env, agencyId) {
  await env.DB.prepare(`UPDATE agencies SET logo_data = NULL, logo_mime = NULL WHERE id = ?`).bind(agencyId).run();
}

export async function getAgencyLogo(env, agencyId) {
  return env.DB.prepare(`SELECT logo_data, logo_mime FROM agencies WHERE id = ?`).bind(agencyId).first();
}

// projects: many named, datable signups per (agency, kind), shared by every user at that
// agency — every query below binds agency_id from the session-resolved caller's own
// user.agency_id, never a client-supplied value. That's the load-bearing IDOR guard: a signup
// is only reachable by a session whose user resolves to that same agency.

export async function listProjects(env, agencyId, kind) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, start_date, end_date, created_at, updated_at FROM projects
     WHERE agency_id = ? AND kind = ? ORDER BY updated_at DESC`
  ).bind(agencyId, kind).all();
  return results;
}

export async function getProjectById(env, agencyId, kind, id) {
  return env.DB.prepare(
    `SELECT id, name, start_date, end_date, payload, updated_at FROM projects
     WHERE id = ? AND agency_id = ? AND kind = ?`
  ).bind(id, agencyId, kind).first();
}

export async function createProject(env, agencyId, kind, { name, startDate, endDate }) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO projects (agency_id, kind, name, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
  ).bind(agencyId, kind, name, startDate || null, endDate || null).run();
  return meta.last_row_id;
}

export async function updateProjectPayload(env, agencyId, kind, id, payloadJson) {
  const { meta } = await env.DB.prepare(
    `UPDATE projects SET payload = ?, updated_at = datetime('now') WHERE id = ? AND agency_id = ? AND kind = ?`
  ).bind(payloadJson, id, agencyId, kind).run();
  return meta.changes > 0;
}

export async function renameProject(env, agencyId, kind, id, { name, startDate, endDate }) {
  const { meta } = await env.DB.prepare(
    `UPDATE projects SET name = ?, start_date = ?, end_date = ?, updated_at = datetime('now')
     WHERE id = ? AND agency_id = ? AND kind = ?`
  ).bind(name, startDate || null, endDate || null, id, agencyId, kind).run();
  return meta.changes > 0;
}

export async function deleteProject(env, agencyId, kind, id) {
  const { meta } = await env.DB.prepare(
    `DELETE FROM projects WHERE id = ? AND agency_id = ? AND kind = ?`
  ).bind(id, agencyId, kind).run();
  return meta.changes > 0;
}
