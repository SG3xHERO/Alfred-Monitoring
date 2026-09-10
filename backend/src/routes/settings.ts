import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { requireAuth, requireAdmin, generateApiKey, hashApiKey } from "../auth.js";
import { audit } from "../audit.js";
import { getSetting, setSetting, settingsForUi, SETTINGS_REGISTRY } from "../settings.js";
import { applyRetention } from "../db.js";
import { sendMail } from "../notify/email.js";
import { masterKeyHex, masterKeyWasGenerated, masterKeyFile } from "../crypto.js";

/** Domains mail may be sent from. Configurable (comma list); empty = any domain allowed. */
function allowedEmailDomains(): string[] {
  return getSetting("email.allowed_domains").split(",").map((s) => s.trim()).filter(Boolean);
}

const EMAIL_PROVIDERS = ["sendgrid", "smtp", "disabled"];
const SMTP_TLS_MODES = ["starttls", "implicit", "none"];

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/settings/email", async () => {
    const { rows } = await query(`SELECT * FROM email_settings WHERE id = 1`);
    const s = rows[0] ?? {
      from_name: "Alfred Monitoring", from_local: "alfred", from_domain: "example.com",
    };
    return { ...s, allowed_domains: allowedEmailDomains() };
  });

  app.put("/api/settings/email", { preHandler: requireAdmin }, async (req, reply) => {
    const { from_name, from_local, from_domain } = (req.body ?? {}) as any;
    if (!from_name || typeof from_name !== "string" || !from_name.trim()) {
      return reply.code(400).send({ error: "from_name is required" });
    }
    if (!from_local || typeof from_local !== "string" || !/^[a-zA-Z0-9._-]+$/.test(from_local)) {
      return reply.code(400).send({ error: "from_local must be a valid email local-part" });
    }
    const allowed = allowedEmailDomains();
    if (allowed.length > 0 && !allowed.includes(from_domain)) {
      return reply.code(400).send({ error: `from_domain must be one of: ${allowed.join(", ")}` });
    }
    if (!from_domain || typeof from_domain !== "string" || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(from_domain)) {
      return reply.code(400).send({ error: "from_domain must be a valid domain" });
    }
    const user = (req as any).user as string;
    await query(
      `INSERT INTO email_settings (id, from_name, from_local, from_domain, updated_at, updated_by)
       VALUES (1, $1, $2, $3, now(), $4)
       ON CONFLICT (id) DO UPDATE SET
         from_name = $1, from_local = $2, from_domain = $3, updated_at = now(), updated_by = $4`,
      [from_name.trim(), from_local.trim(), from_domain, user],
    );
    await audit(user, "settings.email", "email_settings", 1,
      { from_name: from_name.trim(), from: `${from_local.trim()}@${from_domain}` });
    return { ok: true };
  });

  // ---------- app-wide settings (DB-backed, see settings.ts) ----------

  app.get("/api/settings/app", { preHandler: requireAdmin }, async () => settingsForUi());

  app.put("/api/settings/app", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = (req as any).user as string;
    const changed: string[] = [];
    for (const [key, raw] of Object.entries(body)) {
      const def = SETTINGS_REGISTRY[key];
      if (!def) return reply.code(400).send({ error: `unknown setting '${key}'` });
      if (typeof raw !== "string") return reply.code(400).send({ error: `'${key}' must be a string` });
      const value = raw.trim();
      // an empty secret means "keep the current one" — the UI never sees real values to echo back
      if (def.secret && value === "") continue;
      if (key === "email.provider" && !EMAIL_PROVIDERS.includes(value)) {
        return reply.code(400).send({ error: "email.provider must be sendgrid, smtp or disabled" });
      }
      if (key === "email.smtp_tls" && !SMTP_TLS_MODES.includes(value)) {
        return reply.code(400).send({ error: "email.smtp_tls must be starttls, implicit or none" });
      }
      if (["alert.offline_multiplier", "retention.metrics_days", "digest.hour", "email.max_per_hour", "email.smtp_port"].includes(key)
        && value !== "" && !Number.isFinite(parseFloat(value))) {
        return reply.code(400).send({ error: `'${key}' must be a number` });
      }
      await setSetting(key, value, user);
      changed.push(key);
    }
    if (changed.includes("retention.metrics_days")) {
      await applyRetention(parseFloat(getSetting("retention.metrics_days")));
    }
    // audit keys only — never values, some are secrets
    await audit(user, "settings.app", "app_settings", 1, { keys: changed });
    return { ok: true };
  });

  // Sends a real mail through the live provider path so config problems
  // surface here, not on the first genuine alert.
  app.post("/api/settings/email/test", {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const to = String((req.body as any)?.to || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return reply.code(400).send({ error: "a valid recipient address is required" });
    }
    const ok = await sendMail({
      to: [to],
      subject: "Alfred test email",
      text: "This is a test email from Alfred. If you can read this, outgoing mail works.",
      html: "<p>This is a test email from Alfred. If you can read this, outgoing mail works.</p>",
    });
    await audit((req as any).user, "settings.email_test", "email_settings", 1, { to, ok });
    if (!ok) {
      return reply.code(502).send({ error: "send failed — check the notification log below for the provider's error" });
    }
    return { ok: true };
  });

  app.get("/api/settings/notification-log", async (req) => {
    const limit = Math.min(parseInt((req.query as any).limit || "100", 10), 500);
    const { rows } = await query(
      `SELECT id, sent_at, channel, recipient, subject, suppressed, reason
       FROM email_log ORDER BY sent_at DESC LIMIT ${limit}`,
    );
    return rows;
  });

  // Non-secret status of the encryption key: where it came from and where it
  // lives on disk. The value itself is only served by the reveal route below.
  app.get("/api/settings/master-key", { preHandler: requireAdmin }, async () => {
    const source = process.env.ALFRED_MASTER_KEY
      ? "env"
      : masterKeyWasGenerated()
        ? "generated"
        : "file";
    return { source, file: masterKeyFile() };
  });

  // Reveals the active encryption key for disaster recovery (e.g. the data
  // volume was lost and secrets must be re-entered elsewhere). Admin-only,
  // rate-limited, and every reveal is written to the audit log.
  app.post("/api/settings/master-key/reveal", {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
  }, async (req) => {
    await audit((req as any).user, "settings.master_key_reveal", "app_settings", null, {});
    return { key: masterKeyHex() };
  });

  app.get("/api/settings/wall-token", { preHandler: requireAdmin }, async () => {
    const { rows } = await query(`SELECT token_hash, updated_at, updated_by FROM wall_settings WHERE id = 1`);
    const s = rows[0];
    return { set: !!s?.token_hash, updated_at: s?.updated_at ?? null, updated_by: s?.updated_by ?? null };
  });

  app.post("/api/settings/wall-token/rotate", { preHandler: requireAdmin }, async (req) => {
    const user = (req as any).user as string;
    const token = generateApiKey();
    await query(
      `INSERT INTO wall_settings (id, token_hash, updated_at, updated_by)
       VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET token_hash = $1, updated_at = now(), updated_by = $2`,
      [hashApiKey(token), user],
    );
    await audit(user, "settings.wall_token_rotate", "wall_settings", 1, {});
    return { token };
  });
}
