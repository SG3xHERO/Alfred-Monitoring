import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { get, patch, post, del } from "../api";
import type { AlertMute, Annotation, Server, MetricPoint, Incident, SqlSnapshot, NestedDeviceSummary } from "../types";
import { relTime, ts, pct, gb, bps, duration, ms, num } from "../format";
import { StatusDot, Panel, Button, inputCls, SeverityTag, UptimeBar } from "../components/bits";
import { MuteControl } from "../components/MuteControl";
import { bucketAnnotations, annotationLines, type BucketedAnnotation } from "../components/annotations";
import { useLive } from "../useLive";
import { useCanManage } from "../useMe";
import { CHECK_OPTIONS } from "../deviceChecks";
import { useBrands, invalidateBrands } from "../useBrands";

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;

export default function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState<Server | null>(null);
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [mutes, setMutes] = useState<AlertMute[]>([]);
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [editing, setEditing] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [noteAt, setNoteAt] = useState<string | null>(null); // ISO time → modal open
  const [snapshot, setSnapshot] = useState<SqlSnapshot | null>(null);
  const canManage = useCanManage();

  const load = useCallback(() => {
    get<Server>(`/api/servers/${id}`).then(setServer).catch(() => {});
    get<Incident[]>(`/api/servers/${id}/incidents`).then(setIncidents).catch(() => {});
  }, [id]);
  const loadSnapshot = useCallback(() => {
    get<SqlSnapshot>(`/api/servers/${id}/snapshots/latest`).then(setSnapshot).catch(() => setSnapshot(null));
  }, [id]);
  const loadMutes = useCallback(() => {
    get<AlertMute[]>("/api/mutes").then((all) => setMutes(all.filter((m) => m.server_id === Number(id)))).catch(() => {});
  }, [id]);
  const loadMetrics = useCallback(() => {
    get<MetricPoint[]>(`/api/servers/${id}/metrics?range=${range}`)
      .then(setMetrics).catch(() => {});
  }, [id, range]);
  const loadAnnotations = useCallback(() => {
    get<Annotation[]>(`/api/annotations?target=${id}&range=${range}`)
      .then(setAnnotations).catch(() => {});
  }, [id, range]);
  useEffect(loadAnnotations, [loadAnnotations]);

  useEffect(load, [load]);
  useEffect(loadMetrics, [loadMetrics]);
  useEffect(loadMutes, [loadMutes]);
  useEffect(loadSnapshot, [loadSnapshot]);
  useLive(["server", "incident"], () => { load(); loadMetrics(); }, 5000);
  useLive(["sql_snapshot"], loadSnapshot, 1000);

  if (!server) return <div className="text-[13px] text-ink-3">Loading…</div>;
  const snap = server.last_snapshot || {};

  const chartData = metrics.map((m) => ({
    ...m,
    t: new Date(m.bucket).toLocaleString("en-GB", {
      ...(range === "7d" || range === "30d"
        ? { day: "2-digit", month: "short" }
        : { hour: "2-digit", minute: "2-digit" }),
    }),
  }));
  const chartAnnotations = bucketAnnotations(annotations, chartData);
  // click a chart point → note at that time; the header button → note "now"
  const pickTime = canManage ? (label: string | undefined) => {
    const hit = chartData.find((d) => d.t === label);
    setNoteAt(hit ? hit.bucket : new Date().toISOString());
  } : undefined;

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <button
            onClick={() => navigate(-1)}
            className="mb-2 flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink"
          >
            ← Back
          </button>
          <div className="flex items-center gap-2">
            <StatusDot status={server.status} />
            <h1 className="text-[16px] font-semibold">{server.display_name}</h1>
            <span className="text-[12px] text-ink-3">{server.brand}</span>
          </div>
          {server.parent_id != null && (
            <div className="mt-0.5 text-[12px] text-ink-3">
              Nested under <Link to={`/servers/${server.parent_id}`} className="hover:underline">{server.parent_display_name}</Link>
            </div>
          )}
          <div className="mt-1 text-[12px] text-ink-2">
            {server.hostname && <span className="font-mono">{server.hostname}</span>}
            {server.ip_address && <span className="font-mono"> · {server.ip_address}</span>}
            {server.platform && <span> · {server.platform}</span>}
            <span> · last seen {relTime(server.last_seen)}</span>
            {snap.uptime_seconds != null && (
              <span> · up {(snap.uptime_seconds / 86400).toFixed(1)}d</span>
            )}
          </div>
          {server.kind === "agent" && (
            <AgentVersionRow server={server} canManage={canManage} onUpdated={load} />
          )}
        </div>
        <div className="flex gap-2">
          {canManage && <Button onClick={() => setNoteAt(new Date().toISOString())}>Add note</Button>}
          {canManage && <Button onClick={() => setEditing(!editing)}>Edit</Button>}
        </div>
      </div>

      {noteAt && (
        <AnnotationModal
          server={server}
          at={noteAt}
          annotations={annotations}
          onClose={() => setNoteAt(null)}
          onChanged={() => { loadAnnotations(); }}
        />
      )}

      {editing && <EditPanel server={server} onDone={() => { setEditing(false); load(); }}
        onDelete={async () => {
          if (confirm(`Delete ${server.display_name} and all its history?`)) {
            await del(`/api/servers/${server.id}`);
            navigate("/");
          }
        }} />}

      <div className="mb-4 grid grid-cols-4 gap-3">
        {([["24h", server.uptime_24h], ["7d", server.uptime_7d],
          ["30d", server.uptime_30d], ["90d", server.uptime_90d]] as const).map(([label, v]) => (
          <div key={label} className="border border-line bg-panel p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-wider text-ink-3">{label} uptime</span>
              <span className="font-mono text-[13px]">{v == null ? "—" : `${v.toFixed(2)}%`}</span>
            </div>
            <div className="mt-2"><UptimeBar value={v} /></div>
          </div>
        ))}
      </div>

      {(server.nested_devices?.length ?? 0) > 0 && <NestedDevicesPanel devices={server.nested_devices!} />}

      <div className="mb-2 flex gap-1">
        {RANGES.map((r) => (
          <button key={r} onClick={() => setRange(r)}
            className={`px-2.5 py-1 text-[12px] border ${range === r
              ? "border-ink bg-ink text-ink-contrast"
              : "border-line-2 text-ink-2 hover:text-ink"}`}>
            {r}
          </button>
        ))}
      </div>

      {server.kind === "agent" ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Chart title="CPU %" data={chartData} lines={[["cpu_pct", "var(--color-ink)"]]} domain={[0, 100]}
              seed={{ metric: "cpu.percent", target: server.display_name }}
              annotations={chartAnnotations} onPickTime={pickTime} />
            <Chart title="Memory %" data={chartData}
              lines={[["mem_pct", "var(--color-ink)"], ["swap_pct", "var(--color-ink-3)"]]} domain={[0, 100]}
              seed={{ metric: "mem.percent", target: server.display_name }}
              annotations={chartAnnotations} onPickTime={pickTime} />
            <Chart title="Lowest disk free %" data={chartData}
              lines={[["disk_min_free_pct", "var(--color-ink)"]]} domain={[0, 100]}
              seed={{ metric: "disk.min_free_pct", target: server.display_name }}
              annotations={chartAnnotations} onPickTime={pickTime} />
            <Chart title="Network B/s" data={chartData}
              lines={[["net_rx_bps", "var(--color-ink)"], ["net_tx_bps", "var(--color-ink-3)"]]} fmt={bps}
              seed={{ metric: "net.rx_bps", target: server.display_name }}
              annotations={chartAnnotations} onPickTime={pickTime} />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <Panel title="Disks">
              <table className="w-full text-[13px]">
                <tbody>
                  {(snap.disks || []).map((d: any) => (
                    <tr key={d.mount} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-[12px]">{d.mount}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-[12px]">
                        {pct(d.used_percent, 0)} used
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-[12px] text-ink-2">
                        {gb(d.free)} free of {gb(d.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {server.os === "windows" ? (
              server.desired_config?.signed_in_users_panel && (
                <Panel title="Signed-in users">
                  {(snap.sessions || []).length === 0
                    ? <Empty text="No interactive sessions" />
                    : <ul className="text-[13px]">
                        {(snap.sessions || []).map((s: any, i: number) => (
                          <li key={i} className="flex justify-between border-b border-line px-3 py-1.5 last:border-b-0">
                            <span className="font-mono text-[12px]">{s.user}</span>
                            <span className="text-[12px] text-ink-3">{s.state}</span>
                          </li>
                        ))}
                      </ul>}
                </Panel>
              )
            ) : (
              <Panel title="Failed systemd units">
                {(snap.systemd_failed_units || []).length === 0
                  ? <Empty text="No failed units" />
                  : <ul className="text-[13px]">
                      {(snap.systemd_failed_units || []).map((u: string) => (
                        <li key={u} className="border-b border-line px-3 py-1.5 font-mono text-[12px] text-crit last:border-b-0">{u}</li>
                      ))}
                    </ul>}
              </Panel>
            )}

            <Panel title="Watched services">
              {(snap.services || []).length === 0
                ? <Empty text="None configured — add to the agent config" />
                : <ul className="text-[13px]">
                    {(snap.services || []).map((s: any) => (
                      <li key={s.name} className="flex justify-between border-b border-line px-3 py-1.5 last:border-b-0">
                        <span className="font-mono text-[12px]">{s.name}</span>
                        <span className={`text-[12px] ${s.running ? "text-ok" : "text-crit"}`}>
                          {s.running ? "running" : s.detail || "stopped"}
                        </span>
                      </li>
                    ))}
                  </ul>}
            </Panel>

            <Panel title="Watched processes">
              {(snap.processes || []).length === 0
                ? <Empty text="None configured — add to the agent config" />
                : <ul className="text-[13px]">
                    {(snap.processes || []).map((p: any) => (
                      <li key={p.name} className="flex justify-between border-b border-line px-3 py-1.5 last:border-b-0">
                        <span className="font-mono text-[12px]">{p.name}</span>
                        <span className={`text-[12px] ${p.running ? "text-ok" : "text-crit"}`}>
                          {p.running ? "running" : "not running"}
                        </span>
                      </li>
                    ))}
                  </ul>}
            </Panel>
          </div>

          {server.os === "windows" && server.desired_config?.sql_monitoring && (
            <SqlSnapshotPanel serverId={server.id} snapshot={snapshot} canManage={canManage} onRequested={loadSnapshot} />
          )}

          {server.os === "windows" && (snap.event_errors || []).length > 0 && (
            <Panel title="Recent event log errors">
              <ul>
                {(snap.event_errors || []).slice(0, 10).map((e: any, i: number) => (
                  <li key={i} className="border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
                    <span className="font-mono text-ink-3">{ts(e.time)}</span>
                    <span className={`mx-2 ${e.level === "Critical" ? "text-crit" : "text-warn"}`}>{e.level}</span>
                    <span className="text-ink-2">{e.source} #{e.id}</span>
                    <div className="mt-0.5 text-ink-2">{e.message?.slice(0, 200)}</div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      ) : (
        <ProbeDetail server={server} range={range} annotations={chartAnnotations} onPickTime={pickTime} />
      )}

      <div className="mt-4">
        <Panel title="Incident history">
          {incidents.length === 0 ? <Empty text="No incidents recorded" /> : (
            <table className="w-full text-[13px]">
              <tbody>
                {incidents.map((i) => {
                  const mute = mutes.find((m) => m.rule_name === i.rule_name && m.check_key === i.check_key) ?? null;
                  return (
                    <tr key={i.id} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-1.5 w-20"><SeverityTag severity={i.severity} /></td>
                      <td className="py-1.5 pr-3">{i.message}
                        {i.suppressed && <span className="ml-2 text-[11px] text-ink-3">(suppressed)</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-[12px] text-ink-2 whitespace-nowrap">
                        {ts(i.started_at)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-[12px] whitespace-nowrap">
                        {i.resolved_at
                          ? <span className="text-ok">resolved after {duration(i.started_at, i.resolved_at)}</span>
                          : <span className="text-crit">ongoing ({duration(i.started_at)})</span>}
                        {!i.resolved_at && server && (
                          <div className="mt-0.5">
                            <MuteControl
                              target={{ rule_name: i.rule_name, check_key: i.check_key, server_id: server.id }}
                              mute={mute}
                              onChange={loadMutes}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** Devices nested under this one (a HyperV host's guest VMs, sibling IPs on a ping check, etc.) — see nesting.ts for the Overview/Wall side. */
function NestedDevicesPanel({ devices }: { devices: NestedDeviceSummary[] }) {
  return (
    <div className="mb-4">
      <Panel title="Nested devices">
        <ul className="text-[13px]">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between border-b border-line px-3 py-1.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <StatusDot status={d.status} />
                <Link to={`/servers/${d.id}`} className="hover:underline">{d.display_name}</Link>
                <span className="text-[11px] text-ink-3">{d.kind === "probe" ? `probe · ${d.probe?.type ?? ""}` : d.kind}</span>
              </div>
              <span className="text-[12px] text-ink-3">{relTime(d.last_seen)}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

interface ProbeResultPoint { bucket: string; uptime_pct: number | null; latency_ms: number | null; value: number | null }

/**
 * The probe-kind equivalent of the agent's CPU/Mem/Disk charts above — a
 * basic graph + last-check summary so probes (including the ported
 * Directory/Ping/Data checks) aren't a dead end on click, just a lighter
 * view than agents get since there's no OS-level metrics to show.
 */
function ProbeDetail({ server, range, annotations, onPickTime }: {
  server: Server; range: string;
  annotations?: BucketedAnnotation[]; onPickTime?: (label: string | undefined) => void;
}) {
  const [points, setPoints] = useState<ProbeResultPoint[]>([]);

  useEffect(() => {
    get<ProbeResultPoint[]>(`/api/servers/${server.id}/probe-results?range=${range}`)
      .then(setPoints).catch(() => {});
  }, [server.id, range]);

  const chartData = points.map((p) => ({
    ...p,
    t: new Date(p.bucket).toLocaleString("en-GB", {
      ...(range === "7d" || range === "30d"
        ? { day: "2-digit", month: "short" }
        : { hour: "2-digit", minute: "2-digit" }),
    }),
  }));
  const probe = server.probe;
  const hasValue = points.some((p) => p.value != null);

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Panel title="Check">
          <table className="w-full text-[13px]">
            <tbody>
              <tr className="border-b border-line"><td className="px-3 py-1.5 text-ink-3">Type</td><td className="py-1.5 pr-3 font-mono uppercase">{server.probe_type ?? probe?.type ?? "—"}</td></tr>
              <tr className="border-b border-line"><td className="px-3 py-1.5 text-ink-3">Target</td><td className="py-1.5 pr-3 font-mono">{server.probe_target ?? probe?.target ?? "—"}</td></tr>
              {server.probe_file_mask && (
                <tr className="border-b border-line"><td className="px-3 py-1.5 text-ink-3">File mask</td><td className="py-1.5 pr-3 font-mono">{server.probe_file_mask}</td></tr>
              )}
              {server.probe_procedure_name && (
                <tr className="border-b border-line"><td className="px-3 py-1.5 text-ink-3">Procedure</td><td className="py-1.5 pr-3 font-mono">{server.probe_procedure_name}</td></tr>
              )}
              {(server.probe_warning_threshold != null || server.probe_severe_threshold != null) && (
                <tr><td className="px-3 py-1.5 text-ink-3">Thresholds</td>
                  <td className="py-1.5 pr-3 font-mono">warning {server.probe_warning_threshold ?? "—"} · severe {server.probe_severe_threshold ?? "—"}</td></tr>
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="Last result">
          {probe?.error ? (
            <div className="p-3 text-[13px] text-crit">{probe.error}</div>
          ) : (
            <div className="p-3 text-[13px] text-ink-2">
              {probe?.checked_at ? `Checked ${ts(probe.checked_at)}` : "No result yet"}
              {probe?.latency_ms != null && <div className="mt-1">Latency: {ms(probe.latency_ms)}</div>}
              {probe?.json_value != null && <div className="mt-1">Value: {probe.json_value}</div>}
            </div>
          )}
        </Panel>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Chart title="Uptime %" data={chartData} lines={[["uptime_pct", "var(--color-ink)"]]} domain={[0, 100]}
          annotations={annotations} onPickTime={onPickTime} />
        {hasValue ? (
          <Chart title="Value (count)" data={chartData} lines={[["value", "var(--color-ink)"]]}
            annotations={annotations} onPickTime={onPickTime} />
        ) : (
          <Chart title="Latency (ms)" data={chartData} lines={[["latency_ms", "var(--color-ink)"]]} fmt={ms}
            annotations={annotations} onPickTime={onPickTime} />
        )}
      </div>
    </>
  );
}

function AgentVersionRow({ server, canManage, onUpdated }: {
  server: Server; canManage: boolean; onUpdated: () => void;
}) {
  const [latest, setLatest] = useState<{ version: string; changelog: string | null } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    get<{ versions: string[]; changelog: string | null }>("/api/agent-releases")
      .then((r) => setLatest(r.versions[0] ? { version: r.versions[0], changelog: r.changelog } : null))
      .catch(() => {});
  }, [canManage]);

  const hasUpdate = canManage && !!latest && latest.version !== server.agent_version
    && !server.update_requested_version;

  const requestUpdate = async () => {
    setRequesting(true);
    try {
      await post(`/api/servers/${server.id}/request-update`);
      onUpdated();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
      <span className="border border-line-2 px-1.5 py-0.5 font-mono text-ink-2">
        Agent v{server.agent_version || "unknown"}
      </span>
      {server.update_requested_version ? (
        <span className="text-ink-3">update to v{server.update_requested_version} pending…</span>
      ) : hasUpdate ? (
        <>
          <Button kind="info" disabled={requesting} onClick={requestUpdate}>
            {requesting ? "Requesting…" : `Update v${latest!.version}`}
          </Button>
          {latest!.changelog && (
            <button
              onClick={() => setShowNotes((s) => !s)}
              className="text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              {showNotes ? "hide what's new" : "what's new?"}
            </button>
          )}
        </>
      ) : null}
      {showNotes && latest?.changelog && (
        <pre className="mt-1 w-full basis-full whitespace-pre-wrap border border-line bg-paper p-2 font-sans text-[12px] text-ink-2">
          {latest.changelog}
        </pre>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-3 text-[12px] text-ink-3">{text}</div>;
}

function SqlSnapshotPanel({ serverId, snapshot, canManage, onRequested }: {
  serverId: number; snapshot: SqlSnapshot | null; canManage: boolean; onRequested: () => void;
}) {
  const [requesting, setRequesting] = useState(false);

  const requestSnapshot = async () => {
    setRequesting(true);
    try {
      await post(`/api/servers/${serverId}/snapshot`);
      onRequested();
    } finally {
      setRequesting(false);
    }
  };

  const triggerLabel = (by: string | null) => {
    if (!by) return null;
    if (by.startsWith("rule:")) return `auto — ${by.slice(5)} fired`;
    if (by.startsWith("user:")) return `manual — ${by.slice(5)}`;
    return by;
  };

  const status = (() => {
    if (!snapshot) return null;
    if (snapshot.status === "requested") return <span className="text-ink-2">capturing…</span>;
    if (snapshot.status === "error") return <span className="text-crit">failed: {snapshot.error}</span>;
    return (
      <span className="text-ink-3">
        captured {relTime(snapshot.captured_at)}
        {snapshot.requested_by && <span className="text-ink-3"> · {triggerLabel(snapshot.requested_by)}</span>}
      </span>
    );
  })();

  const th = "px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3";

  return (
    <div className="mt-4">
      <Panel
        title="SQL diagnostic snapshot"
        right={
          <div className="flex items-center gap-3">
            {status}
            {canManage && (
              <button
                onClick={requestSnapshot}
                disabled={requesting}
                className="px-2.5 py-1 text-[12px] border border-line-2 text-ink-2 hover:text-ink disabled:opacity-50"
              >
                {requesting ? "Requesting…" : "Snapshot now"}
              </button>
            )}
          </div>
        }
      >
        {!snapshot ? (
          <Empty text="No snapshot captured yet" />
        ) : snapshot.status === "requested" ? (
          <Empty text="Capturing top queries, blocking chains, and job status…" />
        ) : snapshot.status === "error" ? (
          <Empty text={`Capture failed: ${snapshot.error}`} />
        ) : (
          <div className="grid grid-cols-1 gap-4 p-3">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">
                Top queries by total CPU
              </div>
              {!snapshot.top_queries?.length ? <Empty text="None" /> : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>DB</th>
                      <th className={th}>Query</th>
                      <th className={`${th} text-right`}>Avg / call</th>
                      <th className={`${th} text-right`}>Total CPU</th>
                      <th className={`${th} text-right`}>Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.top_queries.map((q, i) => (
                      <tr key={i} className="border-b border-line last:border-b-0 align-top">
                        <td className="py-1.5 pr-3 pl-3 font-mono text-ink-3 whitespace-nowrap">{q.DatabaseName}</td>
                        <td className="py-1.5 pr-3 font-mono text-ink-2" title={q.QueryText}>
                          {q.QueryText?.slice(0, 140)}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono font-semibold whitespace-nowrap">{ms(q.AvgCpuMs)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-ink-3 whitespace-nowrap">{ms(q.TotalCpuMs)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-ink-3 whitespace-nowrap">{num(q.ExecutionCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">Blocking chains</div>
              {!snapshot.blocking?.length ? <Empty text="None" /> : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>Blocking → blocked</th>
                      <th className={th}>Wait type</th>
                      <th className={`${th} text-right`}>Wait time</th>
                      <th className={th}>Blocked query</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.blocking.map((b, i) => (
                      <tr key={i} className="border-b border-line last:border-b-0 align-top">
                        <td className="py-1.5 pr-3 pl-3 font-mono whitespace-nowrap">
                          {b.BlockingSessionID} → {b.BlockedSessionID}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-ink-3 whitespace-nowrap">{b.WaitType}</td>
                        <td className="py-1.5 pr-3 text-right font-mono font-semibold whitespace-nowrap">{ms(b.WaitTimeMs)}</td>
                        <td className="py-1.5 pr-3 font-mono text-ink-2" title={b.BlockedQueryText}>
                          {b.BlockedQueryText?.slice(0, 100)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">SQL Agent jobs</div>
              {!snapshot.jobs?.length ? <Empty text="None" /> : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>Job</th>
                      <th className={th}>Status</th>
                      <th className={th}>Last outcome</th>
                      <th className={th}>Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.jobs.map((j, i) => (
                      <tr key={i} className="border-b border-line last:border-b-0">
                        <td className="py-1.5 pr-3 pl-3 font-mono">{j.JobName}</td>
                        <td className={`py-1.5 pr-3 whitespace-nowrap ${j.Status === "Executing" ? "text-ok" : "text-ink-3"}`}>
                          {j.Status}
                        </td>
                        <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">{j.LastRunOutcome}</td>
                        <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">{j.LastRunDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Chart({ title, data, lines, domain, fmt, seed, annotations, onPickTime }: {
  title: string;
  data: any[];
  lines: Array<[string, string]>;
  domain?: [number, number];
  fmt?: (v: number) => string;
  seed?: { metric: string; target: string };
  annotations?: BucketedAnnotation[];
  onPickTime?: (label: string | undefined) => void;
}) {
  return (
    <Panel title={title} right={seed && (
      <Link
        to={`/dashboards/new?metric=${encodeURIComponent(seed.metric)}&target=${encodeURIComponent(seed.target)}`}
        className="text-[11px] text-ink-3 hover:text-ink"
        title="Start a dashboard panel from this chart"
      >
        + dashboard
      </Link>
    )}>
      <div className="h-44 px-1 py-2" title={onPickTime ? "Click a point in time to add a note" : undefined}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            onClick={onPickTime ? (e: any) => onPickTime(e?.activeLabel) : undefined}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--color-ink-3)" }}
              tickLine={false} axisLine={{ stroke: "var(--color-line)" }} minTickGap={40} />
            <YAxis tick={{ fontSize: 10, fill: "var(--color-ink-3)" }} tickLine={false}
              axisLine={false} domain={domain ?? ["auto", "auto"]} width={fmt ? 70 : 34}
              tickFormatter={fmt ? (v) => fmt(v) : undefined} />
            <Tooltip
              contentStyle={{
                fontSize: 12, borderRadius: 0,
                border: "1px solid var(--color-line)",
                background: "var(--color-panel)", color: "var(--color-ink)",
              }}
              formatter={(v: any) => (fmt ? fmt(v) : `${v}%`)} />
            {annotations && annotationLines(annotations)}
            {lines.map(([key, color]) => (
              <Line key={key} type="monotone" dataKey={key} stroke={color}
                strokeWidth={1.25} dot={false} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/** Local-time value for a datetime-local input. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AnnotationModal({ server, at, annotations, onClose, onChanged }: {
  server: Server; at: string; annotations: Annotation[];
  onClose: () => void; onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState(toLocalInput(at));
  const [scope, setScope] = useState<"server" | "brand" | "all">("server");
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    try {
      await post("/api/annotations", {
        target: scope === "server" ? String(server.id) : scope === "brand" ? `group:${server.brand}` : "*",
        time: new Date(when).toISOString(),
        text,
      });
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (id: number) => {
    await del(`/api/annotations/${id}`);
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[440px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-[14px] font-semibold">Add annotation</h2>
        <p className="mb-3 text-[12px] text-ink-3">
          A note pinned to a moment in time — “deployed v2.3”, “swapped RAM”. Shown as a thin
          marker on the charts.
        </p>

        <label className="mb-1 block text-[12px] text-ink-2">Note</label>
        <input className={inputCls} value={text} autoFocus placeholder="deployed v2.3"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save(); }} />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">When</label>
            <input className={inputCls} type="datetime-local" value={when}
              onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">Applies to</label>
            <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value as any)}>
              <option value="server">{server.display_name}</option>
              <option value="brand">group: {server.brand}</option>
              <option value="all">all servers</option>
            </select>
          </div>
        </div>

        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!text.trim()} onClick={save}>Add</Button>
        </div>

        {annotations.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">In this range</div>
            <ul className="max-h-40 overflow-y-auto text-[12px]">
              {annotations.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2 border-b border-line py-1 last:border-b-0">
                  <span className="font-mono text-[11px] text-ink-3 whitespace-nowrap">{ts(a.time)}</span>
                  <span className="min-w-0 flex-1 truncate" title={a.text}>{a.text}</span>
                  {a.created_by && <span className="text-[11px] text-ink-3">{a.created_by}</span>}
                  <button className="text-ink-3 hover:text-crit" title="Delete annotation"
                    onClick={() => remove(a.id)}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function EditPanel({ server, onDone, onDelete }: {
  server: Server; onDone: () => void; onDelete: () => void;
}) {
  const { names: brandNames } = useBrands();
  const [name, setName] = useState(server.display_name);
  const [brand, setBrand] = useState(server.brand);
  const [tags, setTags] = useState(server.tags.join(", "));
  const [checks, setChecks] = useState<Record<string, boolean>>(server.desired_config || {});
  const [parentId, setParentId] = useState(server.parent_id != null ? String(server.parent_id) : "");
  const [parentCandidates, setParentCandidates] = useState<Server[]>([]);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    get<Server[]>("/api/servers").then((rows) =>
      setParentCandidates(rows.filter((r) => r.id !== server.id && r.parent_id == null)),
    ).catch(() => {});
  }, [server.id]);

  return (
    <div className="mb-4 border border-line bg-panel p-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-[12px] text-ink-2">Display name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-[12px] text-ink-2">Brand / group</label>
          <input className={inputCls} value={brand} list="brand-options"
            onChange={(e) => setBrand(e.target.value)} />
          <datalist id="brand-options">
            {brandNames.map((b) => <option key={b} value={b} />)}
          </datalist>
        </div>
        <div>
          <label className="mb-1 block text-[12px] text-ink-2">Tags</label>
          <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-[12px] text-ink-2">
          Nest under — hides this from the top-level Overview/Wall and rolls its status into the parent's
        </label>
        <select className={inputCls} value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">— none, show at top level —</option>
          {parentCandidates.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
        </select>
      </div>
      {server.kind === "agent" && server.os === "windows" && (
        <div className="mt-3 border-t border-line pt-3">
          <label className="mb-1 block text-[12px] text-ink-2">
            What should this agent watch? — pushed to the agent remotely, applied within one poll
          </label>
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
        </div>
      )}
      {newKey && (
        <div className="mt-3 border border-line bg-paper p-2 font-mono text-[12px]">
          New API key (shown once): {newKey}
        </div>
      )}
      <div className="mt-3 flex justify-between">
        <div className="flex gap-2">
          <Button onClick={async () => {
            const r = await post<{ api_key: string }>(`/api/servers/${server.id}/rotate-key`);
            setNewKey(r.api_key);
          }}>Rotate API key</Button>
          <Button kind="danger" onClick={onDelete}>Delete server</Button>
        </div>
        <Button kind="primary" onClick={async () => {
          await patch(`/api/servers/${server.id}`, {
            display_name: name, brand,
            tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
            parent_id: parentId ? parseInt(parentId, 10) : null,
            ...(server.kind === "agent" && server.os === "windows" ? { desired_config: checks } : {}),
          });
          invalidateBrands();
          onDone();
        }}>Save</Button>
      </div>
    </div>
  );
}
