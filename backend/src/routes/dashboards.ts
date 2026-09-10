import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireOperator, requireWallAccess } from "../auth.js";
import { audit } from "../audit.js";

/**
 * Custom dashboards — a deliberate subset of Grafana's panel model. A panel
 * picks metrics from the catalog below, a target (same syntax rules use),
 * an aggregation across matched servers, a range and a chart type. Ownership
 * and visibility mirror wall_layouts exactly.
 */

// Chartable metrics keyed by their rule-DSL path name (KNOWN_PATHS), mapped to
// where the history actually lives. This is the single metrics catalog — the
// dashboard builder shows these names, rules use the same names.
export const PANEL_METRICS: Record<string, {
  source: "metrics" | "probe_results"; column: string; label: string; unit: "%" | "bps" | "ms" | "days";
}> = {
  "cpu.percent": { source: "metrics", column: "cpu_pct", label: "CPU usage", unit: "%" },
  "mem.percent": { source: "metrics", column: "mem_pct", label: "Memory usage", unit: "%" },
  "swap.percent": { source: "metrics", column: "swap_pct", label: "Swap usage", unit: "%" },
  "disk.min_free_pct": { source: "metrics", column: "disk_min_free_pct", label: "Lowest disk free", unit: "%" },
  "net.rx_bps": { source: "metrics", column: "net_rx_bps", label: "Network receive", unit: "bps" },
  "net.tx_bps": { source: "metrics", column: "net_tx_bps", label: "Network transmit", unit: "bps" },
  "disk.read_bps": { source: "metrics", column: "disk_read_bps", label: "Disk read", unit: "bps" },
  "disk.write_bps": { source: "metrics", column: "disk_write_bps", label: "Disk write", unit: "bps" },
  "probe.latency_ms": { source: "probe_results", column: "latency_ms", label: "Probe latency", unit: "ms" },
  "cert.days_remaining": { source: "probe_results", column: "cert_days_remaining", label: "SSL days remaining", unit: "days" },
};

const AGGS: Record<string, string> = {
  avg: "avg", min: "min", max: "max", sum: "sum", count: "count",
};

const RANGES: Record<string, { interval: string; bucketSec: number }> = {
  "1h": { interval: "1 hour", bucketSec: 30 },
  "6h": { interval: "6 hours", bucketSec: 120 },
  "24h": { interval: "24 hours", bucketSec: 600 },
  "7d": { interval: "7 days", bucketSec: 3600 },
  "30d": { interval: "30 days", bucketSec: 14400 },
};

export interface MatchedServer {
  id: number; display_name: string; hostname: string | null; brand: string; tags: string[];
}

/** Servers matching a rules-style target string: "*", group:Brand, tag:x, or a name. */
export async function matchServers(target: string): Promise<MatchedServer[]> {
  const cols = "id, display_name, hostname, brand, tags";
  const t = String(target || "*").trim();
  const tl = t.toLowerCase();
  if (tl === "*") {
    return (await query(`SELECT ${cols} FROM servers`)).rows;
  }
  if (tl.startsWith("group:")) {
    return (await query(`SELECT ${cols} FROM servers WHERE lower(brand) = $1`,
      [tl.slice(6).trim()])).rows;
  }
  if (tl.startsWith("tag:")) {
    return (await query(
      `SELECT ${cols} FROM servers WHERE EXISTS (
         SELECT 1 FROM unnest(tags) tag WHERE lower(tag) = $1)`,
      [tl.slice(4).trim()])).rows;
  }
  if (/^\d+$/.test(tl)) {
    return (await query(`SELECT ${cols} FROM servers WHERE id = $1`, [parseInt(tl, 10)])).rows;
  }
  return (await query(
    `SELECT ${cols} FROM servers WHERE lower(display_name) = $1 OR lower(hostname) = $1`,
    [tl])).rows;
}

