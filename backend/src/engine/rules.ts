import YAML from "yaml";
import {
  parseExpr, evaluate, truthy, collectRefs,
  type Expr, type Value, type EvalContext, ExprError,
} from "./expr.js";

// ---------- known identifiers (also served to the frontend as reference) ----------

export const KNOWN_PATHS: Record<string, string> = {
  status: "'online' | 'offline'",
  online: "literal 'online'",
  offline: "literal 'offline'",
  "uptime.seconds": "seconds since boot",
  "uptime.hours": "hours since boot",
  "uptime.days": "days since boot",
  "cpu.percent": "total CPU usage %",
  "cpu.load1": "1-min load average (Linux)",
  "cpu.load5": "5-min load average (Linux)",
  "cpu.load15": "15-min load average (Linux)",
  "mem.percent": "memory usage %",
  "mem.used_gb": "memory used, GB",
  "mem.total_gb": "memory total, GB",
  "swap.percent": "swap usage %",
  "net.rx_bps": "network receive, bytes/sec",
  "net.tx_bps": "network transmit, bytes/sec",
  "net.err_in": "cumulative receive errors",
  "net.err_out": "cumulative transmit errors",
  "disk.read_bps": "disk read, bytes/sec",
  "disk.write_bps": "disk write, bytes/sec",
  "disk.min_free_pct": "lowest free % across all mounts/drives",
  "disk.max_used_pct": "highest used % across all mounts/drives",
  "systemd.failed_count": "number of failed systemd units (Linux)",
  "updates.pending": "pending apt updates (Linux)",
  reboot_required: "true when a reboot is pending",
  "windows.event_error_count": "Critical/Error events in the last event-log poll",
  "windows.lockout_count": "AD account lockouts (event 4740) since the last poll — opt-in, needs Security-log read rights",
  "agent.version": "agent version string",
  "probe.latency_ms": "last probe round-trip, ms (probes only)",
  "probe.status_code": "last HTTP status code (http/api probes only)",
  "cert.days_remaining": "days until the SSL certificate expires (https probes only)",
  "probe.json_value": "value extracted by the probe's JSON path, as a string (api probes only)",
  "probe.age_minutes": "minutes since the timestamp the probe watches — a flow's last-run time for api probes, or time since the last push for push probes",
  "probe.value": "numeric result for ping/directory/data probes (unreachable count, file count, row count)",
};

export const KNOWN_FUNCS: Record<string, string> = {
  "user_logged_in(name)": "true if the user has an active or disconnected session (Windows)",
  "windows.user_logged_in(name)": "alias of user_logged_in",
  "windows.user_locked_out(name)": "true if this user was locked out (event 4740) since the last poll",
  "service_running(name)": "true if the watched service is running",
  "process_running(name)": "true if the watched process is running",
  "systemd_unit_failed(name)": "true if the unit is in the failed list (Linux)",
  "disk_free_pct(mount)": "free % for a mount ('/' or 'C:')",
  "disk_used_pct(mount)": "used % for a mount",
  "disk_free_gb(mount)": "free GB for a mount",
  "smart_failed()": "true if any disk fails its SMART health check",
  // Window functions: evaluated over recent history instead of the live
  // sample, so one bad poll can't trip or clear a check on its own. Only
  // work on server metrics with history in the `metrics` table — cpu.percent,
  // mem.percent, swap.percent, disk.min_free_pct, net.rx_bps, net.tx_bps,
  // disk.read_bps, disk.write_bps — and read null (never firing) for
  // anything else, including probe metrics.
  'avg(metric, "10m")': "mean of a metric over the trailing window",
  'max(metric, "10m")': "highest sample of a metric over the trailing window",
  'min(metric, "10m")': "lowest sample of a metric over the trailing window",
  'p95(metric, "10m")': "95th-percentile sample of a metric over the trailing window",
  'rate(metric, "6h")': "change in a metric per hour over the trailing window (e.g. a disk filling up)",
  'pct_time(condition, "20m")': "% of samples over the trailing window where condition held, e.g. pct_time(cpu.percent > 95, \"20m\") > 90",
  'count_true(condition, "30m")': "number of samples over the trailing window where condition held",
};

