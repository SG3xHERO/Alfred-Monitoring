import { query } from "../db.js";
import { broadcast } from "../sse.js";
import { getSetting, getSettingNumber } from "../settings.js";
import { deliverAlert } from "../notify/dispatch.js";
import { sendMail } from "../notify/email.js";
import { evaluate, truthy } from "./expr.js";
import { maxWindowMs, resolveWindows, type WindowSample } from "./windows.js";
import {
  compileRules, buildContext, ruleMatchesServer, checkMessage, isEscalationTarget,
  type CompiledRule, type CompiledCheck, type ServerLike, type NotifyTarget,
} from "./rules.js";

let activeRules: CompiledRule[] = [];
const bootedAt = Date.now();

export function getActiveRules(): CompiledRule[] {
  return activeRules;
}

export async function loadRules(): Promise<string[]> {
  const { rows } = await query("SELECT yaml FROM rules_doc WHERE id = 1");
  if (rows.length === 0) return ["rules document missing"];
  const { rules, errors } = compileRules(rows[0].yaml);
  // a broken document should not silently disable alerting for valid rules
  activeRules = rules.filter((r) => r.enabled && r.checks.length > 0);
  if (errors.length) console.warn(`rules loaded with ${errors.length} error(s):`, errors);
  else console.log(`rules loaded: ${activeRules.length} active`);
  return errors;
}

interface AlertStateRow {
  rule_name: string;
  check_key: string;
  server_id: number;
  active: boolean;
  first_seen: Date | null;
  last_notified: Date | null;
  incident_id: number | null;
  notified_targets: number[];
  clearing_since: Date | null;
  pending_since: Date | null;
}

// Recurring windows are wall-clock local time — "2-3am" should stay 2-3am
// across DST, so evaluate in a named zone rather than UTC arithmetic.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** True when `now` falls inside a recurring window's local-time span. */
export function inRecurringWindow(
  row: { time_start: string | null; time_end: string | null; days: number[] | null },
  now: Date = new Date(),
): boolean {
  const hm = (s: string | null) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const start = hm(row.time_start);
  const end = hm(row.time_end);
  if (start == null || end == null || start === end) return false;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: getSetting("alert.tz"), hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const today = WEEKDAYS.indexOf(get("weekday"));
  const minutes = (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10);
  const days = row.days && row.days.length > 0 ? row.days : null;
  const onDay = (d: number) => !days || days.includes(d);

  if (end > start) return onDay(today) && minutes >= start && minutes < end;
  // spans midnight: [start, 24:00) belongs to the start day, [00:00, end) to the next
  return (onDay(today) && minutes >= start) || (onDay((today + 6) % 7) && minutes < end);
}

interface SilenceRow {
  target: string;
  recurrence: string;
  time_start: string | null;
  time_end: string | null;
  days: number[] | null;
  rule_name: string | null;
  check_key: string | null;
}

/**
 * Silence windows whose target and time span currently match this server —
 * rule_name/check_key filtering happens later, per-check, since a window can
 * be scoped to one specific alert instead of silencing the whole server.
 */
async function activeSilences(server: ServerLike): Promise<SilenceRow[]> {
  const { rows } = await query<SilenceRow>(
    `SELECT target, recurrence, time_start, time_end, days, rule_name, check_key FROM maintenance_windows
     WHERE (recurrence = 'once' AND starts_at <= now() AND ends_at > now())
        OR recurrence = 'recurring'`,
  );
  const host = (server.hostname || "").toLowerCase();
  const display = server.display_name.toLowerCase();
  return rows.filter((r) => {
    if (r.recurrence === "recurring" && !inRecurringWindow(r)) return false;
    const t = String(r.target).toLowerCase();
    if (t === "*") return true;
    if (t.startsWith("group:")) return server.brand.toLowerCase() === t.slice(6).trim();
    if (t.startsWith("tag:")) return server.tags.some((x) => x.toLowerCase() === t.slice(4).trim());
    return t === host || t === display;
  });
}

/** True if any target-matching silence also covers this specific rule/check (NULL = every rule/check on the target). */
function isSilenced(silences: SilenceRow[], ruleName: string, checkKey: string): boolean {
  return silences.some((s) =>
    (s.rule_name == null || s.rule_name === ruleName) &&
    (s.check_key == null || s.check_key === checkKey));
}

