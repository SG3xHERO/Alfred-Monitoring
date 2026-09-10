# backend

Fastify + TypeScript API. Handles agent ingest, the rule engine, notifications,
and everything the dashboard talks to.

## Run

```
npm install
npm run dev          # tsx watch, port 8080
npm run build        # tsc -> dist/
npm start            # node dist/index.js
```

Needs a Postgres database. The schema in `src/schema.ts` is applied on every
boot and is idempotent, so there are no separate migration files to run.
TimescaleDB is used for the metrics tables when available and skipped
otherwise.

## Environment

Everything except the database URL and the encryption key is configured in the
app and stored in the DB. These are the only variables that matter:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://alfred@localhost:5432/alfred` | |
| `ALFRED_MASTER_KEY` | generated on first boot | 64 hex chars. Encrypts secrets at rest. |
| `ALFRED_KEY_FILE` | `/data/alfred-master.key` | Where a generated key is written and read back. |
| `JWT_SECRET` | derived from the master key | Set only to rotate the master key independently. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | unset | Set both to create the admin account without the wizard. |
| `PORT` | `8080` | |
| `LOG_LEVEL` | `info` | |

Legacy `env` seeding of individual settings (SMTP, timezone, retention, ...) is
still read on first boot for older deploys, but the wizard and Settings page are
the supported path.

## Layout

```
src/
  index.ts        wiring and startup order
  schema.ts       full DB schema, applied at boot
  settings.ts     the DB-backed settings registry
  crypto.ts       encryption at rest, master key handling
  auth.ts         sessions, roles, API key hashing
  engine/         rule parser, evaluator, prober (agentless checks)
  notify/         email / smtp / slack / teams / webhook dispatch
  routes/         one file per API area
```
