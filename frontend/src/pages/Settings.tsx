import { useCallback, useEffect, useState } from "react";
import { get, post, put, patch, del } from "../api";
import { ts } from "../format";
import { Panel, Button, inputCls } from "../components/bits";
import { useMe } from "../useMe";
import { useBrands, invalidateBrands, type Brand } from "../useBrands";

export default function Settings() {
  const me = useMe();
  if (me && me.role !== "admin") {
    return <div className="text-[13px] text-ink-3">Settings are admin-only.</div>;
  }
  return (
    <div>
      <h1 className="mb-4 text-[15px] font-semibold">Settings</h1>
      <div className="mb-4"><SystemPanel /></div>
      <div className="mb-4"><EncryptionKeyPanel /></div>
      <div className="mb-4"><MicrosoftAuthPanel /></div>
      <div className="mb-4"><BrandsPanel /></div>
      <div className="mb-4"><WallAccessPanel /></div>
      <div className="mb-4"><NotificationLogPanel /></div>
      <AuditLogPanel />
    </div>
  );
}

type AppSettings = Record<string, string | { set: boolean }>;

/** Instance-wide configuration (DB-backed; legacy env vars only seed first boot). */
function SystemPanel() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get<AppSettings>("/api/settings/app").then((s) => {
      const vals: Record<string, string> = {};
      const secrets: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "string") vals[k] = v;
        else { vals[k] = ""; secrets[k] = v.set; }
      }
      setValues(vals);
      setSecretsSet(secrets);
      setLoaded(true);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      await put("/api/settings/app", values);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (key: string, label: string, hint?: string, type = "text") => (
    <div>
      <label className="mb-1 block text-[12px] text-ink-2">{label}</label>
      <input className={inputCls} type={type} value={values[key] ?? ""}
        placeholder={key in secretsSet ? (secretsSet[key] ? "•••••• (set — leave blank to keep)" : "not set") : undefined}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );

  if (!loaded) return <Panel title="System"><div className="p-3 text-[12px] text-ink-3">Loading…</div></Panel>;

  return (
    <Panel title="System">
      <div className="grid grid-cols-3 gap-3 p-3">
        {field("org.name", "Organisation name", "shown in email footers")}
        {field("base_url", "Base URL", "used for links in emails")}
        {field("alert.tz", "Timezone", "recurring silence windows evaluate in this zone")}
        {field("alert.offline_multiplier", "Offline multiplier", "missed heartbeats before a server counts as offline")}
        {field("alert.offline_min_seconds", "Offline grace floor (s)", "minimum wait before offline, even for fast-polling agents")}
        {field("alert.startup_settle_seconds", "Startup settle (s)", "no offline alerts for this long after Alfred restarts")}
        {field("alert.blackout_seconds", "Ingestion blackout (s)", "pause new offline alerts if not one agent has reported this long — likely Alfred's own problem")}
        {field("alert.probe_confirm_attempts", "Probe confirm attempts", "failed probe checks are retried this many times before counting as down")}
        {field("alert.probe_confirm_spacing_ms", "Probe confirm spacing (ms)", "delay between confirmation retries")}
        {field("retention.metrics_days", "Metrics retention (days)")}
        {field("email.max_per_hour", "Max emails per hour", "global send valve")}
        {field("digest.to", "Daily digest recipients", "comma-separated; empty disables the digest")}
        {field("digest.hour", "Digest hour (UTC)")}
        {field("agent.static_url", "Agent binary source URL", "internal URL the backend fetches agent builds from")}
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <Button kind="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
        {savedFlash && <span className="text-[12px] text-ok">Saved ✓</span>}
        {error && <span className="text-[12px] text-crit">{error}</span>}
      </div>
    </Panel>
  );
}

