import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { pool, query } from "../db.js";
import { signSession, COOKIE_NAME } from "../auth.js";
import { setSetting } from "../settings.js";
import { audit } from "../audit.js";

// Arbitrary fixed key for the advisory lock — only needs to be unique
// within this app, and only ever taken during setup submission.
const SETUP_LOCK_KEY = 847_291_003;

const num = (v: unknown, fallback: number): number => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * First-run onboarding: creates the admin account and configures the whole
 * instance (org identity, timezone, retention, alert tuning, digest, email
 * provider + from-address, optional Microsoft SSO, and the initial group
 * list) in one atomic submission. Public (no session yet), but permanently
 * locked out once any user exists — the advisory lock + in-transaction count
 * check closes the race between two concurrent submissions racing to be
 * "first".
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
    return { needed: rows[0].n === 0 };
  });

  app.post("/api/setup", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const orgName = String(body.org_name || "").trim();
    const baseUrl = String(body.base_url || "").trim();
    const brands: string[] = Array.isArray(body.brands)
      ? body.brands.map((b: unknown) => String(b).trim()).filter(Boolean)
      : [];
    const email = body.email && typeof body.email === "object" ? body.email : { provider: "disabled" };
    const azure = body.azure && typeof body.azure === "object" ? body.azure : null;
    const monitoring = body.monitoring && typeof body.monitoring === "object" ? body.monitoring : {};

    if (!username) return reply.code(400).send({ error: "username is required" });
    if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
    if (!orgName) return reply.code(400).send({ error: "organisation name is required" });
    if (brands.length === 0) return reply.code(400).send({ error: "at least one group is required" });

    if (azure?.enabled) {
      if (!String(azure.tenant_id || "").trim() || !String(azure.client_id || "").trim()) {
        return reply.code(400).send({ error: "Microsoft sign-in needs a tenant ID and client ID" });
      }
      const groups = [azure.group_admin, azure.group_operator, azure.group_viewer].map((g) => String(g || "").trim());
      if (!groups.some(Boolean)) {
        return reply.code(400).send({ error: "Microsoft sign-in needs at least one Entra group object ID" });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [SETUP_LOCK_KEY]);
      const { rows: count } = await client.query("SELECT count(*)::int AS n FROM users");
      if (count[0].n > 0) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: "setup has already been completed" });
      }

      const hash = await bcrypt.hash(password, 10);
      await client.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        [username, hash],
      );

      for (const [i, name] of brands.entries()) {
        await client.query(
          "INSERT INTO brands (name, sort, is_default) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING",
          [name, i, i === 0],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Settings writes happen after commit via the shared cache (setSetting
    // handles its own persistence) — not part of the lock/transaction since
    // they can't race a concurrent setup (the users-table lock already won).
    await setSetting("org.name", orgName, username);
    if (baseUrl) await setSetting("base_url", baseUrl, username);

    // Monitoring preferences (all optional — sensible defaults otherwise).
    if (monitoring.timezone) await setSetting("alert.tz", String(monitoring.timezone).trim(), username);
    if (monitoring.retention_days != null) {
      await setSetting("retention.metrics_days", String(Math.max(1, Math.floor(num(monitoring.retention_days, 90)))), username);
    }
    if (monitoring.offline_multiplier != null) {
      await setSetting("alert.offline_multiplier", String(Math.max(1, num(monitoring.offline_multiplier, 2))), username);
    }
    if (monitoring.digest_to) {
      await setSetting("digest.to", String(monitoring.digest_to).trim(), username);
      if (monitoring.digest_hour != null) {
        const h = Math.min(23, Math.max(0, Math.floor(num(monitoring.digest_hour, 8))));
        await setSetting("digest.hour", String(h), username);
      }
    }

    // Email provider.
    if (email.provider === "sendgrid" && email.sendgrid_api_key) {
      await setSetting("email.provider", "sendgrid", username);
      await setSetting("email.sendgrid_api_key", String(email.sendgrid_api_key), username);
    } else if (email.provider === "smtp" && email.smtp_host) {
      await setSetting("email.provider", "smtp", username);
      await setSetting("email.smtp_host", String(email.smtp_host), username);
      await setSetting("email.smtp_port", String(email.smtp_port || "587"), username);
      await setSetting("email.smtp_user", String(email.smtp_user || ""), username);
      if (email.smtp_password) await setSetting("email.smtp_password", String(email.smtp_password), username);
      await setSetting("email.smtp_tls", String(email.smtp_tls || "starttls"), username);
    }

    // Email from-address (used by every provider).
    const fromName = String(email.from_name || "").trim();
    const fromLocal = String(email.from_local || "").trim();
    const fromDomain = String(email.from_domain || "").trim();
    if (fromName || fromLocal || fromDomain) {
      await query(
        `INSERT INTO email_settings (id, from_name, from_local, from_domain, updated_at, updated_by)
         VALUES (1, $1, $2, $3, now(), $4)
         ON CONFLICT (id) DO UPDATE SET
           from_name = EXCLUDED.from_name, from_local = EXCLUDED.from_local,
           from_domain = EXCLUDED.from_domain, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [fromName || "Alfred Monitoring", fromLocal || "alfred", fromDomain || "example.com", username],
      );
    }

    // Optional Microsoft Entra ID sign-in (off unless explicitly enabled).
    if (azure?.enabled) {
      await setSetting("azure.enabled", "true", username);
      await setSetting("azure.tenant_id", String(azure.tenant_id).trim(), username);
      await setSetting("azure.client_id", String(azure.client_id).trim(), username);
      await setSetting("azure.group_admin", String(azure.group_admin || "").trim(), username);
      await setSetting("azure.group_operator", String(azure.group_operator || "").trim(), username);
      await setSetting("azure.group_viewer", String(azure.group_viewer || "").trim(), username);
    }

    await audit(username, "setup.completed", "users", 1, {
      username, org_name: orgName, brands, microsoft_sso: !!azure?.enabled,
    });

    reply.setCookie(COOKIE_NAME, signSession(username), {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600,
    });
    return { ok: true, username };
  });
}
