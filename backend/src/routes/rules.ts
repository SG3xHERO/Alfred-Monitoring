import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireOperator } from "../auth.js";
import { audit } from "../audit.js";
import {
  compileRules, buildContext, ruleMatchesServer, checkFires, renderTemplate, checkMessage, notifyTargetLabel,
  KNOWN_PATHS, KNOWN_FUNCS, type ServerLike,
} from "../engine/rules.js";
import { loadRules } from "../engine/evaluator.js";

export async function ruleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  app.get("/api/rules", async () => {
    const { rows } = await query(`SELECT yaml, updated_at, updated_by FROM rules_doc WHERE id = 1`);
    return rows[0] ?? { yaml: "", updated_at: null };
  });

  app.get("/api/rules/reference", async () => ({
    paths: KNOWN_PATHS,
    functions: KNOWN_FUNCS,
  }));

  // Rule/check names for the Silences page's target picker — a silence can
  // scope to one specific check instead of muting everything on a server.
  app.get("/api/rules/checks", async () => {
    const { rows } = await query(`SELECT yaml FROM rules_doc WHERE id = 1`);
    const { rules } = compileRules(rows[0]?.yaml ?? "");
    return rules.map((r) => ({ name: r.name, checks: r.checks.map((c) => c.key) }));
  });

  app.post("/api/rules/validate", async (req) => {
    const { yaml } = (req.body ?? {}) as any;
    const { rules, errors } = compileRules(String(yaml ?? ""));
    return {
      ok: errors.length === 0,
      errors,
      rule_count: rules.length,
      check_count: rules.reduce((n, r) => n + r.checks.length, 0),
    };
  });

  app.put("/api/rules", async (req, reply) => {
    const { yaml } = (req.body ?? {}) as any;
    const { errors } = compileRules(String(yaml ?? ""));
    if (errors.length > 0) {
      return reply.code(400).send({ ok: false, errors });
    }
    const user = (req as any).user as string;
    await query(
      `UPDATE rules_doc SET yaml = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
      [yaml, user],
    );
    await query(`INSERT INTO rules_versions (yaml, saved_by) VALUES ($1, $2)`, [yaml, user]);
    await loadRules();
    await audit(user, "rules.save", "rules_doc", 1, { bytes: String(yaml).length });
    return { ok: true };
  });

  app.get("/api/rules/versions", async () => {
    const { rows } = await query(
      `SELECT id, saved_at, saved_by FROM rules_versions ORDER BY id DESC LIMIT 50`,
    );
    return rows;
  });

  app.get("/api/rules/versions/:id", async (req, reply) => {
    const { rows } = await query(`SELECT * FROM rules_versions WHERE id = $1`,
      [parseInt((req.params as any).id, 10)]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  // Dry-run: evaluate a candidate document against last known metrics without saving.
  app.post("/api/rules/dry-run", async (req, reply) => {
    const { yaml, server_id } = (req.body ?? {}) as any;
    const { rules, errors } = compileRules(String(yaml ?? ""));
    if (errors.length > 0) return reply.code(400).send({ ok: false, errors });

    const params: any[] = [];
    let where = `status <> 'pending'`;
    if (server_id) {
      params.push(server_id);
      where = `id = $1`;
    }
    const { rows: servers } = await query<ServerLike>(
      `SELECT id, hostname, display_name, brand, tags, status, agent_version, last_snapshot
       FROM servers WHERE ${where} ORDER BY display_name`,
      params,
    );

    const results: any[] = [];
    for (const server of servers) {
      const ctx = buildContext(server);
      for (const rule of rules.filter((r) => r.enabled)) {
        if (!ruleMatchesServer(rule, server)) continue;
        for (const check of rule.checks) {
          let fires = false;
          let evalError: string | null = null;
          try {
            fires = checkFires(check, ctx);
          } catch (err: any) {
            evalError = err.message;
          }
          results.push({
            server: server.display_name,
            server_id: server.id,
            rule: rule.name,
            check: check.key,
            when: check.when,
            message: checkMessage(check, server),
            fires,
            error: evalError,
            would_notify: fires && check.notify.length > 0
              ? check.notify.map((n) => ({
                  channel: n.channel,
                  label: notifyTargetLabel(n),
                  subject: n.channel === "email"
                    ? renderTemplate(n.subject || `${rule.name}/${check.key} on {{server}}`, server)
                    : undefined,
                }))
              : [],
          });
        }
      }
    }
    return { ok: true, results };
  });
}