/** Active manual mutes for this server, keyed like the alert_states map. */
async function activeMutes(server: ServerLike): Promise<Set<string>> {
  const { rows } = await query(
    `SELECT rule_name, check_key FROM alert_mutes WHERE server_id = $1 AND until > now()`, [server.id],
  );
  return new Set(rows.map((r) => `${r.rule_name}\u0000${r.check_key}`));
}

async function fetchWindowSamples(serverId: number, windowMs: number): Promise<WindowSample[]> {
  const { rows } = await query<{
    time: Date; cpu_pct: number | null; mem_pct: number | null; swap_pct: number | null;
    disk_min_free_pct: number | null; net_rx_bps: number | null; net_tx_bps: number | null;
    disk_read_bps: number | null; disk_write_bps: number | null;
  }>(
    `SELECT time, cpu_pct, mem_pct, swap_pct, disk_min_free_pct, net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps
     FROM metrics WHERE server_id = $1 AND time > now() - ($2 || ' milliseconds')::interval ORDER BY time`,
    [serverId, windowMs],
  );
  return rows.map((r) => ({
    t: new Date(r.time).getTime(),
    "cpu.percent": r.cpu_pct, "mem.percent": r.mem_pct, "swap.percent": r.swap_pct,
    "disk.min_free_pct": r.disk_min_free_pct,
    "net.rx_bps": r.net_rx_bps, "net.tx_bps": r.net_tx_bps,
    "disk.read_bps": r.disk_read_bps, "disk.write_bps": r.disk_write_bps,
  }));
}

/** Evaluate all rules against one server; handles transitions, cooldowns, notifications. */
export async function evaluateServer(server: ServerLike): Promise<void> {
  const matching = activeRules.filter((r) => ruleMatchesServer(r, server));
  if (matching.length === 0) return;

  const ctx = buildContext(server);
  const { rows: stateRows } = await query<AlertStateRow>(
    `SELECT * FROM alert_states WHERE server_id = $1`, [server.id],
  );
  const states = new Map(stateRows.map((s) => [`${s.rule_name}\u0000${s.check_key}`, s]));
  const silences = await activeSilences(server);
  const mutes = await activeMutes(server);

  // Checks using window functions (avg/pct_time/...) need recent history —
  // fetched once per server per tick, sized to the widest window any
  // matching check asks for, rather than once per check.
  const neededWindowMs = Math.max(
    0, ...matching.flatMap((r) => r.checks.flatMap((c) =>
      [maxWindowMs(c.expr), c.clearExpr ? maxWindowMs(c.clearExpr) : 0])),
  );
  const samples = neededWindowMs > 0 ? await fetchWindowSamples(server.id, neededWindowMs) : null;
  const nowMs = Date.now();

  for (const rule of matching) {
    for (const check of rule.checks) {
      const stateKey = `${rule.name}\u0000${check.key}`;
      const state = states.get(stateKey);
      const suppressed = isSilenced(silences, rule.name, check.key) || mutes.has(stateKey);

      const fireExpr = samples ? resolveWindows(check.expr, samples, nowMs) : check.expr;
      const clearExprResolved = check.clearExpr
        ? (samples ? resolveWindows(check.clearExpr, samples, nowMs) : check.clearExpr)
        : undefined;

      let firing: boolean;
      // true once the check is clear enough to resolve — defaults to "not
      // firing" so a check without clear_when behaves exactly as before;
      // with clear_when set, the fire and clear thresholds are independent
      // (hysteresis), so a value sitting between them holds its current state.
      let clearing: boolean;
      try {
        firing = truthy(evaluate(fireExpr, ctx));
        clearing = clearExprResolved ? truthy(evaluate(clearExprResolved, ctx)) : !firing;
      } catch {
        continue; // runtime evaluation error: treat as not firing
      }

      if (firing && !state?.active) {
        await handleFire(server, rule, check, state, suppressed);
      } else if (!firing && state && !state.active && state.pending_since) {
        // The condition went away before the "for" wait elapsed — cancel the
        // pending fire so a blip doesn't half-open an incident.
        await query(
          `UPDATE alert_states SET pending_since = NULL WHERE rule_name=$1 AND check_key=$2 AND server_id=$3`,
          [rule.name, check.key, server.id],
        );
      } else if (!clearing && state?.active) {
        // A relapse mid pending-clear cancels the countdown — the next clear
        // starts a fresh one, so a flapping check never sneaks out resolved.
        if (state.clearing_since) {
          await query(
            `UPDATE alert_states SET clearing_since = NULL WHERE rule_name=$1 AND check_key=$2 AND server_id=$3`,
            [rule.name, check.key, server.id],
          );
        }
        // Still bad but this incident's immediate targets were never
        // delivered (fired during maintenance/mute, rate valve, or inside the
        // flap-guard cooldown): try again once nothing suppresses it anymore.
        // notified_targets is per-incident; last_notified spans incidents and
        // only enforces the cooldown here.
        const immediateNotified = check.notify.some((t, i) =>
          !isEscalationTarget(t) && state.notified_targets.includes(i));
        const withinCooldown = state.last_notified != null &&
          Date.now() - new Date(state.last_notified).getTime() < check.cooldownMs;
        if (!immediateNotified && !withinCooldown && !suppressed && state.incident_id) {
          const sent = await notifyFiring(server, rule, check, state.first_seen ?? new Date(), state.notified_targets, state.incident_id);
          if (sent.length) await recordNotified(rule, check, server, sent, true);
        }
        await checkEscalations(server, rule, check, state, suppressed);
      } else if (clearing && state?.active) {
        await handleClear(server, rule, check, state, suppressed);
      }
    }
  }
}

