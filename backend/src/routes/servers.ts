import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireOperator, requireWallAccess, generateApiKey, hashApiKey } from "../auth.js";
import { audit } from "../audit.js";
import { currentVersion } from "./agent-releases.js";
import { getDefaultBrand, ensureBrand } from "./brands.js";

const RANGES: Record<string, { interval: string; bucketSec: number }> = {
  "1h": { interval: "1 hour", bucketSec: 30 },
  "6h": { interval: "6 hours", bucketSec: 120 },
  "24h": { interval: "24 hours", bucketSec: 600 },
  "7d": { interval: "7 days", bucketSec: 3600 },
  "30d": { interval: "30 days", bucketSec: 14400 },
};

export async function serverRoutes(app: FastifyInstance) {
  // GET /api/servers is the one route the Wall kiosk needs without a login
  // session, via ?wall_token=; every other route here still needs a real
  // session (requireOperator implies requireAuth too).
  app.get("/api/servers", { preHandler: requireWallAccess }, async () => {
    const { rows: servers } = await query(
      `SELECT id, hostname, ip_address, display_name, brand, tags, os, platform, agent_version,
              status, status_since, last_seen, first_seen, interval_seconds, created_at, kind, group_key, parent_id,
              last_snapshot->'cpu'->>'percent' AS cpu_pct,
              last_snapshot->'memory'->>'percent' AS mem_pct,
              last_snapshot->'disks' AS disks,
              last_snapshot->'probe' AS probe
       FROM servers ORDER BY brand, display_name`,
    );

    // heartbeat coverage per window = observed samples / expected samples
    const { rows: coverage } = await query(
      `SELECT server_id,
              count(*) FILTER (WHERE time > now() - interval '24 hours')::int AS c24,
              count(*) FILTER (WHERE time > now() - interval '7 days')::int  AS c7d,
              count(*) FILTER (WHERE time > now() - interval '30 days')::int AS c30d,
              count(*)::int AS c90d
       FROM metrics WHERE time > now() - interval '90 days'
       GROUP BY server_id`,
    );
    const covMap = new Map(coverage.map((c) => [c.server_id, c]));

    // probe uptime is % of checks that were up, not heartbeat coverage
    const { rows: probeUp } = await query(
      `SELECT p.server_id,
              round(avg(r.up::int) FILTER (WHERE r.time > now() - interval '24 hours') * 1000) / 10 AS u24,
              round(avg(r.up::int) FILTER (WHERE r.time > now() - interval '7 days')   * 1000) / 10 AS u7d,
              round(avg(r.up::int) FILTER (WHERE r.time > now() - interval '30 days')  * 1000) / 10 AS u30d,
              round(avg(r.up::int) * 1000) / 10 AS u90d
       FROM probe_results r JOIN probes p ON p.id = r.probe_id
       WHERE r.time > now() - interval '90 days'
       GROUP BY p.server_id`,
    );
    const probeUpMap = new Map(probeUp.map((c) => [c.server_id, c]));

    const { rows: incidents } = await query(
      `SELECT i.id, i.server_id, i.rule_name, i.check_key, i.severity, i.message, i.started_at
       FROM incidents i WHERE i.resolved_at IS NULL AND NOT i.suppressed
       ORDER BY i.started_at DESC`,
    );
    const incMap = new Map<number, any[]>();
    for (const i of incidents) {
      if (!incMap.has(i.server_id)) incMap.set(i.server_id, []);
      incMap.get(i.server_id)!.push(i);
    }

    const now = Date.now();
    return servers.map((s) => {
      const cov = covMap.get(s.id);
      const uptime = (windowSec: number, observed: number) => {
        if (!s.first_seen) return null;
        const knownSec = Math.min(windowSec, (now - new Date(s.first_seen).getTime()) / 1000);
        if (knownSec < s.interval_seconds * 2) return null;
        const expected = knownSec / s.interval_seconds;
        return Math.min(100, Math.round((observed / expected) * 1000) / 10);
      };
      const pu = s.kind === "probe" ? probeUpMap.get(s.id) : undefined;
      const num = (v: any) => (v == null ? null : parseFloat(v));
      return {
        ...s,
        cpu_pct: s.cpu_pct != null ? parseFloat(s.cpu_pct) : null,
        mem_pct: s.mem_pct != null ? parseFloat(s.mem_pct) : null,
        uptime_24h: pu ? num(pu.u24) : uptime(86400, cov?.c24 ?? 0),
        uptime_7d: pu ? num(pu.u7d) : uptime(7 * 86400, cov?.c7d ?? 0),
        uptime_30d: pu ? num(pu.u30d) : uptime(30 * 86400, cov?.c30d ?? 0),
        uptime_90d: pu ? num(pu.u90d) : uptime(90 * 86400, cov?.c90d ?? 0),
        active_incidents: incMap.get(s.id) ?? [],
      };
    });
  });

  app.post("/api/servers", { preHandler: requireOperator }, async (req, reply) => {
    const { display_name, brand, tags, interval_seconds, desired_config, parent_id } = (req.body ?? {}) as any;
    if (!display_name) return reply.code(400).send({ error: "display_name is required" });
    const resolvedBrand = brand || await getDefaultBrand();
    await ensureBrand(resolvedBrand);
    const apiKey = generateApiKey();
    const { rows } = await query(
      `INSERT INTO servers (display_name, brand, tags, interval_seconds, api_key_hash, desired_config, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [display_name, resolvedBrand, tags || [],
        interval_seconds || 15, hashApiKey(apiKey),
        desired_config ? JSON.stringify(desired_config) : null,
        parent_id || null],
    );
    await audit((req as any).user, "server.create", "server", rows[0].id, { display_name, brand, desired_config });
    // the plaintext key is shown exactly once; only its hash is stored
    return { id: rows[0].id, api_key: apiKey };
  });

  app.get("/api/servers/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(
      `SELECT s.*, p.type AS probe_type, p.target AS probe_target,
              p.warning_threshold AS probe_warning_threshold, p.severe_threshold AS probe_severe_threshold,
              p.file_mask AS probe_file_mask, p.procedure_name AS probe_procedure_name,
              parent.display_name AS parent_display_name
       FROM servers s LEFT JOIN probes p ON p.server_id = s.id
                       LEFT JOIN servers parent ON parent.id = s.parent_id
       WHERE s.id = $1`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const { api_key_hash, ...server } = rows[0];

    const { rows: cov } = await query(
      `SELECT count(*) FILTER (WHERE time > now() - interval '24 hours')::int AS c24,
              count(*) FILTER (WHERE time > now() - interval '7 days')::int  AS c7d,
              count(*) FILTER (WHERE time > now() - interval '30 days')::int AS c30d,
              count(*)::int AS c90d
       FROM metrics WHERE server_id = $1 AND time > now() - interval '90 days'`,
      [id],
    );
    const uptime = (windowSec: number, observed: number) => {
      if (!server.first_seen) return null;
      const knownSec = Math.min(windowSec, (Date.now() - new Date(server.first_seen).getTime()) / 1000);
      if (knownSec < server.interval_seconds * 2) return null;
      const expected = knownSec / server.interval_seconds;
      return Math.min(100, Math.round((observed / expected) * 1000) / 10);
    };

    // nested devices (e.g. a HyperV host's guest VMs, or sibling IPs on a
    // ping check) — shown on the parent's detail page instead of their own
    // top-level Overview/Wall row
    const { rows: nestedDevices } = await query(
      `SELECT s.id, s.display_name, s.kind, s.status, s.last_seen,
              s.last_snapshot->'probe' AS probe
       FROM servers s WHERE s.parent_id = $1 ORDER BY s.display_name`,
      [id],
    );

    return {
      ...server,
      uptime_24h: uptime(86400, cov[0]?.c24 ?? 0),
      uptime_7d: uptime(7 * 86400, cov[0]?.c7d ?? 0),
      uptime_30d: uptime(30 * 86400, cov[0]?.c30d ?? 0),
      uptime_90d: uptime(90 * 86400, cov[0]?.c90d ?? 0),
      nested_devices: nestedDevices,
    };
  });

  app.patch("/api/servers/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const body = (req.body ?? {}) as any;
    // desired_config is handled separately from COALESCE below: an explicit
    // {} should be able to clear flags back off, which COALESCE (skip-if-
    // null) can't express — only touch the column when the key is present.
    const hasConfig = Object.prototype.hasOwnProperty.call(body, "desired_config");
    // parent_id needs the same "was the key even sent" handling as
    // desired_config — COALESCE can't express "explicitly clear it back to
    // no parent" (unnest), only "leave unchanged when null".
    const hasParent = Object.prototype.hasOwnProperty.call(body, "parent_id");
    if (hasParent && body.parent_id === id) {
      return reply.code(400).send({ error: "a server can't be nested under itself" });
    }
    if (body.brand) await ensureBrand(body.brand);
    const { rows } = await query(
      `UPDATE servers SET
         display_name = COALESCE($2, display_name),
         brand = COALESCE($3, brand),
         tags = COALESCE($4, tags),
         interval_seconds = COALESCE($5, interval_seconds),
         desired_config = CASE WHEN $6 THEN $7 ELSE desired_config END,
         parent_id = CASE WHEN $8 THEN $9 ELSE parent_id END
       WHERE id = $1 RETURNING id`,
      [id, body.display_name ?? null, body.brand ?? null, body.tags ?? null,
        body.interval_seconds ?? null, hasConfig,
        hasConfig ? JSON.stringify(body.desired_config) : null,
        hasParent, hasParent ? (body.parent_id ?? null) : null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "server.update", "server", id, body);
    return { ok: true };
  });

  app.post("/api/servers/:id/rotate-key", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const apiKey = generateApiKey();
    const { rows } = await query(
      `UPDATE servers SET api_key_hash = $2 WHERE id = $1 RETURNING id`,
      [id, hashApiKey(apiKey)],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "server.rotate_key", "server", id);
    return { api_key: apiKey };
  });

  // Admin-triggered agent update — the agent picks this up (poll-based) via
  // the "update" field on its next /api/ingest response and reports back via
  // POST /api/agent/update-result.
  app.post("/api/servers/:id/request-update", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    // version is optional — omit it to target whatever build is currently
    // deployed (the common case, since there's only ever one "latest" now).
    const requested = String((req.body as any)?.version || "").trim();
    const version = requested || await currentVersion();
    if (!version) return reply.code(400).send({ error: "no agent build is currently available" });
    const { rowCount } = await query(
      `UPDATE servers SET update_requested_version = $2, update_requested_at = now() WHERE id = $1`,
      [id, version],
    );
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "server.request_update", "server", id, { version });
    return { ok: true };
  });

  // On-demand SQL diagnostic capture — no incident required. The agent picks
  // this up (poll-based) via the pending_snapshot field on its next /api/ingest
  // response and posts the result back to POST /api/agent/snapshot.
  app.post("/api/servers/:id/snapshot", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(
      `INSERT INTO sql_snapshots (server_id, incident_id, requested_by, status)
       VALUES ($1, NULL, $2, 'requested') RETURNING id`,
      [id, `user:${(req as any).user ?? "unknown"}`],
    );
    await audit((req as any).user, "server.snapshot_request", "server", id);
    return { id: rows[0].id };
  });

  app.get("/api/servers/:id/snapshots/latest", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(
      `SELECT id, incident_id, requested_at, requested_by, captured_at, status,
              top_queries, blocking, jobs, error
       FROM sql_snapshots WHERE server_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "no snapshot yet" });
    return rows[0];
  });

  app.delete("/api/servers/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows: named } = await query(`SELECT display_name FROM servers WHERE id = $1`, [id]);
    await query(`DELETE FROM metrics WHERE server_id = $1`, [id]);
    await query(
      `DELETE FROM probe_results USING probes
       WHERE probes.server_id = $1 AND probe_results.probe_id = probes.id`, [id]);
    const { rowCount } = await query(`DELETE FROM servers WHERE id = $1`, [id]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await audit((req as any).user, "server.delete", "server", id,
      { display_name: named[0]?.display_name });
    return { ok: true };
  });

  app.get("/api/servers/:id/metrics", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const range = RANGES[(req.query as any).range] ?? RANGES["24h"];
    const { rows } = await query(
      `SELECT date_bin(make_interval(secs => $3), time, TIMESTAMPTZ '2000-01-01') AS bucket,
              round(avg(cpu_pct)::numeric, 1)::float AS cpu_pct,
              round(avg(mem_pct)::numeric, 1)::float AS mem_pct,
              round(avg(swap_pct)::numeric, 1)::float AS swap_pct,
              round(avg(disk_min_free_pct)::numeric, 1)::float AS disk_min_free_pct,
              round(avg(net_rx_bps)::numeric)::float AS net_rx_bps,
              round(avg(net_tx_bps)::numeric)::float AS net_tx_bps,
              round(avg(disk_read_bps)::numeric)::float AS disk_read_bps,
              round(avg(disk_write_bps)::numeric)::float AS disk_write_bps
       FROM metrics
       WHERE server_id = $1 AND time > now() - $2::interval
       GROUP BY bucket ORDER BY bucket`,
      [id, range.interval, range.bucketSec],
    );
    return rows;
  });

  // History for a probe-kind server's detail page — mirrors /metrics above
  // but sourced from probe_results (joined via probes.server_id) instead of
  // the agent metrics table, so probes get the same "basic graph" ServerDetail
  // gives agents rather than an empty CPU/Mem/Disk chart.
  app.get("/api/servers/:id/probe-results", { preHandler: requireAuth }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const range = RANGES[(req.query as any).range] ?? RANGES["24h"];
    const { rows } = await query(
      `SELECT date_bin(make_interval(secs => $3), pr.time, TIMESTAMPTZ '2000-01-01') AS bucket,
              round(avg(pr.up::int) * 100)::float AS uptime_pct,
              round(avg(pr.latency_ms)::numeric, 1)::float AS latency_ms,
              round(avg(pr.value)::numeric, 2)::float AS value
       FROM probe_results pr JOIN probes p ON p.id = pr.probe_id
       WHERE p.server_id = $1 AND pr.time > now() - $2::interval
       GROUP BY bucket ORDER BY bucket`,
      [id, range.interval, range.bucketSec],
    );
    return rows;
  });

  app.get("/api/servers/:id/incidents", { preHandler: requireAuth }, async (req) => {
    const id = parseInt((req.params as any).id, 10);
    const { rows } = await query(
      `SELECT * FROM incidents WHERE server_id = $1 ORDER BY started_at DESC LIMIT 100`,
      [id],
    );
    return rows;
  });
}
