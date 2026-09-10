import { useCallback, useEffect, useState } from "react";
import { get, post, put, patch, del } from "../api";
import { ts } from "../format";
import { Panel, Button, inputCls } from "../components/bits";
import { useMe } from "../useMe";

interface EmailSettings {
  from_name: string;
  from_local: string;
  from_domain: string;
  allowed_domains: string[];
  updated_at?: string;
  updated_by?: string;
}

type AppSettings = Record<string, string | { set: boolean }>;

export default function Credentials() {
  const me = useMe();
  if (me && me.role !== "admin") {
    return <div className="text-[13px] text-ink-3">Credentials are admin-only.</div>;
  }
  return (
    <div>
      <h1 className="mb-4 text-[15px] font-semibold">Credentials</h1>
      <div className="mb-4"><EmailPanel /></div>
      <div className="mb-4"><CredentialListPanel type="smb" title="SMB / domain logins"
        hint="Used by Directory checks to read UNC shares (\\\\server\\share)." /></div>
      <div className="mb-4"><CredentialListPanel type="sql" title="SQL Server logins"
        hint="Used by Data checks to run stored procedures against a SQL Server connection." /></div>
      <CredentialListPanel type="generic" title="Other credentials" hint="Any other named login or secret." />
    </div>
  );
}

interface Credential {
  id: number;
  name: string;
  type: string;
  username: string | null;
  domain: string | null;
  secret_set: boolean;
  extra: Record<string, unknown> | null;
  updated_at: string;
  updated_by: string | null;
}

