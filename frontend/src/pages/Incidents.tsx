import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { get } from "../api";
import type { AlertMute, Incident, Server } from "../types";
import { ts, duration } from "../format";
import { SeverityTag, inputCls } from "../components/bits";
import { MuteControl } from "../components/MuteControl";
import { useLive } from "../useLive";

export default function Incidents() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [mutes, setMutes] = useState<AlertMute[]>([]);
  const [serverId, setServerId] = useState("");
  const [severity, setSeverity] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (serverId) params.set("server_id", serverId);
    if (severity) params.set("severity", severity);
    if (openOnly) params.set("open", "true");
    get<Incident[]>(`/api/incidents?${params}`).then(setIncidents).catch(() => {});
  }, [serverId, severity, openOnly]);
  const loadMutes = useCallback(() => {
    get<AlertMute[]>("/api/mutes").then(setMutes).catch(() => {});
  }, []);

  useEffect(load, [load]);
  useEffect(loadMutes, [loadMutes]);
  useEffect(() => { get<Server[]>("/api/servers").then(setServers).catch(() => {}); }, []);
  useLive(["incident"], load);
  const muteMap = useMemo(() => {
    const m = new Map<string, AlertMute>();
    for (const mu of mutes) m.set(`${mu.server_id} ${mu.rule_name} ${mu.check_key}`, mu);
    return m;
  }, [mutes]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h1 className="mr-3 text-[15px] font-semibold">Incidents</h1>
        <select className={`${inputCls} !w-48`} value={serverId} onChange={(e) => setServerId(e.target.value)}>
          <option value="">All servers</option>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
        <select className={`${inputCls} !w-36`} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open only
        </label>
      </div>

      <div className="border border-line bg-panel">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5 w-20">Severity</th>
              <th className="py-1.5 pr-3">Server</th>
              <th className="py-1.5 pr-3">What happened</th>
              <th className="py-1.5 pr-3">Rule</th>
              <th className="py-1.5 pr-3 text-right">Started</th>
              <th className="py-1.5 pr-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {incidents.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-3">
                No incidents match the filters.
              </td></tr>
            )}
            {incidents.map((i) => (
              <tr key={i.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="px-3 py-2"><SeverityTag severity={i.severity} /></td>
                <td className="py-2 pr-3">
                  <Link to={`/servers/${i.server_id}`} className="hover:underline">{i.server_name}</Link>
                  <span className="ml-1.5 text-[11px] text-ink-3">{i.brand}</span>
                </td>
                <td className="py-2 pr-3">{i.message}
                  {i.suppressed && <span className="ml-2 text-[11px] text-ink-3">(suppressed)</span>}
                </td>
                <td className="py-2 pr-3 font-mono text-[12px] text-ink-2">{i.rule_name}/{i.check_key}</td>
                <td className="py-2 pr-3 text-right font-mono text-[12px] whitespace-nowrap">{ts(i.started_at)}</td>
                <td className="py-2 pr-3 text-right text-[12px] whitespace-nowrap">
                  {i.resolved_at
                    ? <span className="text-ok">resolved after {duration(i.started_at, i.resolved_at)}</span>
                    : <span className="text-crit">ongoing ({duration(i.started_at)})</span>}
                  {!i.resolved_at && (
                    <div className="mt-0.5">
                      <MuteControl
                        target={{ rule_name: i.rule_name, check_key: i.check_key, server_id: i.server_id }}
                        mute={muteMap.get(`${i.server_id} ${i.rule_name} ${i.check_key}`) ?? null}
                        onChange={loadMutes}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
