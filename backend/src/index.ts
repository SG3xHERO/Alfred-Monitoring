import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

import { initDb, applyRetention } from "./db.js";
import { requireMasterKey } from "./crypto.js";
import { initSettings, getSettingNumber } from "./settings.js";
import { runMigrations } from "./migrations.js";
import { seedAdmin } from "./auth.js";
import { loadRules, startEvaluatorLoop, startDigestLoop } from "./engine/evaluator.js";
import { startProberLoop } from "./engine/prober.js";
import { ingestRoutes } from "./routes/ingest.js";
import { agentSnapshotRoutes } from "./routes/agent-snapshot.js";
import { agentReleaseRoutes } from "./routes/agent-releases.js";
import { serverRoutes } from "./routes/servers.js";
import { brandRoutes } from "./routes/brands.js";
import { probeRoutes } from "./routes/probes.js";
import { probeVariableRoutes } from "./routes/probe-variables.js";
import { credentialRoutes } from "./routes/credentials.js";
import { dataConnectionRoutes } from "./routes/data-connections.js";
import { exportImportRoutes } from "./routes/export-import.js";
import { probePushRoutes } from "./routes/probe-push.js";
import { ruleRoutes } from "./routes/rules.js";
import { userRoutes } from "./routes/users.js";
import { settingsRoutes } from "./routes/settings.js";
import { wallLayoutRoutes } from "./routes/wallLayouts.js";
import { dashboardRoutes } from "./routes/dashboards.js";
import { annotationRoutes } from "./routes/annotations.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes, incidentRoutes, maintenanceRoutes, eventRoutes, muteRoutes } from "./routes/misc.js";
import { passwordResetRoutes } from "./routes/password-reset.js";
import { setupRoutes } from "./routes/setup.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 1024 * 1024, // agents send small payloads; cap at 1 MB
  // All traffic arrives via the frontend container's nginx (see
  // frontend/nginx.conf, which sets X-Forwarded-For/X-Real-IP) — nothing
  // reaches the backend directly, so that proxy is always trustworthy and
  // req.ip can safely resolve to the real client instead of nginx's own
  // container address.
  trustProxy: true,
});

async function main() {
  requireMasterKey(); // fail fast with a clear message, not on first secret use
  await initDb();
  await initSettings();
  await applyRetention(getSettingNumber("retention.metrics_days"));
  await runMigrations();
  await seedAdmin();
  await loadRules();

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  await app.register(authRoutes);
  await app.register(passwordResetRoutes);
  await app.register(setupRoutes);
  await app.register(ingestRoutes);
  await app.register(agentSnapshotRoutes);
  await app.register(agentReleaseRoutes);
  await app.register(serverRoutes);
  await app.register(brandRoutes);
  await app.register(probeRoutes);
  await app.register(probeVariableRoutes);
  await app.register(credentialRoutes);
  await app.register(dataConnectionRoutes);
  await app.register(exportImportRoutes);
  await app.register(probePushRoutes);
  await app.register(ruleRoutes);
  await app.register(userRoutes);
  await app.register(settingsRoutes);
  await app.register(wallLayoutRoutes);
  await app.register(dashboardRoutes);
  await app.register(annotationRoutes);
  await app.register(auditRoutes);
  await app.register(incidentRoutes);
  await app.register(maintenanceRoutes);
  await app.register(eventRoutes);
  await app.register(muteRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  startEvaluatorLoop();
  startProberLoop();
  startDigestLoop();

  const port = parseInt(process.env.PORT || "8080", 10);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
