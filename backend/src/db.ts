import pg from "pg";
import { CORE_SCHEMA, TIMESCALE_SCHEMA, DEFAULT_RULES_YAML, retentionSchema } from "./schema.js";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgres://alfred@localhost:5432/alfred",
  max: 10,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

let timescaleActive = false;

export async function initDb(): Promise<void> {
  // Postgres may still be starting inside compose; retry rather than crash-loop.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for database (${attempt}/30)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await pool.query(CORE_SCHEMA);

  // hypertable conversion needs the metrics table to exist first;
  // migrate_data covers a prior plain-Postgres run
  timescaleActive = true;
  for (const stmt of TIMESCALE_SCHEMA) {
    try {
      await pool.query(stmt);
    } catch (err: any) {
      console.warn(`timescale setup skipped (${err.message}) — continuing on plain PostgreSQL`);
      timescaleActive = false;
      break;
    }
  }

  await pool.query(
    `INSERT INTO rules_doc (id, yaml) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_RULES_YAML],
  );
}

/** (Re-)applies Timescale retention policies. Called after settings load at boot, and again when the setting changes. */
export async function applyRetention(days: number): Promise<void> {
  if (!timescaleActive) return;
  for (const stmt of retentionSchema(days)) {
    try {
      await pool.query(stmt);
    } catch (err: any) {
      console.warn(`retention policy update skipped: ${err.message}`);
      return;
    }
  }
}
