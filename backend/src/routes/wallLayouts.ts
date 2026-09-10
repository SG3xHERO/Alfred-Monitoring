import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireWallAccess } from "../auth.js";

/**
 * Saved "monitor wall" layouts — a user-designed arrangement of server tiles
 * into custom columns, shareable with everyone (public) or kept for one
 * person (private). `config` is a free-form JSON blob:
 *   { sections: [{ id: string, title: string, serverIds: number[] }],
 *     hiddenServerIds?: number[] }
 * hiddenServerIds are servers explicitly excluded from the wall (dropped in
 * "Unplaced" in the designer) — kept out of any "Other servers" catch-all too.
 */
export async function wallLayoutRoutes(app: FastifyInstance) {
  // Reads use requireWallAccess so the Wall kiosk (?wall_token=) can load
  // layouts without a login session; writes always need a real session.
  app.get("/api/wall-layouts", { preHandler: requireWallAccess }, async (req) => {
    const me = (req as any).user as string | undefined;
    const { rows } = await query(
      me
        ? `SELECT id, name, owner, is_public, updated_at FROM wall_layouts WHERE owner = $1 OR is_public ORDER BY name`
        : `SELECT id, name, owner, is_public, updated_at FROM wall_layouts WHERE is_public ORDER BY name`,
      me ? [me] : [],
    );
    return rows.map((r: any) => ({ ...r, mine: !!me && r.owner === me }));
  });

  app.get("/api/wall-layouts/:id", { preHandler: requireWallAccess }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const me = (req as any).user as string | undefined;
    const { rows } = await query(`SELECT * FROM wall_layouts WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const layout = rows[0];
    if (layout.owner !== me && !layout.is_public) {
      return reply.code(403).send({ error: "this layout is private" });
    }
    return { ...layout, mine: !!me && layout.owner === me };
  });

  app.post("/api/wall-layouts", { preHandler: requireAuth }, async (req, reply) => {
    const me = (req as any).user as string;
    const { name, is_public, config } = (req.body ?? {}) as any;
    if (!name || typeof name !== "string" || !name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (!config || typeof config !== "object" || !Array.isArray(config.sections)) {
      return reply.code(400).send({ error: "config.sections must be an array" });
    }
    const { rows } = await query(
      `INSERT INTO wall_layouts (name, owner, is_public, config)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), me, !!is_public, JSON.stringify(config)],
    );
    return reply.code(201).send({ ...rows[0], mine: true });
  });

  app.put("/api/wall-layouts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const me = (req as any).user as string;
    const { rows: existing } = await query(`SELECT owner FROM wall_layouts WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    if (existing[0].owner !== me) return reply.code(403).send({ error: "not your layout" });

    const { name, is_public, config } = (req.body ?? {}) as any;
    if (!name || typeof name !== "string" || !name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (!config || typeof config !== "object" || !Array.isArray(config.sections)) {
      return reply.code(400).send({ error: "config.sections must be an array" });
    }
    const { rows } = await query(
      `UPDATE wall_layouts SET name = $2, is_public = $3, config = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, name.trim(), !!is_public, JSON.stringify(config)],
    );
    return { ...rows[0], mine: true };
  });

  app.delete("/api/wall-layouts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const me = (req as any).user as string;
    const { rows: existing } = await query(`SELECT owner FROM wall_layouts WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    if (existing[0].owner !== me) return reply.code(403).send({ error: "not your layout" });

    await query(`DELETE FROM wall_layouts WHERE id = $1`, [id]);
    return { ok: true };
  });
}
