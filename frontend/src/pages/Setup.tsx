import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { Button, inputCls } from "../components/bits";

type Step = "account" | "org" | "monitoring" | "email" | "microsoft" | "groups";
const STEPS: Step[] = ["account", "org", "monitoring", "email", "microsoft", "groups"];
const STEP_LABELS: Record<Step, string> = {
  account: "Admin account",
  org: "Organisation",
  monitoring: "Monitoring",
  email: "Email alerts",
  microsoft: "Microsoft sign-in",
  groups: "Groups",
};

const COMMON_TZ = [
  "UTC", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney",
];

/**
 * First-run wizard, shown when no user exists yet (see /api/setup/status).
 * Collects everything up front and submits once at the end — the companion
 * backend route is a single atomic POST /api/setup, not a step-by-step API,
 * so there's no partially-configured server state if someone abandons the
 * wizard halfway. Everything here is also editable later under Settings.
 */
export default function Setup() {
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [step, setStep] = useState<Step>("account");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [orgName, setOrgName] = useState("");
  const [baseUrl, setBaseUrl] = useState(window.location.origin);

  const guessedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [timezone, setTimezone] = useState(COMMON_TZ.includes(guessedTz) ? guessedTz : "UTC");
  const [retentionDays, setRetentionDays] = useState("90");
  const [offlineMultiplier, setOfflineMultiplier] = useState("2");
  const [digestTo, setDigestTo] = useState("");
  const [digestHour, setDigestHour] = useState("8");

  const [emailProvider, setEmailProvider] = useState<"disabled" | "sendgrid" | "smtp">("disabled");
  const [sgKey, setSgKey] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpTls, setSmtpTls] = useState("starttls");
  const [fromName, setFromName] = useState("Alfred Monitoring");
  const [fromLocal, setFromLocal] = useState("alfred");
  const [fromDomain, setFromDomain] = useState("");

  const [msEnabled, setMsEnabled] = useState(false);
  const [msTenant, setMsTenant] = useState("");
  const [msClient, setMsClient] = useState("");
  const [msGroupAdmin, setMsGroupAdmin] = useState("");
  const [msGroupOperator, setMsGroupOperator] = useState("");
  const [msGroupViewer, setMsGroupViewer] = useState("");

  const [groups, setGroups] = useState("Default");

  useEffect(() => {
    get<{ needed: boolean }>("/api/setup/status")
      .then((s) => { if (!s.needed) navigate("/login"); })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [navigate]);

  const stepIndex = STEPS.indexOf(step);

  const canAdvance = (): boolean => {
    if (step === "account") return username.trim().length > 0 && password.length >= 8 && password === confirmPassword;
    if (step === "org") return orgName.trim().length > 0;
    if (step === "monitoring") return Number(retentionDays) >= 1 && Number(offlineMultiplier) >= 1;
    if (step === "email") {
      if (emailProvider === "disabled") return true;
      const base = emailProvider === "sendgrid" ? !!sgKey : !!smtpHost;
      return base && fromDomain.trim().length > 0;
    }
    if (step === "microsoft") {
      if (!msEnabled) return true;
      return !!msTenant.trim() && !!msClient.trim() && (!!msGroupAdmin.trim() || !!msGroupOperator.trim() || !!msGroupViewer.trim());
    }
    return true;
  };

  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);
  const back = () => setStep(STEPS[Math.max(stepIndex - 1, 0)]);

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      await post("/api/setup", {
        username: username.trim(),
        password,
        org_name: orgName.trim(),
        base_url: baseUrl.trim(),
        brands: groups.split(",").map((g) => g.trim()).filter(Boolean),
        monitoring: {
          timezone,
          retention_days: retentionDays,
          offline_multiplier: offlineMultiplier,
          digest_to: digestTo.trim(),
          digest_hour: digestHour,
        },
        email: {
          provider: emailProvider,
          ...(emailProvider === "sendgrid" ? { sendgrid_api_key: sgKey } : {}),
          ...(emailProvider === "smtp"
            ? { smtp_host: smtpHost, smtp_port: smtpPort, smtp_user: smtpUser, smtp_password: smtpPassword, smtp_tls: smtpTls }
            : {}),
          from_name: fromName.trim(),
          from_local: fromLocal.trim(),
          from_domain: fromDomain.trim(),
        },
        azure: msEnabled
          ? {
              enabled: true,
              tenant_id: msTenant.trim(),
              client_id: msClient.trim(),
              group_admin: msGroupAdmin.trim(),
              group_operator: msGroupOperator.trim(),
              group_viewer: msGroupViewer.trim(),
            }
          : { enabled: false },
      });
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!checked) return null;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-[460px] rounded-panel border border-line bg-panel p-6 shadow-panel">
        <div className="mb-1 text-center font-semibold tracking-[0.18em] text-[14px]">ALFRED</div>
        <div className="mb-5 text-center text-[12px] text-ink-3">
          First-run setup · {STEP_LABELS[step]} ({stepIndex + 1}/{STEPS.length})
        </div>

        <div className="mb-5 flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded ${i <= stepIndex ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>

        {step === "account" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Create the admin account</h2>
            <label className="mb-1 block text-[12px] text-ink-2">Username</label>
            <input className={inputCls} value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Password</label>
            <input className={inputCls} type="password" value={password}
              placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Confirm password</label>
            <input className={inputCls} type="password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)} />
            {password && confirmPassword && password !== confirmPassword && (
              <div className="mt-2 text-[12px] text-crit">Passwords don't match.</div>
            )}
          </>
        )}

        {step === "org" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Organisation</h2>
            <label className="mb-1 block text-[12px] text-ink-2">Organisation name</label>
            <input className={inputCls} value={orgName} autoFocus placeholder="Acme Corp"
              onChange={(e) => setOrgName(e.target.value)} />
            <div className="mt-0.5 text-[11px] text-ink-3">Shown in email footers.</div>
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Base URL</label>
            <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <div className="mt-0.5 text-[11px] text-ink-3">Used for links in alert emails and agent installs.</div>
          </>
        )}

        {step === "monitoring" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Monitoring preferences</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-[12px] text-ink-2">Timezone</label>
                <select className={inputCls} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {[...new Set([timezone, ...COMMON_TZ])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
                <div className="mt-0.5 text-[11px] text-ink-3">Recurring silence windows and the digest hour use this zone.</div>
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Metrics retention (days)</label>
                <input className={inputCls} type="number" min={1} value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Offline multiplier</label>
                <input className={inputCls} type="number" min={1} value={offlineMultiplier}
                  onChange={(e) => setOfflineMultiplier(e.target.value)} />
                <div className="mt-0.5 text-[11px] text-ink-3">Missed heartbeats before offline.</div>
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Daily digest to</label>
                <input className={inputCls} value={digestTo} placeholder="optional, comma-separated"
                  onChange={(e) => setDigestTo(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-ink-2">Digest hour (0–23)</label>
                <input className={inputCls} type="number" min={0} max={23} value={digestHour}
                  onChange={(e) => setDigestHour(e.target.value)} />
              </div>
            </div>
          </>
        )}

        {step === "email" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Email alerts</h2>
            <label className="mb-1 block text-[12px] text-ink-2">Provider</label>
            <select className={`${inputCls} mb-3`} value={emailProvider}
              onChange={(e) => setEmailProvider(e.target.value as any)}>
              <option value="disabled">Skip for now — configure later in Settings</option>
              <option value="sendgrid">SendGrid</option>
              <option value="smtp">SMTP</option>
            </select>

            {emailProvider === "sendgrid" && (
              <>
                <label className="mb-1 block text-[12px] text-ink-2">SendGrid API key</label>
                <input className={inputCls} type="password" value={sgKey} placeholder="SG...."
                  onChange={(e) => setSgKey(e.target.value)} />
              </>
            )}

            {emailProvider === "smtp" && (
              <div className="grid grid-cols-2 gap-3">
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
                  <label className="mb-1 block text-[12px] text-ink-2">Username</label>
                  <input className={inputCls} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Password</label>
                  <input className={inputCls} type="password" value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-[12px] text-ink-2">Encryption</label>
                  <select className={inputCls} value={smtpTls} onChange={(e) => setSmtpTls(e.target.value)}>
                    <option value="starttls">STARTTLS (port 587)</option>
                    <option value="implicit">Implicit TLS (port 465)</option>
                    <option value="none">None (unencrypted)</option>
                  </select>
                </div>
              </div>
            )}

            {emailProvider !== "disabled" && (
              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
                <div className="col-span-3 text-[11px] text-ink-3">From address on alert emails</div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">From name</label>
                  <input className={inputCls} value={fromName} onChange={(e) => setFromName(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Local part</label>
                  <input className={inputCls} value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Domain</label>
                  <input className={inputCls} value={fromDomain} placeholder="example.com"
                    onChange={(e) => setFromDomain(e.target.value)} />
                </div>
              </div>
            )}
          </>
        )}

        {step === "microsoft" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Microsoft sign-in (optional)</h2>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={msEnabled} onChange={(e) => setMsEnabled(e.target.checked)} />
              Enable "Sign in with Microsoft" alongside username/password
            </label>
            <div className="mt-1 text-[11px] text-ink-3">
              Username/password sign-in is always available. Roles are decided by Entra group
              membership. You can also do this later in Settings.
            </div>

            {msEnabled && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Tenant ID</label>
                  <input className={`${inputCls} font-mono`} value={msTenant} onChange={(e) => setMsTenant(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Client ID</label>
                  <input className={`${inputCls} font-mono`} value={msClient} onChange={(e) => setMsClient(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Admin group ID</label>
                  <input className={`${inputCls} font-mono`} value={msGroupAdmin} onChange={(e) => setMsGroupAdmin(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Operator group ID</label>
                  <input className={`${inputCls} font-mono`} value={msGroupOperator} onChange={(e) => setMsGroupOperator(e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-[12px] text-ink-2">Viewer group ID</label>
                  <input className={`${inputCls} font-mono`} value={msGroupViewer} onChange={(e) => setMsGroupViewer(e.target.value)} />
                </div>
                <div className="col-span-2 text-[11px] text-ink-3">
                  App registration needs a "Single-page application" platform with this redirect URI:
                  <span className="font-mono"> {baseUrl}</span> — no client secret (auth code + PKCE).
                </div>
              </div>
            )}
          </>
        )}

        {step === "groups" && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold">Groups</h2>
            <label className="mb-1 block text-[12px] text-ink-2">Server/probe groups (comma-separated)</label>
            <input className={inputCls} value={groups} autoFocus
              onChange={(e) => setGroups(e.target.value)} />
            <div className="mt-0.5 text-[11px] text-ink-3">
              How servers are grouped on the dashboard — e.g. by site, team, or product line.
              The first becomes the default; add or rename more later in Settings.
            </div>
          </>
        )}

        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}

        <div className="mt-5 flex justify-between">
          <Button onClick={back} disabled={stepIndex === 0}>Back</Button>
          {step === "groups" ? (
            <Button kind="primary" disabled={!canAdvance() || submitting} onClick={submit}>
              {submitting ? "Setting up…" : "Finish"}
            </Button>
          ) : (
            <Button kind="primary" disabled={!canAdvance()} onClick={next}>Next</Button>
          )}
        </div>
      </div>
    </div>
  );
}
