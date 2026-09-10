import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { hashApiKey } from "../auth.js";
import { broadcast } from "../sse.js";
import { evaluateServer } from "../engine/evaluator.js";
import type { ServerLike } from "../engine/rules.js";
import { releaseDigest } from "./agent-releases.js";

export async function ingestRoutes(app: FastifyInstance) {
  app.post("/api/ingest", {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
        keyGenerator: (req: any) => String(req.headers["x-api-key"] || req.ip),
      },
    },
  }, async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!key || typeof key !== "string") {
      return reply.code(401).send({ error: "missing X-API-Key" });
    }
    const { rows } = await query(
      `SELECT s.id, s.hostname, s.display_name, s.brand, s.tags, s.status, s.interval_seconds,
              s.update_requested_version, s.desired_config, parent.display_name AS parent_display_name
       FROM servers s LEFT JOIN servers parent ON parent.id = s.parent_id
       WHERE s.api_key_hash = $1`,
      [hashApiKey(key)],
    );
    if (rows.length === 0) {
      return reply.code(401).send({ error: "unknown or revoked API key" });
    }
    const server = rows[0];

    const snap = req.body as any;
    if (!snap || typeof snap !== "object" || !snap.hostname) {
      return reply.code(400).send({ error: "invalid payload" });
    }

    const wasOffline = server.status !== "online";
    const now = new Date();

    // Prefer the agent's own view of its LAN IP (it dials out to pick a
    // route/source address, see agent/internal/collect/localip.go) over
    // req.ip: behind Docker's own port-forwarding — notably Docker Desktop's
    // NAT on Windows/Mac — every agent's connection can appear to originate
    // from the same internal gateway address, which req.ip has no way to see
    // through. Older agents that predate this field fall back to req.ip.
    const ipAddress = snap.ip_address || req.ip;

    await query(
      `UPDATE servers SET
         hostname = $2, os = $3, platform = $4, agent_version = $5,
         status = 'online',
         status_since = CASE WHEN status <> 'online' THEN $6 ELSE status_since END,
         last_seen = $6,
         first_seen = COALESCE(first_seen, $6),
         last_snapshot = $7,
         ip_address = $8
       WHERE id = $1`,
      [server.id, snap.hostname, snap.os, snap.platform, snap.agent_version, now,
        JSON.stringify(snap), ipAddress],
    );

    const disks = (snap.disks || []).map((d: any) => ({
      mount: d.mount,
      used_percent: d.used_percent,
      free_gb: Math.round((d.free / 1024 ** 3) * 10) / 10,
    }));
    const minFree = disks.length
      ? Math.min(...disks.map((d: any) => 100 - d.used_percent))
      : null;

    await query(
      `INSERT INTO metrics (time, server_id, cpu_pct, mem_pct, swap_pct,
                            disk_min_free_pct, net_rx_bps, net_tx_bps,
                            disk_read_bps, disk_write_bps, disks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [now, server.id,
        snap.cpu?.percent ?? null, snap.memory?.percent ?? null,
        snap.memory?.swap_percent ?? null, minFree,
        snap.network?.rx_bps ?? null, snap.network?.tx_bps ?? null,
        snap.disk_io?.read_bps ?? null, snap.disk_io?.write_bps ?? null,
        JSON.stringify(disks)],
    );

    broadcast("server", {
      id: server.id,
      status: "online",
      last_seen: now.toISOString(),
      cpu_pct: snap.cpu?.percent ?? null,
      mem_pct: snap.memory?.percent ?? null,
      disk_min_free_pct: minFree,
      cameOnline: wasOffline,
    });

    const serverLike: ServerLike = {
      id: server.id,
      hostname: snap.hostname,
      display_name: server.display_name,
      brand: server.brand,
      tags: server.tags,
      status: "online",
      agent_version: snap.agent_version,
      last_snapshot: snap,
      last_seen: now,
      parent_display_name: server.parent_display_name,
    };
    // rule evaluation must never fail the ingest response
    evaluateServer(serverLike).catch((err) =>
      console.error(`evaluate ${server.display_name}:`, err.message));

    // agent is poll-only — this response is the only channel to tell it to
    // capture a SQL diagnostic snapshot (event-triggered on rule fire or an
    // admin's "Snapshot now" button), never a continuous poll.
    const pending = await query(
      `SELECT id FROM sql_snapshots WHERE server_id = $1 AND status = 'requested'
       ORDER BY requested_at LIMIT 1`,
      [server.id],
    );
    const pending_snapshot = pending.rows.length ? { id: pending.rows[0].id } : undefined;

    // admin-triggered agent update: only offered while the reported version
    // still differs from what was requested (so it stops re-offering once
    // the new binary is confirmed running).
    let update: { version: string; url: string; sha256: string } | undefined;
    const targetVersion = server.update_requested_version;
    if (targetVersion && targetVersion !== snap.agent_version) {
      const platform: string | undefined = snap.os;
      const sha256 = platform ? await releaseDigest(targetVersion, platform) : null;
      if (platform && sha256) {
        update = { version: targetVersion, url: `/agent/download/${targetVersion}/${platform}`, sha256 };
      }
    }

    // Remote config push: the agent applies this idempotently (it only
    // rewrites config.yaml and hot-reloads when a value actually differs
    // from what it's already running), so re-sending the same desired
    // state on every poll is harmless — no separate "did it apply yet"
    // acknowledgement/hash tracking needed, unlike the update flow above
    // which has a real download-and-restart cost to avoid repeating.
    const config = server.desired_config ?? undefined;

    return { ok: true, interval_seconds: server.interval_seconds, pending_snapshot, update, config };
  });
}
