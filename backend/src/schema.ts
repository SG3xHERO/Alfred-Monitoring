// Idempotent schema, applied at startup. TimescaleDB-specific statements are
// allowed to fail so the backend also runs against plain PostgreSQL.

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
  id              serial PRIMARY KEY,
  hostname        text,
  display_name    text NOT NULL,
  brand           text NOT NULL DEFAULT 'Ungrouped',
  tags            text[] NOT NULL DEFAULT '{}',
  os              text,
  platform        text,
  agent_version   text,
  api_key_hash    text UNIQUE NOT NULL,
  interval_seconds int NOT NULL DEFAULT 15,
  status          text NOT NULL DEFAULT 'pending',
  status_since    timestamptz,
  last_seen       timestamptz,
  first_seen      timestamptz,
  last_snapshot   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 'agent' rows are fed by heartbeats; 'probe' rows are shadow servers owned by
-- a row in probes below, so the rules engine, incidents, mutes and the
-- Overview/Wall brand groupings treat synthetic checks exactly like servers.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent';

-- Admin-triggered agent binary update: set by POST /:id/request-update,
-- surfaced to the agent via the /api/ingest response, cleared once
-- POST /api/agent/update-result confirms the swap (success or failure).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS update_requested_version text;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS update_requested_at timestamptz;

-- Admin-chosen "what should this agent be watching" (e.g. lockout/SQL/
-- signed-in-users monitoring). Drives both what gets pushed down to the
-- agent's config.yaml (via /api/ingest's response, mirroring the update
-- flow above) and which panels the device page shows — a single source of
-- truth instead of separate "desired" and "capability" columns.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS desired_config jsonb;

-- Superseded by parent_id below (kept only so old exports/migrations reading
-- this column don't break) — no longer read by the frontend.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS group_key text;

-- True parent/child nesting: a child is hidden from the top-level
-- Overview/Wall list and rolled into its parent's displayed status (worst-of
-- parent + all descendants), e.g. a HyperV host (parent) with its guest VMs
-- (children), or a "Servers Online"-style ping check (parent) with sibling
-- IPs (children). Each row still gets its own independent rules/incidents/
-- alert emails — this is purely a display-layer rollup, not a data change.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS parent_id int REFERENCES servers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS servers_parent ON servers (parent_id) WHERE parent_id IS NOT NULL;

-- The address the agent's heartbeat was actually seen from (req.ip at
-- ingest time) — shown on the device page so a server can be told apart
-- from others with the same display name/hostname.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS ip_address text;