async function recordNotified(
  rule: CompiledRule, check: CompiledCheck, server: ServerLike, indexes: number[], touchLastNotified: boolean,
): Promise<void> {
  await query(
    `UPDATE alert_states SET
       notified_targets = (SELECT array_agg(DISTINCT x) FROM unnest(notified_targets || $4::int[]) AS x)
       ${touchLastNotified ? ", last_notified = now()" : ""}
     WHERE rule_name = $1 AND check_key = $2 AND server_id = $3`,
    [rule.name, check.key, server.id, indexes],
  );
}

/** Sends escalation (notify.after) targets whose delay has elapsed and haven't fired yet for this incident. */
async function checkEscalations(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck, state: AlertStateRow, suppressed: boolean,
): Promise<void> {
  if (suppressed || !state.first_seen || !state.incident_id) return;
  const elapsed = Date.now() - new Date(state.first_seen).getTime();
  const due: Array<[number, NotifyTarget]> = [];
  check.notify.forEach((t, i) => {
    if (isEscalationTarget(t) && !state.notified_targets.includes(i) && elapsed >= t.after!) due.push([i, t]);
  });
  if (due.length === 0) return;

  const results = await deliverAlert(due.map(([i, t]) => ({ target: t, index: i })), {
    server, rule, check, firstSeen: new Date(state.first_seen), resolved: false,
    metrics: snapshotHighlights(server), incidentId: state.incident_id,
  });
  const sentIdx = due.filter((_, k) => results[k]).map(([i]) => i);
  if (sentIdx.length) await recordNotified(rule, check, server, sentIdx, false);
}

/**
 * Delays opening an incident until the condition has been continuously true
 * for check.forMs — a blip (e.g. one bad poll) doesn't page anyone. The wait
 * restarts if the condition clears before it elapses (see the pending_since
 * reset in evaluateServer's non-firing branch).
 */
async function handleFire(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck,
  prev: AlertStateRow | undefined, suppressed: boolean,
): Promise<void> {
  if (check.forMs <= 0) {
    await onFire(server, rule, check, prev, suppressed);
    return;
  }
  if (!prev?.pending_since) {
    await query(
      `INSERT INTO alert_states (rule_name, check_key, server_id, active, pending_since)
       VALUES ($1,$2,$3,false,now())
       ON CONFLICT (rule_name, check_key, server_id)
       DO UPDATE SET pending_since = COALESCE(alert_states.pending_since, now())
       WHERE alert_states.active = false`,
      [rule.name, check.key, server.id],
    );
    return;
  }
  const elapsed = Date.now() - new Date(prev.pending_since).getTime();
  if (elapsed >= check.forMs) {
    await onFire(server, rule, check, prev, suppressed);
  }
  // else: still waiting for the condition to hold long enough.
}

