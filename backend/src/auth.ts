import type { FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "./db.js";
import { jwtSecret } from "./crypto.js";

export const COOKIE_NAME = "alfred_session";

export function signSession(username: string): string {
  return jwt.sign({ sub: username }, jwtSecret(), { expiresIn: "7d" });
}

export function verifySession(token: string): string | null {
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * preHandler guard for all authenticated routes (admin and viewer alike).
 * Also confirms the account still exists and stashes its current role on the
 * request, so a validly-signed cookie for a user that was deleted — or a
 * stale cookie carried over from an earlier deployment that happened to share
 * the signing key — does not grant access.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE_NAME];
  const user = token ? verifySession(token) : null;
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  }
  const { rows } = await query(`SELECT role FROM users WHERE username = $1`, [user]);
  if (rows.length === 0) {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  }
  (req as any).user = user;
  (req as any).userRole = rows[0].role as string;
}

/**
 * preHandler guard for mutating routes: authenticated AND role=admin.
 * The role is read from the database (not the JWT) so a role change
 * takes effect without waiting for the session to expire.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const denied = await requireAuth(req, reply);
  if (denied) return denied;
  if ((req as any).userRole !== "admin") {
    reply.code(403).send({ error: "admin role required" });
    return reply;
  }
}

/**
 * preHandler guard for infrastructure/alerting routes: authenticated AND
 * role IN (admin, operator). Operator is "everything admin gets except
 * user accounts and Settings" — those stay on requireAdmin.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  const denied = await requireAuth(req, reply);
  if (denied) return denied;
  const role = (req as any).userRole;
  if (role !== "admin" && role !== "operator") {
    reply.code(403).send({ error: "operator or admin role required" });
    return reply;
  }
}

export async function getUserRole(username: string): Promise<string> {
  const { rows } = await query(`SELECT role FROM users WHERE username = $1`, [username]);
  return rows[0]?.role ?? "viewer";
}

/**
 * Only seeds when ADMIN_PASSWORD is set (a scripted/IaC deploy that wants
 * to skip interaction). Otherwise leaves the users table empty so
 * /api/setup/status reports the first-run wizard is needed — a browser
 * visiting a virgin install lands on /setup instead of a generated
 * console-only password nobody would see on a headless deploy.
 */
export async function seedAdmin(): Promise<void> {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;
  if (!process.env.ADMIN_PASSWORD) {
    console.log("no users yet — first-run setup wizard is active at /setup");
    return;
  }
  const username = process.env.ADMIN_USERNAME || "admin";
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  await query("INSERT INTO users (username, password_hash) VALUES ($1, $2)", [username, hash]);
  console.log(`seeded admin user '${username}' from ADMIN_PASSWORD env`);
}

/**
 * Finds or creates the local user record for a Microsoft sign-in, keyed on
 * the token's stable azure_oid (not email, which can be reassigned).
 * Role and profile fields are refreshed on every sign-in so a group change
 * in Entra takes effect immediately rather than waiting for something to
 * expire. password_hash is unusable — Microsoft users never authenticate
 * with a password.
 */
export async function upsertMicrosoftUser(
  profile: { oid: string; email: string; name: string },
  role: "admin" | "operator" | "viewer",
): Promise<string> {
  const { rows: existing } = await query(`SELECT username FROM users WHERE azure_oid = $1`, [profile.oid]);
  if (existing.length > 0) {
    await query(
      `UPDATE users SET role = $2, email = $3, display_name = $4, last_login_at = now() WHERE azure_oid = $1`,
      [profile.oid, role, profile.email || null, profile.name || null],
    );
    return existing[0].username;
  }

  const baseUsername = profile.email || profile.name || profile.oid;
  let username = baseUsername;
  for (let n = 2; ; n++) {
    const { rows } = await query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (rows.length === 0) break;
    username = `${baseUsername}-${n}`;
  }
  const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  await query(
    `INSERT INTO users (username, password_hash, role, email, display_name, azure_oid, auth_provider, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'microsoft', now())`,
    [username, unusableHash, role, profile.email || null, profile.name || null, profile.oid],
  );
  return username;
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return "alf_" + crypto.randomBytes(24).toString("base64url");
}

/** Raw password-reset token — only its hashApiKey() hash is ever stored. */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * preHandler guard for the Wall's read-only endpoints: accepts either a
 * normal session (an admin browsing /wall while logged in) OR a valid
 * ?wall_token=, so the unattended kiosk screen never gets signed out. Falls
 * through to requireAuth so mutating routes elsewhere stay fully gated —
 * this is only ever used on GETs.
 */
export async function requireWallAccess(req: FastifyRequest, reply: FastifyReply) {
  const token = (req.query as any)?.wall_token;
  if (typeof token === "string" && token && (await isValidWallToken(token))) {
    return;
  }
  return requireAuth(req, reply);
}

export async function isValidWallToken(token: string): Promise<boolean> {
  const { rows } = await query(`SELECT token_hash FROM wall_settings WHERE id = 1`, []);
  const hash = rows[0]?.token_hash;
  if (!hash) return false;
  return hashApiKey(token) === hash;
}
