import { useMemo, useState } from "react";
import type { Server } from "../types";
import { Button, inputCls } from "./bits";

type TargetKind = "all" | "brand" | "tag" | "server";
type PresetKind =
  | "offline" | "cpu" | "mem" | "disk" | "service_down" | "process_down"
  | "user_not_signed_in" | "cert_expiring" | "probe_slow" | "custom";

interface Preset {
  label: string;
  needsValue?: string; // placeholder for the numeric/name input
  defaultSeverity: "critical" | "warning" | "info";
  defaultCooldown: string;
  defaultSubject: string;
  defaultMessage: (value: string) => string;
  when: (value: string) => string;
}

const PRESETS: Record<PresetKind, Preset> = {
  offline: {
    label: "Server goes offline",
    defaultSeverity: "critical",
    defaultCooldown: "30m",
    defaultSubject: "🔴 {{server}} is OFFLINE",
    defaultMessage: () => "{{server}} is offline",
    when: () => "status == offline",
  },
  cpu: {
    label: "CPU usage above %",
    needsValue: "90",
    defaultSeverity: "warning",
    defaultCooldown: "1h",
    defaultSubject: "⚠️ High CPU on {{server}}",
    defaultMessage: (v) => `{{server}} CPU usage is above ${v || 90}%`,
    when: (v) => `status == online and cpu.percent > ${v || 90}`,
  },
  mem: {
    label: "Memory usage above %",
    needsValue: "90",
    defaultSeverity: "warning",
    defaultCooldown: "1h",
    defaultSubject: "⚠️ High memory on {{server}}",
    defaultMessage: (v) => `{{server}} memory usage is above ${v || 90}%`,
    when: (v) => `status == online and mem.percent > ${v || 90}`,
  },
  disk: {
    label: "Disk free space below %",
    needsValue: "10",
    defaultSeverity: "warning",
    defaultCooldown: "6h",
    defaultSubject: "⚠️ Low disk space on {{server}}",
    defaultMessage: (v) => `{{server}} is low on disk space (below ${v || 10}% free)`,
    when: (v) => `status == online and disk.min_free_pct < ${v || 10}`,
  },
  service_down: {
    label: "Service stopped",
    needsValue: "nginx",
    defaultSeverity: "critical",
    defaultCooldown: "30m",
    defaultSubject: "🔴 Service {{server}}",
    defaultMessage: (v) => `service '${v || "service-name"}' is not running on {{server}}`,
    when: (v) => `status == online and not service_running("${v || "service-name"}")`,
  },
  process_down: {
    label: "Process not running",
    needsValue: "MyApp",
    defaultSeverity: "warning",
    defaultCooldown: "1h",
    defaultSubject: "⚠️ Process not running on {{server}}",
    defaultMessage: (v) => `process '${v || "process-name"}' is not running on {{server}}`,
    when: (v) => `status == online and not process_running("${v || "process-name"}")`,
  },
  user_not_signed_in: {
    label: "User not signed in (Windows)",
    needsValue: "svcaccount",
    defaultSeverity: "warning",
    defaultCooldown: "1h",
    defaultSubject: "⚠️ {{value}} not signed in on {{server}}",
    defaultMessage: (v) => `user '${v || "username"}' is not signed in on {{server}}`,
    when: (v) => `status == online and not windows.user_logged_in("${v || "username"}")`,
  },
  cert_expiring: {
    label: "SSL certificate expiring (probe)",
    needsValue: "30",
    defaultSeverity: "warning",
    defaultCooldown: "24h",
    defaultSubject: "⚠️ SSL certificate on {{server}} expiring soon",
    defaultMessage: (v) => `{{server}} SSL certificate expires in under ${v || 30} days`,
    when: (v) => `status == online and cert.days_remaining < ${v || 30}`,
  },
  probe_slow: {
    label: "Probe latency above ms",
    needsValue: "2000",
    defaultSeverity: "warning",
    defaultCooldown: "1h",
    defaultSubject: "⚠️ {{server}} responding slowly",
    defaultMessage: (v) => `{{server}} is responding slowly (over ${v || 2000} ms)`,
    when: (v) => `status == online and probe.latency_ms > ${v || 2000}`,
  },
  custom: {
    label: "Custom expression…",
    defaultSeverity: "warning",
    defaultCooldown: "30m",
    defaultSubject: "⚠️ {{server}}: {{rule}}",
    defaultMessage: () => "",
    when: () => "",
  },
};

type NotifyChannel = "email" | "slack" | "teams" | "webhook";

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "new-rule";
}

