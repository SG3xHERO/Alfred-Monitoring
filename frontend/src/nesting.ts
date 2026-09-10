import type { Server } from "./types";

export interface ServerNode extends Server {
  children: Server[];
}

/**
 * Turns a flat server list into top-level nodes with their children attached
 * (one level deep — a HyperV host with guest VMs, or a "Servers Online"-style
 * ping check with sibling IPs). A child whose parent isn't in this list
 * (deleted, or excluded by a filter upstream) falls back to showing at the
 * top level itself rather than disappearing. Display-only: rules/incidents/
 * alert emails still target each server independently (see servers.ts).
 */
export function nestServers(servers: Server[]): ServerNode[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const childrenByParent = new Map<number, Server[]>();
  for (const s of servers) {
    if (s.parent_id != null && byId.has(s.parent_id)) {
      if (!childrenByParent.has(s.parent_id)) childrenByParent.set(s.parent_id, []);
      childrenByParent.get(s.parent_id)!.push(s);
    }
  }
  return servers
    .filter((s) => s.parent_id == null || !byId.has(s.parent_id))
    .map((s) => ({ ...s, children: childrenByParent.get(s.id) ?? [] }));
}

/** Worst-of a node's own status and all its children's — what the board should show for the collapsed row/tile. */
export function rollupStatus(node: { status: Server["status"]; children: Server[] }): Server["status"] {
  if (node.status === "offline" || node.children.some((c) => c.status === "offline")) return "offline";
  if (node.status === "pending" || node.children.some((c) => c.status === "pending")) return "pending";
  return "online";
}
