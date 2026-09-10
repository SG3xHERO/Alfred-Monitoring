import { query } from "./db.js";
import { encryptSecret, decryptSecret, isEncrypted } from "./crypto.js";

/**
 * Instance configuration, DB-backed and editable in Settings. The registry
 * below is the single source of what exists, its default, and whether it's
 * a secret (stored encrypted, never returned to the UI).
 *
 * Reads are synchronous against an in-process cache so call sites inside
 * hot loops (evaluator, prober, email) don't grow awaits — safe because
 * this is a single Node process and every write goes through setSetting(),
 * which updates the DB and the cache together.
 *
 * Legacy env vars seed missing keys once on first boot (IaC-friendly:
 * an existing compose deploy upgrades with identical behavior); after
 * that the DB wins and env changes are ignored.
 */

interface SettingDef {
  default: string;
  secret?: boolean;
  /** legacy env var that seeds this key when the row is missing */
  env?: string;
}

export const SETTINGS_REGISTRY: Record<string, SettingDef> = {
  "org.name": { default: "Alfred" },
  "base_url": { default: "http://localhost:8420", env: "BASE_URL" },
  "alert.tz": { default: "Europe/London", env: "ALERT_TZ" },
  "alert.offline_multiplier": { default: "2", env: "OFFLINE_MULTIPLIER" },
  // floor under the multiplier calc above — a 15s-interval agent shouldn't
  // be able to trip "offline" from one or two dropped heartbeats just
  // because the multiplier math works out to under a minute
  "alert.offline_min_seconds": { default: "90", env: "OFFLINE_MIN_SECONDS" },
  // sweepOffline() skips declaring anything offline for this long after
  // backend boot — a fresh restart hasn't received a heartbeat from anyone
  // yet, which isn't evidence the estate went down
  "alert.startup_settle_seconds": { default: "120", env: "STARTUP_SETTLE_SECONDS" },
  // if not one agent-kind server has reported in this long while the estate
  // isn't empty, that's a sign Alfred's own ingestion is broken, not that
  // everything just went down at once — sweepOffline pauses new offline
  // declarations until reporting resumes
  "alert.blackout_seconds": { default: "180", env: "BLACKOUT_SECONDS" },
  // failed probe attempts are retried this many times (1 = no retry) before
  // a result is committed as down — smooths over a single dropped packet
  "alert.probe_confirm_attempts": { default: "3", env: "PROBE_CONFIRM_ATTEMPTS" },
  "alert.probe_confirm_spacing_ms": { default: "3000", env: "PROBE_CONFIRM_SPACING_MS" },
  "retention.metrics_days": { default: "90", env: "METRICS_RETENTION_DAYS" },
  "digest.to": { default: "", env: "DIGEST_TO" },
  "digest.hour": { default: "8", env: "DIGEST_HOUR" },
  "email.max_per_hour": { default: "30", env: "MAX_EMAILS_PER_HOUR" },
  "email.provider": { default: "disabled" },
  "email.sendgrid_api_key": { default: "", secret: true, env: "SENDGRID_API_KEY" },
  "email.smtp_host": { default: "" },
  "email.smtp_port": { default: "587" },
  "email.smtp_user": { default: "" },
  "email.smtp_password": { default: "", secret: true },
  "email.smtp_tls": { default: "starttls" },
  "email.allowed_domains": { default: "" },
  "agent.static_url": { default: "http://frontend", env: "AGENT_STATIC_URL" },
  // Microsoft Entra ID (Azure AD) sign-in — optional and off by default.
  // Username/password sign-in is always available regardless. Enable the
  // Microsoft button by setting azure.enabled=true with a tenant/client id
  // and the three Entra group object ids, all from Settings.
  "azure.enabled": { default: "false", env: "AZURE_ENABLED" },
  "azure.tenant_id": { default: "", env: "AZURE_TENANT_ID" },
  "azure.client_id": { default: "", env: "AZURE_CLIENT_ID" },
  "azure.group_admin": { default: "", env: "AZURE_GROUP_ADMIN" },
  "azure.group_operator": { default: "", env: "AZURE_GROUP_OPERATOR" },
  "azure.group_viewer": { default: "", env: "AZURE_GROUP_VIEWER" },
};

const cache = new Map<string, string>();

export async function initSettings(): Promise<void> {
  // Seed pass: legacy env values populate missing rows only.
  for (const [key, def] of Object.entries(SETTINGS_REGISTRY)) {
    const envVal = def.env ? process.env[def.env] : undefined;
    if (envVal !== undefined && envVal !== "") {
      const stored = def.secret ? encryptSecret(envVal) : envVal;
      await query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, 'env-seed')
         ON CONFLICT (key) DO NOTHING`,
        [key, stored],
      );
    }
  }
  // A SendGrid key seeded from env implies the deploy was emailing via
  // SendGrid — carry that intent over so upgrades don't silently stop mail.
  if (process.env.SENDGRID_API_KEY) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ('email.provider', 'sendgrid', 'env-seed')
       ON CONFLICT (key) DO NOTHING`,
    );
  }

  const { rows } = await query(`SELECT key, value FROM app_settings`);
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
}

/** Current value (decrypted for secrets), falling back to the registry default. */
export function getSetting(key: string): string {
  const def = SETTINGS_REGISTRY[key];
  const raw = cache.get(key);
  if (raw == null) return def?.default ?? "";
  return def?.secret || isEncrypted(raw) ? decryptSecret(raw) : raw;
}

export function getSettingNumber(key: string): number {
  const n = parseFloat(getSetting(key));
  return Number.isFinite(n) ? n : parseFloat(SETTINGS_REGISTRY[key]?.default ?? "0");
}

export async function setSetting(key: string, value: string, updatedBy: string): Promise<void> {
  const def = SETTINGS_REGISTRY[key];
  if (!def) throw new Error(`unknown setting '${key}'`);
  const stored = def.secret && value !== "" ? encryptSecret(value) : value;
  await query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
    [key, stored, updatedBy],
  );
  cache.set(key, stored);
}

/** Non-secret values plus { set: boolean } markers for secrets — safe to return to the admin UI. */
export function settingsForUi(): Record<string, string | { set: boolean }> {
  const out: Record<string, string | { set: boolean }> = {};
  for (const [key, def] of Object.entries(SETTINGS_REGISTRY)) {
    if (def.secret) out[key] = { set: getSetting(key) !== "" };
    else out[key] = getSetting(key);
  }
  return out;
}
