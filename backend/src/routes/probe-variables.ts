import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireOperator } from "../auth.js";
import { audit } from "../audit.js";
import { encryptSecret, decryptSecret } from "../crypto.js";

/**
 * Named secrets referenced from probe fields as {{Name}} — see schema.ts.
 * Operator/admin-only end to end; values are never exposed to viewers.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function probeVariableRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  app.get("/api/probe-variables", async () => {
    const { rows } = await query(`SELECT name, value, updated_at FROM probe_variables ORDER BY name`);
    // decrypted for the operator UI — same exposure as before encryption-at-rest
    return rows.map((r) => ({ ...r, value: decryptSecret(r.value) }));
  });

  app.put("/api/probe-variables/:name", async (req, reply) => {
    const name = (req.params as any).name;
    if (!NAME_RE.test(name)) {
      return reply.code(400).send({ error: "name must start with a letter or underscore and contain only letters, numbers and underscores" });
    }
    const { value } = (req.body ?? {}) as any;
    if (typeof value !== "string" || !value) {
      return reply.code(400).send({ error: "value is required" });
    }
    await query(
      `INSERT INTO probe_variables (name, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (name) DO UPDATE SET value = $2, updated_at = now()`,
      [name, encryptSecret(value)],
    );
    await audit((req as any).user, "probe_variable.set", "probe_variable", name, { name });
    return { ok: true };
  });

  app.delete("/api/probe-variables/:name", async (req, reply) => {
    const name = (req.params as any).name;
    await query(`DELETE FROM probe_variables WHERE name = $1`, [name]);
    await audit((req as any).user, "probe_variable.delete", "probe_variable", name, { name });
    return { ok: true };
  });
}
