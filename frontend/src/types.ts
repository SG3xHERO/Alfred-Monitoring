export interface Incident {
  id: number;
  server_id: number;
  server_name?: string;
  brand?: string;
  rule_name: string;
  check_key: string;
  severity: "critical" | "warning" | "info";
  message: string;
  suppressed: boolean;
  started_at: string;
  resolved_at: string | null;
}

export interface SqlSnapshot {
  id: number;
  incident_id: number | null;
  requested_at: string;
  requested_by: string | null; // "rule:<name>/<check>" (auto) or "user:<username>" (Snapshot now)
  captured_at: string | null;
  status: "requested" | "ok" | "error";
  top_queries: Array<{
    DatabaseName: string; QueryText: string; TotalCpuMs: number;
    AvgCpuMs: number; ExecutionCount: number; LastExecutionTime: string;
  }> | null;
  blocking: Array<{
    BlockingSessionID: number; BlockedSessionID: number; WaitType: string;
    WaitTimeMs: number; BlockedQueryText: string;
  }> | null;
  jobs: Array<{
    JobName: string; Status: string; LastRunOutcome: string; LastRunDate: string;
  }> | null;
  error: string | null;
}

export interface Server {
  id: number;
  hostname: string | null;
  ip_address: string | null;
  display_name: string;
  brand: string;
  tags: string[];
  os: string | null;
  platform: string | null;
  agent_version: string | null;
  status: "pending" | "online" | "offline";
  status_since: string | null;
  last_seen: string | null;
  first_seen: string | null;
  interval_seconds: number;
  cpu_pct: number | null;
  mem_pct: number | null;
  disks: Array<{ mount: string; used_percent: number; free: number; total: number }> | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
  uptime_90d: number | null;
  active_incidents: Array<Pick<Incident, "id" | "rule_name" | "check_key" | "severity" | "message" | "started_at">>;
  last_snapshot?: any;
  kind: "agent" | "probe";
  probe?: ProbeSnapshot | null;
  update_requested_version: string | null;
  desired_config: Record<string, boolean> | null;
  group_key: string | null;
  parent_id: number | null;
  parent_display_name?: string | null;
  // descriptive (non-secret) probe config, joined in for probe-kind servers on GET /api/servers/:id
  probe_type?: string | null;
  probe_target?: string | null;
  probe_warning_threshold?: number | null;
  probe_severe_threshold?: number | null;
  probe_file_mask?: string | null;
  probe_procedure_name?: string | null;
  // present only on GET /api/servers/:id — devices nested under this one
  nested_devices?: NestedDeviceSummary[];
}

export interface NestedDeviceSummary {
  id: number;
  display_name: string;
  kind: "agent" | "probe";
  status: "pending" | "online" | "offline";
  last_seen: string | null;
  probe: ProbeSnapshot | null;
}

/** Latest result of a synthetic check, embedded in the shadow server row. */
export interface ProbeSnapshot {
  type: "http" | "tcp" | "api" | "push" | "ping" | "directory" | "data";
  target: string;
  checked_at: string;
  latency_ms: number | null;
  status_code: number | null;
  cert_days_remaining: number | null;
  error: string | null;
  json_value?: string | null;
  age_minutes?: number | null;
}

export interface Probe {
  id: number;
  server_id: number;
  name: string;
  brand: string;
  tags: string[];
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
  warning_threshold: number | null;
  severe_threshold: number | null;
  file_mask: string | null;
  credential_id: number | null;
  connection_id: number | null;
  procedure_name: string | null;
  status: "pending" | "online" | "offline";
  status_since: string | null;
  last_seen: string | null;
  last: ProbeSnapshot | null;
  uptime_24h: number | null;
  spark: Array<{ time: string; up: boolean; latency_ms: number | null }>;
  created_at: string;
}

export interface AlertMute {
  rule_name: string;
  check_key: string;
  server_id: number;
  server_name: string;
  until: string;
  created_by: string | null;
  created_at: string;
}

export interface MetricPoint {
  bucket: string;
  cpu_pct: number | null;
  mem_pct: number | null;
  swap_pct: number | null;
  disk_min_free_pct: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  disk_read_bps: number | null;
  disk_write_bps: number | null;
}

export interface SilenceWindow {
  id: number;
  target: string;
  starts_at: string;
  ends_at: string;
  recurrence: "once" | "recurring";
  time_start: string | null;   // 'HH:MM' local, recurring only
  time_end: string | null;
  days: number[] | null;       // 0=Sun..6=Sat, empty = every day
  note: string | null;
  rule_name: string | null;    // null = silences every rule on the target
  check_key: string | null;    // null (with rule_name set) = every check in that rule
}

export interface RuleChecks {
  name: string;
  checks: string[];
}

export interface Annotation {
  id: number;
  target: string;
  time: string;
  text: string;
  created_by: string | null;
  created_at: string;
}

export interface DashPanel {
  id: string;
  title: string;
  metrics: string[];
  target: string;               // same syntax as rule targets: *, group:X, tag:x, name
  agg: "avg" | "min" | "max" | "sum" | "count";
  range: "1h" | "6h" | "24h" | "7d" | "30d";
  chart: "line" | "stat" | "bar";
  width: 1 | 2;                 // grid columns
  height: "s" | "m" | "l";
}

export interface Dashboard {
  id: number;
  name: string;
  owner: string;
  is_public: boolean;
  config: { panels: DashPanel[] };
  mine: boolean;
  panel_count?: number;
  updated_at: string;
}

export interface PanelSeries {
  metric: string;
  label: string;
  unit: "%" | "bps" | "ms" | "days";
  points: Array<{ bucket: string; value: number | null }>;
}

export interface PanelData {
  matched: number;
  series: PanelSeries[];
}

export interface WallSection {
  id: string;
  title: string;
  serverIds: number[];
  // Dashboard-style chart panels shown under this column's server tiles —
  // same DashPanel shape and editor as the Dashboards page.
  panels?: DashPanel[];
}

export interface WallLayoutConfig {
  sections: WallSection[];
  // Servers explicitly dropped in "Unplaced" in the designer — excluded from
  // the wall entirely, not swept into a catch-all "Other servers" column.
  hiddenServerIds?: number[];
}

export interface WallLayout {
  id: number;
  name: string;
  owner: string;
  is_public: boolean;
  config: WallLayoutConfig;
  mine: boolean;
  updated_at: string;
}