/** Renders one YAML rule document as text, matching the hand-written style used elsewhere in the app. */
function renderRuleYaml(opts: {
  name: string; target: string; when: string; message: string; severity: string; cooldown: string;
  channel: NotifyChannel; to: string[]; subject: string; url: string; secret: string;
  recoveryNotify: boolean;
}): string {
  const toYaml = opts.to.length === 1
    ? `to: ${opts.to[0]}`
    : `to: [${opts.to.join(", ")}]`;
  const notifyLines =
    opts.channel === "email"
      ? [`          - channel: email`, `            ${toYaml}`, `            subject: ${JSON.stringify(opts.subject)}`]
      : opts.channel === "webhook"
        ? [`          - channel: webhook`, `            url: ${JSON.stringify(opts.url)}`,
            ...(opts.secret ? [`            secret: ${JSON.stringify(opts.secret)}`] : [])]
        : [`          - channel: ${opts.channel}`, `            url: ${JSON.stringify(opts.url)}`];
  return [
    `  - name: ${opts.name}`,
    `    target: ${/^[\w.-]+$/.test(opts.target) ? opts.target : JSON.stringify(opts.target)}`,
    `    checks:`,
    `      - when: ${opts.when}`,
    ...(opts.message ? [`        message: ${JSON.stringify(opts.message)}`] : []),
    `        severity: ${opts.severity}`,
    `        cooldown: ${opts.cooldown}`,
    `        notify:`,
    ...notifyLines,
    `    recovery_notify: ${opts.recoveryNotify}`,
    ``,
  ].join("\n");
}

