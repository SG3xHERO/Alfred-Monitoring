import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAdmin } from "../auth.js";
import { audit } from "../audit.js";
import { generateApiKey, hashApiKey } from "../auth.js";
import { getDefaultBrand } from "./brands.js";

/**
 * Settings/server-setup export & import. Cross-instance references (a data
 * connection's credential, a probe's credential/connection) are exported by
 * NATURAL KEY (name), never by numeric id — ids are only meaningful within
 * the instance that minted them, so import re-resolves them by name against
 * whatever already exists on the target.
 *
 * Agent-kind servers can't carry over their API key (it's a secret shown
 * once at creation, hashed at rest — there is nothing to export). Importing
 * one recreates the registration with a freshly generated key, which the
 * physical agent's config.yaml then needs updating with; this is called out
 * in the apply response. Probes are fully self-contained and re-creatable —
 * no physical counterpart to re-point.
 */

const SECTIONS = ["brands", "credentials", "data_connections", "probe_variables", "servers", "probes"] as const;
type Section = (typeof SECTIONS)[number];

interface ExportBundle {
  version: 1;
  exported_at: string;
  sections: Record<Section, any[]>;
}

async function buildExport(): Promise<ExportBundle> {
  const { rows: brands } = await query(`SELECT name, sort, is_default FROM brands ORDER BY sort, name`);
  const { rows: credentials } = await query(
    `SELECT name, type, username, domain, secret, extra FROM credentials ORDER BY name`,
  );
  const { rows: dataConnections } = await query(
    `SELECT dc.name, dc.host, dc.database_name, c.name AS credential_name
     FROM data_connections dc LEFT JOIN credentials c ON c.id = dc.credential_id ORDER BY dc.name`,
  );
  const { rows: probeVariables } = await query(`SELECT name, value FROM probe_variables ORDER BY name`);

  const { rows: servers } = await query(
    `SELECT display_name, brand, tags, os, platform, interval_seconds, desired_config, group_key
     FROM servers WHERE kind = 'agent' ORDER BY brand, display_name`,
  );

  const { rows: probes } = await query(
    `SELECT s.display_name AS name, s.brand, s.tags, s.group_key,
            p.type, p.target, p.interval_seconds, p.timeout_ms, p.expected_status,
            p.method, p.headers, p.body, p.auth_token, p.json_path, p.json_expected,
            p.timestamp_path, p.max_age_minutes, p.auth_url, p.auth_body, p.auth_token_path,
            p.fail_on_graphql_errors, p.warning_threshold, p.severe_threshold, p.file_mask,
            cr.name AS credential_name, dc.name AS connection_name, p.procedure_name
     FROM probes p
     JOIN servers s ON s.id = p.server_id
     LEFT JOIN credentials cr ON cr.id = p.credential_id
     LEFT JOIN data_connections dc ON dc.id = p.connection_id
     ORDER BY s.brand, s.display_name`,
  );

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    sections: {
      brands,
      credentials,
      data_connections: dataConnections,
      probe_variables: probeVariables,
      servers,
      probes,
    },
  };
}

/** Natural key per section — what "already exists" is judged by. */
function keyOf(item: any): string {
  return item.name;
}

async function existingKeys(section: Section): Promise<Set<string>> {
  if (section === "servers") {
    const { rows } = await query(`SELECT display_name AS name FROM servers WHERE kind = 'agent'`);
    return new Set(rows.map((r) => r.name));
  }
  if (section === "probes") {
    const { rows } = await query(
      `SELECT s.display_name AS name FROM probes p JOIN servers s ON s.id = p.server_id`,
    );
    return new Set(rows.map((r) => r.name));
  }
  const { rows } = await query(`SELECT name FROM ${section}`);
  return new Set(rows.map((r) => r.name));
}

