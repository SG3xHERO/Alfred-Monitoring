import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get, post } from "../api";
import type { DashPanel, Server, WallLayout } from "../types";
import { relTime, pct } from "../format";
import { useLive } from "../useLive";
import { useOfflineFlash } from "../useOfflineFlash";
import { useAlertEffects } from "../useAlertEffects";
import { unlockAudio, isMuted, setMuted } from "../sound";
import { Button, inputCls } from "../components/bits";
import { PanelView } from "../components/PanelEditor";
import { nestServers, rollupStatus, type ServerNode } from "../nesting";

/**
 * Full-screen "video wall" view: a big, high-contrast grid of every server,
 * meant to be left running on a monitor in the office. Anything red/dead
 * jumps out immediately so someone can react.
 *
 * Servers are laid out in columns. By default columns are auto-grouped by
 * brand; picking a saved layout (built in the Wall Designer) instead shows
 * a hand-arranged set of columns.
 *
 * The wall always fits the screen — never scrolls. Columns wrap into rows
 * when the screen is narrow (portrait monitors), and tile sizing is solved
 * from the viewport: every columns-per-row arrangement is scored and the one
 * that gives tiles the most room wins. Tiles then scale their type down to a
 * readable floor (dropping the least important lines first) or up on a big
 * screen with few servers.
 */

interface WallColumn { title: string; servers: ServerNode[]; panels?: DashPanel[] }

// Fixed pixel heights matching PanelChart's own h-32/h-44/h-64 classes — panel
// charts don't scale with the tile solve below, they're accounted for as
// extra fixed height per column instead.
const PANEL_PX_HEIGHT: Record<DashPanel["height"], number> = { s: 128, m: 176, l: 256 };
const PANEL_HEADER_PX = 30;

function columnExtraH(col: WallColumn): number {
  const panels = col.panels ?? [];
  if (panels.length === 0) return 0;
  const above = col.servers.length > 0 ? TILE_GAP : 0;
  return above + panels.reduce((sum, p) => sum + PANEL_PX_HEIGHT[p.height] + PANEL_HEADER_PX + TILE_GAP, 0);
}

const TILE_NATURAL_H = 152;  // measured height of a tile at scale 1 with every line shown
const TILE_NATURAL_W = 300;
const COL_HEADER_H = 30;
const TILE_GAP = 8;
const BAND_GAP = 14;
// Kept in sync with Tile's own floor pixel sizes below — the smallest a tile
// can render (status + name + one metrics line) once every optional line has
// been dropped. Below this, scaling the number down further does nothing:
// text is already at its floor, so the last-resort transform in Wall picks
// up any remaining gap instead of letting content clip off-screen.
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.7;

/**
 * Choose how many columns sit side by side and how big tiles can be so that
 * every column fits the content box. Returns the columns chunked into bands
 * (rows of columns) plus the tile scale factor.
 */