/** Encryption key for DB-stored secrets: shows where it came from, and reveals it on demand for disaster recovery. */
function EncryptionKeyPanel() {
  const [status, setStatus] = useState<{ source: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    get<{ source: string }>("/api/settings/master-key").then(setStatus).catch(() => {});
  }, []);

  const reveal = async () => {
    setError("");
    if (!confirm("Reveal the encryption key? It unlocks every secret stored in the database. This is logged in the audit trail.")) return;
    setBusy(true);
    try {
      const r = await post<{ key: string }>("/api/settings/master-key/reveal");
      setKey(r.key);
      setCopied(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = status?.source === "env"
    ? "supplied via the ALFRED_MASTER_KEY environment variable"
    : status?.source === "generated"
      ? "generated on first boot and stored in the database"
      : "stored in the database";

  return (
    <Panel title="Encryption key">
      <div className="p-3 text-[12px] text-ink-3">
        <p className="mb-2">
          Secrets stored in the database (email provider credentials, probe tokens) are encrypted
          with a single master key, {status ? sourceLabel : "…"}. Keep a copy somewhere safe. Set it
          as <span className="font-mono">ALFRED_MASTER_KEY</span> in the environment to hold it
          outside the database.
        </p>
        {error && <div className="mb-2 text-crit">{error}</div>}
        {key ? (
          <div className="border border-line bg-paper p-3">
            <div className="mb-1 text-[12px] font-semibold text-warn">Encryption key — store it securely, then close this</div>
            <div className="mb-2 break-all font-mono text-[12px]">{key}</div>
            <div className="flex gap-2">
              <Button onClick={() => { navigator.clipboard.writeText(key); setCopied(true); }}>
                {copied ? "Copied ✓" : "Copy"}
              </Button>
              <Button onClick={() => setKey(null)}>Hide</Button>
            </div>
          </div>
        ) : (
          <Button kind="danger" disabled={busy} onClick={reveal}>
            {busy ? "Revealing…" : "Reveal encryption key"}
          </Button>
        )}
      </div>
    </Panel>
  );
}

const AZURE_KEYS = ["azure.enabled", "azure.tenant_id", "azure.client_id", "azure.group_admin", "azure.group_operator", "azure.group_viewer"];

/** Microsoft Entra ID sign-in: optional and off by default. Username/password sign-in is always available. */
function MicrosoftAuthPanel() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState("");

  const enabled = values["azure.enabled"] === "true";

  useEffect(() => {
    get<AppSettings>("/api/settings/app").then((s) => {
      const vals: Record<string, string> = {};
      for (const k of AZURE_KEYS) {
        const v = s[k];
        vals[k] = typeof v === "string" ? v : "";
      }
      setValues(vals);
      setLoaded(true);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      await put("/api/settings/app", values);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (key: string, label: string, hint?: string) => (
    <div>
      <label className="mb-1 block text-[12px] text-ink-2">{label}</label>
      <input className={`${inputCls} font-mono`} value={values[key] ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );

  if (!loaded) return <Panel title="Microsoft sign-in"><div className="p-3 text-[12px] text-ink-3">Loading…</div></Panel>;

  return (
    <Panel title="Microsoft sign-in">
      <div className="p-3 pb-0 text-[12px] text-ink-3">
        Optional. Adds a "Sign in with Microsoft" button on the login page — username/password
        sign-in stays available either way. Role is decided by Entra group membership; a group
        you're not in at sign-in time gives no access.
      </div>
      <div className="p-3 pb-0">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled}
            onChange={(e) => setValues((v) => ({ ...v, "azure.enabled": e.target.checked ? "true" : "false" }))} />
          Enable Microsoft sign-in
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 p-3">
        {field("azure.tenant_id", "Tenant ID")}
        {field("azure.client_id", "Client ID (App registration, SPA platform, no secret needed)")}
        {field("azure.group_admin", "Admin group ID")}
        {field("azure.group_operator", "Operator group ID")}
        {field("azure.group_viewer", "Viewer group ID")}
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <Button kind="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
        {savedFlash && <span className="text-[12px] text-ok">Saved ✓</span>}
        {error && <span className="text-[12px] text-crit">{error}</span>}
      </div>
    </Panel>
  );
}

/** The brand/group list shown on Overview and the wall — curated here, not hardcoded. */
function BrandsPanel() {
  const { brands } = useBrands();
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<Brand | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");

  const add = async () => {
    setError("");
    if (!adding.trim()) return;
    try {
      await post("/api/brands", { name: adding.trim() });
      setAdding("");
      invalidateBrands();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const rename = async () => {
    if (!renaming) return;
    setError("");
    setWarnings([]);
    try {
      const r = await patch<{ warnings?: string[] }>(`/api/brands/${renaming.id}`, { name: renameValue.trim() });
      invalidateBrands();
      if (r.warnings?.length) setWarnings(r.warnings);
      else setRenaming(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setDefault = async (b: Brand) => {
    await post(`/api/brands/${b.id}/default`);
    invalidateBrands();
  };

  const remove = async (b: Brand) => {
    if (!confirm(`Delete brand "${b.name}"? Servers using it will need reassigning first.`)) return;
    setError("");
    try {
      await del(`/api/brands/${b.id}`);
      invalidateBrands();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Panel title="Brands / groups" right={
      <div className="flex items-center gap-2">
        <input className={`${inputCls} !w-40`} value={adding} placeholder="New brand name"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <Button onClick={add} disabled={!adding.trim()}>Add</Button>
      </div>
    }>
      {error && <div className="border-b border-line bg-crit-bg px-3 py-2 text-[12px] text-crit">{error}</div>}
      {brands.length === 0 ? (
        <div className="p-3 text-[12px] text-ink-3">No brands yet — the first server or probe you add will create one.</div>
      ) : (
        <ul className="text-[13px]">
          {brands.map((b) => (
            <li key={b.id} className="flex items-center justify-between border-b border-line px-3 py-2 last:border-b-0">
              {renaming?.id === b.id ? (
                <div className="flex flex-1 items-center gap-2">
                  <input className={inputCls} value={renameValue} autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(null); }} />
                  <Button kind="primary" onClick={rename}>Save</Button>
                  <Button onClick={() => setRenaming(null)}>Cancel</Button>
                </div>
              ) : (
                <>
                  <span>
                    {b.name}
                    {b.is_default && <span className="ml-2 text-[11px] text-ink-3">(default)</span>}
                  </span>
                  <div className="flex items-center gap-3 text-[12px] text-ink-3">
                    {!b.is_default && (
                      <button className="hover:text-ink" onClick={() => setDefault(b)}>make default</button>
                    )}
                    <button className="hover:text-ink" onClick={() => { setRenaming(b); setRenameValue(b.name); setWarnings([]); }}>rename</button>
                    <button className="hover:text-crit" onClick={() => remove(b)}>delete</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <div className="border-t border-line bg-warn-bg px-3 py-2 text-[12px] text-warn">
          Renamed, but these rule lines still reference the old name and won't match anymore:
          <ul className="mt-1 list-disc pl-4 font-mono text-[11px]">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  );
}

interface NotificationLogRow {
  id: number;
  sent_at: string;
  channel: string;
  recipient: string;
  subject: string;
  suppressed: boolean;
  reason: string | null;
}

function NotificationLogPanel() {
  const [rows, setRows] = useState<NotificationLogRow[]>([]);

  useEffect(() => {
    get<NotificationLogRow[]>("/api/settings/notification-log").then(setRows).catch(() => {});
  }, []);

  return (
    <Panel title="Recent notification deliveries">
      {rows.length === 0 ? (
        <div className="p-3 text-[12px] text-ink-3">No deliveries logged yet.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5">When</th>
              <th className="py-1.5 pr-3">Channel</th>
              <th className="py-1.5 pr-3">To</th>
              <th className="py-1.5 pr-3">Subject / message</th>
              <th className="py-1.5 pr-3">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-1.5 font-mono text-[12px] text-ink-2 whitespace-nowrap">{ts(r.sent_at)}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px] uppercase">{r.channel}</td>
                <td className="py-1.5 pr-3 text-ink-2">{r.recipient}</td>
                <td className="py-1.5 pr-3">{r.subject}</td>
                <td className="py-1.5 pr-3">
                  {r.suppressed
                    ? <span className="text-warn" title={r.reason ?? ""}>suppressed</span>
                    : <span className="text-ok">sent</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

interface AuditRow {
  id: number;
  at: string;
  username: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
}

function AuditLogPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (user) params.set("user", user);
    if (action) params.set("action", action);
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());
    get<AuditRow[]>(`/api/audit?${params}`).then(setRows).catch(() => {});
  }, [user, action, from, to]);
  useEffect(load, [load]);
  useEffect(() => { get<string[]>("/api/audit/actions").then(setActions).catch(() => {}); }, []);

  const users = [...new Set(rows.map((r) => r.username))];

  return (
    <Panel title="Audit log">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select className={`${inputCls} !w-40`} value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">All users</option>
          {users.map((u) => <option key={u}>{u}</option>)}
        </select>
        <select className={`${inputCls} !w-48`} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actions.map((a) => <option key={a}>{a}</option>)}
        </select>
        <input className={`${inputCls} !w-44`} type="datetime-local" value={from}
          onChange={(e) => setFrom(e.target.value)} title="From" />
        <span className="text-[12px] text-ink-3">→</span>
        <input className={`${inputCls} !w-44`} type="datetime-local" value={to}
          onChange={(e) => setTo(e.target.value)} title="To" />
      </div>
      {rows.length === 0 ? (
        <div className="p-3 text-[12px] text-ink-3">Nothing logged yet.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5">When</th>
              <th className="py-1.5 pr-3">User</th>
              <th className="py-1.5 pr-3">Action</th>
              <th className="py-1.5 pr-3">Target</th>
              <th className="py-1.5 pr-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-1.5 font-mono text-[12px] text-ink-2 whitespace-nowrap">{ts(r.at)}</td>
                <td className="py-1.5 pr-3">{r.username}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px]">{r.action}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px] text-ink-2">
                  {r.target_type ? `${r.target_type} #${r.target_id ?? "?"}` : "—"}
                </td>
                <td className="max-w-80 truncate py-1.5 pr-3 font-mono text-[11px] text-ink-3"
                  title={r.detail ? JSON.stringify(r.detail, null, 1) : ""}>
                  {r.detail ? JSON.stringify(r.detail) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

interface WallTokenStatus {
  set: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

function WallAccessPanel() {
  const [status, setStatus] = useState<WallTokenStatus | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    get<WallTokenStatus>("/api/settings/wall-token").then(setStatus).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const rotate = async () => {
    setError("");
    if (status?.set && !confirm("Rotate the wall access token? Any kiosk screen using the old link will need the new URL.")) return;
    setRotating(true);
    try {
      const r = await post<{ token: string }>("/api/settings/wall-token/rotate");
      setNewToken(r.token);
      setCopied(false);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRotating(false);
    }
  };

  const wallUrl = newToken ? `${window.location.origin}/wall?wall_token=${newToken}` : "";

  return (
    <Panel title="Wall access">
      <div className="p-3">
        <p className="mb-3 text-[12px] text-ink-3">
          The monitor wall (<span className="font-mono">/wall</span>) needs no login so it can be left running
          unattended without ever getting signed out. Instead it's unlocked by a token baked into its URL —
          rotating the token invalidates any old links. Leaving/design/opening a server from the wall still
          asks for a real sign-in.
        </p>

        {status && (
          <div className="mb-3 text-[12px] text-ink-3">
            {status.set
              ? <>Token is set{status.updated_at && ` · rotated ${ts(status.updated_at)}`}{status.updated_by && ` by ${status.updated_by}`}</>
              : "No token set yet — the wall will prompt for login until one is generated."}
          </div>
        )}

        {error && <div className="mb-3 text-[12px] text-crit">{error}</div>}

        <Button kind="primary" disabled={rotating} onClick={rotate}>
          {rotating ? "Rotating…" : status?.set ? "Rotate token" : "Generate token"}
        </Button>

        {newToken && (
          <div className="mt-3 border border-line bg-paper p-3">
            <div className="mb-1 text-[12px] font-semibold text-ok">New wall URL — copy it now, it won't be shown again</div>
            <div className="mb-2 break-all font-mono text-[12px]">{wallUrl}</div>
            <Button onClick={() => { navigator.clipboard.writeText(wallUrl); setCopied(true); }}>
              {copied ? "Copied ✓" : "Copy URL"}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