export async function exportImportRoutes(app: FastifyInstance) {
  app.get("/api/export", { preHandler: requireAdmin }, async (req, reply) => {
    const bundle = await buildExport();
    await audit((req as any).user, "export.download", null, null, {});
    reply.header("Content-Disposition", `attachment; filename="alfred-export-${Date.now()}.json"`);
    return bundle;
  });

  app.post("/api/import/preview", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ExportBundle>;
    if (!body.sections) return reply.code(400).send({ error: "not a valid export file" });

    const preview: Record<string, any[]> = {};
    for (const section of SECTIONS) {
      const items = body.sections[section] ?? [];
      const existing = await existingKeys(section);
      preview[section] = items.map((item) => ({ ...item, exists: existing.has(keyOf(item)) }));
    }
    return { version: body.version ?? 1, exported_at: body.exported_at ?? null, sections: preview };
  });

  app.post("/api/import/apply", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { data: ExportBundle; selected: Record<Section, string[]> };
    if (!body?.data?.sections || !body.selected) return reply.code(400).send({ error: "invalid request" });
    const { data, selected } = body;
    const summary: Record<string, { created: number; updated: number; skipped: number }> = {};
    const warnings: string[] = [];
    const newAgentKeys: Array<{ display_name: string; api_key: string }> = [];
    const newPushKeys: Array<{ display_name: string; push_key: string }> = [];

    for (const section of SECTIONS) {
      const wanted = new Set(selected[section] ?? []);
      const items = (data.sections[section] ?? []).filter((i) => wanted.has(keyOf(i)));
      summary[section] = { created: 0, updated: 0, skipped: (data.sections[section]?.length ?? 0) - items.length };

      for (const item of items) {
        const created = await applyOne(section, item, warnings, newAgentKeys, newPushKeys);
        summary[section][created ? "created" : "updated"]++;
      }
    }

    await audit((req as any).user, "import.apply", null, null, { selected: Object.fromEntries(SECTIONS.map((s) => [s, (selected[s] ?? []).length])) });
    return { ok: true, summary, warnings, new_agent_keys: newAgentKeys, new_push_keys: newPushKeys };
  });
}

