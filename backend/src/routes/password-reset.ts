import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { hashApiKey, generateResetToken } from "../auth.js";
import { sendMail, buildResetMail } from "../notify/email.js";
import { getSetting } from "../settings.js";

export async function passwordResetRoutes(app: FastifyInstance) {
  // Always returns { ok: true } regardless of whether the email matched —
  // same non-enumeration behavior as /api/auth/login's generic error.
  app.post("/api/auth/forgot-password", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req) => {
    const email = String((req.body as any)?.email || "").trim().toLowerCase();
    if (!email) return { ok: true };

    const { rows } = await query(
      `SELECT id FROM users WHERE lower(email) = $1`, [email],
    );
    if (rows.length > 0) {
      const userId = rows[0].id;
      const token = generateResetToken();
      await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [userId, hashApiKey(token)],
      );
      const base = getSetting("base_url").replace(/\/$/, "");
      const resetUrl = `${base}/reset-password?token=${token}`;
      const mail = buildResetMail({ resetUrl });
      await sendMail({ to: [email], subject: "Reset your Alfred password", ...mail });
    }
    return { ok: true };
  });

  app.post("/api/auth/reset-password", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { token, password } = (req.body ?? {}) as any;
    if (!token || !password) return reply.code(400).send({ error: "missing token or password" });
    if (String(password).length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }

    const { rows } = await query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashApiKey(token)],
    );
    if (rows.length === 0) return reply.code(400).send({ error: "invalid or expired token" });
    const { id, user_id } = rows[0];

    const hash = await bcrypt.hash(password, 10);
    await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user_id, hash]);
    await query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [id]);
    // invalidate any other outstanding tokens for this user
    await query(
      `UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [user_id],
    );
    return { ok: true };
  });
}
