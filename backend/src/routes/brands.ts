import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireOperator } from "../auth.js";
import { audit } from "../audit.js";

/**
 * The admin-curated list of "brand"/group names shown on Overview and the
 * wall. servers.brand stays a plain text column (rules' group:Name,
 * maintenance targets and wall layouts all match on the string) — this is
 * the list an admin edits, not a foreign key, so renaming here doesn't
 * silently break a "group:OldName" target elsewhere without a warning.
 */

/** Falls back to "Ungrouped" if no brand has been marked default (e.g. a brand-new install). */
export async function getDefaultBrand(): Promise<string> {
  const { rows } = await query(`SELECT name FROM brands WHERE is_default LIMIT 1`);
  return rows[0]?.name ?? "Ungrouped";
}

/**
 * Makes sure `name` exists in the curated brands list, adding it (as
 * non-default, sorted to the end) if it doesn't. Called wherever a server's
 * brand can be set to free text (server create/edit, NAS/probe create) so a
 * brand typed there — e.g. renaming a server's group by hand — immediately
 * becomes a selectable option everywhere else instead of only living on that
 * one server's row until someone adds it to Settings separately.
 */
export async function ensureBrand(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const { rows: existing } = await query(`SELECT count(*)::int AS n FROM brands`);
  await query(
    `INSERT INTO brands (name, sort, is_default) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
    [trimmed, existing[0].n, existing[0].n === 0],
  );
}

function findGroupReferences(yaml: string, name: string): string[] {
  const needle = `group:${name}`.toLowerCase();
  return yaml.split("\n")
    .filter((line) => line.toLowerCase().includes(needle))
    .map((line) => line.trim());
}

export async function brandRoutes(app: FastifyInstance) {
  app.get("/api/brands", { preHandler: requireAuth }, async () => {
    const { rows } = await query(`SELECT * FROM brands ORDER BY sort, name`);
    return rows;
  });

  app.post("/api/brands", { preHandler: requireOperator }, async (req, reply) => {
    const name = String((req.body as any)?.name || "").trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    const { rows: existing } = await query(`SELECT count(*)::int AS n FROM brands`);
    const isFirst = existing[0].n === 0;
    try {
      const { rows } = await query(
        `INSERT INTO brands (name, sort, is_default) VALUES ($1, $2, $3) RETURNING *`,
        [name, existing[0].n, isFirst],
      );
      await audit((req as any).user, "brand.create", "brand", rows[0].id, { name });
      return reply.code(201).send(rows[0]);
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "a brand with that name already exists" });
      throw err;
    }
  });

  app.patch("/api/brands/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const name = String((req.body as any)?.name || "").trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    const { rows: current } = await query(`SELECT name FROM brands WHERE id = $1`, [id]);
    if (current.length === 0) return reply.code(404).send({ error: "not found" });
    const oldName = current[0].name;
    if (oldName === name) return { ok: true, warnings: [] };

    let renamed;
    try {
      const { rows } = await query(`UPDATE brands SET name = $2 WHERE id = $1 RETURNING *`, [id, name]);
      renamed = rows[0];
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "a brand with that name already exists" });
      throw err;
    }
    await query(`UPDATE servers SET brand = $2 WHERE brand = $1`, [oldName, name]);

    // Rename doesn't rewrite rule/maintenance targets — surface anything
    // that referenced the old name by group: so it isn't silently orphaned.
    const { rows: rulesDoc } = await query(`SELECT yaml FROM rules_doc WHERE id = 1`);
    const warnings = rulesDoc.length ? findGroupReferences(rulesDoc[0].yaml, oldName) : [];

    await audit((req as any).user, "brand.rename", "brand", id, { from: oldName, to: name, warnings });
    return { ok: true, brand: renamed, warnings };
  });

  app.post("/api/brands/:id/default", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(`SELECT id FROM brands WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await query(`UPDATE brands SET is_default = (id = $1)`, [id]);
    await audit((req as any).user, "brand.set_default", "brand", id, {});
    return { ok: true };
  });

  app.delete("/api/brands/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const reassignTo = String((req.query as any)?.reassign_to || "").trim();
    const { rows: current } = await query(`SELECT name, is_default FROM brands WHERE id = $1`, [id]);
    if (current.length === 0) return reply.code(404).send({ error: "not found" });
    const { name } = current[0];

    const { rows: inUse } = await query(`SELECT count(*)::int AS n FROM servers WHERE brand = $1`, [name]);
    if (inUse[0].n > 0) {
      if (!reassignTo) {
        return reply.code(400).send({ error: `${inUse[0].n} server(s) use this brand — pass reassign_to to move them first` });
      }
      await query(`UPDATE servers SET brand = $2 WHERE brand = $1`, [name, reassignTo]);
    }
    await query(`DELETE FROM brands WHERE id = $1`, [id]);
    if (current[0].is_default) {
      await query(
        `UPDATE brands SET is_default = true WHERE id = (SELECT id FROM brands ORDER BY sort, name LIMIT 1)`,
      );
    }
    await audit((req as any).user, "brand.delete", "brand", id, { name, reassignTo: reassignTo || null });
    return { ok: true };
  });
}
