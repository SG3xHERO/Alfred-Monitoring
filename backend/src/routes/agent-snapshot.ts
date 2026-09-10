import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { hashApiKey } from "../auth.js";
import { broadcast } from "../sse.js";

/**
 * The agent posts a captured SQL diagnostic snapshot back here once it's
 * done — same X-API-Key auth as /api/ingest, since this route is agent-facing
 * (not a browser session).
 */
export async function agentSnapshotRoutes(app: FastifyInstance) {
  app.post("/api/agent/snapshot", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!key || typeof key !== "string") {
      return reply.code(401).send({ error: "missing X-API-Key" });
    }
    const { rows: servers } = await query(
      `SELECT id FROM servers WHERE api_key_hash = $1`,
      [hashApiKey(key)],
    );
    if (servers.length === 0) {
      return reply.code(401).send({ error: "unknown or revoked API key" });
    }
    const serverId = servers[0].id;

    const body = (req.body ?? {}) as any;
    const id = parseInt(body.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid id" });

    // ownership + idempotency: only the owning server can complete its own
    // request, and only once — ignore duplicate/late posts.
    const { rows } = await query(
      `SELECT id, incident_id FROM sql_snapshots
       WHERE id = $1 AND server_id = $2 AND status = 'requested'`,
      [id, serverId],
    );
    if (rows.length === 0) return { ok: true }; // already completed or not ours — no-op

    const status = body.error ? "error" : "ok";
    await query(
      `UPDATE sql_snapshots SET
         status = $2, captured_at = now(),
         top_queries = $3, blocking = $4, jobs = $5, error = $6
       WHERE id = $1`,
      [id, status,
        body.top_queries ? JSON.stringify(body.top_queries) : null,
        body.blocking ? JSON.stringify(body.blocking) : null,
        body.jobs ? JSON.stringify(body.jobs) : null,
        body.error ?? null],
    );

    broadcast("sql_snapshot", { server_id: serverId, incident_id: rows[0].incident_id, snapshot_id: id });
    return { ok: true };
  });

  // Agent reports the outcome of an admin-triggered binary update attempt
  // (POST /api/servers/:id/request-update). agent_version itself updates
  // naturally on the next successful ingest — this just clears the pending
  // request and lets the UI show success/failure.
  app.post("/api/agent/update-result", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!key || typeof key !== "string") {
      return reply.code(401).send({ error: "missing X-API-Key" });
    }
    const { rows: servers } = await query(
      `SELECT id FROM servers WHERE api_key_hash = $1`,
      [hashApiKey(key)],
    );
    if (servers.length === 0) {
      return reply.code(401).send({ error: "unknown or revoked API key" });
    }
    const serverId = servers[0].id;

    const body = (req.body ?? {}) as any;
    await query(
      `UPDATE servers SET update_requested_version = NULL, update_requested_at = NULL WHERE id = $1`,
      [serverId],
    );
    if (!body.ok) {
      console.error(`agent update failed on server ${serverId}: ${body.error || "unknown error"}`);
    }
    broadcast("server", { id: serverId, update_result: body.ok ? "ok" : "error", update_error: body.error });
    return { ok: true };
  });
}
