import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireOperator } from "../auth.js";
import { audit } from "../audit.js";

/** Reusable SQL Server connection presets for Data-type Monitored Tasks. */
export async function dataConnectionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  app.get("/api/data-connections", async () => {
    const { rows } = await query(
      `SELECT dc.*, c.name AS credential_name
       FROM data_connections dc LEFT JOIN credentials c ON c.id = dc.credential_id
       ORDER BY dc.name`,
    );
    return rows;
  });

  app.post("/api/data-connections", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const host = typeof body.host === "string" ? body.host.trim() : "";
    const database = typeof body.database_name === "string" ? body.database_name.trim() : "";
    if (!name || !host || !database) return reply.code(400).send({ error: "name, host and database_name are required" });

    const { rows } = await query(
      `INSERT INTO data_connections (name, host, database_name, credential_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, host, database, body.credential_id ?? null],
    );
    await audit((req as any).user, "data_connection.create", "data_connection", rows[0].id, { name, host });
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch("/api/data-connections/:id", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows: existing } = await query(`SELECT * FROM data_connections WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as any;
    const merged = { ...existing[0], ...body };
    await query(
      `UPDATE data_connections SET name = $2, host = $3, database_name = $4, credential_id = $5 WHERE id = $1`,
      [id, String(merged.name).trim(), String(merged.host).trim(), String(merged.database_name).trim(), merged.credential_id ?? null],
    );
    await audit((req as any).user, "data_connection.update", "data_connection", id, { name: merged.name });
    return { ok: true };
  });

  app.delete("/api/data-connections/:id", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(`SELECT name FROM data_connections WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await query(`DELETE FROM data_connections WHERE id = $1`, [id]);
    await audit((req as any).user, "data_connection.delete", "data_connection", id, { name: rows[0].name });
    return { ok: true };
  });
}