export const WINDOW_FUNC_NAMES = new Set(["avg", "max", "min", "p95", "rate", "pct_time", "count_true"]);

const FUNC_NAMES = new Set(
  Object.keys(KNOWN_FUNCS).map((s) => s.slice(0, s.indexOf("("))),
);

// ---------- evaluation context from a server snapshot ----------

export interface ServerLike {
  id: number;
  hostname: string | null;
  display_name: string;
  brand: string;
  tags: string[];
  status: string;
  agent_version: string | null;
  last_snapshot: any;
  last_seen?: string | Date | null;
  /** set when this server is nested under a parent (see servers.parent_id) — surfaced in alert messages */
  parent_display_name?: string | null;
}

export function buildContext(server: ServerLike): EvalContext {
  const snap = server.last_snapshot || {};
  const disks: any[] = snap.disks || [];
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10;

  const findDisk = (mount: Value) => {
    const m = String(mount ?? "").toLowerCase().replace(/\\$/, "");
    return disks.find((d) =>
      String(d.mount).toLowerCase().replace(/\\$/, "") === m);
  };

  const paths: Record<string, () => Value> = {
    status: () => (server.status === "online" ? "online" : "offline"),
    online: () => "online",
    offline: () => "offline",
    "uptime.seconds": () => snap.uptime_seconds ?? null,
    "uptime.hours": () => snap.uptime_seconds != null ? snap.uptime_seconds / 3600 : null,
    "uptime.days": () => snap.uptime_seconds != null ? snap.uptime_seconds / 86400 : null,
    "cpu.percent": () => snap.cpu?.percent ?? null,
    "cpu.load1": () => snap.cpu?.load1 ?? null,
    "cpu.load5": () => snap.cpu?.load5 ?? null,
    "cpu.load15": () => snap.cpu?.load15 ?? null,
    "mem.percent": () => snap.memory?.percent ?? null,
    "mem.used_gb": () => snap.memory?.used != null ? gb(snap.memory.used) : null,
    "mem.total_gb": () => snap.memory?.total != null ? gb(snap.memory.total) : null,
    "swap.percent": () => snap.memory?.swap_percent ?? null,
    "net.rx_bps": () => snap.network?.rx_bps ?? null,
    "net.tx_bps": () => snap.network?.tx_bps ?? null,
    "net.err_in": () => snap.network?.err_in ?? null,
    "net.err_out": () => snap.network?.err_out ?? null,
    "disk.read_bps": () => snap.disk_io?.read_bps ?? null,
    "disk.write_bps": () => snap.disk_io?.write_bps ?? null,
    "disk.min_free_pct": () =>
      disks.length ? Math.min(...disks.map((d) => 100 - d.used_percent)) : null,
    "disk.max_used_pct": () =>
      disks.length ? Math.max(...disks.map((d) => d.used_percent)) : null,
    "systemd.failed_count": () => (snap.systemd_failed_units || []).length,
    "updates.pending": () => snap.pending_updates ?? 0,
    reboot_required: () => !!snap.reboot_required,
    "windows.event_error_count": () => (snap.event_errors || []).length,
    "windows.lockout_count": () => (snap.lockouts || []).length,
    "agent.version": () => server.agent_version ?? snap.agent_version ?? null,
    "probe.latency_ms": () => snap.probe?.latency_ms ?? null,
    "probe.status_code": () => snap.probe?.status_code ?? null,
    "cert.days_remaining": () => snap.probe?.cert_days_remaining ?? null,
    "probe.json_value": () => snap.probe?.json_value ?? null,
    "probe.value": () => snap.probe?.value ?? null,
    // api probes freeze this at check time from a JSON timestamp field; push
    // probes have no such field, so fall back to a live "time since last
    // push" computed from last_seen — kept as a separate, opt-in metric
    // rather than ever auto-flipping status, so a quiet pusher never gets
    // reported as "the thing it checks is down".
    "probe.age_minutes": () => snap.probe?.age_minutes ?? (server.last_seen
      ? Math.round(((Date.now() - new Date(server.last_seen).getTime()) / 60_000) * 10) / 10
      : null),
  };

  return {
    getPath(name: string): Value | undefined {
      const fn = paths[name];
      return fn ? fn() : undefined;
    },
    callFn(name: string, args: Value[]): Value {
      const arg0 = String(args[0] ?? "");
      switch (name) {
        case "user_logged_in":
        case "windows.user_logged_in": {
          const want = arg0.toLowerCase();
          return (snap.sessions || []).some((s: any) => {
            const u = String(s.user).toLowerCase();
            // accept both "svcaccount" and "DOMAIN\svcaccount"
            return u === want || u.endsWith("\\" + want);
          });
        }
        case "windows.user_locked_out": {
          const want = arg0.toLowerCase();
          return (snap.lockouts || []).some((l: any) => {
            const u = String(l.user).toLowerCase();
            return u === want || u.endsWith("\\" + want);
          });
        }
        case "service_running":
          return (snap.services || []).some(
            (s: any) => s.name.toLowerCase() === arg0.toLowerCase() && s.running);
        case "process_running":
          return (snap.processes || []).some(
            (p: any) => p.name.toLowerCase().replace(/\.exe$/, "") ===
              arg0.toLowerCase().replace(/\.exe$/, "") && p.running);
        case "systemd_unit_failed": {
          const want = arg0.endsWith(".service") ? arg0 : arg0 + ".service";
          return (snap.systemd_failed_units || []).some(
            (u: string) => u === arg0 || u === want);
        }
        case "disk_free_pct": {
          const d = findDisk(args[0]);
          return d ? Math.round((100 - d.used_percent) * 10) / 10 : null;
        }
        case "disk_used_pct": {
          const d = findDisk(args[0]);
          return d ? d.used_percent : null;
        }
        case "disk_free_gb": {
          const d = findDisk(args[0]);
          return d ? gb(d.free) : null;
        }
        case "smart_failed":
          return (snap.smart || []).some((s: any) => !s.passed);
        default:
          return null;
      }
    },
  };
}

