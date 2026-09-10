import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAuth, requireOperator, requireWallAccess, getUserRole, signSession, upsertMicrosoftUser, COOKIE_NAME } from "../auth.js";
import { azureConfigured, azurePublicConfig, validateAzureIdToken, fetchGraphGroupIds, roleFromGroupIds } from "../microsoftAuth.js";
import { audit } from "../audit.js";
import { addClient } from "../sse.js";

function setSessionCookie(reply: any, username: string) {
  reply.setCookie(COOKIE_NAME, signSession(username), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as any;
    if (!username || !password) return reply.code(400).send({ error: "missing credentials" });
    const { rows } = await query(`SELECT password_hash FROM users WHERE username = $1`, [username]);
    const ok = rows.length > 0 && await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return reply.code(401).send({ error: "invalid username or password" });
    await query(`UPDATE users SET last_login_at = now() WHERE username = $1`, [username]);
    setSessionCookie(reply, username);
    return { ok: true, username };
  });

  // Public — the login page needs this before the user is authenticated to
  // decide whether to show the Microsoft button at all.
  app.get("/api/auth/microsoft/config", async () => azurePublicConfig());

  app.post("/api/auth/microsoft", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!azureConfigured()) {
      return reply.code(403).send({ error: "Microsoft sign-in is not enabled" });
    }
    const { idToken, accessToken } = (req.body ?? {}) as any;
    if (!idToken || !accessToken) return reply.code(400).send({ error: "missing token" });

    let profile;
    try {
      profile = await validateAzureIdToken(idToken);
    } catch (err: any) {
      return reply.code(401).send({ error: err.message || "invalid Microsoft token" });
    }

    let groupIds: string[];
    try {
      groupIds = await fetchGraphGroupIds(accessToken);
    } catch (err: any) {
      return reply.code(502).send({ error: err.message || "could not read group membership" });
    }

    const role = roleFromGroupIds(groupIds);
    if (!role) {
      return reply.code(403).send({ error: "your Microsoft account isn't a member of an Alfred access group" });
    }

    const username = await upsertMicrosoftUser(profile, role);
    await audit(username, "auth.login_microsoft", "user", null, { role });
    setSessionCookie(reply, username);
    return { ok: true, username };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    const username = (req as any).user as string;
    return { username, role: await getUserRole(username) };
  });
}

export async function incidentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/incidents", async (req) => {
    const q = req.query as any;
    const params: any[] = [];
    const where: string[] = [];
    if (q.server_id) { params.push(parseInt(q.server_id, 10)); where.push(`i.server_id = $${params.length}`); }
    if (q.severity) { params.push(q.severity); where.push(`i.severity = $${params.length}`); }
    if (q.open === "true") where.push(`i.resolved_at IS NULL`);
    if (q.from) { params.push(q.from); where.push(`i.started_at >= $${params.length}`); }
    if (q.to) { params.push(q.to); where.push(`i.started_at <= $${params.length}`); }
    const limit = Math.min(parseInt(q.limit || "200", 10), 1000);
    const { rows } = await query(
      `SELECT i.*, s.display_name AS server_name, s.brand
       FROM incidents i JOIN servers s ON s.id = i.server_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY i.started_at DESC LIMIT ${limit}`,
      params,
    );
    return rows;
  });
}