async function onFire(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck,
  prev: AlertStateRow | undefined, suppressed: boolean,
): Promise<void> {
  const now = new Date();
  const message = checkMessage(check, server);

  const { rows } = await query(
    `INSERT INTO incidents (server_id, rule_name, check_key, severity, message, suppressed)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [server.id, rule.name, check.key, check.severity, message, suppressed],
  );
  const incidentId = rows[0].id;

  if (check.capture === "sql_snapshot") {
    try {
      await query(
        `INSERT INTO sql_snapshots (server_id, incident_id, requested_by, status)
         VALUES ($1,$2,$3,'requested')`,
        [server.id, incidentId, `rule:${rule.name}/${check.key}`],
      );
    } catch (err: any) {
      // a snapshot-request failure must never block incident creation or notification
      console.error("sql_snapshot request insert failed:", err.message);
    }
  }

  // cooldown: suppress re-notification if we alerted for this same check recently (flap guard)
  const withinCooldown = prev?.last_notified != null &&
    now.getTime() - new Date(prev.last_notified).getTime() < check.cooldownMs;

  await query(
    `INSERT INTO alert_states (rule_name, check_key, server_id, active, first_seen, last_notified, incident_id, notified_targets, clearing_since, pending_since)
     VALUES ($1,$2,$3,true,$4,$5,$6,'{}',NULL,NULL)
     ON CONFLICT (rule_name, check_key, server_id)
     DO UPDATE SET active = true, first_seen = $4, incident_id = $6, notified_targets = '{}', clearing_since = NULL, pending_since = NULL`,
    [rule.name, check.key, server.id, now, prev?.last_notified ?? null, incidentId],
  );

  broadcast("incident", { server_id: server.id, state: "open", rule: rule.name, check: check.key, severity: check.severity, message });

  if (!suppressed && !withinCooldown) {
    const sent = await notifyFiring(server, rule, check, now, [], incidentId);
    if (sent.length) await recordNotified(rule, check, server, sent, true);
  }
}

/** Sends the "immediate" (no after:) notify targets not yet notified for this incident. Returns sent indexes. */
async function notifyFiring(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck,
  firstSeen: Date, alreadyNotified: number[], incidentId: number,
): Promise<number[]> {
  const targets = check.notify
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => !isEscalationTarget(t) && !alreadyNotified.includes(i));
  if (targets.length === 0) return [];

  const results = await deliverAlert(targets.map((x) => ({ target: x.t, index: x.i })), {
    server, rule, check, firstSeen, resolved: false, metrics: snapshotHighlights(server), incidentId,
  });
  return targets.filter((_, k) => results[k]).map((x) => x.i);
}

/**
 * Delays declaring a check resolved until it has stayed clear for
 * check.resolveAfterMs — a flapping check (fires, clears, fires again within
 * the window) never gets a premature "resolved" email while it's still
 * effectively ongoing. The countdown restarts on every relapse (see the
 * clearing_since reset in evaluateServer's firing branch).
 */
async function handleClear(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck,
  state: AlertStateRow, suppressed: boolean,
): Promise<void> {
  if (check.resolveAfterMs <= 0) {
    await onClear(server, rule, check, state, suppressed);
    return;
  }
  if (!state.clearing_since) {
    await query(
      `UPDATE alert_states SET clearing_since = now() WHERE rule_name=$1 AND check_key=$2 AND server_id=$3`,
      [rule.name, check.key, server.id],
    );
    return;
  }
  const elapsed = Date.now() - new Date(state.clearing_since).getTime();
  if (elapsed >= check.resolveAfterMs) {
    await onClear(server, rule, check, state, suppressed);
  }
  // else: still counting down, nothing to do yet.
}

async function onClear(
  server: ServerLike, rule: CompiledRule, check: CompiledCheck,
  state: AlertStateRow, suppressed: boolean,
): Promise<void> {
  if (state.incident_id) {
    await query(`UPDATE incidents SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`,
      [state.incident_id]);
  }
  await query(
    `UPDATE alert_states SET active = false, incident_id = NULL, clearing_since = NULL
     WHERE rule_name = $1 AND check_key = $2 AND server_id = $3`,
    [rule.name, check.key, server.id],
  );

  broadcast("incident", { server_id: server.id, state: "resolved", rule: rule.name, check: check.key });

  // only send RESOLVED to targets that actually received the firing alert —
  // an escalation contact that was never paged shouldn't get a recovery notice
  const notified = check.notify
    .map((t, i) => ({ target: t, index: i }))
    .filter(({ index }) => state.notified_targets.includes(index));
  if (rule.recoveryNotify && state.last_notified && !suppressed && notified.length > 0 && state.incident_id) {
    await deliverAlert(notified, {
      server, rule, check,
      firstSeen: state.first_seen ?? new Date(),
      resolved: true,
      metrics: snapshotHighlights(server),
      incidentId: state.incident_id,
    });
  }
}

function snapshotHighlights(server: ServerLike): Array<[string, string]> {
  const snap = server.last_snapshot;
  if (!snap) return [["status", server.status]];
  const rows: Array<[string, string]> = [["status", server.status]];
  if (snap.cpu?.percent != null) rows.push(["CPU", `${snap.cpu.percent}%`]);
  if (snap.memory?.percent != null) rows.push(["Memory", `${snap.memory.percent}%`]);
  for (const d of (snap.disks || []).slice(0, 4)) {
    rows.push([`Disk ${d.mount}`, `${d.used_percent}% used, ${(d.free / 1024 ** 3).toFixed(1)} GB free`]);
  }
  const sessions = (snap.sessions || []).map((s: any) => s.user).join(", ");
  if (sessions) rows.push(["Signed-in users", sessions]);
  const failed = (snap.systemd_failed_units || []).join(", ");
  if (failed) rows.push(["Failed units", failed]);
  for (const l of (snap.lockouts || []).slice(0, 10)) {
    const when = l.time ? new Date(l.time).toISOString().replace("T", " ").slice(0, 19) : "unknown time";
    rows.push([`Locked out: ${l.user || "unknown user"}`, `from ${l.caller_computer || "unknown device"} at ${when} UTC`]);
  }
  if (snap.uptime_seconds != null) {
    rows.push(["Uptime", `${(snap.uptime_seconds / 86400).toFixed(1)} days`]);
  }
  return rows;
}

// ---------- offline sweep ----------

let loggedBlackout = false;

export async function sweepOffline(): Promise<void> {
  // A fresh restart hasn't heard from anyone yet — that's not evidence the
  // estate went down, it's evidence Alfred just started.
  const settleMs = getSettingNumber("alert.startup_settle_seconds") * 1000;
  if (Date.now() - bootedAt < settleMs) return;

  const { rows } = await query<ServerLike & { interval_seconds: number; last_seen: Date | null }>(
    `SELECT s.id, s.hostname, s.display_name, s.brand, s.tags, s.status, s.agent_version,
            s.last_snapshot, s.interval_seconds, s.last_seen, parent.display_name AS parent_display_name
     FROM servers s LEFT JOIN servers parent ON parent.id = s.parent_id
     WHERE s.status = 'online' AND s.kind = 'agent'`,
  );
  if (rows.length === 0) return;

  const now = Date.now();

  // Self-health gate: if not one currently-online agent has reported in a
  // while, that's more likely Alfred's own ingestion breaking (DB hiccup,
  // network drop) than every agent going offline in the same window — hold
  // off declaring anything offline until reporting resumes, rather than
  // mass-alerting the whole estate over Alfred's own problem. The threshold
  // scales with the slowest agent's interval so a single slow-polling
  // estate can never get stuck permanently gated.
  const configuredBlackoutMs = getSettingNumber("alert.blackout_seconds") * 1000;
  const maxIntervalMs = Math.max(...rows.map((s) => s.interval_seconds * 1000));
  const blackoutMs = Math.max(configuredBlackoutMs, maxIntervalMs * 2);
  const newestSeen = Math.max(0, ...rows.map((s) => s.last_seen ? new Date(s.last_seen).getTime() : 0));
  if (newestSeen > 0 && now - newestSeen > blackoutMs) {
    if (!loggedBlackout) {
      console.warn(`sweepOffline: no agent has reported in ${Math.round(blackoutMs / 1000)}s — suspected ingestion outage, holding off new offline declarations`);
      loggedBlackout = true;
    }
    return;
  }
  loggedBlackout = false;

  // Real grace period before declaring offline: the configured multiplier
  // over the agent's own interval, with a floor so a fast-polling agent
  // can't trip offline from one or two dropped heartbeats.
  const multiplier = getSettingNumber("alert.offline_multiplier");
  const minCutoffMs = getSettingNumber("alert.offline_min_seconds") * 1000;
  for (const s of rows) {
    const cutoff = Math.max(s.interval_seconds * multiplier * 1000, minCutoffMs);
    if (!s.last_seen || now - new Date(s.last_seen).getTime() > cutoff) {
      await query(
        `UPDATE servers SET status = 'offline', status_since = now() WHERE id = $1`, [s.id]);
      const updated = { ...s, status: "offline" };
      console.log(`server ${s.display_name} (#${s.id}) marked offline`);
      broadcast("server", { id: s.id, status: "offline" });
      await evaluateServer(updated);
    }
  }
}