function CredentialListPanel({ type, title, hint }: { type: string; title: string; hint?: string }) {
  const [all, setAll] = useState<Credential[]>([]);
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    get<Credential[]>("/api/credentials").then((rows) => setAll(rows.filter((r) => r.type === type))).catch(() => {});
  }, [type]);
  useEffect(load, [load]);

  const remove = async (c: Credential) => {
    if (!confirm(`Delete credential "${c.name}"? Any check that uses it will start failing.`)) return;
    setError("");
    try {
      await del(`/api/credentials/${c.id}`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Panel title={title} right={<Button onClick={() => setEditing("new")}>Add</Button>}>
      {hint && <div className="border-b border-line px-3 py-2 text-[11px] text-ink-3">{hint}</div>}
      {error && <div className="border-b border-line bg-crit-bg px-3 py-2 text-[12px] text-crit">{error}</div>}
      {all.length === 0 ? (
        <div className="p-3 text-[12px] text-ink-3">None yet.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5">Name</th>
              {type === "smb" && <th className="py-1.5 pr-3">Domain</th>}
              <th className="py-1.5 pr-3">Username</th>
              <th className="py-1.5 pr-3">Secret</th>
              <th className="py-1.5 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {all.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                {type === "smb" && <td className="py-2 pr-3 text-ink-2">{c.domain || "—"}</td>}
                <td className="py-2 pr-3 text-ink-2">{c.username || "—"}</td>
                <td className="py-2 pr-3 text-ink-2">{c.secret_set ? "set" : <span className="italic text-ink-3">not set</span>}</td>
                <td className="py-2 pr-3 text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button className="border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 hover:bg-paper hover:text-ink"
                      onClick={() => setEditing(c)}>Edit</button>
                    <button className="px-1 text-ink-3 hover:text-crit" onClick={() => remove(c)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <CredentialModal
          type={type}
          credential={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </Panel>
  );
}

function CredentialModal({ type, credential, onClose, onSaved }: {
  type: string; credential: Credential | null; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(credential?.name ?? "");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [domain, setDomain] = useState(credential?.domain ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const body: any = { name: name.trim(), type, username: username.trim() || null, domain: domain.trim() || null };
      if (secret) body.secret = secret;
      if (credential) await patch(`/api/credentials/${credential.id}`, body);
      else await post("/api/credentials", body);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[420px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-[14px] font-semibold">{credential ? "Edit credential" : "Add credential"}</h2>
        <label className="mb-1 block text-[12px] text-ink-2">Name</label>
        <input className={inputCls} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        {type === "smb" && (
          <>
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Domain</label>
            <input className={inputCls} value={domain} placeholder="CORP" onChange={(e) => setDomain(e.target.value)} />
          </>
        )}
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Username</label>
        <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} />
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">{type === "sql" ? "Password" : "Password / secret"}</label>
        <input className={inputCls} type="password" value={secret}
          placeholder={credential?.secret_set ? "•••••• (set — leave blank to keep)" : ""}
          onChange={(e) => setSecret(e.target.value)} />
        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!name.trim() || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmailPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [fromName, setFromName] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [fromDomain, setFromDomain] = useState("");
  // provider config lives in app settings, separate API from the from-address
  const [provider, setProvider] = useState("disabled");
  const [sgKey, setSgKey] = useState("");
  const [sgKeySet, setSgKeySet] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpPasswordSet, setSmtpPasswordSet] = useState(false);
  const [smtpTls, setSmtpTls] = useState("starttls");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get<EmailSettings>("/api/settings/email").then((s) => {
      setSettings(s);
      setFromName(s.from_name);
      setFromLocal(s.from_local);
      setFromDomain(s.from_domain);
    }).catch(() => {});
    get<AppSettings>("/api/settings/app").then((s) => {
      setProvider(typeof s["email.provider"] === "string" ? s["email.provider"] as string : "disabled");
      setSgKeySet(typeof s["email.sendgrid_api_key"] === "object" && (s["email.sendgrid_api_key"] as any).set);
      setSmtpHost((s["email.smtp_host"] as string) ?? "");
      setSmtpPort((s["email.smtp_port"] as string) ?? "587");
      setSmtpUser((s["email.smtp_user"] as string) ?? "");
      setSmtpPasswordSet(typeof s["email.smtp_password"] === "object" && (s["email.smtp_password"] as any).set);
      setSmtpTls((s["email.smtp_tls"] as string) ?? "starttls");
      setAllowedDomains((s["email.allowed_domains"] as string) ?? "");
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      await put("/api/settings/email", { from_name: fromName, from_local: fromLocal, from_domain: fromDomain });
      await put("/api/settings/app", {
        "email.provider": provider,
        "email.sendgrid_api_key": sgKey,
        "email.smtp_host": smtpHost,
        "email.smtp_port": smtpPort,
        "email.smtp_user": smtpUser,
        "email.smtp_password": smtpPassword,
        "email.smtp_tls": smtpTls,
        "email.allowed_domains": allowedDomains,
      });
      if (sgKey) { setSgKeySet(true); setSgKey(""); }
      if (smtpPassword) { setSmtpPasswordSet(true); setSmtpPassword(""); }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTestResult("sending…");
    try {
      await post("/api/settings/email/test", { to: testTo });
      setTestResult("✓ sent — check the inbox");
    } catch (err: any) {
      setTestResult(`✗ ${err.message}`);
    }
  };

  if (!settings) return <Panel title="Email"><div className="p-3 text-[12px] text-ink-3">Loading…</div></Panel>;

  const validLocal = /^[a-zA-Z0-9._-]+$/.test(fromLocal);

  return (
    <Panel title="Email">
      <div className="p-3">
        <label className="mb-1 block text-[12px] text-ink-2">Provider</label>
        <select className={`${inputCls} mb-3`} value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="disabled">disabled — no email is sent</option>
          <option value="sendgrid">SendGrid</option>
          <option value="smtp">SMTP</option>
        </select>

        {provider === "sendgrid" && (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">SendGrid API key</label>
            <input className={`${inputCls} mb-3`} type="password" value={sgKey}
              placeholder={sgKeySet ? "•••••• (set — leave blank to keep)" : "SG...."}
              onChange={(e) => setSgKey(e.target.value)} />
          </>
        )}

        {provider === "smtp" && (
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">SMTP host</label>
              <input className={inputCls} value={smtpHost} placeholder="mail.example.com"
                onChange={(e) => setSmtpHost(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Port</label>
              <input className={inputCls} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Username (optional)</label>
              <input className={inputCls} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Password</label>
              <input className={inputCls} type="password" value={smtpPassword}
                placeholder={smtpPasswordSet ? "•••••• (set — leave blank to keep)" : ""}
                onChange={(e) => setSmtpPassword(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] text-ink-2">Encryption</label>
              <select className={inputCls} value={smtpTls} onChange={(e) => setSmtpTls(e.target.value)}>
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="implicit">Implicit TLS (port 465)</option>
                <option value="none">None (unencrypted)</option>
              </select>
            </div>
          </div>
        )}

        <label className="mb-1 block text-[12px] text-ink-2">From name</label>
        <input className={`${inputCls} mb-3`} value={fromName} placeholder="Alfred"
          onChange={(e) => setFromName(e.target.value)} />

        <label className="mb-1 block text-[12px] text-ink-2">From address</label>
        <div className="mb-1 flex items-center gap-1">
          <input className={inputCls} value={fromLocal} placeholder="alerts"
            onChange={(e) => setFromLocal(e.target.value)} />
          <span className="text-[13px] text-ink-3">@</span>
          {settings.allowed_domains.length > 0 ? (
            <select className={inputCls} value={fromDomain} onChange={(e) => setFromDomain(e.target.value)}>
              {settings.allowed_domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={fromDomain} placeholder="example.com"
              onChange={(e) => setFromDomain(e.target.value)} />
          )}
        </div>
        {!validLocal && (
          <div className="mb-2 text-[12px] text-crit">
            Only letters, numbers, dots, hyphens and underscores are allowed before the @.
          </div>
        )}

        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Allowed sender domains (optional)</label>
        <input className={`${inputCls} mb-1`} value={allowedDomains} placeholder="example.com, example.org"
          onChange={(e) => setAllowedDomains(e.target.value)} />
        <div className="mb-2 text-[11px] text-ink-3">Comma-separated. Empty = any domain allowed.</div>

        <div className="my-3 border border-line bg-paper px-2 py-1.5 font-mono text-[12px]">
          "{fromName || "Alfred"}" &lt;{fromLocal || "alerts"}@{fromDomain || "example.com"}&gt;
        </div>

        {error && <div className="mb-3 text-[12px] text-crit">{error}</div>}
        {settings.updated_at && (
          <div className="mb-3 text-[11px] text-ink-3">
            Last saved {ts(settings.updated_at)}{settings.updated_by && ` by ${settings.updated_by}`}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button kind="primary" disabled={!validLocal || !fromName.trim() || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {savedFlash && <span className="text-[12px] text-ok">Saved ✓</span>}
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <input className={`${inputCls} !w-56`} type="email" value={testTo} placeholder="you@example.com"
            onChange={(e) => setTestTo(e.target.value)} />
          <Button disabled={!testTo.trim() || provider === "disabled"} onClick={sendTest}>Send test email</Button>
          {testResult && <span className="text-[12px] text-ink-2">{testResult}</span>}
        </div>
      </div>
    </Panel>
  );
}