export async function dashboardRoutes(app: FastifyInstance) {
  // Registered ahead of the requireAuth hook below (and given its own
  // wall-token-aware preHandler) so chart panels embedded in the Wall keep
  // working for an unauthenticated kiosk display (?wall_token=…), the same
  // as /api/servers and /api/wall-layouts already do.
  app.post("/api/dashboards/panel-data", { preHandler: requireWallAccess }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const metricKeys: string[] = Array.isArray(body.metrics) ? body.metrics : [];
    if (metricKeys.length === 0 || metricKeys.length > 4) {
      return reply.code(400).send({ error: "metrics must list 1-4 metric keys" });
    }
    for (const k of metricKeys) {
      if (!PANEL_METRICS[k]) return reply.code(400).send({ error: `unknown metric '${k}'` });
    }
    const agg = AGGS[body.agg] ?? "avg";
    const range = RANGES[body.range] ?? RANGES["24h"];

    const servers = await matchServers(body.target);
    const serverIds = servers.map((s) => s.id);
    if (serverIds.length === 0) return { matched: 0, series: [] };

    const series = [];
    for (const key of metricKeys) {
      const m = PANEL_METRICS[key];
      let rows;
      if (m.source === "metrics") {
        ({ rows } = await query(
          `SELECT date_bin(make_interval(secs => $3), time, TIMESTAMPTZ '2000-01-01') AS bucket,
                  round(${agg}(${m.column})::numeric, 2)::float AS value
           FROM metrics
           WHERE server_id = ANY($1) AND time > now() - $2::interval AND ${m.column} IS NOT NULL
           GROUP BY bucket ORDER BY bucket`,
          [serverIds, range.interval, range.bucketSec],
        ));
      } else {
        ({ rows } = await query(
          `SELECT date_bin(make_interval(secs => $3), r.time, TIMESTAMPTZ '2000-01-01') AS bucket,
                  round(${agg}(r.${m.column})::numeric, 2)::float AS value
           FROM probe_results r JOIN probes p ON p.id = r.probe_id
           WHERE p.server_id = ANY($1) AND r.time > now() - $2::interval AND r.${m.column} IS NOT NULL
           GROUP BY bucket ORDER BY bucket`,
          [serverIds, range.interval, range.bucketSec],
        ));
      }
      series.push({ metric: key, label: PANEL_METRICS[key].label, unit: PANEL_METRICS[key].unit, points: rows });
    }
    return { matched: servers.length, series };
  });

  app.addHook("preHandler", requireAuth);

  app.get("/api/dashboards/metrics", async () => {
    return Object.entries(PANEL_METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit }));
  });

  app.get("/api/dashboards", async (req) => {
    const me = (req as any).user as string;
    const { rows } = await query(
      `SELECT id, name, owner, is_public, updated_at,
              jsonb_array_length(config->'panels') AS panel_count
       FROM dashboards WHERE owner = $1 OR is_public ORDER BY name`,
      [me],
    );
    return rows.map((r: any) => ({ ...r, mine: r.owner === me }));
  });

  app.get("/api/dashboards/:id", async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    if (Number.isNaN(id)) return reply.code(404).send({ error: "not found" });
    const me = (req as any).user as string;
    const { rows } = await query(`SELECT * FROM dashboards WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const dash = rows[0];
    if (dash.owner !== me && !dash.is_public) {
      return reply.code(403).send({ error: "this dashboard is private" });
    }
    return { ...dash, mine: dash.owner === me };
  });

  const validBody = (body: any): string | null => {
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) return "name is required";
    if (!body.config || typeof body.config !== "object" || !Array.isArray(body.config.panels)) {
      return "config.panels must be an array";
    }
    for (const p of body.config.panels) {
      if (!Array.isArray(p.metrics) || p.metrics.length === 0) return "each panel needs metrics";
      for (const k of p.metrics) if (!PANEL_METRICS[k]) return `unknown metric '${k}'`;
      if (p.agg != null && !AGGS[p.agg]) return `unknown aggregation '${p.agg}'`;
      if (p.range != null && !RANGES[p.range]) return `unknown range '${p.range}'`;
      if (p.chart != null && !["line", "stat", "bar"].includes(p.chart)) return `unknown chart '${p.chart}'`;
    }
    return null;
  };

  app.post("/api/dashboards", { preHandler: requireOperator }, async (req, reply) => {
    const me = (req as any).user as string;
    const body = (req.body ?? {}) as any;
    const invalid = validBody(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const { rows } = await query(
      `INSERT INTO dashboards (name, owner, is_public, config)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name.trim(), me, !!body.is_public, JSON.stringify(body.config)],
    );
    await audit(me, "dashboard.save", "dashboard", rows[0].id, { name: body.name.trim() });
    return reply.code(201).send({ ...rows[0], mine: true });
  });

  app.put("/api/dashboards/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const me = (req as any).user as string;
    const { rows: existing } = await query(`SELECT owner FROM dashboards WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    if (existing[0].owner !== me) return reply.code(403).send({ error: "not your dashboard" });

    const body = (req.body ?? {}) as any;
    const invalid = validBody(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const { rows } = await query(
      `UPDATE dashboards SET name = $2, is_public = $3, config = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, body.name.trim(), !!body.is_public, JSON.stringify(body.config)],
    );
    await audit(me, "dashboard.save", "dashboard", id, { name: body.name.trim() });
    return { ...rows[0], mine: true };
  });

  app.delete("/api/dashboards/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    const me = (req as any).user as string;
    const { rows: existing } = await query(`SELECT owner, name FROM dashboards WHERE id = $1`, [id]);
    if (existing.length === 0) return reply.code(404).send({ error: "not found" });
    if (existing[0].owner !== me) return reply.code(403).send({ error: "not your dashboard" });
    await query(`DELETE FROM dashboards WHERE id = $1`, [id]);
    await audit(me, "dashboard.delete", "dashboard", id, { name: existing[0].name });
    return { ok: true };
  });
}
