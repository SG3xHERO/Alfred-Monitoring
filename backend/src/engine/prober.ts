import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFile } from "node:child_process";
import sql from "mssql";
import * as SMB2Module from "@marsaud/smb2";
import { query } from "../db.js";
import { broadcast } from "../sse.js";
import { decryptSecret } from "../crypto.js";
import { getCredential } from "../routes/credentials.js";
import { getSettingNumber } from "../settings.js";
import { evaluateServer } from "./evaluator.js";
import type { ServerLike } from "./rules.js";

// @marsaud/smb2 is a CJS package (module.exports = class); NodeNext module
// resolution doesn't always synthesize the default import cleanly, so grab
// the constructor directly rather than fighting esModuleInterop here.
const SMB2 = (SMB2Module as any).default ?? (SMB2Module as any);

export interface ProbeRow {
  id: number;
  server_id: number;
  type: "http" | "tcp" | "api" | "push" | "ping" | "directory" | "data";
  target: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number | null;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  auth_token: string | null;
  json_path: string | null;
  json_expected: string | null;
  timestamp_path: string | null;
  max_age_minutes: number | null;
  auth_url: string | null;
  auth_body: string | null;
  auth_token_path: string | null;
  fail_on_graphql_errors: boolean;
  // Directory/Ping/Data check types (no agent required)
  warning_threshold: number | null;
  severe_threshold: number | null;
  file_mask: string | null;
  credential_id: number | null;
  connection_id: number | null;
  procedure_name: string | null;
  // joined from the shadow server row
  display_name: string;
  brand: string;
  tags: string[];
  status: string;
  parent_display_name?: string | null;
}

export interface ProbeResult {
  up: boolean;
  latency_ms: number | null;
  status_code: number | null;
  cert_days_remaining: number | null;
  error: string | null;
  json_value?: string | null;
  age_minutes?: number | null;
  /** numeric metric for ping/directory/data (unreachable count, file count, row count) — rules can reference probe.value */
  value?: number | null;
}

/** Dot-path lookup into a parsed JSON value, e.g. "data.flows.0.status". */
function getByPath(value: any, path: string): any {
  return path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
}

/**
 * Resolves {{Name}} references against probe_variables — lets a shared
 * secret (an API's access token) live in one place and be reused across
 * every probe's URL/headers/body/auth fields instead of pasted into each.
 * Unknown names are left as-is so a typo shows up in the probe's error
 * instead of silently sending "{{Typo}}" or an empty string.
 */
function interpolate<T extends string | null>(str: T, vars: Record<string, string>): T {
  if (str == null) return str;
  return str.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m) as T;
}

// TLS session resumption makes getPeerCertificate() return an empty object,
// which would blank cert.days_remaining after the first check — so never
// cache sessions, and don't hold sockets open between probe runs either.
const httpsAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
const httpAgent = new http.Agent({ keepAlive: false });

export function probeHttp(target: string, timeoutMs: number, expectedStatus: number | null): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return resolve({ up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: "invalid URL" });
    }
    const lib = u.protocol === "https:" ? https : http;
    const started = Date.now();
    let settled = false;
    const done = (r: ProbeResult) => { if (!settled) { settled = true; resolve(r); } };

    const req = lib.request(u, {
      method: "GET",
      agent: u.protocol === "https:" ? httpsAgent : httpAgent,
      timeout: timeoutMs,
      // an expired/self-signed cert must not hide the probe result — expiry is
      // surfaced as cert.days_remaining for rules to alert on instead
      rejectUnauthorized: false,
      headers: { "User-Agent": "alfred-probe/1.0", Accept: "*/*" },
    }, (res) => {
      const latency = Date.now() - started;
      let certDays: number | null = null;
      const socket = res.socket as import("node:tls").TLSSocket;
      if (u.protocol === "https:" && typeof socket.getPeerCertificate === "function") {
        const cert = socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          certDays = Math.round(((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000) * 10) / 10;
        }
      }
      res.resume(); // drain so the socket is released
      const code = res.statusCode ?? 0;
      const up = expectedStatus != null ? code === expectedStatus : code >= 200 && code < 400;
      done({
        up, latency_ms: latency, status_code: code, cert_days_remaining: certDays,
        error: up ? null : `HTTP ${code}${expectedStatus != null ? ` (expected ${expectedStatus})` : ""}`,
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (err) => done({
      up: false, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null,
      error: errText(err),
    }));
    req.end();
  });
}

