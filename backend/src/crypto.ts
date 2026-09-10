import crypto from "node:crypto";
import { query } from "./db.js";

/**
 * Encryption-at-rest for secrets stored in the database (email provider
 * credentials, probe variables, probe auth tokens). Everything derives from
 * one master key, resolved once at boot in this order:
 *
 *   1. ALFRED_MASTER_KEY env var (64 hex chars). Keeps the key outside the
 *      database, which is the stronger option for production.
 *   2. The instance_secrets row, if an earlier boot generated and stored one.
 *   3. A fresh key, generated, stored in instance_secrets, and printed once.
 *
 * resolveMasterKey() must run after initDb(). After that, encryptSecret /
 * decryptSecret / jwtSecret use the cached key synchronously.
 *
 * Stored format: "enc:v1:" + base64(IV(12) ‖ GCM tag(16) ‖ ciphertext).
 * The versioned prefix makes migrations idempotent (plaintext values are
 * detectable) and leaves room for a future key-rotation scheme.
 */

const PREFIX = "enc:v1:";
const DB_KEY_NAME = "master_key";

let cachedKey: Buffer | null = null;
let cachedKeyHex: string | null = null;
let keySource: "env" | "database" | "generated" = "generated";

const isValidKey = (hex: string): boolean => /^[0-9a-fA-F]{64}$/.test(hex);

function setKey(hex: string, source: "env" | "database" | "generated"): void {
  cachedKeyHex = hex;
  cachedKey = Buffer.from(hex, "hex");
  keySource = source;
}

export async function resolveMasterKey(): Promise<void> {
  if (cachedKey) return;

  const fromEnv = (process.env.ALFRED_MASTER_KEY || "").trim();
  if (fromEnv) {
    if (!isValidKey(fromEnv)) {
      console.error(
        "ALFRED_MASTER_KEY is set but invalid. It must be 64 hex characters (32 bytes).\n" +
        "Generate one with:  openssl rand -hex 32",
      );
      process.exit(1);
    }
    setKey(fromEnv, "env");
    return;
  }

  const { rows } = await query(`SELECT value FROM instance_secrets WHERE key = $1`, [DB_KEY_NAME]);
  if (rows.length > 0 && isValidKey(rows[0].value)) {
    setKey(rows[0].value, "database");
    return;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO instance_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [DB_KEY_NAME, generated],
  );
  // Re-read: a concurrent boot may have won the insert.
  const { rows: after } = await query(`SELECT value FROM instance_secrets WHERE key = $1`, [DB_KEY_NAME]);
  const key = after[0]?.value && isValidKey(after[0].value) ? after[0].value : generated;
  setKey(key, key === generated ? "generated" : "database");

  if (keySource === "generated") {
    const rule = "=".repeat(72);
    console.log(
      `\n${rule}\n` +
      "  Alfred generated an encryption key for secrets stored in the database\n" +
      "  and saved it there. Record it now:\n\n" +
      `  ALFRED_MASTER_KEY=${key}\n\n` +
      "  Set that as an environment variable to keep the key outside the\n" +
      "  database (recommended for production). An admin can also reveal it\n" +
      "  later under Settings.\n" +
      `${rule}\n`,
    );
  }
}

/** The resolved key. Throws if resolveMasterKey() has not run yet. */
export function requireMasterKey(): Buffer {
  if (!cachedKey) {
    throw new Error("master key not resolved — resolveMasterKey() must run at boot before any secret is used");
  }
  return cachedKey;
}

/** The active master key as hex — for the admin-only reveal endpoint. */
export function masterKeyHex(): string {
  if (!cachedKeyHex) throw new Error("master key not resolved");
  return cachedKeyHex;
}

/** Where the active key came from. */
export function masterKeySource(): "env" | "database" | "generated" {
  return keySource;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const key = requireMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // tolerate not-yet-migrated plaintext
  const key = requireMasterKey();
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Session-signing secret. JWT_SECRET (if set) stays authoritative so existing
 * deploys keep their sessions; otherwise derive a stable key from the master
 * key. Kept separate from the encryption key (HKDF with its own info string)
 * so rotating sessions and re-encrypting secrets stay independent.
 */
export function jwtSecret(): string {
  const env = process.env.JWT_SECRET;
  if (env) return env;
  const derived = crypto.hkdfSync("sha256", requireMasterKey(), Buffer.alloc(0), "alfred-jwt-v1", 32);
  return Buffer.from(derived).toString("hex");
}