// ---------- rules document ----------

export type NotifyTarget =
  | { channel: "email"; to: string[]; subject?: string; after?: number }
  | { channel: "slack" | "teams"; url: string; after?: number }
  | { channel: "webhook"; url: string; secret?: string; after?: number };

/** True for a secondary/on-call target that only pages once the alert has been firing for a while. */
export function isEscalationTarget(n: NotifyTarget): boolean {
  return typeof n.after === "number" && n.after > 0;
}

/** Short human label for a notify target, e.g. for dry-run results and the reference panel. */
export function notifyTargetLabel(n: NotifyTarget): string {
  const suffix = isEscalationTarget(n) ? ` (after ${formatDuration(n.after!)})` : "";
  switch (n.channel) {
    case "email": return n.to.join(", ") + suffix;
    case "slack": return `Slack: ${hostOf(n.url)}${suffix}`;
    case "teams": return `Teams: ${hostOf(n.url)}${suffix}`;
    case "webhook": return `Webhook: ${hostOf(n.url)}${suffix}`;
  }
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function isValidWebhookUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CompiledCheck {
  key: string;
  when: string;
  expr: Expr;
  /** Optional separate condition for clearing — omit to clear on "when" going false (v1 behavior). Gives a check hysteresis: fire above 95%, only clear below 85%. */
  clearWhen?: string;
  clearExpr?: Expr;
  message?: string;
  severity: "critical" | "warning" | "info";
  cooldownMs: number;
  resolveAfterMs: number;
  forMs: number;
  notify: NotifyTarget[];
  capture?: "sql_snapshot";
}

export interface CompiledRule {
  name: string;
  targets: string[];
  enabled: boolean;
  recoveryNotify: boolean;
  checks: CompiledCheck[];
}

export interface CompileResult {
  rules: CompiledRule[];
  errors: string[];
}

export function parseDuration(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(s).trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0))) * 1000;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_RESOLVE_AFTER_MS = 3 * 60 * 1000;
const DEFAULT_FOR_MS = 0; // fire immediately unless a rule/check opts into a wait

