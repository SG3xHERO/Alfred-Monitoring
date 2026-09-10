# Alfred

Self-hosted monitoring for a fleet of servers and workstations.

A small Go agent runs on each machine and pushes CPU, memory, disk, network and
service/process status to a central server every 15-30 seconds. The server keeps
the history in TimescaleDB, evaluates alert rules written in YAML, and sends
notifications by email, Slack, Teams or webhook. The dashboard is a React app
with live updates, incident history, custom charts and a full-screen wall view
for a NOC screen.

You can also add agentless checks (HTTP, TCP, ICMP ping, SMB directory counts,
SQL Server queries) for things that can't run an agent.

## Running it

The stack is three containers: Postgres/TimescaleDB, the API, and nginx serving
the dashboard. Only nginx is published, on port 8420 by default.

```
docker compose up -d --build
```

Open `http://your-host:8420`. The first visit is a setup wizard. It creates the
admin account and asks for the organisation name, timezone, email provider and a
few alert settings. Everything it collects goes in the database, not a config
file, and can be changed later under Settings.

Nothing needs configuring before the first run. To skip the wizard for a
scripted deploy, or to pin the encryption key, see `.env.example`.

### The encryption key

Provider credentials and probe tokens are encrypted in the database with a
single key. If you don't supply one, the server generates it on first boot,
prints it to the container log, and writes it to the `alfred-data` volume at
`/data/alfred-master.key`. Copy it somewhere safe. Those secrets can't be read
back without it if the volume is lost. An admin can also reveal the current key
from Settings.

### TLS

Terminate HTTPS with your own reverse proxy in front of the stack, or add
certificates to the nginx container. Agents can talk to a self-signed backend
with `insecure_skip_verify: true`, but a real certificate is better.

## Agents

The frontend image cross-compiles the agent binaries on every build and serves
them, so a normal Docker deploy already has agents ready to install. To build
them by hand you need Go 1.23+:

```
./deploy/build-agents.ps1        # writes agent/bin/<version>/alfred-agent[.exe]
```

In the dashboard, open **Add server**, give it a name and group, and copy the
API key it shows once.

Linux (Debian, as root):

```
./deploy/install-agent-linux.sh https://your-host:8420 alf_thekey
```

Windows (elevated PowerShell):

```
.\deploy\install-agent-windows.ps1 -BackendUrl https://your-host:8420 -ApiKey alf_thekey
```

Both install a service that starts on boot and restarts on failure. The config
file is at `/etc/alfred-agent/config.yaml` or
`C:\ProgramData\AlfredAgent\config.yaml`, and edits are picked up within one
poll. To watch specific services or processes:

```yaml
checks:
  services: [nginx, MSSQLSERVER]
  processes: [MyApp]
```

The agent only makes outbound connections. It opens no ports.

## Alert rules

Rules are one YAML document, edited on the Rules page. It's validated as you type
and versioned on every save. Dry-run tests a rule against live metrics without
saving or sending anything.

```yaml
rules:
  - name: server-offline
    target: "*"                 # a name, group:Production, tag:prod, or *
    checks:
      - when: status == offline
        severity: critical
        cooldown: 30m
        notify:
          - channel: email
            to: alerts@example.com
            subject: "{{server}} is offline"
    recovery_notify: true
```

Conditions combine any metric with `and`, `or`, `not` and comparisons. The full
list of metrics and functions is in the reference panel next to the editor.
Nothing is `eval()`ed, and unknown metric names are rejected on save, so a typo
can't quietly disable a rule.

A few things that aren't obvious:

- A check sends one notification when it starts firing. `cooldown` suppresses a
  repeat if it clears and fires again inside that window. The incident is
  recorded either way.
- `recovery_notify: true` sends a "resolved" message when the condition clears,
  but only if the original alert went out.
- "Offline" means no heartbeat for the offline multiplier times the agent's
  interval.
- Maintenance windows and silences mute notifications but still record
  incidents. A condition still firing when the window ends notifies then.

## Layout

```
agent/      Go agent. One codebase, build-tagged Linux and Windows collectors.
backend/    Fastify + TypeScript API, rule engine, notifier.
frontend/   React + Tailwind dashboard, served by nginx.
deploy/     Agent build and install scripts.
docker-compose.yml
```

Each directory has its own README.

## Development

You need Postgres running somewhere. TimescaleDB is optional; the schema falls
back to plain Postgres when the extension is missing.

```
cd backend  && npm install && DATABASE_URL=postgres://localhost/alfred ALFRED_KEY_FILE=./data/master.key npm run dev
cd frontend && npm install && npm run dev
```

The backend listens on 8080. The Vite dev server runs on 5173 and proxies
`/api` to it.

## Security

- Agent API keys are 192-bit random, stored only as SHA-256 hashes. Rotate or
  revoke them per server from the dashboard.
- Login is rate-limited per IP, ingest per key.
- Sessions are httpOnly JWT cookies. Provider credentials never leave the
  backend and are encrypted at rest.
- Username/password sign-in is always on. Microsoft Entra ID SSO is optional,
  off by default, enabled from Settings.
