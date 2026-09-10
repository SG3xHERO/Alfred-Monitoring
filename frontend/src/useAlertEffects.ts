import { useEffect, useRef, useState } from "react";
import type { Server } from "./types";
import { playWarning, playCritical, playResolved } from "./sound";
import { fireConfetti } from "./confetti";

export type Severity = "offline" | "critical" | "warning" | "ok";

/** Mirrors Tile's own color logic in Wall.tsx, kept in sync deliberately. */
export function severityOf(s: Server): Severity {
  if (s.status === "offline") return "offline";
  if (s.active_incidents.some((i) => i.severity === "critical")) return "critical";
  if (s.active_incidents.some((i) => i.severity === "warning") || s.status === "pending") return "warning";
  return "ok";
}

const FLASH_MS = 2600;

/**
 * Diffs server severity each update and fires sound/confetti/screen-flash on
 * transitions, plus reports which tiles are *currently* critical/warning so
 * they can pulse continuously — not just flash once when the alert starts.
 * "offline" gets the same urgent sound as "critical" but keeps its own
 * existing flicker/lightning visual (useOfflineFlash) rather than double-
 * animating with the new pulse.
 */
export function useAlertEffects(servers: Server[]) {
  const prevSeverity = useRef(new Map<number, Severity>());
  const [flashing, setFlashing] = useState<Map<number, "critical" | "warning" | "resolved">>(new Map());
  const [screenFlash, setScreenFlash] = useState(false);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let sawNewCritical = false;
    let sawNewWarning = false;
    let sawResolved = false;
    const transitioned: Array<[number, "critical" | "warning" | "resolved"]> = [];

    for (const s of servers) {
      const prev = prevSeverity.current.get(s.id);
      const cur = severityOf(s);
      if (prev !== undefined && prev !== cur) {
        if (cur === "offline") {
          sawNewCritical = true;
        } else if (cur === "critical") {
          transitioned.push([s.id, "critical"]);
          sawNewCritical = true;
        } else if (cur === "warning" && prev === "ok") {
          transitioned.push([s.id, "warning"]);
          sawNewWarning = true;
        } else if (cur === "ok" && prev !== "ok") {
          transitioned.push([s.id, "resolved"]);
          sawResolved = true;
        }
      }
      prevSeverity.current.set(s.id, cur);
    }

    if (transitioned.length > 0) {
      setFlashing((cur) => {
        const next = new Map(cur);
        transitioned.forEach(([id, kind]) => next.set(id, kind));
        return next;
      });
      transitioned.forEach(([id]) => {
        const existing = timers.current.get(id);
        if (existing) clearTimeout(existing);
        timers.current.set(id, setTimeout(() => {
          timers.current.delete(id);
          setFlashing((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Map(cur);
            next.delete(id);
            return next;
          });
        }, FLASH_MS));
      });
    }

    if (sawNewCritical) {
      playCritical();
      setScreenFlash(true);
      setTimeout(() => setScreenFlash(false), 2800);
    } else if (sawNewWarning) {
      playWarning();
    }
    if (sawResolved) {
      playResolved();
      fireConfetti();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const persistent = new Map<number, "critical" | "warning">();
  for (const s of servers) {
    const sev = severityOf(s);
    if (sev === "critical" || sev === "warning") persistent.set(s.id, sev);
  }

  return { flashing, screenFlash, persistent };
}
