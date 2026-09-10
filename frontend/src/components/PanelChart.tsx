import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { get, post } from "../api";
import type { Annotation, DashPanel, PanelData } from "../types";
import { bps } from "../format";
import { bucketAnnotations, annotationLines } from "./annotations";

const LINE_COLORS = ["var(--color-ink)", "var(--color-ink-3)", "var(--color-warn)", "var(--color-crit)"];

export const PANEL_HEIGHTS: Record<DashPanel["height"], string> = { s: "h-32", m: "h-44", l: "h-64" };

function fmtValue(v: number | null | undefined, unit: string): string {
  if (v == null) return "—";
  if (unit === "%") return `${v.toFixed(1)}%`;
  if (unit === "bps") return bps(v);
  if (unit === "ms") return `${Math.round(v)} ms`;
  if (unit === "days") return `${Math.floor(v)}d`;
  return String(v);
}

/**
 * One dashboard panel: fetches its own series for the given spec and renders
 * a line chart, bar chart or single stat. Shared by the viewer and the
 * builder's live preview. refreshKey bumps re-fetch (SSE tick / spec edits).
 */
export function PanelChart({ panel, refreshKey = 0, wallToken }: { panel: DashPanel; refreshKey?: number; wallToken?: string }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    const tokenQs = wallToken ? `wall_token=${encodeURIComponent(wallToken)}` : "";
    post<PanelData>(`/api/dashboards/panel-data${tokenQs ? `?${tokenQs}` : ""}`, {
      metrics: panel.metrics, target: panel.target, agg: panel.agg, range: panel.range,
    })
      .then((d) => { if (!stale) { setData(d); setError(""); } })
      .catch((err) => { if (!stale) setError(err.message); });
    get<Annotation[]>(`/api/annotations?target=${encodeURIComponent(panel.target)}&range=${panel.range}${tokenQs ? `&${tokenQs}` : ""}`)
      .then((a) => { if (!stale) setAnnotations(a); })
      .catch(() => {});
    return () => { stale = true; };
  }, [panel.metrics.join(","), panel.target, panel.agg, panel.range, refreshKey, wallToken]);

  const heightCls = PANEL_HEIGHTS[panel.height] ?? PANEL_HEIGHTS.m;

  if (error) return <div className={`${heightCls} flex items-center justify-center text-[12px] text-crit`}>{error}</div>;
  if (!data) return <div className={`${heightCls} flex items-center justify-center text-[12px] text-ink-3`}>Loading…</div>;
  if (data.matched === 0) {
    return <div className={`${heightCls} flex items-center justify-center text-[12px] text-ink-3`}>
      No servers match “{panel.target}”
    </div>;
  }

  const unit = data.series[0]?.unit ?? "%";

  if (panel.chart === "stat") {
    return (
      <div className={`${heightCls} flex items-center justify-around px-2`}>
        {data.series.map((s) => {
          const last = [...s.points].reverse().find((p) => p.value != null);
          return (
            <div key={s.metric} className="text-center">
              <div className="font-mono text-[28px] leading-tight">{fmtValue(last?.value, s.unit)}</div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-ink-3">{s.label}</div>
            </div>
          );
        })}
      </div>
    );
  }

  // merge series on bucket for a single x-axis
  const byBucket = new Map<string, any>();
  for (const s of data.series) {
    for (const p of s.points) {
      const key = p.bucket;
      if (!byBucket.has(key)) byBucket.set(key, { bucket: key });
      byBucket.get(key)[s.metric] = p.value;
    }
  }
  const longRange = panel.range === "7d" || panel.range === "30d";
  const chartData = [...byBucket.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((r) => ({
      ...r,
      t: new Date(r.bucket).toLocaleString("en-GB",
        longRange ? { day: "2-digit", month: "short" } : { hour: "2-digit", minute: "2-digit" }),
    }));
  const marks = annotationLines(bucketAnnotations(annotations, chartData));

  const axisProps = {
    tick: { fontSize: 10, fill: "var(--color-ink-3)" },
    tickLine: false,
  } as const;
  const tooltipProps = {
    contentStyle: {
      fontSize: 12, borderRadius: 0,
      border: "1px solid var(--color-line)",
      background: "var(--color-panel)", color: "var(--color-ink)",
    },
    formatter: (v: any) => fmtValue(v, unit),
  } as const;

  return (
    <div className={`${heightCls} px-1 py-2`}>
      <ResponsiveContainer width="100%" height="100%">
        {panel.chart === "bar" ? (
          <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="t" {...axisProps} axisLine={{ stroke: "var(--color-line)" }} minTickGap={40} />
            <YAxis {...axisProps} axisLine={false} width={unit === "bps" ? 70 : 40}
              tickFormatter={(v) => fmtValue(v, unit)} />
            <Tooltip {...tooltipProps} />
            {marks}
            {data.series.map((s, i) => (
              <Bar key={s.metric} dataKey={s.metric} name={s.label}
                fill={LINE_COLORS[i % LINE_COLORS.length]} isAnimationActive={false} />
            ))}
          </BarChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="t" {...axisProps} axisLine={{ stroke: "var(--color-line)" }} minTickGap={40} />
            <YAxis {...axisProps} axisLine={false} width={unit === "bps" ? 70 : 40}
              domain={unit === "%" ? [0, 100] : ["auto", "auto"]}
              tickFormatter={(v) => fmtValue(v, unit)} />
            <Tooltip {...tooltipProps} />
            {marks}
            {data.series.map((s, i) => (
              <Line key={s.metric} type="monotone" dataKey={s.metric} name={s.label}
                stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.25}
                dot={false} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