export function compileRules(yamlText: string): CompileResult {
  const errors: string[] = [];
  let doc: any;
  try {
    doc = YAML.parse(yamlText);
  } catch (err: any) {
    return { rules: [], errors: [`YAML parse error: ${err.message}`] };
  }
  if (!doc || typeof doc !== "object") {
    return { rules: [], errors: ["document is empty — expected a top-level 'rules:' list"] };
  }
  if (!Array.isArray(doc.rules)) {
    return { rules: [], errors: ["missing top-level 'rules:' list"] };
  }

  let defaultCooldown = DEFAULT_COOLDOWN_MS;
  if (doc.defaults?.cooldown != null) {
    const ms = parseDuration(doc.defaults.cooldown);
    if (ms == null) errors.push(`defaults.cooldown: invalid duration '${doc.defaults.cooldown}' (use e.g. 30m, 1h, 1h30m)`);
    else defaultCooldown = ms;
  }

  let defaultResolveAfter = DEFAULT_RESOLVE_AFTER_MS;
  if (doc.defaults?.resolve_after != null) {
    const ms = parseDuration(doc.defaults.resolve_after);
    if (ms == null) errors.push(`defaults.resolve_after: invalid duration '${doc.defaults.resolve_after}' (use e.g. 3m, 30s, 1h)`);
    else defaultResolveAfter = ms;
  }

  let defaultFor = DEFAULT_FOR_MS;
  if (doc.defaults?.for != null) {
    const ms = parseDuration(doc.defaults.for);
    if (ms == null) errors.push(`defaults.for: invalid duration '${doc.defaults.for}' (use e.g. 30s, 1m, 1m30s)`);
    else defaultFor = ms;
  }

  const seen = new Set<string>();
  const rules: CompiledRule[] = [];

  doc.rules.forEach((r: any, ri: number) => {
    const where = `rules[${ri}]${r?.name ? ` (${r.name})` : ""}`;
    if (!r || typeof r !== "object") { errors.push(`${where}: not a mapping`); return; }
    if (!r.name || typeof r.name !== "string") { errors.push(`${where}: 'name' is required`); return; }
    if (seen.has(r.name)) { errors.push(`${where}: duplicate rule name '${r.name}'`); return; }
    seen.add(r.name);
    if (r.target == null) { errors.push(`${where}: 'target' is required (hostname, group:Brand, tag:x, or "*")`); return; }
    if (!Array.isArray(r.checks) || r.checks.length === 0) {
      errors.push(`${where}: 'checks' must be a non-empty list`);
      return;
    }

    const ruleCooldownRaw = r.cooldown != null ? parseDuration(r.cooldown) : null;
    if (r.cooldown != null && ruleCooldownRaw == null) {
      errors.push(`${where}: invalid cooldown '${r.cooldown}'`);
    }
    const ruleCooldown = ruleCooldownRaw ?? defaultCooldown;

    const ruleResolveAfterRaw = r.resolve_after != null ? parseDuration(r.resolve_after) : null;
    if (r.resolve_after != null && ruleResolveAfterRaw == null) {
      errors.push(`${where}: invalid resolve_after '${r.resolve_after}'`);
    }
    const ruleResolveAfter = ruleResolveAfterRaw ?? defaultResolveAfter;

    const ruleForRaw = r.for != null ? parseDuration(r.for) : null;
    if (r.for != null && ruleForRaw == null) {
      errors.push(`${where}: invalid for '${r.for}'`);
    }
    const ruleFor = ruleForRaw ?? defaultFor;

    const checks: CompiledCheck[] = [];
    r.checks.forEach((c: any, ci: number) => {
      const cwhere = `${where}.checks[${ci}]`;
      if (!c || typeof c !== "object" || !c.when) {
        errors.push(`${cwhere}: 'when' is required`);
        return;
      }
      let expr: Expr;
      try {
        expr = parseExpr(String(c.when));
      } catch (err) {
        const e = err as ExprError;
        errors.push(`${cwhere}.when: ${e.message} (at position ${e.pos})`);
        return;
      }
      // save-time identifier validation — typos fail loudly here, not silently at runtime
      const usedPaths = new Set<string>();
      const usedCalls = new Set<string>();
      collectRefs(expr, usedPaths, usedCalls);
      for (const p of usedPaths) {
        if (!(p in KNOWN_PATHS)) errors.push(`${cwhere}.when: unknown metric '${p}'`);
      }
      for (const f of usedCalls) {
        if (!FUNC_NAMES.has(f)) errors.push(`${cwhere}.when: unknown function '${f}()'`);
      }

      let clearExpr: Expr | undefined;
      if (c.clear_when != null) {
        try {
          clearExpr = parseExpr(String(c.clear_when));
        } catch (err) {
          const e = err as ExprError;
          errors.push(`${cwhere}.clear_when: ${e.message} (at position ${e.pos})`);
        }
        if (clearExpr) {
          const clearPaths = new Set<string>();
          const clearCalls = new Set<string>();
          collectRefs(clearExpr, clearPaths, clearCalls);
          for (const p of clearPaths) {
            if (!(p in KNOWN_PATHS)) errors.push(`${cwhere}.clear_when: unknown metric '${p}'`);
          }
          for (const f of clearCalls) {
            if (!FUNC_NAMES.has(f)) errors.push(`${cwhere}.clear_when: unknown function '${f}()'`);
          }
        }
      }

      let cooldownMs = ruleCooldown;
      if (c.cooldown != null) {
        const ms = parseDuration(c.cooldown);
        if (ms == null) errors.push(`${cwhere}: invalid cooldown '${c.cooldown}'`);
        else cooldownMs = ms;
      }

      let resolveAfterMs = ruleResolveAfter;
      if (c.resolve_after != null) {
        const ms = parseDuration(c.resolve_after);
        if (ms == null) errors.push(`${cwhere}: invalid resolve_after '${c.resolve_after}'`);
        else resolveAfterMs = ms;
      }

      let forMs = ruleFor;
      if (c.for != null) {
        const ms = parseDuration(c.for);
        if (ms == null) errors.push(`${cwhere}: invalid for '${c.for}'`);
        else forMs = ms;
      }

      const severity = c.severity ?? "warning";
      if (!["critical", "warning", "info"].includes(severity)) {
        errors.push(`${cwhere}: severity must be critical | warning | info`);
      }

      const notify: NotifyTarget[] = [];
      for (const n of c.notify ?? []) {
        const channel = n.channel ?? "email";
        let after: number | undefined;
        if (n.after != null) {
          const ms = parseDuration(n.after);
          if (ms == null) { errors.push(`${cwhere}: invalid notify 'after' duration '${n.after}'`); continue; }
          after = ms;
        }
        if (channel === "email") {
          // 'to' accepts a YAML list OR a single string — and either can be a
          // comma-separated list of addresses (a bare comma-joined string was
          // silently sent to SendGrid as one malformed recipient and rejected).
          const raw = Array.isArray(n.to) ? n.to : n.to != null ? [n.to] : [];
          const to: string[] = raw.flatMap((v: any) => String(v).split(",").map((s: string) => s.trim())).filter(Boolean);
          if (to.length === 0) {
            errors.push(`${cwhere}: email notify entry needs 'to'`);
            continue;
          }
          const badEmails = to.filter((e: string) => !EMAIL_RE.test(e));
          if (badEmails.length > 0) {
            errors.push(`${cwhere}: invalid email address(es) in 'to': ${badEmails.join(", ")}`);
            continue;
          }
          notify.push({ channel: "email", to, subject: n.subject, after });
        } else if (channel === "slack" || channel === "teams") {
          const url = typeof n.url === "string" ? n.url.trim() : "";
          if (!isValidWebhookUrl(url)) {
            errors.push(`${cwhere}: ${channel} notify entry needs a valid 'url'`);
            continue;
          }
          notify.push({ channel, url, after });
        } else if (channel === "webhook") {
          const url = typeof n.url === "string" ? n.url.trim() : "";
          if (!isValidWebhookUrl(url)) {
            errors.push(`${cwhere}: webhook notify entry needs a valid 'url'`);
            continue;
          }
          const secret = typeof n.secret === "string" && n.secret ? n.secret : undefined;
          notify.push({ channel: "webhook", url, secret, after });
        } else {
          errors.push(`${cwhere}: unsupported channel '${channel}' (use email | slack | teams | webhook)`);
        }
      }

      if (c.message != null && typeof c.message !== "string") {
        errors.push(`${cwhere}: 'message' must be a string`);
      }

      let capture: CompiledCheck["capture"];
      if (c.capture != null) {
        if (c.capture === "sql_snapshot") capture = "sql_snapshot";
        else errors.push(`${cwhere}: unsupported capture '${c.capture}' (use sql_snapshot)`);
      }

      checks.push({
        key: c.name ? String(c.name) : `check-${ci}`,
        when: String(c.when),
        expr,
        clearWhen: c.clear_when != null ? String(c.clear_when) : undefined,
        clearExpr,
        message: typeof c.message === "string" ? c.message : undefined,
        severity: severity as CompiledCheck["severity"],
        cooldownMs,
        resolveAfterMs,
        forMs,
        notify,
        capture,
      });
    });

    const targets = (Array.isArray(r.target) ? r.target : [r.target]).map(String);
    rules.push({
      name: r.name,
      targets,
      enabled: r.enabled !== false,
      recoveryNotify: r.recovery_notify === true,
      checks,
    });
  });

  return { rules, errors };
}