interface RawResponse { status: number; body: string; latency_ms: number; }

/** One HTTP round-trip, TLS-lenient like the other probes, no retries. */
function rawRequest(url: string, method: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error("invalid URL"));
    }
    const lib = u.protocol === "https:" ? https : http;
    const started = Date.now();
    let settled = false;
    const req = lib.request(u, {
      method, agent: u.protocol === "https:" ? httpsAgent : httpAgent,
      timeout: timeoutMs, rejectUnauthorized: false, headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), latency_ms: Date.now() - started });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (err) => { if (!settled) { settled = true; reject(new Error(errText(err))); } });
    if (body != null && body !== "") req.write(body);
    req.end();
  });
}

/**
 * Generic REST/GraphQL probe: any method, headers, body, bearer auth — with
 * an optional JSON-path assertion, a staleness check against a timestamp
 * field, and GraphQL error detection (GraphQL returns HTTP 200 even when the
 * query fails, so the errors array has to be checked explicitly). Covers
 * internal API health checks and 3rd-party flow status polling.
 *
 * When auth_url is set, a short-lived bearer token is fetched first (POSTing
 * auth_body there and lifting the token out at auth_token_path) — the
 * access-token-exchange pattern some GraphQL gateways require.
 */
export async function probeApi(p: ProbeRow, vars: Record<string, string> = {}): Promise<ProbeResult> {
  const target = interpolate(p.target, vars);
  const body = interpolate(p.body, vars);
  const authUrl = interpolate(p.auth_url, vars);
  const authBody = interpolate(p.auth_body, vars);
  const authToken = interpolate(p.auth_token ? decryptSecret(p.auth_token) : p.auth_token, vars);
  const headers: Record<string, string> = { "User-Agent": "alfred-probe/1.0", Accept: "*/*" };
  for (const [k, v] of Object.entries(p.headers || {})) headers[k] = interpolate(v, vars);
  if (body != null && body !== "" && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  let authLatency = 0;
  if (authUrl) {
    try {
      const authRes = await rawRequest(authUrl, "POST",
        { "User-Agent": "alfred-probe/1.0", Accept: "*/*", "Content-Type": "application/json" },
        authBody, p.timeout_ms);
      authLatency = authRes.latency_ms;
      if (authRes.status < 200 || authRes.status >= 300) {
        return { up: false, latency_ms: authLatency, status_code: authRes.status, cert_days_remaining: null, error: `auth HTTP ${authRes.status}${bodySnippet(authRes.body)}` };
      }
      const token = getByPath(JSON.parse(authRes.body), p.auth_token_path || "token");
      if (!token) {
        return { up: false, latency_ms: authLatency, status_code: authRes.status, cert_days_remaining: null, error: `auth response had no token at '${p.auth_token_path || "token"}'` };
      }
      headers["Authorization"] = `Bearer ${token}`;
    } catch (err: any) {
      return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: `auth failed: ${err.message}` };
    }
  } else if (authToken && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  let res: RawResponse;
  try {
    res = await rawRequest(target, p.method || "GET", headers, body, p.timeout_ms);
  } catch (err: any) {
    return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: err.message };
  }

  const latency = authLatency + res.latency_ms;
  let up = p.expected_status != null ? res.status === p.expected_status : res.status >= 200 && res.status < 400;
  let error = up ? null
    : `HTTP ${res.status}${p.expected_status != null ? ` (expected ${p.expected_status})` : ""}${bodySnippet(res.body)}`;
  let jsonValue: string | null = null;
  let ageMinutes: number | null = null;

  if (up && (p.json_path || p.timestamp_path || p.fail_on_graphql_errors)) {
    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      up = false;
      error = "response body is not valid JSON";
    }
    if (parsed !== undefined) {
      if (up && p.fail_on_graphql_errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        up = false;
        error = `GraphQL error: ${parsed.errors[0].message || JSON.stringify(parsed.errors[0])}`;
      }
      if (up && p.json_path) {
        const found = getByPath(parsed, p.json_path);
        jsonValue = found == null ? null : String(found);
        if (p.json_expected) {
          const wanted = p.json_expected.split(",").map((s) => s.trim().toLowerCase());
          if (jsonValue == null || !wanted.includes(jsonValue.toLowerCase())) {
            up = false;
            error = `${p.json_path} was '${jsonValue ?? "null"}', expected '${p.json_expected}'`;
          }
        }
      }
      if (up && p.timestamp_path) {
        const raw = getByPath(parsed, p.timestamp_path);
        const t = raw != null ? new Date(raw).getTime() : NaN;
        if (Number.isNaN(t)) {
          up = false;
          error = `${p.timestamp_path} was not a valid timestamp`;
        } else {
          ageMinutes = Math.round(((Date.now() - t) / 60_000) * 10) / 10;
          if (p.max_age_minutes != null && ageMinutes > p.max_age_minutes) {
            up = false;
            error = `last run ${ageMinutes.toFixed(0)}m ago (expected within ${p.max_age_minutes}m)`;
          }
        }
      }
    }
  }

  return { up, latency_ms: latency, status_code: res.status, cert_days_remaining: null, error, json_value: jsonValue, age_minutes: ageMinutes };
}

