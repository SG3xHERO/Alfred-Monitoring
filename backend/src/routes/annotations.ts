import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireOperator, requireWallAccess } from "../auth.js";
import { matchServers, type MatchedServer } from "./dashboards.js";

const RANGE_INTERVALS: Record<string, string> = {
  "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days", "30d": "30 days",
};

/** Does an annotation's target string apply to this server? Same grammar as rules, plus a bare id. */
function appliesTo(target: string, s: MatchedServer): boolean {
  const t = String(target || "*").trim().toLowerCase();
  if (t === "*") return true;
  if (t.startsWith("group:")) return s.brand.toLowerCase() === t.slice(6).trim();
  if (t.startsWith("tag:")) return s.tags.some((x) => x.toLowerCase() === t.slice(4).trim());
  if (/^\d+$/.test(t)) return s.id === parseInt(t, 10);
  return t === s.display_name.toLowerCase() || t === (s.hostname || "").toLowerCase();
}

export async function annotationRoutes(app: FastifyInstance) {
  /**
   * Annotations visible on a chart for ?target= (same syntax as rule targets)
   * within ?range= (defaults 24h). An annotation shows if its own target
   * overlaps any server the chart's target matches. Registered ahead of the
   * requireAuth hook below, with its own wall-token-aware preHandler, so
   * chart panels embedded in the Wall keep working on an unauthenticated
   * kiosk display (?wall_token=…) — same reasoning as panel-data.
   */
  app.get("/api/annotations", { preHandler: requireWallAccess }, async (req) => {
    const q = req.query as any;
    const interval = RANGE_INTERVALS[q.range] ?? RANGE_INTERVALS["24h"];
    const servers = await matchServers(q.target ?? "*");
    const { rows } = await query(
      `SELECT * FROM annotations WHERE time > now() - $1::interval ORDER BY time DESC LIMIT 200`,
      [interval],
    );
    return rows.filter((a) => servers.some((s) => appliesTo(a.target, s)));
  });

  app.addHook("preHandler", requireAuth);

  app.post("/api/annotations", { preHandler: requireOperator }, async (req, reply) => {
    const { target, time, text } = (req.body ?? {}) as any;
    if (!text || typeof text !== "string" || !text.trim()) {
      return reply.code(400).send({ error: "text is required" });
    }
    const at = time ? new Date(time) : new Date();
    if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: "invalid time" });
    const { rows } = await query(
      `INSERT INTO annotations (target, time, text, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(target || "*").trim() || "*", at, text.trim().slice(0, 300), (req as any).user],
    );
    return reply.code(201).send(rows[0]);
  });

  app.delete("/api/annotations/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rowCount } = await query(`DELETE FROM annotations WHERE id = $1`, [id]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}