function fitWall(columns: WallColumn[], width: number, height: number): {
  bands: WallColumn[][]; perRow: number; scale: number;
} {
  const C = columns.length;
  if (C === 0 || width <= 0 || height <= 0) return { bands: [columns], perRow: Math.max(1, C), scale: 1 };

  let best = { perRow: C, scale: MIN_SCALE, score: -Infinity };
  for (let perRow = 1; perRow <= C; perRow++) {
    const rows = Math.ceil(C / perRow);
    const colWidth = (width - TILE_GAP * (perRow - 1)) / perRow;
    // needed vertical space at scale 1: per band, its tallest column
    let tilesTotal = 0;
    let fixed = (rows - 1) * BAND_GAP;
    for (let r = 0; r < rows; r++) {
      const band = columns.slice(r * perRow, (r + 1) * perRow);
      const maxTiles = Math.max(1, ...band.map((c) => c.servers.length));
      const maxExtra = Math.max(0, ...band.map(columnExtraH));
      tilesTotal += maxTiles;
      fixed += COL_HEADER_H + (maxTiles - 1) * TILE_GAP + maxExtra;
    }
    const tileH = (height - fixed) / tilesTotal;
    const scaleH = tileH / TILE_NATURAL_H;
    const scaleW = colWidth / TILE_NATURAL_W;
    // a tile can be wider than natural, but readability is set by the tighter axis
    const score = Math.min(scaleH, scaleW * 1.25);
    if (score > best.score) best = { perRow, scale: score, score };
  }

  const bands: WallColumn[][] = [];
  for (let i = 0; i < C; i += best.perRow) bands.push(columns.slice(i, i + best.perRow));
  return { bands, perRow: best.perRow, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, best.scale)) };
}
export default function Wall() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const layoutId = searchParams.get("layout");
  const wallToken = searchParams.get("wall_token") ?? "";
  const tokenQs = wallToken ? `wall_token=${encodeURIComponent(wallToken)}` : "";
  const withToken = (path: string) => tokenQs ? `${path}${path.includes("?") ? "&" : "?"}${tokenQs}` : path;

  const [servers, setServers] = useState<Server[]>([]);
  const [layouts, setLayouts] = useState<WallLayout[]>([]);
  const [activeLayout, setActiveLayout] = useState<WallLayout | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [audioArmed, setAudioArmed] = useState(false);
  const [muted, setMutedState] = useState(() => isMuted());

  const load = useCallback(() => {
    get<Server[]>(withToken("/api/servers")).then(setServers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenQs]);
  useEffect(load, [load]);
  const connected = useLive(["server", "incident"], load, 500, tokenQs);
  const flashing = useOfflineFlash(servers);
  const { flashing: alertFlashing, screenFlash, persistent } = useAlertEffects(servers);

  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) { unlockAudio(); setAudioArmed(true); }
  };

  useEffect(() => {
    get<WallLayout[]>(withToken("/api/wall-layouts")).then(setLayouts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenQs]);

  useEffect(() => {
    if (!layoutId) { setActiveLayout(null); return; }
    get<WallLayout>(withToken(`/api/wall-layouts/${layoutId}`)).then(setActiveLayout).catch(() => setActiveLayout(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutId, tokenQs]);

  // Determine login state without triggering the global 401 redirect
  // (/api/auth/me is exempt from it), so an unauthenticated visitor can view
  // the Wall freely and only gets prompted when they try to leave it.
  useEffect(() => {
    get("/api/auth/me").then(() => setLoggedIn(true)).catch(() => setLoggedIn(false));
  }, []);

  // Anything that leaves the Wall for an authenticated part of the app
  // prompts for login instead of silently redirecting, so the kiosk screen
  // never gets stuck on a login page nobody's watching for.
  const guardedNavigate = (path: string) => {
    if (loggedIn) { navigate(path); return; }
    setPendingNav(path);
  };

  // Fallback poll in case SSE drops silently, and drive the on-screen clock.
  useEffect(() => {
    const t = setInterval(() => { load(); setNow(Date.now()); }, 15000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const exit = async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* ignore */ }
    }
    guardedNavigate("/");
  };

  const enterFullscreen = async () => {
    try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
  };

  const design = () => {
    guardedNavigate(layoutId ? `/wall/design?layout=${layoutId}` : "/wall/design");
  };

  // Worst-first: dead/critical servers surface at the top, where eyes land first.
  // For a nested node, a bad child counts the same as the parent itself being bad.
  const rank = (s: Server | ServerNode) => {
    const children = "children" in s ? s.children : [];
    const incidents = [...s.active_incidents, ...children.flatMap((c) => c.active_incidents)];
    if (s.status === "offline" || children.some((c) => c.status === "offline")) return 0;
    if (incidents.some((i) => i.severity === "critical")) return 1;
    if (incidents.some((i) => i.severity === "warning")) return 2;
    if (s.status === "pending" || children.some((c) => c.status === "pending")) return 3;
    return 4;
  };

  const columns = useMemo(() => {
    const byId = new Map(servers.map((s) => [s.id, s]));
    // A placed host keeps its nested devices folded into its tile as dots,
    // same as the auto-grouped wall — curating which HOSTS appear doesn't
    // mean flattening away what's nested under them.
    const nestedById = new Map(nestServers(servers).map((n) => [n.id, n]));
    const toNode = (s: Server): ServerNode => nestedById.get(s.id) ?? { ...s, children: [] };

    if (activeLayout) {
      const hidden = new Set(activeLayout.config.hiddenServerIds ?? []);
      const used = new Set<number>(hidden);
      const cols = activeLayout.config.sections.map((sec) => {
        const list = sec.serverIds.map((id) => byId.get(id)).filter((s): s is Server => !!s).map(toNode);
        list.forEach((s) => used.add(s.id));
        return { title: sec.title, servers: list, panels: sec.panels ?? [] };
      });
      const leftover = servers.filter((s) => !used.has(s.id)).map(toNode);
      if (leftover.length > 0) {
        leftover.sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
        cols.push({ title: "Other servers", servers: leftover, panels: [] });
      }
      return cols;
    }

    // Auto: group by brand, worst-first within each column. A nested device
    // (a HyperV host's guest VM, a sibling ping IP) is folded into its
    // parent's tile instead of getting its own — see nesting.ts.
    const nodes = nestServers(servers);
    const m = new Map<string, ServerNode[]>();
    for (const n of nodes) {
      if (!m.has(n.brand)) m.set(n.brand, []);
      m.get(n.brand)!.push(n);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([title, list]) => ({
        title,
        servers: [...list].sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name)),
      }));
  }, [servers, activeLayout]);

  const counts = useMemo(() => {
    const hidden = new Set(activeLayout?.config.hiddenServerIds ?? []);
    const visible = hidden.size > 0 ? servers.filter((s) => !hidden.has(s.id)) : servers;
    return {
      online: visible.filter((s) => s.status === "online").length,
      offline: visible.filter((s) => s.status === "offline").length,
      total: visible.length,
    };
  }, [servers, activeLayout]);

  // measure the content box so the wall can be solved to fit it exactly;
  // direct measurement + resize listener works even where ResizeObserver
  // callbacks are throttled, RO additionally catches header reflows
  const contentRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const el = contentRef.current;
      if (!el) return;
      const { clientWidth: w, clientHeight: h } = el;
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (contentRef.current && ro) ro.observe(contentRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  const { bands, perRow, scale } = useMemo(
    () => fitWall(columns, box.w, box.h), [columns, box.w, box.h]);

  // Last-resort safety net: fitWall's math assumes tiles scale linearly, but
  // Tile.tsx has floor pixel sizes below which text stops shrinking. On an
  // extreme viewport (very short, very many tiles) that mismatch could still
  // overflow the box even at MIN_SCALE — measure the real rendered height
  // and shrink the whole grid uniformly rather than ever letting it clip.
  const fitRef = useRef<HTMLDivElement>(null);
  const [shrink, setShrink] = useState(1);
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el || box.h <= 0) return;
    // scrollHeight is the element's natural, untransformed layout height —
    // unaffected by the CSS transform:scale() already applied below — so it
    // can be measured and corrected in one pass. This used to reset shrink
    // to 1 and re-measure a frame later, which visibly snapped the whole
    // wall to full scale and back on every live update (every ~500ms):
    // most noticeable at viewport sizes needing a small correction, e.g.
    // 1920x1080, where it looked like constant jiggling.
    const natural = el.scrollHeight;
    setShrink(natural > box.h ? Math.max(0.4, box.h / natural) : 1);
  }, [bands, perRow, scale, box.h]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-6 w-6 shrink-0 object-contain" />
          <span className="font-head text-[16px] font-bold tracking-[0.02em]">Alfred</span>
          <span className="text-[13px] text-ink-3">Monitor wall</span>
          {!connected && <span className="text-[12px] text-crit">live updates disconnected</span>}
        </div>
        <div className="flex items-center gap-3 text-[13px]">
          <select
            className="border border-line-2 bg-panel px-2 py-1 text-[12px]"
            value={layoutId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setSearchParams(v ? { layout: v } : {});
            }}
          >
            <option value="">Auto (grouped by brand)</option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}{!l.mine ? ` (by ${l.owner})` : !l.is_public ? " (private)" : ""}
              </option>
            ))}
          </select>
          <button onClick={design} className="border border-line-2 px-2.5 py-1 text-ink-2 hover:text-ink">
            Design
          </button>
          <span className="text-ok font-medium">{counts.online} online</span>
          {counts.offline > 0 && <span className="text-crit font-medium">{counts.offline} offline</span>}
          <span className="font-mono text-ink-2">
            {new Date(now).toLocaleTimeString("en-GB")}
          </span>
          {!isFullscreen && (
            <button onClick={enterFullscreen}
              className="border border-line-2 px-2.5 py-1 text-ink-2 hover:text-ink">
              Full screen
            </button>
          )}
          <button onClick={exit} className="border border-line-2 px-2.5 py-1 text-ink-2 hover:text-ink">
            Exit
          </button>
          <button onClick={toggleMuted} title={muted ? "Alert sound is off — click to enable" : "Alert sound is on — click to mute"}
            className="border border-line-2 px-2.5 py-1 text-ink-2 hover:text-ink">
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      </div>

      {!muted && !audioArmed && (
        <button
          onClick={() => { unlockAudio(); setAudioArmed(true); }}
          className="mb-3 w-full border border-line-2 bg-panel px-3 py-2 text-left text-[12px] text-ink-2 hover:text-ink"
        >
          🔔 Click to enable alert sound for this session — browsers block audio until you interact with the page.
        </button>
      )}

      {screenFlash && <div className="screen-flash" />}

      <div ref={contentRef} className="min-h-0 flex-1 overflow-hidden">
        {servers.length === 0 ? (
          <div className="border border-line bg-panel p-12 text-center text-[14px] text-ink-3">
            No servers yet.
          </div>
        ) : (
          <div ref={fitRef} className="flex flex-col" style={{
            gap: BAND_GAP,
            transform: shrink < 1 ? `scale(${shrink})` : undefined,
            transformOrigin: "top left",
            width: shrink < 1 ? `${100 / shrink}%` : undefined,
          }}>
            {bands.map((band, bi) => (
              <div key={bi} className="grid items-start"
                style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`, gap: TILE_GAP }}>
                {band.map((col) => (
                  <div key={col.title} className="min-w-0">
                    <h2 className="mb-1.5 flex items-baseline gap-2 truncate text-[12px] font-semibold uppercase tracking-wider text-ink-2">
                      {col.title}
                      <span className="font-normal normal-case tracking-normal text-ink-3">
                        {col.servers.filter((s) => s.status === "online").length}/{col.servers.length} online
                      </span>
                    </h2>
                    <div className="flex flex-col" style={{ gap: TILE_GAP }}>
                      {col.servers.length === 0 && (col.panels?.length ?? 0) === 0 ? (
                        <div className="rounded-panel border border-dashed border-line p-4 text-center text-[12px] text-ink-3">
                          empty
                        </div>
                      ) : (
                        col.servers.map((node) => (
                          <Tile key={node.id} node={node} scale={scale}
                            onOpen={() => guardedNavigate(`/servers/${node.id}`)}
                            flashing={flashing.has(node.id) || node.children.some((c) => flashing.has(c.id))}
                            pulse={persistent.get(node.id)}
                            tileFlash={alertFlashing.get(node.id) === "critical" || alertFlashing.get(node.id) === "warning"} />
                        ))
                      )}
                    </div>
                    {(col.panels?.length ?? 0) > 0 && (
                      <div className="flex flex-col" style={{ gap: TILE_GAP, marginTop: TILE_GAP }}>
                        {col.panels!.map((p) => <PanelView key={p.id} panel={p} wallToken={wallToken} />)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingNav && (
        <WallLoginModal
          onCancel={() => setPendingNav(null)}
          onSuccess={() => {
            const dest = pendingNav;
            setPendingNav(null);
            setLoggedIn(true);
            if (dest) navigate(dest);
          }}
        />
      )}
    </div>
  );
}

function WallLoginModal({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/api/auth/login", { username, password });
      onSuccess();
    } catch (err: any) {
      setError(err.message || "sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form onSubmit={submit} className="w-80 border border-line bg-panel p-6">
        <div className="mb-1 text-center font-semibold tracking-[0.18em] text-[14px]">SIGN IN</div>
        <div className="mb-4 text-center text-[12px] text-ink-3">
          this Wall is open to view — sign in to leave it
        </div>
        <label className="mb-1 block text-[12px] text-ink-2">Username</label>
        <input className={inputCls} value={username} autoFocus
          onChange={(e) => setUsername(e.target.value)} />
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Password</label>
        <input className={inputCls} type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex gap-2">
          <Button type="button" onClick={onCancel} className="flex-1">Cancel</Button>
          <Button kind="primary" type="submit" disabled={busy} className="flex-1">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Tile({ node: s, onOpen, flashing, scale, pulse, tileFlash }: {
  node: ServerNode; onOpen: () => void; flashing: boolean; scale: number;
  pulse?: "critical" | "warning"; tileFlash?: boolean;
}) {
  const childIncidents = s.children.flatMap((c) => c.active_incidents);
  const offlineChild = s.children.find((c) => c.status === "offline");
  const critical = s.active_incidents.find((i) => i.severity === "critical")
    ?? childIncidents.find((i) => i.severity === "critical");
  const warning = s.active_incidents.find((i) => i.severity === "warning")
    ?? childIncidents.find((i) => i.severity === "warning");

  const status = rollupStatus(s);
  const dead = status === "offline";
  const bad = dead || !!critical;
  const warn = !bad && (!!warning || status === "pending");

  const tone = dead
    ? { border: "border-crit", bg: "bg-crit-bg", label: "OFFLINE", labelCls: "text-crit" }
    : critical
      ? { border: "border-crit", bg: "bg-crit-bg", label: "CRITICAL", labelCls: "text-crit" }
      : warn
        ? { border: "border-warn", bg: "bg-warn-bg", label: s.status === "pending" ? "PENDING" : "WARNING", labelCls: "text-warn" }
        : { border: "border-line", bg: "bg-panel", label: "ONLINE", labelCls: "text-ok" };

  const message = critical?.message || warning?.message || (offlineChild ? `${offlineChild.display_name} is offline` : undefined);

  // Type scales with the solved tile size, but never below a readable floor.
  // As tiles shrink, the least important lines drop first — a bad tile keeps
  // its message as long as possible.
  const px = (v: number, floor: number) => `${Math.max(floor, Math.round(v * scale))}px`;
  const showLastSeen = scale >= 0.85;
  const showDetail = scale >= 0.62 || !!message;
  const showBrand = scale >= 0.72;

  return (
    <button
      onClick={onOpen}
      style={{ padding: `${Math.max(3, Math.round(11 * scale))}px ${Math.max(5, Math.round(14 * scale))}px` }}
      className={`flex min-w-0 flex-col rounded-panel border-2 text-left ${tone.border} ${tone.bg} ${bad ? "tile-glow-crit" : warn ? "tile-glow-warn" : "hover:border-line-2"} ${flashing ? "offline-flash" : ""} ${pulse === "critical" ? "pulse-critical" : pulse === "warning" ? "pulse-warning" : ""} ${tileFlash ? "tile-flash" : ""}`}
    >
      <div className="flex items-center justify-between leading-snug" style={{ fontSize: px(11, 8) }}>
        <span className={`font-bold uppercase tracking-wider ${tone.labelCls}`}>
          {tone.label}
        </span>
        {showBrand && <span className="text-ink-3">{s.brand}</span>}
      </div>

      <div className="truncate font-semibold leading-tight" title={s.display_name}
        style={{ fontSize: px(20, 11), marginTop: px(6, 1) }}>
        {s.display_name}
      </div>

      {showDetail && (message ? (
        <div className={`truncate leading-snug ${tone.labelCls}`} title={message}
          style={{ fontSize: px(13, 10), marginTop: px(4, 1) }}>
          {message}
        </div>
      ) : (
        <div className="truncate leading-snug text-ink-2" style={{ fontSize: px(13, 10), marginTop: px(4, 1) }}>
          {s.kind === "probe" ? s.probe?.target ?? "probe"
            : s.os === "windows" ? "Windows" : s.os === "linux" ? "Linux" : "—"}
        </div>
      ))}

      <div className="flex items-center font-mono leading-snug text-ink-2"
        style={{ fontSize: px(13, 9), marginTop: px(10, 2), gap: px(16, 6) }}>
        {s.kind === "probe" ? (
          <>
            <span>
              {s.status === "online" && s.probe?.latency_ms != null
                ? `${Math.round(s.probe.latency_ms)} ms` : "PROBE"}
            </span>
            {s.probe?.cert_days_remaining != null && (
              <span>CERT {Math.floor(s.probe.cert_days_remaining)}d</span>
            )}
          </>
        ) : (
          <>
            <span>CPU {pct(s.cpu_pct, 0)}</span>
            <span>MEM {pct(s.mem_pct, 0)}</span>
          </>
        )}
      </div>

      {s.children.length > 0 && (
        <div className="flex flex-wrap items-center" style={{ marginTop: px(7, 3), gap: px(4, 3) }}>
          {s.children.map((c) => (
            <span key={c.id} title={`${c.display_name}: ${c.status}`}
              className={`inline-block rounded-full ${c.status === "offline" ? "bg-crit" : c.status === "pending" ? "bg-idle" : "bg-ok"}`}
              style={{ width: px(8, 6), height: px(8, 6) }} />
          ))}
        </div>
      )}

      {showLastSeen && (
        <div className="leading-snug text-ink-3" style={{ fontSize: px(12, 10), marginTop: px(7, 2) }}>
          last seen {relTime(s.last_seen)}
        </div>
      )}
    </button>
  );
}