-- Named logins for things Alfred itself connects out to on the operator's
-- behalf (an SMB share for directory checks, a SQL Server login for data
-- checks) — distinct from probe_variables (which are {{Name}} template
-- values pasted into probe fields, never used by Alfred's own network code).
-- Admin-only, unlike probe_variables' operator access, since these are
-- credentials for internal systems rather than 3rd-party API tokens.
CREATE TABLE IF NOT EXISTS credentials (
  id         serial PRIMARY KEY,
  name       text UNIQUE NOT NULL,
  type       text NOT NULL,
  username   text,
  domain     text,
  secret     text,
  extra      jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Reusable SQL Server connection presets for 'data' probes (e.g.
-- "Orders (db01 : orders)") — several probes can share one connection
-- instead of repeating host/database/credential.
CREATE TABLE IF NOT EXISTS data_connections (
  id            serial PRIMARY KEY,
  name          text UNIQUE NOT NULL,
  host          text NOT NULL,
  database_name text NOT NULL,
  credential_id int REFERENCES credentials(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Synthetic HTTP/TCP checks that need no agent (a website, a switch UI, a
-- printer). Name/brand/tags live on the shadow server row to avoid drift.
CREATE TABLE IF NOT EXISTS probes (
  id               serial PRIMARY KEY,
  server_id        int UNIQUE NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type             text NOT NULL,
  target           text NOT NULL,
  interval_seconds int NOT NULL DEFAULT 60,
  timeout_ms       int NOT NULL DEFAULT 5000,
  expected_status  int,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 'api' probes: generic REST/webhook checks (any method, headers, body, bearer
-- auth) with an optional JSON-path assertion and a staleness check — used for
-- watching internal API health as well as 3rd-party flow status (e.g. an
-- integration-platform flow-run endpoint that reports last run status/time).
ALTER TABLE probes ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'GET';
ALTER TABLE probes ADD COLUMN IF NOT EXISTS headers jsonb;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS auth_token text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS json_path text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS json_expected text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS timestamp_path text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS max_age_minutes int;

-- Some internal APIs (e.g. certain GraphQL gateways) don't take a static
-- bearer token: you exchange a long-lived access token for a short-lived
-- bearer token first. When auth_url is set, the prober POSTs auth_body there
-- and lifts the token out of the response at auth_token_path before firing
-- the real request. fail_on_graphql_errors treats a non-empty top-level
-- 'errors' array as a failure, since GraphQL returns HTTP 200 either way.
ALTER TABLE probes ADD COLUMN IF NOT EXISTS auth_url text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS auth_body text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS auth_token_path text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS fail_on_graphql_errors boolean NOT NULL DEFAULT false;

-- 'push' probes: for checks that can only be meaningfully run from outside
-- this network (e.g. a public-facing proxy that hairpin-NATs when tested from
-- inside), an external runner POSTs its own result to
-- /api/probes/:id/push instead of Alfred polling it. push_key_hash
-- authenticates that push, same scheme as servers.api_key_hash. Deliberately
-- excluded from the offline sweep (see evaluator.ts) — a push probe going
-- quiet just means nothing has reported, not that the check failed, so it
-- must never be conflated with an explicit "up: false" push.
ALTER TABLE probes ADD COLUMN IF NOT EXISTS push_key_hash text;

-- 'ping' probes: real ICMP (not a TCP connect) to an internal IP that has no
-- open port to probe against otherwise. 'directory' probes count files
-- matching a mask under a UNC path over SMB (a stored 'smb'-type credential).
-- 'data' probes run a SQL Server stored procedure and threshold on the
-- row count. All three are Directory/Ping/Data check types that fit the
-- existing probe model instead of a separate system, so they show on
-- Overview/Wall like any other probe. warning/severe_threshold
-- only apply to directory/data (their "up" = below severe_threshold; the
-- warning tier has no dedicated column — author a second Rule on
-- probe.value for that, same pattern as e.g. disk.min_free_pct rules).
ALTER TABLE probes ADD COLUMN IF NOT EXISTS warning_threshold int;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS severe_threshold int;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS file_mask text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS credential_id int REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS connection_id int REFERENCES data_connections(id) ON DELETE SET NULL;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS procedure_name text;

-- Named secrets referenced from probe fields as {{Name}} (URL, headers, body,
-- auth_token, auth_url, auth_body) so a shared credential — e.g. one API's
-- access token used by six probes — lives in one place and can be rotated
-- without touching every probe. Values are only ever read server-side by the
-- prober and the admin-only /api/probe-variables routes, never by rules.
CREATE TABLE IF NOT EXISTS probe_variables (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS probe_results (
  time                timestamptz NOT NULL,
  probe_id            int NOT NULL,
  up                  boolean NOT NULL,
  latency_ms          real,
  status_code         int,
  cert_days_remaining real,
  error               text
);
CREATE INDEX IF NOT EXISTS probe_results_probe_time ON probe_results (probe_id, time DESC);
-- numeric metric for ping/directory/data probes (unreachable-IP count, file
-- count, row count) — rules can reference probe.value for a warning-tier
-- alert independent of the up/down state (which only reflects severe_threshold).
ALTER TABLE probe_results ADD COLUMN IF NOT EXISTS value real;

CREATE TABLE IF NOT EXISTS metrics (
  time              timestamptz NOT NULL,
  server_id         int NOT NULL,
  cpu_pct           real,
  mem_pct           real,
  swap_pct          real,
  disk_min_free_pct real,
  net_rx_bps        double precision,
  net_tx_bps        double precision,
  disk_read_bps     double precision,
  disk_write_bps    double precision,
  disks             jsonb
);
CREATE INDEX IF NOT EXISTS metrics_server_time ON metrics (server_id, time DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id          serial PRIMARY KEY,
  server_id   int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  rule_name   text NOT NULL,
  check_key   text NOT NULL,
  severity    text NOT NULL DEFAULT 'warning',
  message     text NOT NULL,
  suppressed  boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS incidents_server ON incidents (server_id, started_at DESC);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents (resolved_at) WHERE resolved_at IS NULL;

-- One-off SQL Server diagnostic captures (top queries / blocking / agent jobs),
-- requested either by a firing rule check (capture: sql_snapshot) or an admin's
-- "Snapshot now" button. Agent is poll-based so results land asynchronously.
CREATE TABLE IF NOT EXISTS sql_snapshots (
  id           serial PRIMARY KEY,
  server_id    int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  incident_id  int REFERENCES incidents(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text,
  captured_at  timestamptz,
  status       text NOT NULL DEFAULT 'requested',
  top_queries  jsonb,
  blocking     jsonb,
  jobs         jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS sql_snapshots_server ON sql_snapshots (server_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS sql_snapshots_pending ON sql_snapshots (server_id) WHERE status = 'requested';

CREATE TABLE IF NOT EXISTS alert_states (
  rule_name     text NOT NULL,
  check_key     text NOT NULL,
  server_id     int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  active        boolean NOT NULL DEFAULT false,
  first_seen    timestamptz,
  last_notified timestamptz,
  incident_id   int,
  PRIMARY KEY (rule_name, check_key, server_id)
);
-- indexes of check.notify[] already delivered for the current active incident,
-- so an "after: 15m" escalation target fires exactly once per incident
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS notified_targets int[] NOT NULL DEFAULT '{}';
-- when the check was first observed non-firing after having been active; NULL
-- while firing or fully resolved. Lets resolution require a sustained quiet
-- period (resolve_after) instead of clearing on the very first clean poll.
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS clearing_since timestamptz;
-- when the check was first observed firing while not yet active; NULL once
-- the incident actually opens or the condition clears again first. Lets
-- firing require a sustained bad period (the "for" duration) instead of
-- opening an incident on the very first bad poll.
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS pending_since timestamptz;

-- Manual "mute for..." on one open incident: suppresses notifications for that
-- specific rule+check+server without touching the incident or maintenance_windows.
CREATE TABLE IF NOT EXISTS alert_mutes (
  rule_name  text NOT NULL,
  check_key  text NOT NULL,
  server_id  int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  until      timestamptz NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_name, check_key, server_id)
);
CREATE INDEX IF NOT EXISTS alert_mutes_until ON alert_mutes (until);

-- Despite the name, this now logs every notification channel (email, slack,
-- teams, webhook) — kept as email_log rather than renamed so the table
-- rename doesn't have to be made idempotent-safe.
CREATE TABLE IF NOT EXISTS email_log (
  id         serial PRIMARY KEY,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  recipient  text NOT NULL,
  subject    text NOT NULL,
  suppressed boolean NOT NULL DEFAULT false,
  reason     text
);
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
CREATE INDEX IF NOT EXISTS email_log_time ON email_log (sent_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- 'admin' edits everything; 'viewer' sees everything but changes nothing.
-- Default admin keeps existing seeded accounts working unchanged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
-- nullable: existing/seeded users have none until an admin sets one via
-- Settings — self-serve password reset only works for users with an email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

-- Microsoft Entra ID sign-in. azure_oid is the token's stable 'oid' claim —
-- unique per account, unlike email which can be reassigned. 'local' users
-- (password_hash) and 'microsoft' users can coexist; role for microsoft
-- users is recomputed from group membership on every sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN IF NOT EXISTS azure_oid text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_azure_oid ON users (azure_oid) WHERE azure_oid IS NOT NULL;

-- Self-serve password reset tokens. Only the SHA-256 hash is stored, same
-- idiom as servers.api_key_hash / wall_settings.token_hash — mirrored via
-- hashApiKey() in auth.ts. Single-use (used_at) with a short expiry.
CREATE TABLE IF NOT EXISTS password_resets (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_token ON password_resets (token_hash);

-- Who changed what, when — written by every mutating admin action.
CREATE TABLE IF NOT EXISTS audit_log (
  id          serial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  username    text NOT NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);

CREATE TABLE IF NOT EXISTS rules_doc (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  yaml       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS rules_versions (
  id         serial PRIMARY KEY,
  yaml       text NOT NULL,
  saved_at   timestamptz NOT NULL DEFAULT now(),
  saved_by   text
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id         serial PRIMARY KEY,
  target     text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Recurring windows ("BUILD01 reboots nightly 02:00-03:00"): a local
-- wall-clock span (evaluated in ALERT_TZ, default Europe/London) plus an
-- optional weekday set (0=Sun..6=Sat, empty = every day). One-off rows keep
-- recurrence='once' and their absolute starts_at/ends_at; recurring rows use
-- ends_at far in the future so existing "current windows" filters keep them.
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'once';
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS time_start text;
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS time_end text;
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS days int[];
-- NULL rule_name = silences every rule on the target (the original
-- behavior); a specific rule_name (+ optional check_key) narrows a window
-- to just that alert, e.g. "silence db01's CPU check" without also
-- muting its disk-space check. See evaluator.ts's per-check suppression.
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS rule_name text;
ALTER TABLE maintenance_windows ADD COLUMN IF NOT EXISTS check_key text;

CREATE TABLE IF NOT EXISTS email_settings (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  from_name  text NOT NULL DEFAULT 'Alfred Monitoring',
  from_local text NOT NULL DEFAULT 'alfred',
  from_domain text NOT NULL DEFAULT 'example.com',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Chart annotations: "deployed v2.3", "swapped RAM" — rendered as a thin
-- vertical marker on ServerDetail charts and dashboard panels. target uses
-- the same syntax as rules: '*', group:Brand, tag:x, a name, or a server id.
CREATE TABLE IF NOT EXISTS annotations (
  id         serial PRIMARY KEY,
  target     text NOT NULL DEFAULT '*',
  time       timestamptz NOT NULL DEFAULT now(),
  text       text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS annotations_time ON annotations (time DESC);

-- Custom metric dashboards: config is { panels: [...] }, same ownership and
-- visibility model as wall_layouts.
CREATE TABLE IF NOT EXISTS dashboards (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  owner      text NOT NULL,
  is_public  boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboards_owner ON dashboards (owner);

CREATE TABLE IF NOT EXISTS wall_layouts (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  owner      text NOT NULL,
  is_public  boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wall_layouts_owner ON wall_layouts (owner);

-- Single shared token that lets the Wall (an unattended kiosk screen) read
-- server/layout data and live updates without a normal login session, while
-- every other endpoint stays behind requireAuth. Rotate-to-invalidate.
CREATE TABLE IF NOT EXISTS wall_settings (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Instance configuration, editable in Settings. The DB is the source of
-- truth; legacy env vars only seed missing keys on boot (see settings.ts).
-- Secret values are stored encrypted ("enc:v1:..." — see crypto.ts).
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- The list of server/probe "brand" groups shown on Overview/the wall.
-- servers.brand stays a plain text column (rules' group:Name, maintenance
-- targets, and wall layouts all match on the string) — this table is the
-- authoritative *list* an admin curates, not a foreign key. Populated at
-- boot from whatever brands already exist on servers, not a fixed list
-- (see migrations.ts), so an existing deploy's data is never disturbed.
-- Threads a firing/escalation/resolved email chain for one incident so they
-- land in the recipient's inbox as one conversation instead of separate
-- emails. Keyed per notify-target index (not just incident) because two
-- targets on the same check can have different subjects and are separate
-- RFC 5322 threads. Only email uses this — slack/teams/webhook have no
-- equivalent concept.
CREATE TABLE IF NOT EXISTS notification_threads (
  incident_id  int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  notify_index int NOT NULL,
  message_id   text NOT NULL,
  subject      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, notify_index)
);

CREATE TABLE IF NOT EXISTS brands (
  id         serial PRIMARY KEY,
  name       text UNIQUE NOT NULL,
  sort       int NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Instance-level secrets that can't themselves be encrypted at rest because
-- they're needed before decryption is possible. Currently just the master
-- key used to encrypt everything else (see crypto.ts), stored here on first
-- boot unless ALFRED_MASTER_KEY is supplied via the environment.
CREATE TABLE IF NOT EXISTS instance_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

`;

export const TIMESCALE_SCHEMA = [
  `CREATE EXTENSION IF NOT EXISTS timescaledb`,
  `SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE, migrate_data => TRUE)`,
  `SELECT create_hypertable('probe_results', 'time', if_not_exists => TRUE, migrate_data => TRUE)`,
];

/**
 * Retention runs separately from the schema: the day count is an app
 * setting (loaded after the core schema exists), and changing it in
 * Settings re-applies without a restart. remove-then-add because
 * add_retention_policy(if_not_exists) won't alter an existing policy.
 */
export function retentionSchema(days: number): string[] {
  const d = Math.max(1, Math.floor(days));
  return [
    `SELECT remove_retention_policy('metrics', if_exists => TRUE)`,
    `SELECT add_retention_policy('metrics', INTERVAL '${d} days', if_not_exists => TRUE)`,
    `SELECT remove_retention_policy('probe_results', if_exists => TRUE)`,
    `SELECT add_retention_policy('probe_results', INTERVAL '${d} days', if_not_exists => TRUE)`,
  ];
}

export const DEFAULT_RULES_YAML = `# Alfred alert rules — YAML DSL.
# Docs: see the Reference panel on the right. Save runs full validation first.

defaults:
  cooldown: 30m

rules:
  - name: any-server-offline
    target: "*"
    checks:
      - when: status == offline
        message: "{{server}} is offline"
        severity: critical
        cooldown: 30m
        notify:
          - channel: email
            to: you@example.com
            subject: "🔴 {{server}} is OFFLINE"
    recovery_notify: true

  - name: disk-space-low
    target: "*"
    checks:
      - when: status == online and disk.min_free_pct < 10
        message: "{{server}} is low on disk space"
        severity: warning
        cooldown: 6h
        notify:
          - channel: email
            to: you@example.com
            subject: "⚠️ Low disk space on {{server}}"
    recovery_notify: true
`;
