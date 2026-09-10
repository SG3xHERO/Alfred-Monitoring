# Alfred agent changelog

## v1.8 — 2026-09-09

- **New: agent-reported IP address.** Each heartbeat now includes the local
  IPv4 address of the interface the agent uses to reach the backend, shown
  on the device page under the hostname. Fixes every server showing the same
  wrong address on deployments where Docker's own port-forwarding (notably
  Docker Desktop's NAT on Windows/Mac) rewrites the connecting address before
  the backend ever sees it — the agent now reports its own view instead of
  relying on the network layer to get it right.

## v1.7 — 2026-07-17

- **Remote config push.** The app's Add Server / Edit panels can now push
  `lockout_monitoring`, `sql_monitoring`, and a new `signed_in_users_panel`
  flag down to an already-installed agent — no more hand-editing
  `config.yaml` on the box. Applied idempotently (a value is only rewritten
  when it actually differs) and picked up by the existing file-mtime hot
  reload, so no service restart is needed.
- **New `sql_monitoring` config flag.** The SQL diagnostic snapshot capture
  (triggered by a rule's `capture: sql_snapshot` or the device page's
  "Snapshot now") is now gated behind it — a snapshot request against a box
  not flagged as running SQL Server is declined rather than attempted.

## v1.6 — 2026-07-16

- **Fixed: caller computer was always blank in lockout alerts.** The code
  assumed the 8-property TargetUserName..CallerComputerName-at-index-7
  layout documented for older Windows versions. Dumping the actual
  properties on a production DC showed only 7 properties, with the caller
  computer at index 1, not 7 — confirmed against a real lockout event
  (the caller-computer field resolved to the correct source hostname).
  Fixed the index; no schema/rule changes needed.

## v1.5 — 2026-07-16

- **Fixed: lockout monitoring was blocking the entire collection cycle.**
  Observed in production timing out at 30s on every single poll against a
  busy DC's Security log — because the query ran inline, this delayed that
  server's whole snapshot push (CPU/memory/disk, not just lockouts) by
  30+ seconds every cycle, risking spurious "offline" flaps when the delay
  exceeded the offline-detection cutoff. The query now runs in the
  background and is never awaited by the main tick; whatever it last found
  is attached to the next snapshot. Its own timeout is also raised from 30s
  to 2 minutes, since a slow Security log no longer holds anything else up.

## v1.4 — 2026-07-16

- **Lockout query no longer fails silently.** It previously ran with
  `-ErrorAction SilentlyContinue`, which hid "access denied" identically to
  the normal "no lockouts this poll" case — a real permissions problem and
  a quiet night looked exactly the same. It now distinguishes the two and
  logs an explicit error for the former.
- **New persistent log file** (`agent.log`, next to `config.yaml`, capped at
  10MB with one rotation). Previously the agent's `log.Printf` output went
  to stderr, which a Windows service has no console to show — so nothing
  was visible without stopping the service and running the binary
  interactively. Startup, config reloads, collection errors, and lockout
  query results now land there.

## v1.3 — 2026-07-16

- **AD account lockout monitoring (Windows, opt-in).** New `checks.lockout_monitoring`
  config flag; when enabled, the agent polls the Security log for event 4740
  ("account was locked out") every regular interval (not the slower
  `eventlog_interval_seconds` cadence used for System/Application) so a
  lockout is flagged on the next check-in instead of minutes later. Requires
  the agent's service account to have Security-log read rights (add it to
  the local `Event Log Readers` group).
- New rule-engine surface: `windows.lockout_count` metric and
  `windows.user_locked_out(name)` function, plus a `{{lockouts}}` template
  variable for alert subjects/messages.
- Lockout alert emails now include the locked-out user's source device
  (Security log's "caller computer") and the event time in the details table.

## v1.2 and earlier

Not tracked here — see git history.
