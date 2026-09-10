import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { query } from "../db.js";
import { requireOperator, hashApiKey, generateApiKey } from "../auth.js";
import { audit } from "../audit.js";
import { encryptSecret, decryptSecret, isEncrypted } from "../crypto.js";
import { getDefaultBrand, ensureBrand } from "./brands.js";

/**
 * Synthetic HTTP/TCP probes. Each probe owns a shadow row in `servers`
 * (kind='probe') that carries name/brand/tags/status, so rules, incidents,
 * mutes and the Overview/Wall groupings treat probes like any other server.
 * This file only manages the probe-specific config and read views.
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const PROBE_TYPES = ["http", "tcp", "api", "push", "ping", "directory", "data"];

function validateProbeConfig(body: any): string | null {
  if (!PROBE_TYPES.includes(body.type)) {
    return `type must be one of ${PROBE_TYPES.join(", ")}`;
  }
  if (body.type === "push") {
    const interval = body.interval_seconds ?? 60;
    if (!Number.isInteger(interval) || interval < 10 || interval > 86400) {
      return "interval_seconds must be between 10 and 86400";
    }
    return null;
  }
  if (body.type === "directory") {
    if (!body.target || !String(body.target).trim()) return "target (UNC path) is required";
    if (!body.file_mask || !String(body.file_mask).trim()) return "file_mask is required";
    if (body.severe_threshold == null) return "severe_threshold is required";
  } else if (body.type === "data") {
    if (!body.connection_id) return "connection_id is required";
    if (!body.procedure_name || !String(body.procedure_name).trim()) return "procedure_name is required";
    if (body.severe_threshold == null) return "severe_threshold is required";
  } else if (body.type === "ping") {
    if (!body.target || !String(body.target).trim()) return "target (IP address) is required";
  } else {
    const target = typeof body.target === "string" ? body.target.trim() : "";
    if (!target) return "target is required";
    if (body.type === "http" || body.type === "api") {
      try {
        const u = new URL(target);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "target must be an http(s):// URL";
      } catch {
        return "target must be a valid URL";
      }
    } else if (!/^.+:\d+$/.test(target)) {
      return "target must be host:port";
    }
  }
  const interval = body.interval_seconds ?? 60;
  if (!Number.isInteger(interval) || interval < 10 || interval > 86400) {
    return "interval_seconds must be between 10 and 86400";
  }
  const timeout = body.timeout_ms ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) {
    return "timeout_ms must be between 100 and 60000";
  }
  if (body.expected_status != null &&
      (!Number.isInteger(body.expected_status) || body.expected_status < 100 || body.expected_status > 599)) {
    return "expected_status must be an HTTP status code";
  }
  if (body.type === "api") {
    const method = String(body.method || "GET").toUpperCase();
    if (!HTTP_METHODS.has(method)) return "method must be one of GET, POST, PUT, PATCH, DELETE";
    if (body.headers != null && (typeof body.headers !== "object" || Array.isArray(body.headers))) {
      return "headers must be an object of header name to value";
    }
    if (body.headers) {
      for (const v of Object.values(body.headers)) {
        if (typeof v !== "string") return "header values must be strings";
      }
    }
    if (body.json_expected != null && !body.json_path) {
      return "json_path is required when json_expected is set";
    }
    if (body.max_age_minutes != null) {
      if (!body.timestamp_path) return "timestamp_path is required when max_age_minutes is set";
      if (!Number.isInteger(body.max_age_minutes) || body.max_age_minutes < 1 || body.max_age_minutes > 43200) {
        return "max_age_minutes must be between 1 and 43200";
      }
    }
    if (body.auth_url) {
      try {
        const u = new URL(body.auth_url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "auth_url must be an http(s):// URL";
      } catch {
        return "auth_url must be a valid URL";
      }
    }
  }
  return null;
}

export async function probeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  app.get("/api/probes", async () => {
    const { rows } = await query(
      `SELECT p.id, p.server_id, p.type, p.target, p.interval_seconds, p.timeout_ms,
              p.expected_status, p.method, p.headers, p.body, p.auth_token,
              p.json_path, p.json_expected, p.timestamp_path, p.max_age_minutes,
              p.auth_url, p.auth_body, p.auth_token_path, p.fail_on_graphql_errors, p.created_at,
              p.warning_threshold, p.severe_threshold, p.file_mask, p.credential_id,
              p.connection_id, p.procedure_name,
              s.display_name AS name, s.brand, s.tags, s.status, s.status_since, s.last_seen,
              s.parent_id, s.last_snapshot->'probe' AS last
       FROM probes p JOIN servers s ON s.id = p.server_id
       ORDER BY s.brand, s.display_name`,
    );
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    // % of checks up over 24h — the probe equivalent of heartbeat uptime
    const { rows: up24 } = await query(
      `SELECT probe_id, round(avg(up::int) * 1000) / 10 AS uptime
       FROM probe_results WHERE probe_id = ANY($1) AND time > now() - interval '24 hours'
       GROUP BY probe_id`,
      [ids],
    );
    const upMap = new Map(up24.map((r) => [r.probe_id, parseFloat(r.uptime)]));

    // last ~40 samples per probe for the latency sparkline
    const { rows: spark } = await query(
      `SELECT probe_id, time, up, latency_ms FROM (
         SELECT probe_id, time, up, latency_ms,
                row_number() OVER (PARTITION BY probe_id ORDER BY time DESC) AS rn
         FROM probe_results WHERE probe_id = ANY($1) AND time > now() - interval '24 hours'
       ) x WHERE rn <= 40 ORDER BY probe_id, time`,
      [ids],
    );
    const sparkMap = new Map<number, any[]>();
    for (const s of spark) {
      if (!sparkMap.has(s.probe_id)) sparkMap.set(s.probe_id, []);
      sparkMap.get(s.probe_id)!.push({ time: s.time, up: s.up, latency_ms: s.latency_ms });
    }

    return rows.map((r) => ({
      ...r,
      // decrypted for the operator edit form — same exposure as probe variables
      auth_token: r.auth_token ? decryptSecret(r.auth_token) : r.auth_token,
      uptime_24h: upMap.get(r.id) ?? null,
      spark: sparkMap.get(r.id) ?? [],
    }));
  });

  app.post("/api/probes", { preHandler: requireOperator }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    const invalid = validateProbeConfig(body);
    if (invalid) return reply.code(400).send({ error: invalid });

    // the shadow row needs a unique key hash but is never ingested against
    const shadowKey = hashApiKey("probe:" + crypto.randomBytes(24).toString("base64url"));
    const resolvedBrand = body.brand || await getDefaultBrand();
    await ensureBrand(resolvedBrand);
    const { rows: srv } = await query(
      `INSERT INTO servers (display_name, brand, tags, interval_seconds, api_key_hash, kind, group_key, parent_id)
       VALUES ($1, $2, $3, $4, $5, 'probe', $6, $7) RETURNING id`,
      [body.name.trim(), resolvedBrand, body.tags || [],
        body.interval_seconds ?? 60, shadowKey, body.group_key || null, body.parent_id ?? null],
    );
    const pushKey = body.type === "push" ? generateApiKey() : null;
    const { rows } = await query(
      `INSERT INTO probes (server_id, type, target, interval_seconds, timeout_ms, expected_status,
                            method, headers, body, auth_token, json_path, json_expected,
                            timestamp_path, max_age_minutes, auth_url, auth_body, auth_token_path,
                            fail_on_graphql_errors, push_key_hash,
                            warning_threshold, severe_threshold, file_mask, credential_id,
                            connection_id, procedure_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [srv[0].id, body.type, body.type === "push" ? "push" : body.target.trim(), body.interval_seconds ?? 60,
        body.timeout_ms ?? 5000, body.expected_status ?? null,
        String(body.method || "GET").toUpperCase(),
        body.headers ? JSON.stringify(body.headers) : null,
        body.body || null, body.auth_token ? encryptSecret(body.auth_token) : null,
        body.json_path || null, body.json_expected || null,
        body.timestamp_path || null, body.max_age_minutes ?? null,
        body.auth_url || null, body.auth_body || null, body.auth_token_path || null,
        !!body.fail_on_graphql_errors, pushKey ? hashApiKey(pushKey) : null,
        body.warning_threshold ?? null, body.severe_threshold ?? null, body.file_mask || null,
        body.credential_id ?? null, body.connection_id ?? null, body.procedure_name || null],
    );
    await audit((req as any).user, "probe.create", "probe", rows[0].id,
      { name: body.name, type: body.type, target: body.target });
    // the plaintext push key is shown exactly once; only its hash is stored
    return reply.code(201).send(pushKey ? { ...rows[0], push_key: pushKey } : rows[0]);
  });

  app.patch("/api/probes/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const body = (req.body ?? {}) as any;
    const { rows: existing } = await query(`SELECT * FROM probes WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });

    const merged = { ...existing[0], ...body };
    const invalid = validateProbeConfig(merged);
    if (invalid) return reply.code(400).send({ error: invalid });

    await query(
      `UPDATE probes SET type = $2, target = $3, interval_seconds = $4, timeout_ms = $5, expected_status = $6,
                          method = $7, headers = $8, body = $9, auth_token = $10,
                          json_path = $11, json_expected = $12, timestamp_path = $13, max_age_minutes = $14,
                          auth_url = $15, auth_body = $16, auth_token_path = $17, fail_on_graphql_errors = $18,
                          warning_threshold = $19, severe_threshold = $20, file_mask = $21, credential_id = $22,
                          connection_id = $23, procedure_name = $24
       WHERE id = $1`,
      [id, merged.type, String(merged.target).trim(), merged.interval_seconds,
        merged.timeout_ms, merged.expected_status ?? null,
        String(merged.method || "GET").toUpperCase(),
        merged.headers ? JSON.stringify(merged.headers) : null,
        // a patched token arrives plaintext; an untouched one is already ciphertext
        merged.body || null,
        merged.auth_token ? (isEncrypted(merged.auth_token) ? merged.auth_token : encryptSecret(merged.auth_token)) : null,
        merged.json_path || null, merged.json_expected || null,
        merged.timestamp_path || null, merged.max_age_minutes ?? null,
        merged.auth_url || null, merged.auth_body || null, merged.auth_token_path || null,
        !!merged.fail_on_graphql_errors,
        merged.warning_threshold ?? null, merged.severe_threshold ?? null, merged.file_mask || null,
        merged.credential_id ?? null, merged.connection_id ?? null, merged.procedure_name || null],
    );
    const hasParent = Object.prototype.hasOwnProperty.call(body, "parent_id");
    if (body.brand) await ensureBrand(body.brand);
    await query(
      `UPDATE servers SET
         display_name = COALESCE($2, display_name),
         brand = COALESCE($3, brand),
         tags = COALESCE($4, tags),
         interval_seconds = $5,
         parent_id = CASE WHEN $6 THEN $7 ELSE parent_id END
       WHERE id = $1`,
      [existing[0].server_id, body.name?.trim() || null, body.brand ?? null,
        body.tags ?? null, merged.interval_seconds,
        hasParent, hasParent ? (body.parent_id ?? null) : null],
    );
    await audit((req as any).user, "probe.update", "probe", id, body);
    return { ok: true };
  });

  app.post("/api/probes/:id/rotate-push-key", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows: existing } = await query(`SELECT type FROM probes WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    if (existing[0].type !== "push") return reply.code(400).send({ error: "not a push probe" });
    const pushKey = generateApiKey();
    await query(`UPDATE probes SET push_key_hash = $2 WHERE id = $1`, [id, hashApiKey(pushKey)]);
    await audit((req as any).user, "probe.rotate_push_key", "probe", id, {});
    return { push_key: pushKey };
  });

  app.delete("/api/probes/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(
      `SELECT p.server_id, s.display_name FROM probes p JOIN servers s ON s.id = p.server_id
       WHERE p.id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await query(`DELETE FROM probe_results WHERE probe_id = $1`, [id]);
    // cascades to the probes row, alert states, mutes and incidents
    await query(`DELETE FROM servers WHERE id = $1`, [rows[0].server_id]);
    await audit((req as any).user, "probe.delete", "probe", id, { name: rows[0].display_name });
    return { ok: true };
  });
}
