import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAdmin } from "../auth.js";

/** Read side of the audit log — admin-only, filterable by user/action/date. */
export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/audit", async (req) => {
    const q = req.query as any;
    const params: any[] = [];
    const where: string[] = [];
    if (q.user) { params.push(q.user); where.push(`username = $${params.length}`); }
    if (q.action) { params.push(`${q.action}%`); where.push(`action LIKE $${params.length}`); }
    if (q.from) { params.push(q.from); where.push(`at >= $${params.length}`); }
    if (q.to) { params.push(q.to); where.push(`at <= $${params.length}`); }
    const limit = Math.min(parseInt(q.limit || "200", 10), 1000);
    const { rows } = await query(
      `SELECT * FROM audit_log
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY at DESC LIMIT ${limit}`,
      params,
    );
    return rows;
  });

  app.get("/api/audit/actions", async () => {
    const { rows } = await query(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
    return rows.map((r) => r.action);
  });
}
