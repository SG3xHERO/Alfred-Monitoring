import { useState } from "react";
import type { DashPanel } from "../types";
import { inputCls } from "./bits";
import { PanelChart } from "./PanelChart";

export interface MetricOption { key: string; label: string; unit: string }

export const AGGS: DashPanel["agg"][] = ["avg", "min", "max", "sum", "count"];
export const RANGES: DashPanel["range"][] = ["1h", "6h", "24h", "7d", "30d"];
export const CHARTS: DashPanel["chart"][] = ["line", "stat", "bar"];

export function newPanel(seed?: Partial<DashPanel>): DashPanel {
  return {
    id: crypto.randomUUID(),
    title: "",
    metrics: ["cpu.percent"],
    target: "*",
    agg: "avg",
    range: "24h",
    chart: "line",
    width: 1,
    height: "m",
    ...seed,
  };
}

/**
 * A chart panel's editor + live preview — same control set (metrics, target,
 * aggregation, range, chart type, height) used by both the Dashboard builder
 * and the Wall Designer, so a panel behaves identically wherever it's added.
 * Drag-to-reorder, if the caller wants it, is layered on from outside via
 * `dragHandle`/`className` rather than baked in here.
 */
export function PanelEditorCard({ panel, metricOptions, targetOptions, onChange, onRemove, dragHandle, className = "" }: {
  panel: DashPanel;
  metricOptions: MetricOption[];
  targetOptions: Array<{ value: string; label: string }>;
  onChange: (patch: Partial<DashPanel>) => void;
  onRemove: () => void;
  dragHandle?: React.ReactNode;
  className?: string;
}) {
  const [showMetrics, setShowMetrics] = useState(false);

  const toggleMetric = (key: string) => {
    const has = panel.metrics.includes(key);
    if (has && panel.metrics.length === 1) return; // never empty
    onChange({
      metrics: has ? panel.metrics.filter((m) => m !== key)
        : panel.metrics.length >= 4 ? panel.metrics : [...panel.metrics, key],
    });
  };

  const selCls = `${inputCls} !w-auto !py-0.5 !text-[11px]`;

  return (
    <section className={`rounded-panel border border-line bg-panel ${className}`}>
      <header className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        {dragHandle}
        <input
          className="min-w-0 flex-1 border border-transparent bg-transparent px-1 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-ink-2 hover:border-line-2 focus:border-line-2 focus:outline-none"
          placeholder={panel.metrics.join(", ")}
          value={panel.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <button onClick={() => onChange({ width: panel.width === 1 ? 2 : 1 })}
          className="px-1 text-[11px] text-ink-3 hover:text-ink" title="Toggle width">
          {panel.width === 1 ? "⇥ wide" : "⇤ half"}
        </button>
        <select className={selCls} value={panel.height} title="Height"
          onChange={(e) => onChange({ height: e.target.value as DashPanel["height"] })}>
          <option value="s">S</option><option value="m">M</option><option value="l">L</option>
        </select>
        <button onClick={onRemove} className="px-1 text-ink-3 hover:text-crit" title="Remove panel">✕</button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-[11px]">
        <span className="relative">
          <button className="rounded-control border border-line-2 px-1.5 py-0.5 text-ink-2 hover:text-ink"
            onClick={() => setShowMetrics(!showMetrics)}>
            {panel.metrics.length} metric{panel.metrics.length > 1 ? "s" : ""} ▾
          </button>
          {showMetrics && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMetrics(false)} />
              <div className="absolute left-0 top-6 z-20 w-56 rounded-panel border border-line bg-panel p-2 shadow-panel">
                {metricOptions.map((m) => (
                  <label key={m.key} className="flex items-center gap-1.5 px-1 py-0.5 hover:bg-paper">
                    <input type="checkbox" checked={panel.metrics.includes(m.key)}
                      onChange={() => toggleMetric(m.key)} />
                    <span>{m.label}</span>
                    <span className="ml-auto font-mono text-ink-3">{m.key}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </span>
        <select className={selCls} value={panel.target}
          onChange={(e) => onChange({ target: e.target.value })}>
          {targetOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className={selCls} value={panel.agg} title="Aggregation across matched servers"
          onChange={(e) => onChange({ agg: e.target.value as DashPanel["agg"] })}>
          {AGGS.map((a) => <option key={a}>{a}</option>)}
        </select>
        <select className={selCls} value={panel.range}
          onChange={(e) => onChange({ range: e.target.value as DashPanel["range"] })}>
          {RANGES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <select className={selCls} value={panel.chart}
          onChange={(e) => onChange({ chart: e.target.value as DashPanel["chart"] })}>
          {CHARTS.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <PanelChart panel={panel} />
    </section>
  );
}

/** Read-only render of a saved panel — the Wall and dashboard viewer use this, not the editor card. */
export function PanelView({ panel, wallToken }: { panel: DashPanel; wallToken?: string }) {
  return (
    <div className="rounded-panel border border-line bg-panel">
      {panel.title && (
        <div className="border-b border-line px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          {panel.title}
        </div>
      )}
      <PanelChart panel={panel} wallToken={wallToken} />
    </div>
  );
}
