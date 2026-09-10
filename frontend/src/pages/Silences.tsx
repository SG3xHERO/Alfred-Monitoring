import { useCallback, useEffect, useState } from "react";
import { get, post, del } from "../api";
import type { SilenceWindow, RuleChecks, Server } from "../types";
import { ts } from "../format";
import { Button, inputCls, Panel } from "../components/bits";
import { useCanManage, useMe } from "../useMe";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// picker shows Mon..Sun, values stay 0=Sun..6=Sat
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ALL_RULES = "*"; // scope sentinel: silence every rule on the target

export default function Silences() {
  const [windows, setWindows] = useState<SilenceWindow[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [ruleChecks, setRuleChecks] = useState<RuleChecks[]>([]);
  const [mode, setMode] = useState<"once" | "recurring">("once");
  const [target, setTarget] = useState("*");
  const [ruleName, setRuleName] = useState(ALL_RULES);
  const [checkKey, setCheckKey] = useState(ALL_RULES);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [timeStart, setTimeStart] = useState("02:00");
  const [timeEnd, setTimeEnd] = useState("03:00");
  const [days, setDays] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const me = useMe();
  const canManage = useCanManage();

  const load = useCallback(() => {
    get<SilenceWindow[]>("/api/maintenance").then(setWindows).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEffect(() => { get<Server[]>("/api/servers").then(setServers).catch(() => {}); }, []);
  useEffect(() => { get<RuleChecks[]>("/api/rules/checks").then(setRuleChecks).catch(() => {}); }, []);

  const availableChecks = ruleChecks.find((r) => r.name === ruleName)?.checks ?? [];

  const create = async () => {
    setError("");
    try {
      const scope = {
        rule_name: ruleName === ALL_RULES ? null : ruleName,
        check_key: ruleName === ALL_RULES || checkKey === ALL_RULES ? null : checkKey,
      };
      await post("/api/maintenance", mode === "recurring"
        ? { target, recurrence: "recurring", time_start: timeStart, time_end: timeEnd, days, note: note || null, ...scope }
        : {
            target,
            starts_at: new Date(start).toISOString(),
            ends_at: new Date(end).toISOString(),
            note: note || null,
            ...scope,
          });
      setNote(""); setStart(""); setEnd("");
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const activeOnce = (w: SilenceWindow) =>
    w.recurrence !== "recurring" &&
    new Date(w.starts_at) <= new Date() && new Date(w.ends_at) > new Date();

  const scopeLabel = (w: SilenceWindow) =>
    w.rule_name ? (w.check_key ? `${w.rule_name} / ${w.check_key}` : `${w.rule_name} (all checks)`) : "all rules";

  const recurring = windows.filter((w) => w.recurrence === "recurring");
  const oneOff = windows.filter((w) => w.recurrence !== "recurring");

  if (me && !canManage) {
    return <div className="text-[13px] text-ink-3">Silences are admin/operator-only.</div>;
  }

  return (
    <div>
      <h1 className="mb-3 text-[15px] font-semibold">Silences</h1>
      <p className="mb-4 text-[13px] text-ink-2">
        Suppresses matching alerts while a window is active — scope it to one specific rule/check
        (e.g. just db01's CPU alert) or leave it as "all rules" to silence everything on the
        target, the way a maintenance window works. Incidents are still recorded (marked
        "suppressed"), and anything still firing when the window ends notifies as normal.
      </p>

      {canManage && (
        <Panel title="Schedule a silence" right={
          <div className="flex gap-1">
            {(["once", "recurring"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-[12px] border ${mode === m
                  ? "border-ink bg-ink text-ink-contrast"
                  : "border-line-2 text-ink-2 hover:text-ink"}`}>
                {m === "once" ? "One-off" : "Recurring"}
              </button>
            ))}
          </div>
        }>
          <div className="flex flex-wrap items-end gap-3 p-3">
            <div className="w-56">
              <label className="mb-1 block text-[12px] text-ink-2">Target</label>
              <select className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="*">All servers</option>
                {[...new Set(servers.map((s) => s.brand))].map((b) => (
                  <option key={b} value={`group:${b}`}>group: {b}</option>
                ))}
                {servers.map((s) => (
                  <option key={s.id} value={s.display_name}>{s.display_name}</option>
                ))}
              </select>
            </div>

            <div className="w-48">
              <label className="mb-1 block text-[12px] text-ink-2">Rule</label>
              <select className={inputCls} value={ruleName}
                onChange={(e) => { setRuleName(e.target.value); setCheckKey(ALL_RULES); }}>
                <option value={ALL_RULES}>All rules</option>
                {ruleChecks.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            </div>

            {ruleName !== ALL_RULES && (
              <div className="w-48">
                <label className="mb-1 block text-[12px] text-ink-2">Check</label>
                <select className={inputCls} value={checkKey} onChange={(e) => setCheckKey(e.target.value)}>
                  <option value={ALL_RULES}>All checks in this rule</option>
                  {availableChecks.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}

            {mode === "once" ? (
              <>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Starts</label>
                  <input className={inputCls} type="datetime-local" value={start}
                    onChange={(e) => setStart(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Ends</label>
                  <input className={inputCls} type="datetime-local" value={end}
                    onChange={(e) => setEnd(e.target.value)} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">Between</label>
                  <div className="flex items-center gap-1">
                    <input className={`${inputCls} !w-28`} type="time" value={timeStart}
                      onChange={(e) => setTimeStart(e.target.value)} />
                    <span className="text-[13px] text-ink-3">–</span>
                    <input className={`${inputCls} !w-28`} type="time" value={timeEnd}
                      onChange={(e) => setTimeEnd(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-ink-2">
                    On days <span className="text-ink-3">(none = every day)</span>
                  </label>
                  <div className="flex gap-1">
                    {DAY_ORDER.map((d) => (
                      <button key={d} onClick={() => toggleDay(d)}
                        className={`px-1.5 py-1 text-[11px] border ${days.includes(d)
                          ? "border-ink bg-ink text-ink-contrast"
                          : "border-line-2 text-ink-2 hover:text-ink"}`}>
                        {DAY_LABELS[d]}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="min-w-40 flex-1">
              <label className="mb-1 block text-[12px] text-ink-2">Note</label>
              <input className={inputCls} value={note}
                placeholder={mode === "recurring" ? "nightly backup reboot" : "OS patching"}
                onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button kind="primary"
              disabled={mode === "once" ? (!start || !end) : (!timeStart || !timeEnd || timeStart === timeEnd)}
              onClick={create}>
              Add
            </Button>
          </div>
          {mode === "recurring" && (
            <div className="px-3 pb-2 text-[12px] text-ink-3">
              Every {days.length === 0 ? "day" : [...days].sort().map((d) => DAY_LABELS[d]).join(", ")} between{" "}
              {timeStart} and {timeEnd} (UK time), matching alerts on the target are suppressed. If it's
              still firing when the window closes, notifications fire as normal.
            </div>
          )}
          {error && <div className="px-3 pb-3 text-[12px] text-crit">{error}</div>}
        </Panel>
      )}

      {recurring.length > 0 && (
        <div className="mt-4">
          <Panel title="Recurring">
            <table className="w-full text-[13px]">
              <tbody>
                {recurring.map((w) => (
                  <tr key={w.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 w-8"></td>
                    <td className="py-2 pr-3 font-mono text-[12px]">{w.target}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-2">{scopeLabel(w)}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-2">
                      {w.days && w.days.length > 0
                        ? [...w.days].sort().map((d) => DAY_LABELS[d]).join(", ")
                        : "every day"}{" "}
                      {w.time_start}–{w.time_end}
                    </td>
                    <td className="py-2 pr-3 text-ink-2">{w.note}</td>
                    <td className="py-2 pr-3 text-right">
                      {canManage && (
                        <button className="text-[12px] text-crit hover:underline"
                          onClick={async () => { await del(`/api/maintenance/${w.id}`); load(); }}>
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}

      <div className="mt-4">
        <Panel title="One-off — scheduled and recent">
          {oneOff.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-ink-3">No one-off silences.</div>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {oneOff.map((w) => (
                  <tr key={w.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 w-8">
                      {activeOnce(w) && <span className="inline-block h-2 w-2 rounded-full bg-warn" title="active now" />}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[12px]">{w.target}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-2">{scopeLabel(w)}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-2">
                      {ts(w.starts_at)} → {ts(w.ends_at)}
                    </td>
                    <td className="py-2 pr-3 text-ink-2">{w.note}</td>
                    <td className="py-2 pr-3 text-right">
                      {canManage && (
                        <button className="text-[12px] text-crit hover:underline"
                          onClick={async () => { await del(`/api/maintenance/${w.id}`); load(); }}>
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
