import type { FastifyInstance } from "fastify";
import { createHash } from "crypto";
import { query } from "../db.js";
import { hashApiKey, requireOperator } from "../auth.js";
import { getSetting } from "../settings.js";

// The frontend container cross-compiles the agent on every image build (see
// frontend/Dockerfile) and serves it as static files at a fixed path,
// stamped with a build-time version. Fetching it from here — rather than a
// human running a build script and copying files into a watched directory —
// means every Forgejo push + Portainer redeploy is automatically "published":
// no separate release step exists to forget.
const staticBase = () => getSetting("agent.static_url").replace(/\/$/, "");
const BINARY_NAMES: Record<string, string> = { windows: "alfred-agent.exe", linux: "alfred-agent" };

/** The version currently baked into the running frontend image, or null if unreachable. */
export async function currentVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${staticBase()}/agent/VERSION`);
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

/** The "## vX.Y — ..." section for the newest entry in the running image's CHANGELOG.md, or null. */
export async function currentChangelog(): Promise<string | null> {
  try {
    const res = await fetch(`${staticBase()}/agent/CHANGELOG.md`);
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.startsWith("## "));
    if (start === -1) return null;
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    return lines.slice(start, end === -1 ? lines.length : end).join("\n").trim() || null;
  } catch {
    return null;
  }
}

async function fetchBinary(platform: string): Promise<Buffer | null> {
  const binaryName = BINARY_NAMES[platform];
  if (!binaryName) return null;
  try {
    const res = await fetch(`${staticBase()}/agent/${binaryName}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// A version string only ever corresponds to one build (the timestamp changes
// every image build), so caching its digest forever is safe — no invalidation
// needed. Entries for versions no longer current just go unused.
const digestCache = new Map<string, string>();

/** SHA-256 of the binary currently served for `platform`, cached per version+platform. */
export async function releaseDigest(version: string, platform: string): Promise<string | null> {
  const cacheKey = `${version}/${platform}`;
  const cached = digestCache.get(cacheKey);
  if (cached) return cached;
  const bin = await fetchBinary(platform);
  if (!bin) return null;
  const digest = createHash("sha256").update(bin).digest("hex");
  digestCache.set(cacheKey, digest);
  return digest;
}

export async function agentReleaseRoutes(app: FastifyInstance) {
  // Always reflects the currently deployed build — there's no publish step
  // and no history, just "what's running right now".
  app.get("/api/agent-releases", { preHandler: requireOperator }, async () => {
    const version = await currentVersion();
    const changelog = await currentChangelog();
    return { versions: version ? [version] : [], changelog };
  });

  // Agent-facing download — same X-API-Key auth as /api/ingest, so binaries
  // aren't exposed to the open internet, only to known agents.
  app.get("/agent/download/:version/:platform", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!key || typeof key !== "string") {
      return reply.code(401).send({ error: "missing X-API-Key" });
    }
    const { rows } = await query(`SELECT id FROM servers WHERE api_key_hash = $1`, [hashApiKey(key)]);
    if (rows.length === 0) {
      return reply.code(401).send({ error: "unknown or revoked API key" });
    }

    const { version, platform } = req.params as { version: string; platform: string };
    if (!BINARY_NAMES[platform]) {
      return reply.code(400).send({ error: "unknown platform" });
    }
    const live = await currentVersion();
    if (!live || live !== version) {
      return reply.code(404).send({ error: "that version is no longer current — a newer build has since been deployed" });
    }
    const bin = await fetchBinary(platform);
    if (!bin) return reply.code(502).send({ error: "could not fetch binary from the frontend" });

    reply.header("Content-Type", "application/octet-stream");
    return reply.send(bin);
  });
}
