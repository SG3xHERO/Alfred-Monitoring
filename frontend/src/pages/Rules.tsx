import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { get, post, put } from "../api";
import type { Server } from "../types";
import { ts } from "../format";
import { Panel, Button, inputCls } from "../components/bits";
import FlowGenerator from "../components/FlowGenerator";
import { useCanManage, useMe } from "../useMe";

interface DryRunRow {
  server: string;
  server_id: number;
  rule: string;
  check: string;
  when: string;
  message: string;
  fires: boolean;
  error: string | null;
  would_notify: Array<{ channel: string; label: string; subject?: string }>;
}

export default function Rules() {
  const [yaml, setYaml] = useState("");
  const [meta, setMeta] = useState<{ updated_at: string | null; updated_by?: string }>({ updated_at: null });
  const [errors, setErrors] = useState<string[]>([]);
  const [counts, setCounts] = useState({ rules: 0, checks: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [dryServer, setDryServer] = useState("");
  const [dryRun, setDryRun] = useState<DryRunRow[] | null>(null);
  const [reference, setReference] = useState<{ paths: Record<string, string>; functions: Record<string, string> } | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const validateTimer = useRef<ReturnType<typeof setTimeout>>();
  const me = useMe();
  const canManage = useCanManage();

  useEffect(() => {
    get<{ yaml: string; updated_at: string | null; updated_by?: string }>("/api/rules")
      .then((r) => { setYaml(r.yaml); setMeta(r); validate(r.yaml); });
    get<Server[]>("/api/servers").then(setServers).catch(() => {});
    get("/api/rules/reference").then(setReference).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validate = useCallback((text: string) => {
    post<{ ok: boolean; errors: string[]; rule_count: number; check_count: number }>(
      "/api/rules/validate", { yaml: text })
      .then((r) => {
        setErrors(r.errors);
        setCounts({ rules: r.rule_count, checks: r.check_count });
      })
      .catch(() => {});
  }, []);

  const onChange = (value?: string) => {
    const text = value ?? "";
    setYaml(text);
    setDirty(true);
    setDryRun(null);
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => validate(text), 500);
  };

  const save = async () => {
    setSaving(true);
    try {
      await put("/api/rules", { yaml });
      setDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      setMeta({ updated_at: new Date().toISOString() });
    } catch (err: any) {
      setErrors(err.errors ?? [err.message]);
    } finally {
      setSaving(false);
    }
  };

  const runDry = async () => {
    try {
      const r = await post<{ results: DryRunRow[] }>("/api/rules/dry-run", {
        yaml, server_id: dryServer || undefined,
      });
      setDryRun(r.results);
    } catch (err: any) {
      setErrors(err.errors ?? [err.message]);
    }
  };

  // Appends a generated rule block onto the document — rules: is always the final
  // top-level section in the templates this app produces, so appending is safe.
  const insertRuleBlock = (block: string) => {
    let next: string;
    if (/^\s*$/.test(yaml)) {
      next = `rules:\n${block}`;
    } else if (/^rules:\s*$/m.test(yaml)) {
      next = `${yaml.replace(/\s*$/, "")}\n${block}`;
    } else if (/rules:/.test(yaml)) {
      next = `${yaml.replace(/\s*$/, "")}\n${block}`;
    } else {
      next = `${yaml.replace(/\s*$/, "")}\n\nrules:\n${block}`;
    }
    onChange(next);
    setShowGenerator(false);
  };

  if (me && !canManage) {
    return <div className="text-[13px] text-ink-3">Rules are admin/operator-only.</div>;
  }

  return (
    <div className="-mx-4 px-4 sm:mx-[calc(50%-50vw)] sm:px-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-[15px] font-semibold">Alert rules</h1>
          <span className="text-[12px] text-ink-3">
            {counts.rules} rules, {counts.checks} checks
            {meta.updated_at && ` · last saved ${ts(meta.updated_at)}`}
            {meta.updated_by && ` by ${meta.updated_by}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {savedFlash && <span className="text-[12px] text-ok">Saved ✓</span>}
          {!canManage && <span className="text-[12px] text-ink-3">read-only (viewer)</span>}
          {canManage && <Button onClick={() => setShowGenerator(true)}>Alert flow generator</Button>}
          {canManage && (
            <Button kind="primary" disabled={!dirty || errors.length > 0 || saving} onClick={save}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div>
          <div className="border border-line">
            <Editor
              height="calc(100vh - 260px)"
              theme="vs-dark"
              language="yaml"
              value={yaml}
              onChange={onChange}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "ui-monospace, Cascadia Mono, Consolas, monospace",
                scrollBeyondLastLine: false,
                renderLineHighlight: "line",
                lineNumbersMinChars: 3,
                tabSize: 2,
                wordWrap: "on",
                wrappingIndent: "indent",
                readOnly: !canManage,
              }}
            />
          </div>

          {errors.length > 0 && (
            <div className="mt-2 border border-crit bg-crit-bg p-3">
              <div className="mb-1 text-[12px] font-semibold text-crit">
                {errors.length} validation error{errors.length > 1 ? "s" : ""} — saving disabled
              </div>
              <ul className="text-[12px] text-crit">
                {errors.map((e, i) => <li key={i} className="font-mono">{e}</li>)}
              </ul>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <select className={`${inputCls} !w-64`} value={dryServer}
              onChange={(e) => setDryServer(e.target.value)}>
              <option value="">Dry-run against all servers</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.display_name}</option>
              ))}
            </select>
            <Button disabled={errors.length > 0} onClick={runDry}>Dry-run</Button>
            <span className="text-[12px] text-ink-3">
              Evaluates against last known metrics. Nothing is saved or sent.
            </span>
          </div>

          {dryRun && (
            <div className="mt-2 border border-line bg-panel">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
                    <th className="px-3 py-1.5">Server</th>
                    <th className="py-1.5 pr-3">Rule / check</th>
                    <th className="py-1.5 pr-3">Message</th>
                    <th className="py-1.5 pr-3">Condition</th>
                    <th className="py-1.5 pr-3">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {dryRun.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-3 text-ink-3">
                      No rule targets matched any server.
                    </td></tr>
                  )}
                  {dryRun.map((r, i) => (
                    <tr key={i} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-1.5">{r.server}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.rule} / {r.check}</td>
                      <td className="py-1.5 pr-3">{r.message}</td>
                      <td className="py-1.5 pr-3 font-mono text-ink-2">{r.when}</td>
                      <td className="py-1.5 pr-3">
                        {r.error
                          ? <span className="text-warn">error: {r.error}</span>
                          : r.fires
                            ? <span className="font-medium text-crit">
                                WOULD FIRE
                                {r.would_notify.map((n, j) => (
                                  <span key={j} className="block font-normal text-ink-2">
                                    → {n.label}{n.subject ? `: “${n.subject}”` : ""}
                                  </span>
                                ))}
                              </span>
                            : <span className="text-ok">ok</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <Panel title="Reference">
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto overflow-x-hidden break-words p-3 text-[12px] leading-relaxed">
            <div className="mb-1 font-semibold">Structure</div>
            <pre className="mb-3 max-w-full overflow-x-auto border border-line bg-paper p-2 font-mono text-[11px]">
{`rules:
  - name: my-rule
    target: HOSTNAME   # or
    # group:Production, tag:production, "*"
    checks:
      - when: <condition>
        message: "{{server}} is down"   # optional, human-readable
        severity: critical
        for: 30s             # must stay firing this long before it's opened (default: instant)
        cooldown: 30m
        resolve_after: 3m   # must stay clear this long before it's resolved
        notify:
          - channel: email
            to: a@b.com, oncall@b.com   # comma-separated or a YAML list, either works
            subject: "🔴 {{server}} down"
          - channel: slack   # or teams
            url: https://hooks.slack.com/services/...
          - channel: webhook
            url: https://example.com/hook
            secret: sharedSecret   # optional, sent as X-Alfred-Secret
          - channel: email
            to: oncall@b.com
            after: 15m   # escalation: only sent if still firing 15m after first seen
    recovery_notify: true`}
            </pre>
            <div className="mb-1 font-semibold">Notify channels</div>
            <dl className="mb-3">
              <div className="mb-1">
                <dt className="font-mono text-[11px]">email</dt>
                <dd className="text-ink-3">
                  to (required — one address, a YAML list, or a comma-separated string; the first address is
                  the To, the rest are Cc'd), subject (optional)
                </dd>
              </div>
              <div className="mb-1">
                <dt className="font-mono text-[11px]">slack / teams</dt>
                <dd className="text-ink-3">url — the incoming webhook URL</dd>
              </div>
              <div className="mb-1">
                <dt className="font-mono text-[11px]">webhook</dt>
                <dd className="text-ink-3">
                  url, optional secret. POSTs {"{"}server_id, rule, check, severity, message, status, timestamp{"}"}.
                </dd>
              </div>
              <div className="mb-1">
                <dt className="font-mono text-[11px]">after (any channel)</dt>
                <dd className="text-ink-3">
                  escalation delay — this target is only notified once the alert has been continuously
                  firing for this long and hasn't cleared. Sent exactly once per incident.
                </dd>
              </div>
              <div className="mb-1">
                <dt className="font-mono text-[11px]">for (rule or check level, or defaults.for)</dt>
                <dd className="text-ink-3">
                  how long a condition must stay continuously true before an incident opens and the first
                  notification goes out — a blip below this window is ignored entirely. Defaults to 0s
                  (fires instantly). Note: this only delays the alert — a server's OFFLINE label on the
                  Wall/Overview reflects its real connection status immediately, independent of any rule.
                </dd>
              </div>
              <div className="mb-1">
                <dt className="font-mono text-[11px]">resolve_after (rule or check level, or defaults.resolve_after)</dt>
                <dd className="text-ink-3">
                  how long a check must stay clear before it's declared resolved and the recovery email
                  goes out. A relapse before this window elapses restarts the countdown, so a flapping
                  check never sends a premature "resolved". Defaults to 3m; set to 0s to resolve instantly.
                </dd>
              </div>
            </dl>
            <div className="mb-1 font-semibold">Metrics</div>
            <dl className="mb-3">
              {reference && Object.entries(reference.paths).map(([k, v]) => (
                <div key={k} className="mb-1">
                  <dt className="font-mono text-[11px]">{k}</dt>
                  <dd className="text-ink-3">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mb-1 font-semibold">Functions</div>
            <dl>
              {reference && Object.entries(reference.functions).map(([k, v]) => (
                <div key={k} className="mb-1">
                  <dt className="font-mono text-[11px]">{k}</dt>
                  <dd className="text-ink-3">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
      </div>

      {showGenerator && (
        <FlowGenerator
          servers={servers}
          onInsert={insertRuleBlock}
          onClose={() => setShowGenerator(false)}
        />
      )}
    </div>
  );
}
