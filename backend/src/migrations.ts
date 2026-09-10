import { query } from "./db.js";
import { encryptSecret, isEncrypted } from "./crypto.js";

/**
 * One-off, idempotent boot migrations that can't be plain DDL.
 * Detection is by the "enc:v1:" prefix, so re-running is always safe.
 */
export async function runMigrations(): Promise<void> {
  // Probe variables predate encryption-at-rest and were stored plaintext.
  const { rows: vars } = await query(
    `SELECT name, value FROM probe_variables WHERE value NOT LIKE 'enc:v1:%'`,
  );
  for (const v of vars) {
    await query(`UPDATE probe_variables SET value = $2 WHERE name = $1`, [v.name, encryptSecret(v.value)]);
  }
  if (vars.length) console.log(`encrypted ${vars.length} probe variable(s) at rest`);

  // Same for per-probe bearer tokens.
  const { rows: tokens } = await query(
    `SELECT id, auth_token FROM probes WHERE auth_token IS NOT NULL AND auth_token <> '' AND auth_token NOT LIKE 'enc:v1:%'`,
  );
  for (const t of tokens) {
    if (isEncrypted(t.auth_token)) continue;
    await query(`UPDATE probes SET auth_token = $2 WHERE id = $1`, [t.id, encryptSecret(t.auth_token)]);
  }
  if (tokens.length) console.log(`encrypted ${tokens.length} probe auth token(s) at rest`);

  await seedBrandsFromServers();
  await migrateGroupKeysToParentId();
}

/**
 * One-time: group_key-based sibling clustering (flat, no real parent) is
 * superseded by parent_id (true parent/child, worst-of rollup — see
 * schema.ts). For each existing group_key cluster, the lowest-id member
 * becomes the parent and the rest point at it; group_key itself is left
 * alone (unused going forward) so this is safe to run more than once —
 * a member that already has a parent_id is skipped.
 */
async function migrateGroupKeysToParentId(): Promise<void> {
  const { rows: keys } = await query(
    `SELECT group_key FROM servers WHERE group_key IS NOT NULL AND parent_id IS NULL GROUP BY group_key HAVING count(*) > 1`,
  );
  for (const { group_key } of keys) {
    const { rows: members } = await query(
      `SELECT id FROM servers WHERE group_key = $1 ORDER BY id`, [group_key],
    );
    const [parent, ...children] = members;
    for (const c of children) {
      await query(`UPDATE servers SET parent_id = $2 WHERE id = $1 AND parent_id IS NULL`, [c.id, parent.id]);
    }
  }
  if (keys.length) console.log(`migrated ${keys.length} group_key cluster(s) to parent/child nesting`);
}

/**
 * First boot only: populate the brands list from whatever brand values
 * already exist on servers, so an existing deploy's groups show up exactly
 * as they were — never from a fixed/example list. A brand-new install with
 * no servers yet gets an empty list; the setup wizard populates it.
 */
async function seedBrandsFromServers(): Promise<void> {
  const { rows: existing } = await query(`SELECT count(*)::int AS n FROM brands`);
  if (existing[0].n > 0) return;

  const { rows: distinct } = await query(
    `SELECT DISTINCT brand FROM servers WHERE brand IS NOT NULL AND brand <> '' ORDER BY brand`,
  );
  if (distinct.length === 0) return;

  const defaultName = distinct.some((r) => r.brand === "Shared Infrastructure")
    ? "Shared Infrastructure" : distinct[0].brand;
  for (const [i, r] of distinct.entries()) {
    await query(
      `INSERT INTO brands (name, sort, is_default) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [r.brand, i, r.brand === defaultName],
    );
  }
  console.log(`seeded ${distinct.length} brand(s) from existing servers`);
}
