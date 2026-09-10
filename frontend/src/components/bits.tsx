import type { Server } from "../types";

/** Small stroke icon for a row/tile — by probe type, else by agent OS. One consistent style, 24x24 viewbox. */
export function DeviceIcon({ node, className = "h-[15px] w-[15px] shrink-0 text-ink-3" }: {
  node: Pick<Server, "kind" | "os"> & { probe?: { type?: string | null } | null };
  className?: string;
}) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;

  if (node.kind === "probe") {
    const t = node.probe?.type;
    if (t === "ping" || t === "tcp") {
      return (
        <svg {...common}>
          <path d="M5 12a7 7 0 0 1 14 0" />
          <path d="M8.5 12a3.5 3.5 0 0 1 7 0" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    }
    if (t === "api" || t === "http") {
      return (
        <svg {...common}>
          <polyline points="7,8 3,12 7,16" />
          <polyline points="17,8 21,12 17,16" />
          <line x1="14" y1="6" x2="10" y2="18" />
        </svg>
      );
    }
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }

  if (node.os === "windows") {
    return (
      <svg {...common} fill="currentColor" stroke="none">
        <rect x="3" y="4" width="8" height="8" rx="1.2" />
        <rect x="13" y="4" width="8" height="8" rx="1.2" opacity="0.55" />
        <rect x="3" y="14" width="8" height="8" rx="1.2" opacity="0.55" />
        <rect x="13" y="14" width="8" height="8" rx="1.2" opacity="0.3" />
      </svg>
    );
  }
  if (node.os === "linux") {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 9h2M15 9h2M9 15h6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** Small indigo pill for a parent device that has nested children folded into its row/tile. */
export function HostBadge({ tags, brand }: { tags: string[]; brand?: string }) {
  const isHyperV = [...tags, brand ?? ""].some((t) => /hyper-?v/i.test(t));
  const label = isHyperV ? "HyperV host" : "Host";
  return (
    <span className="rounded-control bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
      {label}
    </span>
  );
}

export function StatusDot({ status }: { status: Server["status"] }) {
  const color =
    status === "online" ? "bg-ok" : status === "offline" ? "bg-crit" : "bg-idle";
  return (
    <span className="inline-flex items-center" title={status}>
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

export function SeverityTag({ severity }: { severity: string }) {
  const cls =
    severity === "critical"
      ? "bg-crit-bg text-crit"
      : severity === "warning"
        ? "bg-warn-bg text-warn"
        : "bg-paper text-ink-2";
  return (
    <span className={`inline-block rounded-control px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  );
}

export function UptimeCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col items-end">
      <span className="font-mono text-[12px] leading-tight">
        {value == null ? "—" : `${value.toFixed(1)}%`}
      </span>
      <span className="text-[10px] text-ink-3 leading-tight">{label}</span>
    </div>
  );
}

/** Simple horizontal SLA bar: green fill proportional to uptime. */
export function UptimeBar({ value }: { value: number | null }) {
  if (value == null) return <div className="h-1 w-full bg-line" />;
  const color = value >= 99.5 ? "bg-ok" : value >= 97 ? "bg-warn" : "bg-crit";
  return (
    <div className="h-1 w-full bg-line">
      <div className={`h-1 ${color}`} style={{ width: `${Math.max(2, value)}%` }} />
    </div>
  );
}

export function Panel({ title, children, right }: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-panel shadow-panel overflow-hidden">
      {title && (
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-ink-2">{title}</h2>
          {right}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

export function Button({ children, kind = "default", ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "default" | "primary" | "danger" | "info" }) {
  const cls =
    kind === "primary"
      ? "bg-accent text-accent-contrast shadow-accent hover:opacity-90"
      : kind === "danger"
        ? "border border-crit text-crit hover:bg-crit-bg"
        : kind === "info"
          ? "bg-info text-info-contrast hover:opacity-90"
          : "border border-line-2 text-ink hover:bg-paper";
  return (
    <button
      {...rest}
      className={`rounded-control px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed ${cls} ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export const inputCls =
  "rounded-control border border-line-2 bg-panel px-2 py-1.5 text-[13px] w-full focus:outline-none focus:border-ink-3";
