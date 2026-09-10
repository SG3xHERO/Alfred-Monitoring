import { ReferenceLine } from "recharts";
import type { Annotation } from "../types";

/**
 * Chart annotation markers — a thin vertical line in --color-line-2 with the
 * note text as a native SVG tooltip on hover. Deliberately quiet.
 *
 * Recharts references category x-axes by label, so annotations are snapped to
 * the nearest rendered bucket first.
 */

export interface BucketedAnnotation {
  t: string;       // the chart's category label for the bucket this annotation lands in
  texts: string[]; // one line per annotation in that bucket
}

export function bucketAnnotations(
  annotations: Annotation[],
  data: Array<{ bucket: string; t: string }>,
): BucketedAnnotation[] {
  if (annotations.length === 0 || data.length < 2) return [];
  const buckets = data.map((d) => ({ at: new Date(d.bucket).getTime(), t: d.t }));
  const byLabel = new Map<string, string[]>();
  for (const a of annotations) {
    const at = new Date(a.time).getTime();
    if (at < buckets[0].at || at > buckets[buckets.length - 1].at + (buckets[1].at - buckets[0].at)) continue;
    let best = buckets[0];
    for (const b of buckets) if (Math.abs(b.at - at) < Math.abs(best.at - at)) best = b;
    const line = a.created_by ? `${a.text} — ${a.created_by}` : a.text;
    if (!byLabel.has(best.t)) byLabel.set(best.t, []);
    byLabel.get(best.t)!.push(line);
  }
  return [...byLabel.entries()].map(([t, texts]) => ({ t, texts }));
}

/** ReferenceLine elements to spread as direct children of a Recharts chart. */
export function annotationLines(items: BucketedAnnotation[]) {
  return items.map((a) => (
    <ReferenceLine
      key={`anno-${a.t}`}
      x={a.t}
      stroke="var(--color-line-2)"
      strokeWidth={1}
      isFront
      label={(props: any) => {
        const { viewBox } = props;
        return (
          <g>
            <title>{a.texts.join("\n")}</title>
            <circle cx={viewBox.x} cy={viewBox.y + 4} r={2.5} fill="var(--color-line-2)" />
            {/* invisible fat hit-area so the tooltip is easy to reach */}
            <rect x={viewBox.x - 5} y={viewBox.y} width={10} height={viewBox.height}
              fill="transparent" />
          </g>
        );
      }}
    />
  ));
}
