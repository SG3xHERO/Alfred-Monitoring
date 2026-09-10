import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAdmin, requireOperator } from "../auth.js";
import { audit } from "../audit.js";
import { encryptSecret, decryptSecret } from "../crypto.js";

/**
 * Named logins Alfred's own backend connects out with (SMB share credentials
 * for directory checks, SQL Server logins for data checks). The vault itself
 * (list with secret_set flags, create/edit/delete) is admin-only — more
 * sensitive than probe_variables (3rd-party API tokens), since these often
 * carry domain/service-account access to internal infrastructure. Operators
 * only get /names (id/name/type, no secret exposure at all) so they can pick
 * a credential while creating a Directory/Data probe. Secrets are never
 * returned to the browser, only whether one is set — same exposure model as
 * app_settings (see settings.ts).
 */

const TYPES = new Set(["smb", "sql", "generic"]);

export interface DecryptedCredential {
  id: number;
  name: string;
  type: string;
  username: string | null;
  domain: string | null;
  secret: string | null;
  extra: Record<string, unknown> | null;
}

/** For internal use by check engines (directory/data checkers) — never exposed over HTTP. */
export async function getCredential(id: number): Promise<DecryptedCredential | null> {
  const { rows } = await query(`SELECT id, name, type, username, domain, secret, extra FROM credentials WHERE id = $1`, [id]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { ...r, secret: r.secret ? decryptSecret(r.secret) : null };
}

export async function credentialRoutes(app: FastifyInstance) {
  // Operators create/edit probes (Directory/Data types need to pick a stored
  // credential) but can't manage the vault itself — this route exposes only
  // id/name/type so a probe's edit form can populate a dropdown, never a
  // secret or even whether one is set.
  app.get("/api/credentials/names", { preHandler: requireOperator }, async () => {
    const { rows } = await query(`SELECT id, name, type FROM credentials ORDER BY type, name`);
    return rows;
  });

  app.get("/api/credentials", { preHandler: requireAdmin }, async () => {
    const { rows } = await query(
      `SELECT id, name, type, username, domain, extra, created_at, updated_at, updated_by,
              (secret IS NOT NULL AND secret <> '') AS secret_set
       FROM credentials ORDER BY type, name`,
    );
    return rows;
  });

  app.post("/api/credentials", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!TYPES.has(body.type)) return reply.code(400).send({ error: "type must be 'smb', 'sql' or 'generic'" });

    const { rows } = await query(
      `INSERT INTO credentials (name, type, username, domain, secret, extra, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, body.type, body.username || null, body.domain || null,
        body.secret ? encryptSecret(body.secret) : null,
        body.extra ? JSON.stringify(body.extra) : null,
        (req as any).user],
    );
    await audit((req as any).user, "credential.create", "credential", rows[0].id, { name, type: body.type });
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch("/api/credentials/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows: existing } = await query(`SELECT * FROM credentials WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as any;
    const merged = { ...existing[0], ...body };
    if (!TYPES.has(merged.type)) return reply.code(400).send({ error: "type must be 'smb', 'sql' or 'generic'" });

    await query(
      `UPDATE credentials SET
         name = $2, type = $3, username = $4, domain = $5,
         secret = $6, extra = $7, updated_at = now(), updated_by = $8
       WHERE id = $1`,
      [id, String(merged.name).trim(), merged.type, body.username ?? existing[0].username, body.domain ?? existing[0].domain,
        // a blank secret in the request means "leave unchanged"; anything else replaces it
        body.secret ? encryptSecret(body.secret) : existing[0].secret,
        body.extra !== undefined ? JSON.stringify(body.extra) : existing[0].extra,
        (req as any).user],
    );
    await audit((req as any).user, "credential.update", "credential", id, { name: merged.name });
    return { ok: true };
  });

  app.delete("/api/credentials/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(`SELECT name FROM credentials WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await query(`DELETE FROM credentials WHERE id = $1`, [id]);
    await audit((req as any).user, "credential.delete", "credential", id, { name: rows[0].name });
    return { ok: true };
  });
}
