import { useEffect, useRef, useState } from "react";

/**
 * Subscribes to the backend SSE stream and invokes the callback (debounced)
 * whenever a matching event arrives. Pages use this to refetch, keeping the
 * data path identical for live and initial loads.
 */
export function useLive(events: string[], onEvent: () => void, debounceMs = 1500, query = "") {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/events${query ? `?${query}` : ""}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), debounceMs);
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const ev of events) es.addEventListener(ev, fire);
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.join(","), query]);

  return connected;
}
