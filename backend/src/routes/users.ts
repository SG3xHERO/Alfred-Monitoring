import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAdmin } from "../auth.js";
import { audit } from "../audit.js";

export async function userRoutes(app: FastifyInstance) {
  // user management is admin-only in its entirety
  app.addHook("preHandler", requireAdmin);

  app.get("/api/users", async () => {
    const { rows } = await query(
      `SELECT id, username, email, role, created_at, auth_provider, display_name, last_login_at
       FROM users ORDER BY username`,
    );
    return rows;
  });

  app.post("/api/users", async (req, reply) => {
    const { username, password, role, email } = (req.body ?? {}) as any;
    if (!username || typeof username !== "string" || !username.trim()) {
      return reply.code(400).send({ error: "username is required" });
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    const userRole = role === "viewer" || role === "operator" ? role : "admin";
    const userEmail = typeof email === "string" && email.trim() ? email.trim() : null;
    const { rows: existing } = await query(`SELECT id FROM users WHERE username = $1`, [username.trim()]);
    if (existing.length > 0) return reply.code(409).send({ error: "username already exists" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, email, created_at`,
      [username.trim(), hash, userRole, userEmail],
    );
    await audit((req as any).user, "user.create", "user", rows[0].id,
      { username: username.trim(), role: userRole });
    return reply.code(201).send(rows[0]);
  });

  app.patch("/api/users/:id", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { email } = (req.body ?? {}) as any;
    const userEmail = typeof email === "string" && email.trim() ? email.trim() : null;
    const { rowCount } = await query(`UPDATE users SET email = $2 WHERE id = $1`, [id, userEmail]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "user.email", "user", id, { email: userEmail });
    return { ok: true };
  });

  app.patch("/api/users/:id/password", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { password } = (req.body ?? {}) as any;
    if (!password || typeof password !== "string" || password.length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rowCount } = await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, hash]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "user.password", "user", id);
    return { ok: true };
  });

  app.patch("/api/users/:id/role", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { role } = (req.body ?? {}) as any;
    if (role !== "admin" && role !== "operator" && role !== "viewer") {
      return reply.code(400).send({ error: "role must be admin, operator or viewer" });
    }
    const { rows } = await query(`SELECT username, role FROM users WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });

    // never demote the last admin — that would lock everyone out of user/Settings management
    if (rows[0].role === "admin" && role !== "admin") {
      const { rows: admins } = await query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
      if (admins[0].n <= 1) {
        return reply.code(400).send({ error: "cannot demote the last remaining admin" });
      }
    }
    await query(`UPDATE users SET role = $2 WHERE id = $1`, [id, role]);
    await audit((req as any).user, "user.role", "user", id, { username: rows[0].username, role });
    return { ok: true };
  });

  app.delete("/api/users/:id", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(`SELECT username, role FROM users WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });

    const currentUsername = (req as any).user as string;
    if (rows[0].username === currentUsername) {
      return reply.code(400).send({ error: "you cannot delete your own account" });
    }
    if (rows[0].role === "admin") {
      const { rows: admins } = await query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
      if (admins[0].n <= 1) {
        return reply.code(400).send({ error: "cannot delete the last remaining admin" });
      }
    }
    await query(`DELETE FROM users WHERE id = $1`, [id]);
    await audit(currentUsername, "user.delete", "user", id, { username: rows[0].username });
    return { ok: true };
  });
}