export default function FlowGenerator({ servers, onInsert, onClose }: {
  servers: Server[];
  onInsert: (yamlBlock: string) => void;
  onClose: () => void;
}) {
  const brands = useMemo(
    () => [...new Set(servers.map((s) => s.brand))].sort(),
    [servers],
  );
  const tags = useMemo(
    () => [...new Set(servers.flatMap((s) => s.tags))].sort(),
    [servers],
  );

  const [targetKind, setTargetKind] = useState<TargetKind>("all");
  const [targetBrand, setTargetBrand] = useState(brands[0] || "");
  const [targetTag, setTargetTag] = useState(tags[0] || "");
  const [targetServer, setTargetServer] = useState(servers[0]?.display_name || "");

  const [preset, setPreset] = useState<PresetKind>("offline");
  const [value, setValue] = useState(PRESETS.offline.needsValue ?? "");
  const [customWhen, setCustomWhen] = useState("");

  const p = PRESETS[preset];
  const target =
    targetKind === "all" ? "*" :
    targetKind === "brand" ? `group:${targetBrand}` :
    targetKind === "tag" ? `tag:${targetTag}` :
    targetServer;

  const when = preset === "custom" ? customWhen : p.when(value);

  const [name, setName] = useState("");
  const [severity, setSeverity] = useState<"critical" | "warning" | "info">(p.defaultSeverity);
  const [cooldown, setCooldown] = useState(p.defaultCooldown);
  const [channel, setChannel] = useState<NotifyChannel>("email");
  const [to, setTo] = useState("alerts@example.com");
  const [subject, setSubject] = useState(p.defaultSubject);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState(p.defaultMessage(value));
  const [recoveryNotify, setRecoveryNotify] = useState(true);
  const [touchedName, setTouchedName] = useState(false);
  const [touchedMessage, setTouchedMessage] = useState(false);

  const changePreset = (k: PresetKind) => {
    setPreset(k);
    setValue(PRESETS[k].needsValue ?? "");
    setSeverity(PRESETS[k].defaultSeverity);
    setCooldown(PRESETS[k].defaultCooldown);
    setSubject(PRESETS[k].defaultSubject);
    setMessage(PRESETS[k].defaultMessage(PRESETS[k].needsValue ?? ""));
    setTouchedMessage(false);
  };

  const changeValue = (v: string) => {
    setValue(v);
    if (!touchedMessage) setMessage(p.defaultMessage(v));
  };

  const autoName = slug(`${preset === "custom" ? "custom" : preset}-${
    targetKind === "all" ? "any" : targetKind === "brand" ? targetBrand : targetKind === "tag" ? targetTag : targetServer
  }`);
  const effectiveName = touchedName && name ? slug(name) : autoName;

  const toList = to.split(",").map((s) => s.trim()).filter(Boolean);
  const yamlBlock = renderRuleYaml({
    name: effectiveName, target, when, message, severity, cooldown,
    channel, to: toList.length ? toList : ["alerts@example.com"],
    subject, url, secret, recoveryNotify,
  });

  const canInsert = when.trim().length > 0 &&
    (channel === "email" ? toList.length > 0 : /^https?:\/\/.+/i.test(url.trim()));

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/30 py-10"
      onClick={onClose}>
      <div className="w-[640px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-[14px] font-semibold">Alert flow generator</h2>
        <p className="mb-4 text-[12px] text-ink-3">
          Build a rule step by step — it's added to the editor as YAML, ready to review before saving.
        </p>

        <label className="mb-1 block text-[12px] text-ink-2">Applies to</label>
        <div className="mb-3 flex gap-2">
          <select className={`${inputCls} !w-40`} value={targetKind}
            onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
            <option value="all">All servers</option>
            <option value="brand">Brand / group</option>
            <option value="tag">Tag</option>
            <option value="server">Specific server</option>
          </select>
          {targetKind === "brand" && (
            <select className={inputCls} value={targetBrand} onChange={(e) => setTargetBrand(e.target.value)}>
              {brands.map((b) => <option key={b}>{b}</option>)}
            </select>
          )}
          {targetKind === "tag" && (
            tags.length > 0 ? (
              <select className={inputCls} value={targetTag} onChange={(e) => setTargetTag(e.target.value)}>
                {tags.map((t) => <option key={t}>{t}</option>)}
              </select>
            ) : (
              <input className={inputCls} placeholder="production" value={targetTag}
                onChange={(e) => setTargetTag(e.target.value)} />
            )
          )}
          {targetKind === "server" && (
            <select className={inputCls} value={targetServer} onChange={(e) => setTargetServer(e.target.value)}>
              {servers.map((s) => <option key={s.id}>{s.display_name}</option>)}
            </select>
          )}
        </div>

        <label className="mb-1 block text-[12px] text-ink-2">When</label>
        <select className={`${inputCls} mb-2`} value={preset}
          onChange={(e) => changePreset(e.target.value as PresetKind)}>
          {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {preset !== "custom" && p.needsValue !== undefined && (
          <input className={`${inputCls} mb-2`} value={value} placeholder={p.needsValue}
            onChange={(e) => changeValue(e.target.value)} />
        )}
        {preset === "custom" && (
          <textarea className={`${inputCls} mb-2 h-16 font-mono text-[12px]`}
            placeholder='e.g. status == online and disk.min_free_pct < 5'
            value={customWhen} onChange={(e) => setCustomWhen(e.target.value)} />
        )}
        <div className="mb-3 border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink-2">
          when: {when || <span className="text-ink-3">— enter a condition —</span>}
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">Severity</label>
            <select className={inputCls} value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-ink-2">Cooldown</label>
            <input className={inputCls} value={cooldown} placeholder="30m"
              onChange={(e) => setCooldown(e.target.value)} />
          </div>
        </div>

        <label className="mb-1 block text-[12px] text-ink-2">
          Message <span className="text-ink-3">(shown in incident history, the dashboard, and emails)</span>
        </label>
        <input className={`${inputCls} mb-3`} value={message} placeholder="e.g. {{server}} is offline"
          onChange={(e) => { setTouchedMessage(true); setMessage(e.target.value); }} />

        <label className="mb-1 block text-[12px] text-ink-2">Notify via</label>
        <select className={`${inputCls} mb-2`} value={channel}
          onChange={(e) => setChannel(e.target.value as NotifyChannel)}>
          <option value="email">Email</option>
          <option value="slack">Slack (incoming webhook)</option>
          <option value="teams">Microsoft Teams (incoming webhook)</option>
          <option value="webhook">Generic webhook</option>
        </select>

        {channel === "email" ? (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">To (comma-separated emails)</label>
            <input className={`${inputCls} mb-3`} value={to} onChange={(e) => setTo(e.target.value)} />
            <label className="mb-1 block text-[12px] text-ink-2">Email subject</label>
            <input className={`${inputCls} mb-3`} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </>
        ) : (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">
              {channel === "slack" ? "Slack webhook URL" : channel === "teams" ? "Teams webhook URL" : "Webhook URL"}
            </label>
            <input className={`${inputCls} mb-3 font-mono`} placeholder="https://…" value={url}
              onChange={(e) => setUrl(e.target.value)} />
            {channel === "webhook" && (
              <>
                <label className="mb-1 block text-[12px] text-ink-2">
                  Shared secret <span className="text-ink-3">(sent as the X-Alfred-Secret header, optional)</span>
                </label>
                <input className={`${inputCls} mb-3 font-mono`} value={secret}
                  onChange={(e) => setSecret(e.target.value)} />
              </>
            )}
          </>
        )}

        <label className="mb-1 block text-[12px] text-ink-2">Rule name</label>
        <input className={`${inputCls} mb-3 font-mono`} value={touchedName ? name : autoName}
          onChange={(e) => { setTouchedName(true); setName(e.target.value); }} />

        <label className="mb-3 flex items-center gap-2 text-[12px] text-ink-2">
          <input type="checkbox" checked={recoveryNotify}
            onChange={(e) => setRecoveryNotify(e.target.checked)} />
          Send a RESOLVED email when the condition clears
        </label>

        <div className="mb-4 border border-line bg-paper p-2 font-mono text-[11px] leading-relaxed">
          <pre className="overflow-x-auto whitespace-pre">{yamlBlock}</pre>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!canInsert} onClick={() => onInsert(yamlBlock)}>
            Insert into editor
          </Button>
        </div>
      </div>
    </div>
  );
}
