import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { hashApiKey } from "../auth.js";
import { applyProbeResult, type ProbeContext } from "../engine/prober.js";

/**
 * Receiving end for 'push' probes — an external runner (outside this
 * network, so it can actually observe a hairpin-NAT'd public endpoint) POSTs
 * its own check result here instead of Alfred polling it. See schema.ts for
 * why this is deliberately excluded from the offline sweep.
 */
export async function probePushRoutes(app: FastifyInstance) {
  app.post("/api/probes/:id/push", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
        keyGenerator: (req: any) => String(req.headers["x-api-key"] || req.ip),
      },
    },
  }, async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!key || typeof key !== "string") {
      return reply.code(401).send({ error: "missing X-API-Key" });
    }
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query<ProbeContext & { push_key_hash: string | null }>(
      `SELECT p.id, p.server_id, p.type, p.target, p.push_key_hash,
              s.display_name, s.brand, s.tags, s.status, parent.display_name AS parent_display_name
       FROM probes p JOIN servers s ON s.id = p.server_id
                      LEFT JOIN servers parent ON parent.id = s.parent_id
       WHERE p.id = $1 AND p.type = 'push'`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const probe = rows[0];
    if (!probe.push_key_hash || probe.push_key_hash !== hashApiKey(key)) {
      return reply.code(401).send({ error: "unknown or revoked push key" });
    }

    const body = (req.body ?? {}) as any;
    if (typeof body.up !== "boolean") {
      return reply.code(400).send({ error: "'up' (boolean) is required" });
    }
    await applyProbeResult(probe, {
      up: body.up,
      latency_ms: typeof body.latency_ms === "number" ? body.latency_ms : null,
      status_code: typeof body.status_code === "number" ? body.status_code : null,
      cert_days_remaining: null,
      error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
    });

    return { ok: true };
  });
}
