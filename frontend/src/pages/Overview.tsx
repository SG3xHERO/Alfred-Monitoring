import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post, del } from "../api";
import type { AlertMute, Server } from "../types";
import { relTime, pct } from "../format";
import { StatusDot, UptimeCell, Button, inputCls, SeverityTag, DeviceIcon, HostBadge } from "../components/bits";
import { MuteControl } from "../components/MuteControl";
import { useLive } from "../useLive";
import { useCanManage } from "../useMe";
import { useBrands, invalidateBrands } from "../useBrands";
import { CHECK_OPTIONS } from "../deviceChecks";
import { nestServers, rollupStatus, type ServerNode } from "../nesting";

export default function Overview() {
  const navigate = useNavigate();
  const [servers, setServers] = useState<Server[]>([]);
  const [mutes, setMutes] = useState<AlertMute[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const canManage = useCanManage();

  const load = useCallback(() => {
    get<Server[]>("/api/servers").then(setServers).catch(() => {});
  }, []);
  const loadMutes = useCallback(() => {
    get<AlertMute[]>("/api/mutes").then(setMutes).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEffect(loadMutes, [loadMutes]);
  const connected = useLive(["server", "incident"], load);
  const muteMap = useMemo(() => {
    const m = new Map<string, AlertMute>();
    for (const mu of mutes) m.set(`${mu.server_id} ${mu.rule_name} ${mu.check_key}`, mu);
    return m;
  }, [mutes]);

  // top-level nodes (a nested device's own row is folded into its parent's — see nesting.ts),
  // grouped by brand for section headers
  const groups = useMemo(() => {
    const nodes = nestServers(servers);
    const m = new Map<string, ServerNode[]>();
    for (const n of nodes) {
      if (!m.has(n.brand)) m.set(n.brand, []);
      m.get(n.brand)!.push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.display_name.localeCompare(b.display_name));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [servers]);

  const minDiskFree = (s: Server) => {
    const snapDisks: any[] = (s as any).disks || [];
    if (!snapDisks.length) return null;
    return Math.min(...snapDisks.map((d) => 100 - d.used_percent));
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-[15px] font-semibold">Servers</h1>
          <span className="text-[12px] text-ink-3">
            {servers.filter((s) => s.status === "online").length} of {servers.length} online
            {!connected && " · live updates disconnected"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button onClick={async () => {
            try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
            navigate("/wall");
          }}>
            Monitor wall
          </Button>
          {canManage && <Button onClick={() => setShowAdd(true)}>Add server</Button>}
        </div>
      </div>

      {groups.length === 0 && (
        <div className="border border-line bg-panel p-8 text-center text-[13px] text-ink-3">
          No servers yet. Click “Add server” to generate an API key and install an agent.
        </div>
      )}

      {groups.map(([brand, list]) => {
        const flat = list.flatMap((n) => [n, ...n.children]);
        return (
        <section key={brand} className="mb-6">
          <h2 className="mb-1 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wider text-ink-2">
            {brand}
            <span className="font-normal normal-case tracking-normal text-ink-3">
              {flat.filter((s) => s.status === "online").length}/{flat.length} online
            </span>
          </h2>
          <div className="rounded-panel border border-line bg-panel shadow-panel overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="w-6 px-3 py-1.5"></th>
                  <th className="py-1.5 pr-3">Server</th>
                  <th className="py-1.5 pr-3 text-right">Check</th>
                  <th className="py-1.5 pr-3 text-right">CPU</th>
                  <th className="py-1.5 pr-3 text-right">Mem</th>
                  <th className="py-1.5 pr-3 text-right">Disk free</th>
                  <th className="py-1.5 pr-3 text-right">24h</th>
                  <th className="py-1.5 pr-3 text-right">7d</th>
                  <th className="py-1.5 pr-3 text-right">30d</th>
                  <th className="py-1.5 pr-3 text-right">Last seen</th>
                  <th className="py-1.5 pr-3 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((node) => (
                  <ServerRow key={node.id} node={node} minDiskFree={minDiskFree(node)} onRemoved={load}
                    muteMap={muteMap} onMuteChange={loadMutes} canEdit={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
        );
      })}

      {showAdd && <AddServerModal onClose={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

/** A single Overview row — an agent/probe on its own, or a parent with nested devices rolled into it (see nesting.ts). */
function ServerRow({ node, minDiskFree, onRemoved, muteMap, onMuteChange, canEdit }: {
  node: ServerNode; minDiskFree: number | null; onRemoved: () => void;
  muteMap: Map<string, AlertMute>; onMuteChange: () => void; canEdit: boolean;
}) {
  const s = node;
  const status = rollupStatus(node);
  const alert = s.active_incidents[0];

  const remove = async (target: { id: number; display_name: string }) => {
    if (!confirm(`Remove ${target.display_name}? This deletes its metrics history and incidents too.`)) return;
    await del(`/api/servers/${target.id}`);
    onRemoved();
  };

  const isProbe = s.kind === "probe";

  return (
    <>
      <tr className="border-b border-line last:border-b-0 hover:bg-paper">
        <td className="px-3 py-2"><StatusDot status={status} /></td>
        <td className="py-2 pr-3">
          <span className="inline-flex items-center gap-1.5">
            <DeviceIcon node={s} />
            <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
              {s.display_name}
            </Link>
          </span>
          <span className="ml-2 text-[11px] text-ink-3">
            {isProbe ? `probe · ${s.probe?.type ?? ""}` : s.os === "windows" ? "win" : s.os === "linux" ? "linux" : ""}
            {s.tags.length > 0 && ` · ${s.tags.join(", ")}`}
          </span>
          {node.children.length > 0 && <span className="ml-2"><HostBadge tags={s.tags} brand={s.brand} /></span>}
          {node.children.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {node.children.map((c) => (
                <span key={c.id} className="device-chip group">
                  <StatusDot status={c.status} />
                  <Link to={`/servers/${c.id}`} className="hover:underline">{c.display_name}</Link>
                  {canEdit && (
                    <button onClick={() => remove(c)} className="text-ink-3 opacity-0 group-hover:opacity-100 hover:text-crit" title={`Remove ${c.display_name}`}>
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="py-2 pr-3 text-right font-mono text-[12px] text-ink-2">
          {isProbe && s.status === "online" && s.probe?.latency_ms != null
            ? `${Math.round(s.probe.latency_ms)} ms` : isProbe ? "—" : ""}
          {isProbe && s.probe?.cert_days_remaining != null && ` · cert ${Math.floor(s.probe.cert_days_remaining)}d`}
        </td>
        {isProbe ? (
          <td colSpan={3} className="py-2 pr-3 text-right font-mono text-[12px] text-ink-3">—</td>
        ) : (
          <>
            <td className="py-2 pr-3 text-right font-mono text-[12px]">{pct(s.cpu_pct, 0)}</td>
            <td className="py-2 pr-3 text-right font-mono text-[12px]">{pct(s.mem_pct, 0)}</td>
            <td className="py-2 pr-3 text-right font-mono text-[12px]">
              {minDiskFree == null ? "—" : pct(minDiskFree, 0)}
            </td>
          </>
        )}
        <td className="py-2 pr-3 text-right"><UptimeCell label="" value={s.uptime_24h} /></td>
        <td className="py-2 pr-3 text-right"><UptimeCell label="" value={s.uptime_7d} /></td>
        <td className="py-2 pr-3 text-right"><UptimeCell label="" value={s.uptime_30d} /></td>
        <td className="py-2 pr-3 text-right font-mono text-[12px] text-ink-2">
          {relTime(s.last_seen)}
        </td>
        <td className="py-2 pl-3 pr-3 text-right">
          {canEdit && (
            <button onClick={() => remove(s)} className="text-[11px] text-ink-3 hover:text-crit">
              remove
            </button>
          )}
        </td>
      </tr>
      {alert && (
        <tr className="border-b border-line last:border-b-0">
          <td></td>
          <td colSpan={9} className="pb-2 pr-3">
            <div className="flex items-center gap-2 text-[12px]">
              <SeverityTag severity={alert.severity} />
              <span className="text-ink-2">{alert.message}</span>
              <span className="text-ink-3">since {relTime(alert.started_at)}</span>
              {s.active_incidents.length > 1 && (
                <span className="text-ink-3">+{s.active_incidents.length - 1} more</span>
              )}
              <MuteControl
                target={{ rule_name: alert.rule_name, check_key: alert.check_key, server_id: s.id }}
                mute={muteMap.get(`${s.id} ${alert.rule_name} ${alert.check_key}`) ?? null}
                onChange={onMuteChange}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddServerModal({ onClose }: { onClose: () => void }) {
  const { names: brandNames, defaultBrand } = useBrands();
  const [deviceType, setDeviceType] = useState<"agent" | "nas">("agent");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [tags, setTags] = useState("");
  const [os, setOs] = useState<"linux" | "windows">("linux");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ id: number; api_key: string } | null>(null);
  const [nasDone, setNasDone] = useState(false);
  const [nasHost, setNasHost] = useState("");
  const [nasPort, setNasPort] = useState("5001");
  const [parentId, setParentId] = useState("");
  const [parentCandidates, setParentCandidates] = useState<Server[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    get<Server[]>("/api/servers").then((rows) =>
      setParentCandidates(rows.filter((r) => r.parent_id == null)),
    ).catch(() => {});
  }, []);

  const create = async () => {
    setError("");
    try {
      const r = await post<{ id: number; api_key: string }>("/api/servers", {
        display_name: name,
        brand: brand || defaultBrand,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        desired_config: os === "windows" && Object.values(checks).some(Boolean) ? checks : undefined,
        parent_id: parentId ? parseInt(parentId, 10) : undefined,
      });
      invalidateBrands();
      setResult(r);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const createNas = async () => {
    setError("");
    try {
      const groupKey = `nas-${crypto.randomUUID()}`;
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const b = brand || defaultBrand;
      const parent_id = parentId ? parseInt(parentId, 10) : undefined;
      await post("/api/probes", {
        name, brand: b, tags: tagList, group_key: groupKey, parent_id,
        type: "tcp", target: `${nasHost}:${nasPort}`, interval_seconds: 30,
      });
      await post("/api/probes", {
        name: `${name} — Backup`, brand: b, tags: tagList, group_key: groupKey, parent_id,
        type: "api", target: `https://${nasHost}:${nasPort}/webapi/entry.cgi`, interval_seconds: 60,
      });
      invalidateBrands();
      setNasDone(true);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const backendUrl = window.location.origin;
  const installCommand = result
    ? os === "linux"
      ? `curl -fsSL ${backendUrl}/agent/install.sh | sudo sh -s -- ${backendUrl} ${result.api_key}`
      : `iex "& { $(irm ${backendUrl}/agent/install.ps1) } -BackendUrl '${backendUrl}' -ApiKey '${result.api_key}'"`
    : "";

  if (deviceType === "nas") {
    return (
      <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
        <div className="w-[480px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="mb-4 text-[14px] font-semibold">Add NAS</h2>
          {!nasDone ? (
            <>
              <label className="mb-1 block text-[12px] text-ink-2">Device type</label>
              <div className="mb-3 flex gap-2">
                <Button className="flex-1" onClick={() => setDeviceType("agent")}>Windows/Linux agent</Button>
                <Button kind="primary" className="flex-1" onClick={() => setDeviceType("nas")}>Synology NAS</Button>
              </div>
              <label className="mb-1 block text-[12px] text-ink-2">Name</label>
              <input className={inputCls} value={name} autoFocus placeholder="NAS01"
                onChange={(e) => setName(e.target.value)} />
              <label className="mb-1 mt-3 block text-[12px] text-ink-2">Brand / group</label>
              <select className={inputCls} value={brand || defaultBrand} onChange={(e) => setBrand(e.target.value)}>
                {brandNames.map((b) => <option key={b}>{b}</option>)}
              </select>
              <label className="mb-1 mt-3 block text-[12px] text-ink-2">Tags (comma-separated)</label>
              <input className={inputCls} value={tags} placeholder="nas, backup"
                onChange={(e) => setTags(e.target.value)} />
              <label className="mb-1 mt-3 block text-[12px] text-ink-2">
                Nest under — hides this from the top-level Overview/Wall and rolls its status into the parent's
              </label>
              <select className={inputCls} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">— none, show at top level —</option>
                {parentCandidates.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
              </select>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Hostname / IP</label>
                  <input className={inputCls} value={nasHost} placeholder="192.168.1.30"
                    onChange={(e) => setNasHost(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">DSM port</label>
                  <input className={inputCls} value={nasPort} onChange={(e) => setNasPort(e.target.value)} />
                </div>
              </div>
              <p className="mt-3 text-[12px] text-ink-3">
                Creates two checks that show as one combined entry: a TCP reachability ping now,
                and a HyperBackup status check pre-filled with the host — you'll still need to finish its
                login/query details in the Probes page once you've captured the real API shape from DSM.
              </p>
              {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button kind="primary" disabled={!name.trim() || !nasHost.trim()} onClick={createNas}>
                  Create checks
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-[13px]">
                Created. The reachability check is live now — open <strong>Probes</strong> to finish
                configuring the backup-status check's login and query details.
              </p>
              <div className="flex justify-end">
                <Button kind="primary" onClick={onClose}>Done</Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}>
      <div className="w-[480px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-[14px] font-semibold">Add server</h2>
        {!result ? (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">Device type</label>
            <div className="mb-3 flex gap-2">
              <Button kind="primary" className="flex-1" onClick={() => setDeviceType("agent")}>Windows/Linux agent</Button>
              <Button className="flex-1" onClick={() => setDeviceType("nas")}>Synology NAS</Button>
            </div>
            <label className="mb-1 block text-[12px] text-ink-2">Display name</label>
            <input className={inputCls} value={name} placeholder="SERVER01"
              onChange={(e) => setName(e.target.value)} />
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Brand / group</label>
            <select className={inputCls} value={brand || defaultBrand} onChange={(e) => setBrand(e.target.value)}>
              {brandNames.map((b) => <option key={b}>{b}</option>)}
            </select>
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Tags (comma-separated)</label>
            <input className={inputCls} value={tags} placeholder="production, database"
              onChange={(e) => setTags(e.target.value)} />
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">
              Nest under — hides this from the top-level Overview/Wall and rolls its status into the parent's
            </label>
            <select className={inputCls} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— none, show at top level —</option>
              {parentCandidates.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Target OS</label>
            <div className="flex gap-2">
              <Button kind={os === "linux" ? "primary" : "default"} className="flex-1"
                onClick={() => setOs("linux")}>Linux</Button>
              <Button kind={os === "windows" ? "primary" : "default"} className="flex-1"
                onClick={() => setOs("windows")}>Windows</Button>
            </div>
            {os === "windows" && (
              <>
                <label className="mb-1 mt-3 block text-[12px] text-ink-2">What should this agent watch?</label>
                <div className="border border-line-2">
                  {CHECK_OPTIONS.map((opt) => (
                    <label key={opt.key} className="flex items-start gap-2 border-b border-line-2 p-2 last:border-b-0">
                      <input type="checkbox" className="mt-0.5" checked={!!checks[opt.key]}
                        onChange={(e) => setChecks((c) => ({ ...c, [opt.key]: e.target.checked }))} />
                      <span>
                        <span className="block text-[12px]">{opt.label}</span>
                        <span className="block text-[11px] text-ink-3">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-ink-3">
                  Bakes these into the agent's config automatically — nothing to hand-edit after install.
                </p>
              </>
            )}
            {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button kind="primary" disabled={!name.trim()} onClick={create}>Create &amp; get key</Button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-[13px]">
              API key created. <strong>It is shown only once</strong>. Run this single command in
              {os === "linux" ? " a root/sudo shell" : " an elevated PowerShell"} on the target server —
              it downloads the agent, installs it as a service, and configures it. Nothing to download by hand.
            </p>
            <div className="mb-2 flex gap-2">
              <Button kind={os === "linux" ? "primary" : "default"} className="flex-1"
                onClick={() => setOs("linux")}>Linux</Button>
              <Button kind={os === "windows" ? "primary" : "default"} className="flex-1"
                onClick={() => setOs("windows")}>Windows</Button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all border border-line bg-paper p-3 font-mono text-[12px] leading-relaxed">
              {installCommand}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => navigator.clipboard.writeText(installCommand)}>Copy command</Button>
              <Button kind="primary" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
