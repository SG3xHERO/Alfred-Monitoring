import { useEffect, useRef, useState } from "react";
import type { Server } from "./types";

/**
 * Tracks servers that just transitioned to offline, for a brief flash
 * animation. Diffs client-side against each server's previous status, so it
 * works whether the update arrived via SSE or a fallback poll.
 */
export function useOfflineFlash(servers: Server[], durationMs = 2600): Set<number> {
  const prevStatus = useRef(new Map<number, Server["status"]>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [flashing, setFlashing] = useState<Set<number>>(new Set());

  useEffect(() => {
    const justWentOffline: number[] = [];
    for (const s of servers) {
      const prev = prevStatus.current.get(s.id);
      if (prev && prev !== "offline" && s.status === "offline") justWentOffline.push(s.id);
      prevStatus.current.set(s.id, s.status);
    }
    if (justWentOffline.length === 0) return;

    setFlashing((cur) => {
      const next = new Set(cur);
      justWentOffline.forEach((id) => next.add(id));
      return next;
    });

    for (const id of justWentOffline) {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setFlashing((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Set(cur);
            next.delete(id);
            return next;
          });
        }, durationMs),
      );
    }
  }, [servers, durationMs]);

  // clear pending timers on unmount only
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  return flashing;
}
