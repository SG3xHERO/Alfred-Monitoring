# agent

The Go agent. One static binary per host, no CGO. Collects host metrics and
service/process status and pushes them to the backend on a fixed interval.

## Build

```
go build ./cmd/alfred-agent                       # current platform
../deploy/build-agents.ps1                         # Linux + Windows, versioned
```

The Linux and Windows collectors are separate files behind build tags
(`collect_linux.go`, `collect_windows.go`). Everything else is shared.

## Run

```
alfred-agent -config ./config.yaml
alfred-agent -service install | start | stop | uninstall
alfred-agent -version
```

Without `-service` it runs in the foreground, which is what you want for a
local test. The install scripts in `../deploy` register it as a systemd unit or
a Windows service.

## Config

`config.example.yaml` has the full set. The minimum is `backend_url` and
`api_key`. Default paths:

- Linux: `/etc/alfred-agent/config.yaml`
- Windows: `C:\ProgramData\AlfredAgent\config.yaml`

The file is re-read within one interval when it changes, so no restart is needed
after an edit. An admin can also push the `lockout_monitoring`, `sql_monitoring`
and `signed_in_users_panel` flags from the dashboard; the agent writes them into
the file and reloads.

## Updates

An admin can trigger a binary update from the device page. The agent downloads
the new build, verifies its SHA-256, swaps itself, and exits so the service
manager restarts it. See `internal/update`.

## What it collects

CPU, memory, swap, per-disk usage and IO, network throughput, a heartbeat, and
the state of any services or processes named in the config. Windows agents can
also read Critical/Error event log entries, account lockouts (event 4740), and
SQL Server diagnostics on request. Linux agents can report pending apt updates
and SMART health.

Changes per version are in `CHANGELOG.md`.