export function probeTcp(target: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const m = /^(.+?):(\d+)$/.exec(target.trim());
    if (!m) {
      return resolve({ up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: "target must be host:port" });
    }
    const started = Date.now();
    let settled = false;
    const done = (r: ProbeResult) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
    const socket = net.connect({ host: m[1], port: parseInt(m[2], 10), timeout: timeoutMs });
    socket.on("connect", () => done({
      up: true, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null, error: null,
    }));
    socket.on("timeout", () => done({
      up: false, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null, error: `timeout after ${timeoutMs}ms`,
    }));
    socket.on("error", (err) => done({
      up: false, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null, error: errText(err),
    }));
  });
}

/**
 * Real ICMP ping (not a TCP connect) — for internal IPs with no open port to
 * probe against otherwise. Shells out to the system `ping` binary since Node
 * has no built-in ICMP; the backend container needs CAP_NET_RAW (see
 * docker-compose.yml). up = the host answered; no thresholds involved here —
 * a flap guard (N consecutive failures before alerting) is a Rules `for:` duration.
 */
export function probePing(target: string, timeoutMs: number): Promise<ProbeResult> {
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const started = Date.now();
  return new Promise((resolve) => {
    execFile("ping", ["-c", "1", "-W", String(timeoutSec), target.trim()], (err) => {
      const latency = Date.now() - started;
      resolve(err
        ? { up: false, latency_ms: latency, status_code: null, cert_days_remaining: null, error: `no reply from ${target}` }
        : { up: true, latency_ms: latency, status_code: null, cert_days_remaining: null, error: null });
    });
  });
}

/** Splits a UNC path like \\host\share\sub\folder into { share, subPath }. */
function parseUnc(uncPath: string): { share: string; subPath: string } | null {
  const normalized = uncPath.replace(/\//g, "\\");
  const m = /^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/.exec(normalized);
  if (!m) return null;
  return { share: `\\\\${m[1]}\\${m[2]}`, subPath: m[3].replace(/\\/g, "/") };
}

/** Turns a simple DOS-style mask (`*`, `?`, literal chars) into a RegExp — no full glob semantics needed here. */
function maskToRegExp(mask: string): RegExp {
  const escaped = mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Directory probe: counts files matching a mask under a UNC path over SMB —
 * up = value < severe_threshold (the
 * warning tier has no dedicated column; author a second Rule on probe.value
 * for that, same pattern as e.g. disk.min_free_pct rules). Requires network
 * line-of-sight from the backend container to the share (SMB/445) and a
 * stored 'smb' credential.
 */
export async function probeDirectory(p: ProbeRow): Promise<ProbeResult> {
  const parsed = parseUnc(p.target);
  if (!parsed) return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: `not a valid UNC path: ${p.target}` };

  const cred = p.credential_id ? await getCredential(p.credential_id) : null;
  const client = new SMB2({
    share: parsed.share,
    domain: cred?.domain || "",
    username: cred?.username || "guest",
    password: cred?.secret || "",
  });

  try {
    const entries = await client.readdir(parsed.subPath || ".", { stats: true }) as Array<{ name: string; isDirectory(): boolean }>;
    const regex = maskToRegExp(p.file_mask || "*");
    const count = entries.filter((e) => !e.isDirectory() && regex.test(e.name)).length;
    const severe = p.severe_threshold ?? 0;
    const up = count < severe;
    return {
      up, latency_ms: null, status_code: null, cert_days_remaining: null, value: count,
      error: up ? null : `${count} file(s) matching "${p.file_mask}" (severe at ${severe})`,
    };
  } catch (err: any) {
    return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: `SMB error: ${err.message}` };
  } finally {
    client.disconnect();
  }
}