export async function maintenanceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  app.get("/api/maintenance", async () => {
    const { rows } = await query(
      `SELECT * FROM maintenance_windows
       WHERE recurrence = 'recurring' OR ends_at > now() - interval '7 days'
       ORDER BY recurrence DESC, starts_at DESC`,
    );
    return rows;
  });

  app.post("/api/maintenance", async (req, reply) => {
    const { target, recurrence, starts_at, ends_at, time_start, time_end, days, note, rule_name, check_key } =
      (req.body ?? {}) as any;
    if (!target) return reply.code(400).send({ error: "target is required" });
    // a check_key only means anything paired with the rule it belongs to
    if (check_key && !rule_name) {
      return reply.code(400).send({ error: "check_key requires rule_name" });
    }
    const ruleName = rule_name || null;
    const checkKey = check_key || null;

    if (recurrence === "recurring") {
      const hm = /^\d{1,2}:\d{2}$/;
      if (!hm.test(time_start ?? "") || !hm.test(time_end ?? "")) {
        return reply.code(400).send({ error: "time_start and time_end must be HH:MM" });
      }
      if (time_start === time_end) {
        return reply.code(400).send({ error: "time_start and time_end must differ" });
      }
      const dayList: number[] = Array.isArray(days) ? days.map(Number) : [];
      if (dayList.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return reply.code(400).send({ error: "days must be weekday numbers 0-6" });
      }
      const { rows } = await query(
        `INSERT INTO maintenance_windows
           (target, recurrence, starts_at, ends_at, time_start, time_end, days, note, rule_name, check_key)
         VALUES ($1,'recurring', now(), TIMESTAMPTZ '9999-12-31', $2, $3, $4, $5, $6, $7) RETURNING *`,
        [target, time_start, time_end, dayList, note ?? null, ruleName, checkKey],
      );
      await audit((req as any).user, "silence.create", "maintenance_window", rows[0].id,
        { target, recurrence: "recurring", time_start, time_end, days: dayList, note, rule_name: ruleName, check_key: checkKey });
      return rows[0];
    }

    if (!starts_at || !ends_at) {
      return reply.code(400).send({ error: "starts_at and ends_at are required" });
    }
    const { rows } = await query(
      `INSERT INTO maintenance_windows (target, starts_at, ends_at, note, rule_name, check_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [target, starts_at, ends_at, note ?? null, ruleName, checkKey],
    );
    await audit((req as any).user, "silence.create", "maintenance_window", rows[0].id,
      { target, starts_at, ends_at, note, rule_name: ruleName, check_key: checkKey });
    return rows[0];
  });

  app.delete("/api/maintenance/:id", async (req) => {
    const id = parseInt((req.params as any).id, 10);
    await query(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
    await audit((req as any).user, "silence.delete", "maintenance_window", id);
    return { ok: true };
  });
}

export async function eventRoutes(app: FastifyInstance) {
  app.get("/api/events", { preHandler: requireWallAccess }, (req, reply) => {
    addClient(reply);
    // reply is hijacked; fastify must not try to send a response
    return reply;
  });
}

export async function muteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/mutes", async () => {
    const { rows } = await query(
      `SELECT m.*, s.display_name AS server_name
       FROM alert_mutes m JOIN servers s ON s.id = m.server_id
       WHERE m.until > now() ORDER BY m.until`,
    );
    return rows;
  });

  app.post("/api/mutes", { preHandler: requireOperator }, async (req, reply) => {
    const { rule_name, check_key, server_id, until } = (req.body ?? {}) as any;
    if (!rule_name || !check_key || !server_id || !until) {
      return reply.code(400).send({ error: "rule_name, check_key, server_id and until are required" });
    }
    const untilDate = new Date(until);
    if (Number.isNaN(untilDate.getTime()) || untilDate <= new Date()) {
      return reply.code(400).send({ error: "until must be a valid time in the future" });
    }
    const createdBy = (req as any).user as string;
    const { rows } = await query(
      `INSERT INTO alert_mutes (rule_name, check_key, server_id, until, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (rule_name, check_key, server_id)
       DO UPDATE SET until = $4, created_by = $5, created_at = now()
       RETURNING *`,
      [rule_name, check_key, parseInt(server_id, 10), untilDate, createdBy],
    );
    await audit(createdBy, "mute.create", "alert_mute", `${server_id}/${rule_name}/${check_key}`,
      { until: untilDate.toISOString() });
    return rows[0];
  });

  app.delete("/api/mutes", { preHandler: requireOperator }, async (req, reply) => {
    const { rule_name, check_key, server_id } = (req.query ?? {}) as any;
    if (!rule_name || !check_key || !server_id) {
      return reply.code(400).send({ error: "rule_name, check_key and server_id are required" });
    }
    await query(
      `DELETE FROM alert_mutes WHERE rule_name = $1 AND check_key = $2 AND server_id = $3`,
      [rule_name, check_key, parseInt(server_id, 10)],
    );
    await audit((req as any).user, "mute.delete", "alert_mute", `${server_id}/${rule_name}/${check_key}`);
    return { ok: true };
  });
}