export function ruleMatchesServer(rule: CompiledRule, server: ServerLike): boolean {
  const host = (server.hostname || "").toLowerCase();
  const display = server.display_name.toLowerCase();
  for (const t of rule.targets) {
    const tl = t.toLowerCase();
    if (tl === "*") return true;
    if (tl.startsWith("group:")) {
      if (server.brand.toLowerCase() === tl.slice(6).trim()) return true;
    } else if (tl.startsWith("tag:")) {
      if (server.tags.some((x) => x.toLowerCase() === tl.slice(4).trim())) return true;
    } else if (tl === host || tl === display) {
      return true;
    }
  }
  return false;
}

export function checkFires(check: CompiledCheck, ctx: EvalContext, exprOverride?: Expr): boolean {
  return truthy(evaluate(exprOverride ?? check.expr, ctx));
}

export function renderTemplate(tpl: string, server: ServerLike, extra: Record<string, string> = {}): string {
  const vars: Record<string, string> = {
    server: server.display_name || server.hostname || `#${server.id}`,
    hostname: server.hostname || "",
    group: server.brand,
    brand: server.brand,
    status: server.status,
    ...extra,
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ---------- human-readable descriptions ----------
//
// Incident history, the dashboard, and emails should read like "SERVER01 is
// offline", not "Condition 'status == offline' is true on SERVER01". This
// walks the parsed AST (rather than regexing the raw string) so odd spacing
// or parens in the YAML don't break it. Authors can still set an explicit
// `message:` on a check to override this entirely.

const METRIC_LABELS: Record<string, string> = {
  "cpu.percent": "CPU usage",
  "cpu.load1": "1-min load average",
  "cpu.load5": "5-min load average",
  "cpu.load15": "15-min load average",
  "mem.percent": "memory usage",
  "swap.percent": "swap usage",
  "disk.min_free_pct": "free disk space",
  "disk.max_used_pct": "disk usage",
  "net.rx_bps": "inbound network traffic",
  "net.tx_bps": "outbound network traffic",
  "net.err_in": "receive errors",
  "net.err_out": "transmit errors",
  "systemd.failed_count": "failed systemd units",
  "updates.pending": "pending updates",
  "windows.event_error_count": "logged error events",
  "windows.lockout_count": "AD account lockouts",
  "probe.latency_ms": "probe latency",
  "probe.status_code": "HTTP status code",
  "cert.days_remaining": "SSL certificate expiry",
  "probe.json_value": "probe JSON field value",
  "probe.age_minutes": "time since last run",
};

const OP_WORDS: Record<string, string> = {
  ">": "above", ">=": "at least", "<": "below", "<=": "at most",
};

const UNIT_SUFFIX: Record<string, string> = {
  "cpu.percent": "%", "mem.percent": "%", "swap.percent": "%",
  "disk.min_free_pct": "%", "disk.max_used_pct": "%",
  "probe.latency_ms": " ms",
  "cert.days_remaining": " days",
  "probe.age_minutes": " min",
};

function humanizeCall(name: string, args: Expr[], negate: boolean): string {
  const a0 = args[0];
  const arg0 = a0?.kind === "str" ? a0.value : a0 ? exprLabel(a0) : "";
  switch (name) {
    case "service_running": return `service '${arg0}' is ${negate ? "not " : ""}running`;
    case "process_running": return `process '${arg0}' is ${negate ? "not " : ""}running`;
    case "user_logged_in":
    case "windows.user_logged_in": return `user '${arg0}' is ${negate ? "not " : ""}signed in`;
    case "windows.user_locked_out": return `user '${arg0}' was ${negate ? "not " : ""}locked out`;
    case "systemd_unit_failed": return `systemd unit '${arg0}' has ${negate ? "not " : ""}failed`;
    case "smart_failed": return `a disk has ${negate ? "not " : ""}failed its SMART health check`;
    default: return `${name}(${arg0})${negate ? " is false" : " is true"}`;
  }
}

function exprLabel(e: Expr): string {
  if (e.kind === "path") return METRIC_LABELS[e.name] ?? e.name;
  if (e.kind === "str") return e.value;
  if (e.kind === "num") return String(e.value);
  if (e.kind === "bool") return String(e.value);
  if (e.kind === "call") return humanizeCall(e.name, e.args, false);
  return "value";
}

function humanizeClause(e: Expr): string {
  switch (e.kind) {
    case "not": {
      const inner = e.operand;
      if (inner.kind === "call") return humanizeCall(inner.name, inner.args, true);
      if (inner.kind === "path" && inner.name === "reboot_required") return "does not need a reboot";
      return `not (${humanizeClause(inner)})`;
    }
    case "call":
      return humanizeCall(e.name, e.args, false);
    case "path":
      if (e.name === "reboot_required") return "needs a reboot";
      return exprLabel(e);
    case "cmp": {
      const { op, left, right } = e;
      if (left.kind === "path" && left.name === "status" && right.kind === "path") {
        const isOffline = right.name === "offline";
        const isOnline = right.name === "online";
        if (isOffline) return op === "!=" ? "is not offline" : "is offline";
        if (isOnline) return op === "!=" ? "is not online" : "is online";
      }
      const label = exprLabel(left);
      const valueStr = right.kind === "str" ? right.value
        : right.kind === "num" ? String(right.value)
        : right.kind === "path" ? right.name
        : right.kind === "bool" ? String(right.value)
        : exprLabel(right);
      if (op === "==") return `${label} is ${valueStr}`;
      if (op === "!=") return `${label} is not ${valueStr}`;
      const word = OP_WORDS[op] ?? op;
      const unit = left.kind === "path" ? UNIT_SUFFIX[left.name] ?? "" : "";
      return `${label} is ${word} ${valueStr}${unit}`;
    }
    case "logic":
      return `${humanizeClause(e.left)} ${e.op} ${humanizeClause(e.right)}`;
    default:
      return exprLabel(e);
  }
}

function flattenAnd(e: Expr): Expr[] {
  if (e.kind === "logic" && e.op === "and") return [...flattenAnd(e.left), ...flattenAnd(e.right)];
  return [e];
}

function isOnlineGuard(e: Expr): boolean {
  return e.kind === "cmp" && e.op === "==" &&
    e.left.kind === "path" && e.left.name === "status" &&
    e.right.kind === "path" && e.right.name === "online";
}

/** Human-readable form of a condition, e.g. "free disk space is below 10%". */
export function humanizeExpr(expr: Expr): string {
  const clauses = flattenAnd(expr);
  const meaningful = clauses.length > 1 ? clauses.filter((c) => !isOnlineGuard(c)) : clauses;
  return meaningful.map(humanizeClause).join(" and ");
}

/** The message shown in incident history, the dashboard, and emails for a firing check. */
/** Comma-joined usernames from this server's most recent lockout events, for use as a {{lockouts}} template var. */
export function lockoutUsers(server: ServerLike): string {
  return ((server.last_snapshot?.lockouts || []) as any[])
    .map((l) => l.user).filter(Boolean).join(", ");
}

export function checkMessage(check: CompiledCheck, server: ServerLike): string {
  const lockouts = lockoutUsers(server);
  if (check.message) return renderTemplate(check.message, server, { lockouts });
  const label = server.display_name || server.hostname || `#${server.id}`;
  const suffix = lockouts ? ` (${lockouts})` : "";
  return `${label} ${humanizeExpr(check.expr)}${suffix}`;
}
