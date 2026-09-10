import { useCallback, useEffect, useMemo, useState } from "react";
import { get, post, put, patch, del } from "../api";
import type { Probe } from "../types";
import { relTime } from "../format";
import { StatusDot, Button, inputCls } from "../components/bits";
import { useLive } from "../useLive";
import { useCanManage, useMe } from "../useMe";
import { useBrands } from "../useBrands";

/**
 * Synthetic checks — HTTP/TCP probes that need no agent. Probes appear on the
 * Overview and Wall inside their brand group like any server; this page is
 * where they are created and tuned.
 */
export default function Probes() {
  const [probes, setProbes] = useState<Probe[]>([]);
  const [editing, setEditing] = useState<Probe | "new" | null>(null);
  const [managingVars, setManagingVars] = useState(false);
  const me = useMe();
  const canManage = useCanManage();

  const load = useCallback(() => {
    get<Probe[]>("/api/probes").then(setProbes).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const connected = useLive(["server", "incident"], load);

  const groups = useMemo(() => {
    const m = new Map<string, Probe[]>();
    for (const p of probes) {
      if (!m.has(p.brand)) m.set(p.brand, []);
      m.get(p.brand)!.push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [probes]);

  if (me && !canManage) {
    return <div className="text-[13px] text-ink-3">Probes are admin/operator-only.</div>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-[15px] font-semibold">Probes</h1>
          <span className="text-[12px] text-ink-3">
            {probes.filter((p) => p.status === "online").length} of {probes.length} up
            {!connected && " · live updates disconnected"}
          </span>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button onClick={() => setManagingVars(true)}>Variables</Button>
            <Button onClick={() => setEditing("new")}>Add probe</Button>
          </div>
        )}
      </div>

      <p className="mb-4 text-[13px] text-ink-2">
        Agentless checks — HTTP/TCP/API for a website, switch UI, printer or 3rd-party flow status
        (e.g. an integration platform's run status), plus real ICMP Ping, SMB Directory file-count checks and SQL Server Data
        checks for things that don't need (or can't run) an agent. Probes join the Overview and Wall
        under their brand, and rules target them by name the same way as servers (plus{" "}
        <code className="font-mono text-[12px]">probe.latency_ms</code>,{" "}
        <code className="font-mono text-[12px]">cert.days_remaining</code> for https,{" "}
        <code className="font-mono text-[12px]">probe.age_minutes</code> for API probes watching
        when something last ran, and <code className="font-mono text-[12px]">probe.json_value</code>{" "}
        for a Directory/Data probe's file/row count). API probe fields accept{" "}
        <code className="font-mono text-[12px]">{"{{VariableName}}"}</code> for secrets stored under{" "}
        {canManage
          ? <button className="underline hover:text-ink" onClick={() => setManagingVars(true)}>Variables</button>
          : "Variables"}.
      </p>

      {probes.length === 0 && (
        <div className="border border-line bg-panel p-8 text-center text-[13px] text-ink-3">
          No probes yet. Click “Add probe” to monitor something without an agent.
        </div>
      )}

      {groups.map(([brand, list]) => (
        <section key={brand} className="mb-6">
          <h2 className="mb-1 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wider text-ink-2">
            {brand}
            <span className="font-normal normal-case tracking-normal text-ink-3">
              {list.filter((p) => p.status === "online").length}/{list.length} up
            </span>
          </h2>
          <div className="border border-line bg-panel">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="w-6 px-3 py-1.5"></th>
                  <th className="py-1.5 pr-3">Probe</th>
                  <th className="py-1.5 pr-3">Target</th>
                  <th className="py-1.5 pr-3 text-right">Latency</th>
                  <th className="py-1.5 pr-3 text-right">Cert</th>
                  <th className="py-1.5 pr-3 text-right">24h up</th>
                  <th className="py-1.5 pr-3">Last 24h</th>
                  <th className="py-1.5 pr-3 text-right">Checked</th>
                  <th className="py-1.5 pr-3 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <ProbeRow key={p.id} p={p} onEdit={() => setEditing(p)} onRemoved={load}
                    canEdit={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {editing && (
        <ProbeModal
          probe={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {managingVars && <VariablesModal onClose={() => setManagingVars(false)} />}
    </div>
  );
}

interface ProbeVariable { name: string; value: string; updated_at: string; }

/**
 * Named secrets referenced from probe fields as {{Name}} — kept out of every
 * individual probe's body/headers so a shared credential lives in one place
 * and can be rotated without editing each probe that uses it.
 */
function VariablesModal({ onClose }: { onClose: () => void }) {
  const [vars, setVars] = useState<ProbeVariable[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    get<ProbeVariable[]>("/api/probe-variables").then(setVars).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setError("");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      setError("Name must start with a letter or underscore and contain only letters, numbers and underscores");
      return;
    }
    if (!value) { setError("Value is required"); return; }
    try {
      await put(`/api/probe-variables/${encodeURIComponent(name)}`, { value });
      setName(""); setValue("");
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (n: string) => {
    if (!confirm(`Remove variable {{${n}}}? Any probe still referencing it will fail.`)) return;
    await del(`/api/probe-variables/${encodeURIComponent(n)}`);
    load();
  };

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[480px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-[14px] font-semibold">Variables</h2>
        <p className="mb-4 text-[12px] text-ink-3">
          Reference these from any API probe field as <code className="font-mono">{"{{Name}}"}</code> — e.g.
          an access token used by several probes only has to be entered once, here.
        </p>

        {vars.length > 0 && (
          <div className="mb-4 border border-line">
            {vars.map((v) => (
              <div key={v.name} className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px] last:border-b-0">
                <code className="font-mono">{"{{" + v.name + "}}"}</code>
                <button onClick={() => remove(v.name)} className="text-[11px] text-ink-3 hover:text-crit">remove</button>
              </div>
            ))}
          </div>
        )}

        <label className="mb-1 block text-[12px] text-ink-2">Name</label>
        <input className={inputCls} value={name} placeholder="ApiAccessToken"
          onChange={(e) => setName(e.target.value)} />

        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Value</label>
        <input className={inputCls} type="password" value={value} placeholder="the secret value"
          onChange={(e) => setValue(e.target.value)} />

        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Done</Button>
          <Button kind="primary" disabled={!name.trim() || !value} onClick={save}>Add / update</Button>
        </div>
      </div>
    </div>
  );
}

function ProbeRow({ p, onEdit, onRemoved, canEdit }: {
  p: Probe; onEdit: () => void; onRemoved: () => void; canEdit: boolean;
}) {
  const remove = async () => {
    if (!confirm(`Remove probe ${p.name}? This deletes its history and incidents too.`)) return;
    await del(`/api/probes/${p.id}`);
    onRemoved();
  };

  const certDays = p.last?.cert_days_remaining;

  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-paper">
      <td className="px-3 py-2"><StatusDot status={p.status} /></td>
      <td className="py-2 pr-3">
        <span className="font-medium">{p.name}</span>
        <span className="ml-2 text-[11px] uppercase text-ink-3">
          {p.type === "api" ? `${p.method} api` : p.type}
        </span>
        {p.status === "offline" && p.last?.error && (
          <div className="text-[12px] text-crit">{p.last.error}</div>
        )}
      </td>
      <td className="max-w-56 truncate py-2 pr-3 font-mono text-[12px] text-ink-2" title={p.target}>
        {p.type === "push" ? "waiting for external pushes" : p.target}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-[12px]">
        {p.last?.latency_ms != null && p.status === "online" ? `${Math.round(p.last.latency_ms)} ms` : "—"}
      </td>
      <td className={`py-2 pr-3 text-right font-mono text-[12px] ${
        certDays == null ? "text-ink-3" : certDays < 14 ? "text-crit" : certDays < 30 ? "text-warn" : ""}`}>
        {certDays == null ? "—" : `${Math.floor(certDays)}d`}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-[12px]">
        {p.uptime_24h == null ? "—" : `${p.uptime_24h.toFixed(1)}%`}
      </td>
      <td className="py-2 pr-3"><Sparkline points={p.spark} /></td>
      <td className="py-2 pr-3 text-right font-mono text-[12px] text-ink-2">
        {relTime(p.last?.checked_at ?? null)}
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">
        {canEdit && (
          <>
            <button onClick={onEdit} className="text-[11px] text-ink-3 hover:text-ink">edit</button>
            <button onClick={remove} className="ml-2 text-[11px] text-ink-3 hover:text-crit">remove</button>
          </>
        )}
      </td>
    </tr>
  );
}

/** Tiny inline latency sparkline; down samples render as marks on the baseline. */
function Sparkline({ points }: { points: Probe["spark"] }) {
  const W = 120, H = 22;
  if (points.length < 2) return <div className="h-[22px] w-[120px]" />;
  const lats = points.map((p) => (p.up && p.latency_ms != null ? p.latency_ms : null));
  const max = Math.max(...lats.filter((v): v is number => v != null), 1);
  const x = (i: number) => (i / (points.length - 1)) * (W - 2) + 1;
  const y = (v: number) => H - 2 - (v / max) * (H - 6);
  const path = lats
    .map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .map((pt, i, arr) => (pt == null ? "" : `${i === 0 || arr[i - 1] == null ? "M" : "L"}${pt}`))
    .join("");
  return (
    <svg width={W} height={H} className="block">
      {path && <path d={path} fill="none" stroke="var(--color-ink-3)" strokeWidth="1" />}
      {points.map((p, i) =>
        !p.up ? <rect key={i} x={x(i) - 1} y={H - 5} width="2" height="4" fill="var(--color-crit)" /> : null,
      )}
    </svg>
  );
}

const HEADER_LINE = /^([^:]+):\s*(.*)$/;

function headersToText(h: Record<string, string> | null): string {
  return h ? Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
}

function textToHeaders(t: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const m = HEADER_LINE.exec(line.trim());
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

interface CredentialName { id: number; name: string; type: string }
interface DataConnection { id: number; name: string; host: string; database_name: string }

function ProbeModal({ probe, onClose, onSaved }: {
  probe: Probe | null; onClose: () => void; onSaved: () => void;
}) {
  const { names: brandNames, defaultBrand } = useBrands();
  const [name, setName] = useState(probe?.name ?? "");
  const [brand, setBrand] = useState(probe?.brand ?? "");
  const [tags, setTags] = useState(probe?.tags.join(", ") ?? "");
  const [type, setType] = useState<Probe["type"]>(probe?.type ?? "http");
  const [target, setTarget] = useState(probe?.target ?? "");
  const [warningThreshold, setWarningThreshold] = useState(probe?.warning_threshold != null ? String(probe.warning_threshold) : "0");
  const [severeThreshold, setSevereThreshold] = useState(probe?.severe_threshold != null ? String(probe.severe_threshold) : "1");
  const [fileMask, setFileMask] = useState(probe?.file_mask ?? "*");
  const [credentialId, setCredentialId] = useState(probe?.credential_id ? String(probe.credential_id) : "");
  const [connectionId, setConnectionId] = useState(probe?.connection_id ? String(probe.connection_id) : "");
  const [procedureName, setProcedureName] = useState(probe?.procedure_name ?? "");
  const [smbCredentials, setSmbCredentials] = useState<CredentialName[]>([]);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [interval, setIntervalSec] = useState(String(probe?.interval_seconds ?? 60));
  const [timeout_, setTimeout_] = useState(String(probe?.timeout_ms ?? 5000));
  const [expected, setExpected] = useState(probe?.expected_status ? String(probe.expected_status) : "");
  const [method, setMethod] = useState(probe?.method ?? "GET");
  const [headersText, setHeadersText] = useState(headersToText(probe?.headers ?? null));
  const [body, setBody] = useState(probe?.body ?? "");
  const [authToken, setAuthToken] = useState(probe?.auth_token ?? "");
  const [jsonPath, setJsonPath] = useState(probe?.json_path ?? "");
  const [jsonExpected, setJsonExpected] = useState(probe?.json_expected ?? "");
  const [timestampPath, setTimestampPath] = useState(probe?.timestamp_path ?? "");
  const [maxAge, setMaxAge] = useState(probe?.max_age_minutes ? String(probe.max_age_minutes) : "");
  const [exchangeAuth, setExchangeAuth] = useState(!!probe?.auth_url);
  const [authUrl, setAuthUrl] = useState(probe?.auth_url ?? "");
  const [authBody, setAuthBody] = useState(probe?.auth_body ?? "");
  const [authTokenPath, setAuthTokenPath] = useState(probe?.auth_token_path ?? "token");
  const [failOnGraphqlErrors, setFailOnGraphqlErrors] = useState(probe?.fail_on_graphql_errors ?? false);
  const [error, setError] = useState("");
  const [pushKeyResult, setPushKeyResult] = useState<{ id: number; key: string } | null>(null);

  useEffect(() => {
    if (type === "directory") get<CredentialName[]>("/api/credentials/names").then((rows) => setSmbCredentials(rows.filter((c) => c.type === "smb"))).catch(() => {});
    if (type === "data") get<DataConnection[]>("/api/data-connections").then(setConnections).catch(() => {});
  }, [type]);

  const save = async () => {
    setError("");
    const reqBody: any = {
      name, brand: brand || defaultBrand,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      type, target: type === "push" ? "push" : type === "data" ? (procedureName || "data") : target,
      interval_seconds: parseInt(interval, 10),
      timeout_ms: parseInt(timeout_, 10),
      expected_status: (type === "http" || type === "api") && expected ? parseInt(expected, 10) : null,
    };
    if (type === "directory") {
      Object.assign(reqBody, {
        file_mask: fileMask, credential_id: credentialId ? parseInt(credentialId, 10) : null,
        warning_threshold: parseInt(warningThreshold, 10) || 0,
        severe_threshold: parseInt(severeThreshold, 10) || 1,
      });
    }
    if (type === "data") {
      Object.assign(reqBody, {
        connection_id: connectionId ? parseInt(connectionId, 10) : null, procedure_name: procedureName,
        warning_threshold: parseInt(warningThreshold, 10) || 0,
        severe_threshold: parseInt(severeThreshold, 10) || 1,
      });
    }
    if (type === "api") {
      Object.assign(reqBody, {
        method,
        headers: textToHeaders(headersText),
        body: (method === "POST" || method === "PUT" || method === "PATCH") && body ? body : null,
        auth_token: !exchangeAuth && authToken ? authToken : null,
        json_path: jsonPath || null,
        json_expected: jsonPath && jsonExpected ? jsonExpected : null,
        timestamp_path: timestampPath || null,
        max_age_minutes: timestampPath && maxAge ? parseInt(maxAge, 10) : null,
        auth_url: exchangeAuth && authUrl ? authUrl : null,
        auth_body: exchangeAuth && authBody ? authBody : null,
        auth_token_path: exchangeAuth ? (authTokenPath || "token") : null,
        fail_on_graphql_errors: failOnGraphqlErrors,
      });
    }
    try {
      if (probe) {
        await patch(`/api/probes/${probe.id}`, reqBody);
        onSaved();
      } else {
        const created = await post<Probe & { push_key?: string }>("/api/probes", reqBody);
        if (created.push_key) setPushKeyResult({ id: created.id, key: created.push_key });
        else onSaved();
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const rotatePushKey = async () => {
    if (!probe) return;
    const r = await post<{ push_key: string }>(`/api/probes/${probe.id}/rotate-push-key`);
    setPushKeyResult({ id: probe.id, key: r.push_key });
  };

  if (pushKeyResult) {
    const pushUrl = `${window.location.origin}/api/probes/${pushKeyResult.id}/push`;
    return (
      <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
        <div className="w-[520px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="mb-1 text-[14px] font-semibold">Push key (shown once)</h2>
          <p className="mb-3 text-[12px] text-ink-3">
            Save this now — it won't be shown again. Have your external check POST here after every run:
          </p>
          <div className="mb-3 border border-line bg-paper p-2 font-mono text-[12px] break-all">{pushUrl}</div>
          <div className="mb-3 border border-line bg-paper p-2 font-mono text-[12px] break-all">
            X-API-Key: {pushKeyResult.key}
          </div>
          <p className="mb-1 text-[12px] text-ink-2">Example (PowerShell):</p>
          <pre className="mb-3 overflow-x-auto border border-line bg-paper p-2 font-mono text-[11px]">
{`Invoke-RestMethod -Method Post -Uri "${pushUrl}" \`
  -Headers @{ "X-API-Key" = "${pushKeyResult.key}" } \`
  -ContentType "application/json" \`
  -Body (@{ up = $true } | ConvertTo-Json)`}
          </pre>
          <div className="flex justify-end">
            <Button kind="primary" onClick={() => { setPushKeyResult(null); onSaved(); }}>Done</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[480px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-[14px] font-semibold">{probe ? "Edit probe" : "Add probe"}</h2>

        <label className="mb-1 block text-[12px] text-ink-2">Name</label>
        <input className={inputCls} value={name} autoFocus placeholder="Company website"
          onChange={(e) => setName(e.target.value)} />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">Brand / group</label>
            <select className={inputCls} value={brand || defaultBrand} onChange={(e) => setBrand(e.target.value)}>
              {brandNames.map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">Tags (comma-separated)</label>
            <input className={inputCls} value={tags} placeholder="website, public"
              onChange={(e) => setTags(e.target.value)} />
          </div>
        </div>

        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Type</label>
        <div className="flex flex-wrap gap-2">
          <Button kind={type === "http" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("http")}>HTTP(S)</Button>
          <Button kind={type === "tcp" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("tcp")}>TCP</Button>
          <Button kind={type === "api" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("api")}>API / Webhook</Button>
          <Button kind={type === "push" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("push")}>Push</Button>
          <Button kind={type === "ping" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("ping")}>Ping</Button>
          <Button kind={type === "directory" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("directory")}>Directory</Button>
          <Button kind={type === "data" ? "primary" : "default"} className="flex-1"
            onClick={() => setType("data")}>Data (SQL)</Button>
        </div>

        {type === "push" && (
          <>
            <p className="mt-2 text-[12px] text-ink-3">
              For checks Alfred can't run itself — e.g. a public endpoint that hairpin-NATs when
              tested from inside the same network. An external runner (a scheduled task, an
              external host) POSTs its own result here. Going quiet never marks this "offline" on
              its own — that would conflate the checker failing with what it's checking failing —
              use <code className="font-mono">probe.age_minutes</code> in a rule if you want to
              alert on "no push received in a while" as a separate, explicit condition.
            </p>
            {probe && (
              <Button className="mt-3" onClick={rotatePushKey}>Rotate push key</Button>
            )}
          </>
        )}

        {type !== "push" && type !== "data" && (
          <>
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">
              {type === "tcp" ? "Host and port" : type === "ping" ? "IP address" : type === "directory" ? "UNC path" : "URL"}
            </label>
            <input className={inputCls} value={target}
              placeholder={
                type === "tcp" ? "192.168.1.30:9100"
                : type === "ping" ? "192.168.1.30"
                : type === "directory" ? "\\\\server\\share\\folder"
                : "https://www.example.com"
              }
              onChange={(e) => setTarget(e.target.value)} />
          </>
        )}

        {type === "directory" && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">File mask</label>
                <input className={inputCls} value={fileMask} placeholder="*.csv"
                  onChange={(e) => setFileMask(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">SMB credential</label>
                <select className={inputCls} value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                  <option value="">— none —</option>
                  {smbCredentials.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">
              Counts files matching the mask under the path over SMB. Goes offline once the count
              reaches "severe" below; use a Rule on <code className="font-mono">probe.json_value</code>{" "}
              for a separate warning-tier alert (e.g. <code className="font-mono">probe.json_value &gt;= 3</code>).
            </p>
          </>
        )}

        {type === "data" && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Connection</label>
                <select className={inputCls} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                  <option value="">— select —</option>
                  {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host} : {c.database_name})</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">SQL procedure</label>
                <input className={inputCls} value={procedureName} placeholder="Monitor.CheckTransactionHeader"
                  onChange={(e) => setProcedureName(e.target.value)} />
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">
              Runs the procedure and thresholds on the row count returned. Manage connections under{" "}
              Admin → Credentials.
            </p>
          </>
        )}

        {(type === "directory" || type === "data") && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Warning threshold</label>
              <input className={inputCls} type="number" value={warningThreshold}
                onChange={(e) => setWarningThreshold(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Severe threshold</label>
              <input className={inputCls} type="number" value={severeThreshold}
                onChange={(e) => setSevereThreshold(e.target.value)} />
            </div>
          </div>
        )}

        {type === "ping" && (
          <p className="mt-2 text-[12px] text-ink-3">
            Real ICMP ping (not a TCP connect). To match the legacy behaviour of only alerting after
            N consecutive failed pings, set a <code className="font-mono">for:</code> duration on the
            Rule watching this probe (e.g. <code className="font-mono">for: 5m</code>) rather than
            alerting on the very first missed ping.
          </p>
        )}

        {type === "api" && (
          <>
            <p className="mt-2 text-[12px] text-ink-3">
              Any method, headers, body and auth — plus an optional JSON-path assertion, staleness
              check, and GraphQL error detection (a GraphQL query still returns HTTP 200 when it
              fails, so tick "Fail on GraphQL errors" for those). Use the JSON/timestamp paths to
              watch a flow's last-run status and time. Headers, body and auth fields below accept{" "}
              <code className="font-mono">{"{{VariableName}}"}</code> — add secrets under{" "}
              <span className="font-medium">Variables</span> once and reuse them across probes.
            </p>

            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Method</label>
            <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
            </select>

            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Headers (one per line, "Name: value")</label>
            <textarea className={`${inputCls} h-16 font-mono text-[12px]`} value={headersText}
              placeholder={"X-API-Key: {{APIKey}}\nAccept: application/json"}
              onChange={(e) => setHeadersText(e.target.value)} />

            {(method === "POST" || method === "PUT" || method === "PATCH") && (
              <>
                <label className="mb-1 mt-3 block text-[12px] text-ink-2">Body</label>
                <textarea className={`${inputCls} h-20 font-mono text-[12px]`} value={body}
                  placeholder='{"query": "{ ping }"}'
                  onChange={(e) => setBody(e.target.value)} />
              </>
            )}

            <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-2">
              <input type="checkbox" checked={exchangeAuth} onChange={(e) => setExchangeAuth(e.target.checked)} />
              This API needs a token exchange first (POST an access token, get a bearer token back)
            </label>

            {exchangeAuth ? (
              <>
                <label className="mb-1 mt-2 block text-[12px] text-ink-2">Auth URL</label>
                <input className={inputCls} value={authUrl}
                  placeholder="https://api.example.com/identity/authenticate-with-access-token"
                  onChange={(e) => setAuthUrl(e.target.value)} />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-[12px] text-ink-2">Auth request body</label>
                    <textarea className={`${inputCls} h-16 font-mono text-[12px]`} value={authBody}
                      placeholder='{"accessToken": "{{ApiAccessToken}}"}'
                      onChange={(e) => setAuthBody(e.target.value)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px] text-ink-2">Token path in auth response</label>
                    <input className={inputCls} value={authTokenPath} placeholder="token"
                      onChange={(e) => setAuthTokenPath(e.target.value)} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="mb-1 mt-3 block text-[12px] text-ink-2">Bearer token (optional)</label>
                <input className={inputCls} value={authToken} placeholder="{{ApiToken}} — sent as Authorization: Bearer …"
                  onChange={(e) => setAuthToken(e.target.value)} />
              </>
            )}

            <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-2">
              <input type="checkbox" checked={failOnGraphqlErrors}
                onChange={(e) => setFailOnGraphqlErrors(e.target.checked)} />
              Fail on GraphQL errors (response has a non-empty top-level "errors" array)
            </label>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">JSON path to check (optional)</label>
                <input className={inputCls} value={jsonPath} placeholder="data.flows.0.status"
                  onChange={(e) => setJsonPath(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Expected value(s)</label>
                <input className={inputCls} value={jsonExpected} placeholder="success, completed"
                  disabled={!jsonPath} onChange={(e) => setJsonExpected(e.target.value)} />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Timestamp path (optional)</label>
                <input className={inputCls} value={timestampPath} placeholder="data.flows.0.finished_at"
                  onChange={(e) => setTimestampPath(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Max age (minutes)</label>
                <input className={inputCls} type="number" min={1} value={maxAge} placeholder="e.g. 60"
                  disabled={!timestampPath} onChange={(e) => setMaxAge(e.target.value)} />
              </div>
            </div>
          </>
        )}

        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">
              {type === "push" ? "Expected push interval (s)" : "Interval (s)"}
            </label>
            <input className={inputCls} type="number" min={10} value={interval}
              onChange={(e) => setIntervalSec(e.target.value)} />
          </div>
          {type !== "push" && (
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Timeout (ms)</label>
              <input className={inputCls} type="number" min={100} value={timeout_}
                onChange={(e) => setTimeout_(e.target.value)} />
            </div>
          )}
          {(type === "http" || type === "api") && (
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Expect status</label>
              <input className={inputCls} type="number" value={expected} placeholder="2xx/3xx"
                onChange={(e) => setExpected(e.target.value)} />
            </div>
          )}
        </div>

        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={
            !name.trim() ||
            (type === "data" ? (!connectionId || !procedureName.trim()) : type !== "push" && !target.trim())
          } onClick={save}>
            {probe ? "Save" : "Create probe"}
          </Button>
        </div>
      </div>
    </div>
  );
}