/** Returns true if the row was newly created (vs updated). */
async function applyOne(
  section: Section, item: any, warnings: string[],
  newAgentKeys: Array<{ display_name: string; api_key: string }>,
  newPushKeys: Array<{ display_name: string; push_key: string }>,
): Promise<boolean> {
  switch (section) {
    case "brands": {
      const { rows: existing } = await query(`SELECT id FROM brands WHERE name = $1`, [item.name]);
      if (existing.length) {
        await query(`UPDATE brands SET sort = $2, is_default = $3 WHERE id = $1`, [existing[0].id, item.sort ?? 0, !!item.is_default]);
        return false;
      }
      await query(`INSERT INTO brands (name, sort, is_default) VALUES ($1,$2,$3)`, [item.name, item.sort ?? 0, !!item.is_default]);
      return true;
    }
    case "credentials": {
      const { rows: existing } = await query(`SELECT id FROM credentials WHERE name = $1`, [item.name]);
      const fields = [item.name, item.type, item.username ?? null, item.domain ?? null, item.secret ?? null, item.extra ? JSON.stringify(item.extra) : null];
      if (existing.length) {
        await query(`UPDATE credentials SET type=$2, username=$3, domain=$4, secret=$5, extra=$6, updated_at=now() WHERE name=$1`, fields);
        return false;
      }
      await query(`INSERT INTO credentials (name, type, username, domain, secret, extra) VALUES ($1,$2,$3,$4,$5,$6)`, fields);
      return true;
    }
    case "data_connections": {
      let credentialId: number | null = null;
      if (item.credential_name) {
        const { rows } = await query(`SELECT id FROM credentials WHERE name = $1`, [item.credential_name]);
        if (rows.length) credentialId = rows[0].id;
        else warnings.push(`data connection "${item.name}": credential "${item.credential_name}" not found — left unset`);
      }
      const { rows: existing } = await query(`SELECT id FROM data_connections WHERE name = $1`, [item.name]);
      if (existing.length) {
        await query(`UPDATE data_connections SET host=$2, database_name=$3, credential_id=$4 WHERE name=$1`,
          [item.name, item.host, item.database_name, credentialId]);
        return false;
      }
      await query(`INSERT INTO data_connections (name, host, database_name, credential_id) VALUES ($1,$2,$3,$4)`,
        [item.name, item.host, item.database_name, credentialId]);
      return true;
    }
    case "probe_variables": {
      const { rows: existing } = await query(`SELECT name FROM probe_variables WHERE name = $1`, [item.name]);
      await query(
        `INSERT INTO probe_variables (name, value, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (name) DO UPDATE SET value = $2, updated_at = now()`,
        [item.name, item.value],
      );
      return existing.length === 0;
    }
    case "servers": {
      const { rows: existing } = await query(`SELECT id FROM servers WHERE kind = 'agent' AND display_name = $1`, [item.name]);
      const desiredConfig = item.desired_config ? JSON.stringify(item.desired_config) : null;
      if (existing.length) {
        await query(
          `UPDATE servers SET brand=$2, tags=$3, os=$4, platform=$5, interval_seconds=$6, desired_config=$7, group_key=$8
           WHERE id = $1`,
          [existing[0].id, item.brand || await getDefaultBrand(), item.tags ?? [], item.os ?? null, item.platform ?? null,
            item.interval_seconds ?? 15, desiredConfig, item.group_key ?? null],
        );
        return false;
      }
      // no physical agent key to import — mint a fresh one, same as a normal "Add server"
      const apiKey = generateApiKey();
      await query(
        `INSERT INTO servers (display_name, brand, tags, os, platform, interval_seconds, api_key_hash, desired_config, group_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [item.name, item.brand || await getDefaultBrand(), item.tags ?? [], item.os ?? null, item.platform ?? null,
          item.interval_seconds ?? 15, hashApiKey(apiKey), desiredConfig, item.group_key ?? null],
      );
      newAgentKeys.push({ display_name: item.name, api_key: apiKey });
      return true;
    }
    case "probes": {
      let credentialId: number | null = null;
      if (item.credential_name) {
        const { rows } = await query(`SELECT id FROM credentials WHERE name = $1`, [item.credential_name]);
        if (rows.length) credentialId = rows[0].id;
        else warnings.push(`probe "${item.name}": credential "${item.credential_name}" not found — left unset`);
      }
      let connectionId: number | null = null;
      if (item.connection_name) {
        const { rows } = await query(`SELECT id FROM data_connections WHERE name = $1`, [item.connection_name]);
        if (rows.length) connectionId = rows[0].id;
        else warnings.push(`probe "${item.name}": data connection "${item.connection_name}" not found — left unset`);
      }

      const { rows: existingServer } = await query(
        `SELECT s.id AS server_id, p.id AS probe_id FROM servers s
         JOIN probes p ON p.server_id = s.id WHERE s.display_name = $1`,
        [item.name],
      );
      // target is NOT NULL — push/data probes don't carry a real one in the
      // export (push has no meaningful target; data uses connection+procedure
      // instead), so synthesize the same placeholder the manual create form uses.
      const resolvedTarget = item.type === "push" ? "push"
        : item.type === "data" ? (item.target || item.procedure_name || "data")
        : item.target;
      const probeFields = [
        item.type, resolvedTarget, item.interval_seconds ?? 60, item.timeout_ms ?? 5000,
        item.expected_status ?? null, String(item.method || "GET").toUpperCase(),
        item.headers ? JSON.stringify(item.headers) : null, item.body ?? null, item.auth_token ?? null,
        item.json_path ?? null, item.json_expected ?? null, item.timestamp_path ?? null, item.max_age_minutes ?? null,
        item.auth_url ?? null, item.auth_body ?? null, item.auth_token_path ?? null, !!item.fail_on_graphql_errors,
        item.warning_threshold ?? null, item.severe_threshold ?? null, item.file_mask ?? null,
        credentialId, connectionId, item.procedure_name ?? null,
      ];

      if (existingServer.length) {
        const { server_id, probe_id } = existingServer[0];
        await query(
          `UPDATE servers SET brand=$2, tags=$3, group_key=$4 WHERE id = $1`,
          [server_id, item.brand || await getDefaultBrand(), item.tags ?? [], item.group_key ?? null],
        );
        await query(
          `UPDATE probes SET type=$2, target=$3, interval_seconds=$4, timeout_ms=$5, expected_status=$6,
             method=$7, headers=$8, body=$9, auth_token=$10, json_path=$11, json_expected=$12,
             timestamp_path=$13, max_age_minutes=$14, auth_url=$15, auth_body=$16, auth_token_path=$17,
             fail_on_graphql_errors=$18, warning_threshold=$19, severe_threshold=$20, file_mask=$21,
             credential_id=$22, connection_id=$23, procedure_name=$24
           WHERE id = $1`,
          [probe_id, ...probeFields],
        );
        return false;
      }

      const shadowKey = hashApiKey("probe:" + Math.random().toString(36).slice(2) + Date.now());
      const { rows: srv } = await query(
        `INSERT INTO servers (display_name, brand, tags, interval_seconds, api_key_hash, kind, group_key)
         VALUES ($1,$2,$3,$4,$5,'probe',$6) RETURNING id`,
        [item.name, item.brand || await getDefaultBrand(), item.tags ?? [], item.interval_seconds ?? 60, shadowKey, item.group_key ?? null],
      );
      const pushKey = item.type === "push" ? generateApiKey() : null;
      await query(
        `INSERT INTO probes (server_id, type, target, interval_seconds, timeout_ms, expected_status,
           method, headers, body, auth_token, json_path, json_expected, timestamp_path, max_age_minutes,
           auth_url, auth_body, auth_token_path, fail_on_graphql_errors, warning_threshold, severe_threshold,
           file_mask, credential_id, connection_id, procedure_name, push_key_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [srv[0].id, ...probeFields, pushKey ? hashApiKey(pushKey) : null],
      );
      if (pushKey) newPushKeys.push({ display_name: item.name, push_key: pushKey });
      return true;
    }
  }
}