export function startEvaluatorLoop(): void {
  const tick = async () => {
    try {
      await sweepOffline();
    } catch (err: any) {
      console.error("sweep error:", err.message);
    }
  };
  setInterval(tick, 15_000).unref();

  // periodic full pass so rules fire even without fresh ingests (e.g. after rules edit)
  setInterval(async () => {
    try {
      const { rows } = await query<ServerLike>(
        `SELECT s.id, s.hostname, s.display_name, s.brand, s.tags, s.status, s.agent_version,
                s.last_snapshot, s.last_seen, parent.display_name AS parent_display_name
         FROM servers s LEFT JOIN servers parent ON parent.id = s.parent_id
         WHERE s.status <> 'pending'`,
      );
      for (const s of rows) await evaluateServer(s);
    } catch (err: any) {
      console.error("full evaluation pass error:", err.message);
    }
  }, 60_000).unref();

  // sql_snapshots isn't a hypertable (request/response rows, not a dense time
  // series) so it doesn't get a Timescale retention policy — prune it here.
  let lastSnapshotCleanupDate = "";
  setInterval(async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (lastSnapshotCleanupDate === today) return;
    lastSnapshotCleanupDate = today;
    try {
      const days = String(getSettingNumber("retention.metrics_days"));
      await query(`DELETE FROM sql_snapshots WHERE requested_at < now() - ($1 || ' days')::interval`, [days]);
    } catch (err: any) {
      console.error("sql_snapshots cleanup error:", err.message);
    }
  }, 60 * 60_000).unref();
}

