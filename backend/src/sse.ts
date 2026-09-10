import type { FastifyReply } from "fastify";

const clients = new Set<FastifyReply>();

export function addClient(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  clients.add(reply);
  reply.raw.on("close", () => clients.delete(reply));
}

export function broadcast(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.raw.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

// keep-alive comments so proxies don't drop idle connections
setInterval(() => {
  for (const c of clients) {
    try {
      c.raw.write(": ping\n\n");
    } catch {
      clients.delete(c);
    }
  }
}, 25_000).unref();
