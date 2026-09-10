import { Link } from "react-router-dom";
import { useIsAdmin, useCanManage, useMe } from "../useMe";

interface AdminCard {
  to: string;
  title: string;
  description: string;
}

const CARDS: AdminCard[] = [
  { to: "/rules", title: "Rules", description: "Alert conditions, cooldowns, and notify targets." },
  { to: "/probes", title: "Probes", description: "HTTP/TCP/API/Ping/Directory/Data checks that need no agent." },
  { to: "/silences", title: "Silences", description: "Suppress an alert (or a whole server) for a scheduled window." },
];

/** Landing page behind the single "Admin" nav link — bundles what used to be separate tabs. */
export default function AdminHome() {
  const me = useMe();
  const canManage = useCanManage();
  const isAdmin = useIsAdmin();

  if (me && !canManage) {
    return <div className="text-[13px] text-ink-3">The Admin area is admin/operator-only.</div>;
  }

  const cards = isAdmin
    ? [
        ...CARDS,
        { to: "/admin/users", title: "Users", description: "Accounts, roles, and password resets." },
        { to: "/admin/credentials", title: "Credentials", description: "Email sending, SMB and SQL Server logins." },
        { to: "/settings", title: "Settings", description: "System, wall access, audit log." },
        { to: "/admin/import-export", title: "Import / Export", description: "Back up or transfer servers, probes and settings." },
      ]
    : CARDS;

  return (
    <div>
      <h1 className="mb-4 text-[15px] font-semibold">Admin</h1>
      <div className="grid grid-cols-2 gap-3">
        {cards.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="border border-line bg-panel p-4 hover:border-line-2"
          >
            <div className="text-[14px] font-semibold">{c.title}</div>
            <div className="mt-1 text-[12px] text-ink-3">{c.description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