// ---------- daily digest ----------

let lastDigestDate = "";

export function startDigestLoop(): void {
  // Settings are read every tick (not once at startup) so enabling the
  // digest or changing its hour from the UI takes effect without a restart.
  setInterval(async () => {
    const to = getSetting("digest.to").split(",").map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) return;
    const hour = getSettingNumber("digest.hour");
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== hour || lastDigestDate === today) return;
    lastDigestDate = today;
    try {
      const { rows } = await query(
        `SELECT i.*, s.display_name FROM incidents i
         JOIN servers s ON s.id = i.server_id
         WHERE i.resolved_at IS NULL ORDER BY i.started_at`,
      );
      const lines = rows.length === 0
        ? ["All clear — no active alerts."]
        : rows.map((r) => `[${r.severity}] ${r.display_name}: ${r.message} (since ${new Date(r.started_at).toISOString()})`);
      const subject = rows.length === 0
        ? "✅ Alfred daily digest — all clear"
        : `⚠️ Alfred daily digest — ${rows.length} active alert(s)`;
      await sendMail({
        to,
        subject,
        text: lines.join("\n"),
        html: `<pre style="font-family:ui-monospace,Consolas,monospace;font-size:13px">${lines.join("\n")}</pre>`,
      });
    } catch (err: any) {
      console.error("digest error:", err.message);
    }
  }, 60_000).unref();
}
