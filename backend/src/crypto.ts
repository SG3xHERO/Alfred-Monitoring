import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encryption-at-rest for secrets stored in the database (email provider
 * credentials, probe variables, probe auth tokens). Everything derives from
 * one master key — the single secret a deploy must keep; all other
 * configuration lives in the DB and is editable in Settings.
 *
 * The key is resolved once at boot, in order:
 *   1. ALFRED_MASTER_KEY env var (64 hex chars) — for scripted/IaC deploys.
 *   2. The key file (ALFRED_KEY_FILE, default /data/alfred-master.key) if it
 *      exists — where a previously auto-generated key was persisted.
 *   3. Otherwise a fresh key is generated, written to that file, and printed
 *      to the logs once so the operator can record it.
 *
 * Stored format: "enc:v1:" + base64(IV(12) ‖ GCM tag(16) ‖ ciphertext).
 * The versioned prefix makes migrations idempotent (plaintext values are
 * detectable) and leaves room for a future key-rotation scheme.
 */

const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;
let cachedKeyHex: string | null = null;
let keyWasGenerated = false;

function keyFilePath(): string {
  return process.env.ALFRED_KEY_FILE || "/data/alfred-master.key";
}

/** Resolves the master key (env → key file → generate). Call once at boot. */
export function requireMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = (process.env.ALFRED_MASTER_KEY || "").trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      console.error(
        "ALFRED_MASTER_KEY is set but invalid. It must be 64 hex characters (32 bytes).\n" +
        "Generate one with:  openssl rand -hex 32\n" +
        "Or leave it unset and Alfred will generate and persist one for you.",
      );
      process.exit(1);
    }
    return setKey(fromEnv, false);
  }

  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const onDisk = fs.readFileSync(file, "utf8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(onDisk)) return setKey(onDisk, false);
      console.error(`key file ${file} exists but does not contain a valid 64-hex key — refusing to overwrite it`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`could not read key file ${file}: ${err.message}`);
    process.exit(1);
  }

  // Generate, persist, and announce.
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated + "\n", { mode: 0o600 });
  } catch (err: any) {
    console.error(
      `no ALFRED_MASTER_KEY set and could not write a generated one to ${file}: ${err.message}\n` +
      "Set ALFRED_MASTER_KEY in the environment, or mount a writable volume at that path.",
    );
    process.exit(1);
  }
  keyWasGenerated = true;
  const rule = "=".repeat(72);
  console.log(
    `\n${rule}\n` +
    "  Alfred generated a new encryption key for secrets stored in the DB.\n" +
    `  Saved to: ${file}\n\n` +
    `  ALFRED_MASTER_KEY=${generated}\n\n` +
    "  Record this now. Without it, secrets in the database (email provider\n" +
    "  credentials, probe tokens) cannot be decrypted if the volume is lost.\n" +
    "  An admin can also reveal it later under Settings → System.\n" +
    `${rule}\n`,
  );
  return setKey(generated, true);
}

function setKey(hex: string, generated: boolean): Buffer {
  cachedKeyHex = hex;
  cachedKey = Buffer.from(hex, "hex");
  keyWasGenerated = generated || keyWasGenerated;
  return cachedKey;
}

/** The active master key as hex — for the admin-only reveal endpoint. */
export function masterKeyHex(): string {
  requireMasterKey();
  return cachedKeyHex!;
}

/** Whether the active key was auto-generated this run (vs supplied via env / key file). */
export function masterKeyWasGenerated(): boolean {
  requireMasterKey();
  return keyWasGenerated;
}

/** Where the key is (or would be) persisted on disk. */
export function masterKeyFile(): string {
  return keyFilePath();
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
 * Session-signing secret. JWT_SECRET (if set) stays authoritative so
 * existing deploys keep their sessions; otherwise derive a stable key from
 * the master key — a fresh install needs only a database.
 * Kept separate from the encryption key (HKDF with its own info string) so
 * rotating sessions and re-encrypting secrets remain independent operations.
 */
export function jwtSecret(): string {
  const env = process.env.JWT_SECRET;
  if (env) return env;
  const derived = crypto.hkdfSync("sha256", requireMasterKey(), Buffer.alloc(0), "alfred-jwt-v1", 32);
  return Buffer.from(derived).toString("hex");
}
