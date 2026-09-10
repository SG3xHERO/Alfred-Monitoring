import { useRef, useState } from "react";
import { get, post } from "../api";
import { Panel, Button } from "../components/bits";
import { useMe } from "../useMe";

const SECTIONS = ["brands", "credentials", "data_connections", "probe_variables", "servers", "probes"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABELS: Record<Section, string> = {
  brands: "Brands / groups",
  credentials: "Credentials",
  data_connections: "Data connections",
  probe_variables: "Probe variables",
  servers: "Servers (agents)",
  probes: "Probes (HTTP/TCP/API/Ping/Directory/Data)",
};

interface PreviewItem { name: string; exists: boolean; [k: string]: unknown }
interface PreviewBundle { version: number; exported_at: string | null; sections: Record<Section, PreviewItem[]> }

export default function ImportExport() {
  const me = useMe();
  if (me && me.role !== "admin") {
    return <div className="text-[13px] text-ink-3">Import / Export is admin-only.</div>;
  }
  return (
    <div>
      <h1 className="mb-4 text-[15px] font-semibold">Import / Export</h1>
      <div className="mb-4"><ExportPanel /></div>
      <ImportPanel />
    </div>
  );
}

function ExportPanel() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError("");
    setBusy(true);
    try {
      const bundle = await get("/api/export");
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `alfred-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Export">
      <div className="p-3">
        <p className="mb-3 text-[12px] text-ink-3">
          Downloads brands, credentials, data connections, probe variables, agent server registrations and probes
          (HTTP/TCP/API/Ping/Directory/Data) as one JSON file. Secrets stay encrypted at rest in the export — it's
          only portable to a deploy that shares the same <span className="font-mono">ALFRED_MASTER_KEY</span>.
          Agent servers can't carry their API key over (it's a secret shown once, never stored in reversible form) —
          importing one mints a fresh key that the physical agent's config then needs updating with.
        </p>
        {error && <div className="mb-3 text-[12px] text-crit">{error}</div>}
        <Button kind="primary" disabled={busy} onClick={download}>{busy ? "Preparing…" : "Download export"}</Button>
      </div>
    </Panel>
  );
}

function ImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState<any | null>(null);
  const [preview, setPreview] = useState<PreviewBundle | null>(null);
  const [selected, setSelected] = useState<Record<Section, Set<string>>>(
    Object.fromEntries(SECTIONS.map((s) => [s, new Set<string>()])) as Record<Section, Set<string>>,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    summary: Record<string, { created: number; updated: number; skipped: number }>;
    warnings: string[];
    new_agent_keys: Array<{ display_name: string; api_key: string }>;
    new_push_keys: Array<{ display_name: string; push_key: string }>;
  } | null>(null);

  const onFile = async (file: File) => {
    setError("");
    setResult(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      setRaw(data);
      const p = await post<PreviewBundle>("/api/import/preview", data);
      setPreview(p);
      // pre-check every item that doesn't already exist; leave existing ones unchecked
      const next = Object.fromEntries(SECTIONS.map((s) => [
        s, new Set((p.sections[s] ?? []).filter((i) => !i.exists).map((i) => i.name)),
      ])) as Record<Section, Set<string>>;
      setSelected(next);
    } catch (err: any) {
      setError(err.message || "could not read that file");
    }
  };

  const toggle = (section: Section, name: string) => {
    setSelected((prev) => {
      const next = new Set(prev[section]);
      if (next.has(name)) next.delete(name); else next.add(name);
      return { ...prev, [section]: next };
    });
  };

  const selectAllNew = () => {
    if (!preview) return;
    const next = Object.fromEntries(SECTIONS.map((s) => [
      s, new Set((preview.sections[s] ?? []).filter((i) => !i.exists).map((i) => i.name)),
    ])) as Record<Section, Set<string>>;
    setSelected(next);
  };

  const apply = async () => {
    if (!raw) return;
    setBusy(true);
    setError("");
    try {
      const body = { data: raw, selected: Object.fromEntries(SECTIONS.map((s) => [s, [...selected[s]]])) };
      const r = await post<{
        ok: boolean; summary: any; warnings: string[];
        new_agent_keys: Array<{ display_name: string; api_key: string }>;
        new_push_keys: Array<{ display_name: string; push_key: string }>;
      }>("/api/import/apply", body);
      setResult(r);
      setPreview(null);
      setRaw(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const totalSelected = SECTIONS.reduce((n, s) => n + selected[s].size, 0);

  return (
    <Panel title="Import">
      <div className="p-3">
        <p className="mb-3 text-[12px] text-ink-3">
          Pick an export file (or the converted legacy task list) to preview what it contains — items that already
          exist here (matched by name) start unchecked so re-importing is safe.
        </p>
        <input ref={fileRef} type="file" accept="application/json"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} className="text-[12px]" />
        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}

        {result && (
          <div className="mt-3 border border-line bg-paper p-3 text-[12px]">
            <div className="mb-1 font-semibold">Import complete</div>
            {SECTIONS.map((s) => {
              const c = result.summary[s];
              if (!c || (c.created === 0 && c.updated === 0 && c.skipped === 0)) return null;
              return <div key={s}>{SECTION_LABELS[s]}: {c.created} created, {c.updated} updated, {c.skipped} skipped</div>;
            })}
            {result.warnings.length > 0 && (
              <div className="mt-2 text-warn">
                {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
            {(result.new_agent_keys.length > 0 || result.new_push_keys.length > 0) && (
              <div className="mt-3 border-t border-line pt-2">
                <div className="mb-1 font-semibold text-ok">New keys — copy these now, they won't be shown again</div>
                {result.new_agent_keys.map((k) => (
                  <div key={k.display_name} className="mt-1 border border-line bg-panel p-2 font-mono text-[11px] break-all">
                    {k.display_name}: {k.api_key}
                  </div>
                ))}
                {result.new_push_keys.map((k) => (
                  <div key={k.display_name} className="mt-1 border border-line bg-panel p-2 font-mono text-[11px] break-all">
                    {k.display_name} (push key): {k.push_key}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {preview && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <Button onClick={selectAllNew}>Select all new</Button>
              <span className="text-[12px] text-ink-3">{totalSelected} item(s) selected</span>
            </div>
            {SECTIONS.map((s) => {
              const items = preview.sections[s] ?? [];
              if (items.length === 0) return null;
              return (
                <div key={s} className="mb-3 border border-line">
                  <div className="border-b border-line bg-paper px-3 py-1.5 text-[12px] font-semibold">{SECTION_LABELS[s]}</div>
                  <ul className="text-[13px]">
                    {items.map((item) => (
                      <li key={item.name} className="flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-b-0">
                        <input type="checkbox" checked={selected[s].has(item.name)} onChange={() => toggle(s, item.name)} />
                        <span>{item.name}</span>
                        {item.exists && <span className="text-[11px] text-ink-3">already exists</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <Button kind="primary" disabled={busy || totalSelected === 0} onClick={apply}>
              {busy ? "Importing…" : `Import ${totalSelected} selected item(s)`}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
