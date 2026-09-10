// Resolves window-function calls (avg/max/min/p95/rate/pct_time/count_true)
// in a parsed condition against recent history, before the ordinary
// synchronous expr evaluator runs. This is an AST rewrite, not a new
// evaluation mode: every window call is replaced with a literal num/bool
// node computed from a pre-fetched sample array, and the rest of the tree
// (and expr.ts itself) is untouched — a check with no window calls costs
// nothing extra.
import { type Expr, type Value, evaluate, truthy } from "./expr.js";
import { parseDuration, WINDOW_FUNC_NAMES } from "./rules.js";

/** One historical sample, sparse — only the metrics actually recorded at that time are non-null. */
export interface WindowSample {
  t: number;
  "cpu.percent"?: number | null;
  "mem.percent"?: number | null;
  "swap.percent"?: number | null;
  "disk.min_free_pct"?: number | null;
  "disk.max_used_pct"?: number | null;
  "net.rx_bps"?: number | null;
  "net.tx_bps"?: number | null;
  "disk.read_bps"?: number | null;
  "disk.write_bps"?: number | null;
}

export type SamplePath = Exclude<keyof WindowSample, "t">;

/** Walks an expr collecting every window call's window duration, in ms. Unparseable durations are skipped (caught earlier at compile time). */
export function maxWindowMs(expr: Expr): number {
  let max = 0;
  const visit = (e: Expr): void => {
    switch (e.kind) {
      case "call":
        if (WINDOW_FUNC_NAMES.has(e.name)) {
          const durArg = e.args[1];
          if (durArg?.kind === "str") {
            const ms = parseDuration(durArg.value);
            if (ms != null) max = Math.max(max, ms);
          }
        }
        e.args.forEach(visit);
        break;
      case "not": visit(e.operand); break;
      case "logic":
      case "cmp": visit(e.left); visit(e.right); break;
    }
  };
  visit(expr);
  return max;
}

/** A no-op eval context for running a predicate against one historical sample — no functions, just metric lookups. */
function sampleContext(sample: WindowSample) {
  return {
    getPath(name: string): Value | undefined {
      return (sample as any)[name] ?? null;
    },
    callFn(): Value {
      return null; // window predicates only support metric comparisons, not user_logged_in() etc.
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeWindow(name: string, argExpr: Expr, windowMs: number, samples: WindowSample[], nowMs: number): Value {
  const cutoff = nowMs - windowMs;
  const inWindow = samples.filter((s) => s.t >= cutoff);

  if (name === "pct_time" || name === "count_true") {
    if (inWindow.length === 0) return name === "pct_time" ? null : 0;
    const ctx = sampleContext(inWindow[0]);
    let trueCount = 0;
    for (const s of inWindow) {
      Object.assign(ctx, { getPath: (n: string) => (s as any)[n] ?? null });
      if (truthy(evaluate(argExpr, ctx))) trueCount++;
    }
    return name === "pct_time" ? (trueCount / inWindow.length) * 100 : trueCount;
  }

  // avg/max/min/p95/rate all read a single bare metric path
  if (argExpr.kind !== "path") return null;
  const path = argExpr.name as SamplePath;
  const values = inWindow.map((s) => s[path]).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;

  switch (name) {
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "max": return Math.max(...values);
    case "min": return Math.min(...values);
    case "p95": return percentile([...values].sort((a, b) => a - b), 95);
    case "rate": {
      if (values.length < 2) return null;
      const hours = windowMs / 3_600_000;
      return hours > 0 ? (values[values.length - 1] - values[0]) / hours : null;
    }
    default: return null;
  }
}

/** Returns a copy of expr with every window call replaced by its resolved value. Cheap — these trees are small. */
export function resolveWindows(expr: Expr, samples: WindowSample[], nowMs: number): Expr {
  const rewrite = (e: Expr): Expr => {
    switch (e.kind) {
      case "call": {
        if (WINDOW_FUNC_NAMES.has(e.name)) {
          const durArg = e.args[1];
          const windowMs = durArg?.kind === "str" ? parseDuration(durArg.value) : null;
          if (windowMs == null || !e.args[0]) return { kind: "num", value: NaN };
          const val = computeWindow(e.name, e.args[0], windowMs, samples, nowMs);
          if (typeof val === "boolean") return { kind: "bool", value: val };
          if (typeof val === "number") return { kind: "num", value: val };
          return { kind: "num", value: NaN }; // null/insufficient data -> comparisons come out false
        }
        return { kind: "call", name: e.name, args: e.args.map(rewrite) };
      }
      case "not": return { kind: "not", operand: rewrite(e.operand) };
      case "logic": return { kind: "logic", op: e.op, left: rewrite(e.left), right: rewrite(e.right) };
      case "cmp": return { kind: "cmp", op: e.op, left: rewrite(e.left), right: rewrite(e.right) };
      default: return e;
    }
  };
  return rewrite(expr);
}