interface DataConnectionRow {
  id: number; name: string; host: string; database_name: string; credential_id: number | null;
}

/**
 * Data probe: runs a SQL Server stored procedure and thresholds on the
 * number of rows it returns. up = value
 * < severe_threshold. Requires network reachability from the backend
 * container to the SQL Server host:1433 and a stored 'sql' credential.
 */
export async function probeData(p: ProbeRow): Promise<ProbeResult> {
  if (!p.connection_id || !p.procedure_name) {
    return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: "connection and procedure are required" };
  }
  const { rows } = await query<DataConnectionRow>(`SELECT * FROM data_connections WHERE id = $1`, [p.connection_id]);
  if (rows.length === 0) return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: "data connection not found" };
  const conn = rows[0];
  const cred = conn.credential_id ? await getCredential(conn.credential_id) : null;
  if (!cred) return { up: false, latency_ms: null, status_code: null, cert_days_remaining: null, error: "no credential set on data connection" };

  const pool = new sql.ConnectionPool({
    server: conn.host,
    database: conn.database_name,
    user: cred.username || undefined,
    password: cred.secret || undefined,
    options: { trustServerCertificate: true, encrypt: true },
    connectionTimeout: Math.min(p.timeout_ms, 30_000),
    requestTimeout: 30_000,
  });

  const started = Date.now();
  try {
    await pool.connect();
    const result = await pool.request().execute(p.procedure_name);
    const count = result.recordset?.length ?? 0;
    const severe = p.severe_threshold ?? 0;
    const up = count < severe;
    return {
      up, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null, value: count,
      error: up ? null : `${p.procedure_name} returned ${count} row(s) (severe at ${severe})`,
    };
  } catch (err: any) {
    return { up: false, latency_ms: Date.now() - started, status_code: null, cert_days_remaining: null, error: `SQL error: ${err.message}` };
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Happy-eyeballs failures surface as an AggregateError with an empty message. */
function errText(err: any): string {
  return err.message || err.code || err.errors?.[0]?.message || "connection failed";
}

/** Short excerpt of a failed response body, for actionable probe errors. */
function bodySnippet(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const flat = trimmed.replace(/\s+/g, " ").slice(0, 200);
  return ` — ${flat}${trimmed.length > 200 ? "…" : ""}`;
}

export interface ProbeContext {
  id: number; server_id: number; type: string; target: string;
  display_name: string; brand: string; tags: string[]; status: string;
  parent_display_name?: string | null;
}

/**
 * Writes one probe result and mirrors what /api/ingest does for agents —
 * status transition, SSE broadcast, rule evaluation — so both pulled
 * (http/tcp/api) and pushed results feed the rest of the system identically.
 */
export async function applyProbeResult(p: ProbeContext, result: ProbeResult): Promise<void> {
  const now = new Date();

  await query(
    `INSERT INTO probe_results (time, probe_id, up, latency_ms, status_code, cert_days_remaining, error, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [now, p.id, result.up, result.latency_ms, result.status_code, result.cert_days_remaining, result.error, result.value ?? null],
  );

  const snapshot = {
    probe: {
      type: p.type, target: p.target, checked_at: now.toISOString(),
      latency_ms: result.latency_ms, status_code: result.status_code,
      cert_days_remaining: result.cert_days_remaining, error: result.error,
      json_value: result.json_value ?? (result.value != null ? String(result.value) : null),
      age_minutes: result.age_minutes ?? null,
      value: result.value ?? null,
    },
  };
  const newStatus = result.up ? "online" : "offline";
  await query(
    `UPDATE servers SET
       status = $2,
       status_since = CASE WHEN status <> $2 THEN $3 ELSE status_since END,
       last_seen = CASE WHEN $4 THEN $3 ELSE last_seen END,
       first_seen = COALESCE(first_seen, $3),
       last_snapshot = $5
     WHERE id = $1`,
    [p.server_id, newStatus, now, result.up, JSON.stringify(snapshot)],
  );

  if (p.status !== newStatus) {
    console.log(`probe ${p.display_name} (#${p.id}) ${newStatus}${result.error ? `: ${result.error}` : ""}`);
  }
  broadcast("server", {
    id: p.server_id, status: newStatus, kind: "probe",
    last_seen: now.toISOString(), latency_ms: result.latency_ms,
    cameOnline: result.up && p.status !== "online",
  });

  const serverLike: ServerLike = {
    id: p.server_id, hostname: null, display_name: p.display_name,
    brand: p.brand, tags: p.tags, status: newStatus, agent_version: null,
    last_snapshot: snapshot, last_seen: now, parent_display_name: p.parent_display_name,
  };
  await evaluateServer(serverLike);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(p: ProbeRow, target: string, vars: Record<string, string>): Promise<ProbeResult> {
  return p.type === "http" ? await probeHttp(target, p.timeout_ms, p.expected_status)
    : p.type === "api" ? await probeApi(p, vars)
    : p.type === "tcp" ? await probeTcp(target, p.timeout_ms)
    : p.type === "ping" ? await probePing(target, p.timeout_ms)
    : p.type === "directory" ? await probeDirectory(p)
    : await probeData(p);
}

async function runProbe(p: ProbeRow, vars: Record<string, string>): Promise<void> {
  // target is resolved for the outgoing request only — the raw (unresolved)
  // form is what gets stored/displayed, so a {{Var}} used in a URL never
  // ends up echoing its resolved value into the snapshot or the UI.
  const target = interpolate(p.target, vars);

  // A single failed attempt doesn't commit a probe as down — one dropped
  // packet, one 502 during an app-pool recycle, one slow DNS answer
  // shouldn't flip a shadow server offline and fire rules. Only a run of
  // failures across every attempt does; a success at any point wins and is
  // what gets recorded.
  let result = await runOnce(p, target, vars);
  const attempts = Math.max(1, Math.round(getSettingNumber("alert.probe_confirm_attempts")));
  const spacingMs = Math.max(0, getSettingNumber("alert.probe_confirm_spacing_ms"));
  for (let i = 1; i < attempts && !result.up; i++) {
    await sleep(spacingMs);
    result = await runOnce(p, target, vars);
  }
  await applyProbeResult(p, result);
}

const lastRun = new Map<number, number>();
const inFlight = new Set<number>();

/** Fires each probe on its own interval; one loop for the whole estate. */
export function startProberLoop(): void {
  const tick = async () => {
    const { rows } = await query<ProbeRow>(
      `SELECT p.id, p.server_id, p.type, p.target, p.interval_seconds, p.timeout_ms, p.expected_status,
              p.method, p.headers, p.body, p.auth_token, p.json_path, p.json_expected,
              p.timestamp_path, p.max_age_minutes, p.auth_url, p.auth_body, p.auth_token_path,
              p.fail_on_graphql_errors,
              p.warning_threshold, p.severe_threshold, p.file_mask, p.credential_id, p.connection_id, p.procedure_name,
              s.display_name, s.brand, s.tags, s.status, parent.display_name AS parent_display_name
       FROM probes p JOIN servers s ON s.id = p.server_id
                      LEFT JOIN servers parent ON parent.id = s.parent_id`,
    );
    const now = Date.now();
    // push probes are never actively fired — an external runner posts to
    // /api/probes/:id/push on its own schedule instead
    const due = rows.filter((p) => p.type !== "push" &&
      (lastRun.get(p.id) ?? 0) + p.interval_seconds * 1000 <= now && !inFlight.has(p.id));
    if (due.length > 0) {
      const { rows: varRows } = await query<{ name: string; value: string }>(`SELECT name, value FROM probe_variables`);
      const vars = Object.fromEntries(varRows.map((v) => [v.name, decryptSecret(v.value)]));
      for (const p of due) {
        lastRun.set(p.id, now);
        inFlight.add(p.id);
        runProbe(p, vars)
          .catch((err) => console.error(`probe ${p.display_name} (#${p.id}):`, err.message))
          .finally(() => inFlight.delete(p.id));
      }
    }
    // drop state for deleted probes so the maps don't grow forever
    if (lastRun.size > rows.length) {
      const ids = new Set(rows.map((r) => r.id));
      for (const id of lastRun.keys()) if (!ids.has(id)) lastRun.delete(id);
    }
  };
  setInterval(() => { tick().catch((err) => console.error("prober error:", err.message)); }, 5_000).unref();
}
