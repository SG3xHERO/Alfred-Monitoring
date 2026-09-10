import { useEffect, useState } from "react";
import { Routes, Route, NavLink, Navigate, useNavigate } from "react-router-dom";
import { get, post } from "./api";
import { MeProvider, useMe } from "./useMe";
import { useTheme } from "./useTheme";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Overview from "./pages/Overview";
import ServerDetail from "./pages/ServerDetail";
import Rules from "./pages/Rules";
import Incidents from "./pages/Incidents";
import Probes from "./pages/Probes";
import Dashboards from "./pages/Dashboards";
import DashboardView from "./pages/DashboardView";
import DashboardEdit from "./pages/DashboardEdit";
import Silences from "./pages/Silences";
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import Credentials from "./pages/Credentials";
import ImportExport from "./pages/ImportExport";
import AdminHome from "./pages/AdminHome";
import Wall from "./pages/Wall";
import WallDesigner from "./pages/WallDesigner";

/**
 * Blocks the app shell until we know there's a valid session. No session →
 * send the browser to the first-run wizard if no admin exists yet, otherwise
 * to the login page. Without this, an unauthenticated visit renders the
 * dashboard frame and only bounces once some data fetch happens to 401.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    get("/api/auth/me")
      .then(() => { if (!cancelled) setReady(true); })
      .catch(async () => {
        if (cancelled) return;
        let needsSetup = false;
        try {
          const s = await get<{ needed: boolean }>("/api/setup/status");
          needsSetup = s.needed;
        } catch { /* fall through to /login */ }
        navigate(needsSetup ? "/setup" : "/login", { replace: true });
      });
    return () => { cancelled = true; };
  }, [navigate]);

  if (!ready) return null;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <MeProvider>
        <ShellInner>{children}</ShellInner>
      </MeProvider>
    </AuthGate>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const nav = ({ isActive }: { isActive: boolean }) =>
    `rounded-control px-3 py-1.5 text-[13px] font-medium ${isActive ? "bg-accent-soft text-ink" : "text-ink-2 hover:text-ink"}`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 h-14">
          <NavLink to="/" className="mr-7 flex items-center gap-2 font-head font-bold text-[15px] tracking-[-0.01em]">
            <img src="/logo.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
            Alfred
          </NavLink>
          <nav className="flex items-center gap-0.5">
            <NavLink to="/" end className={nav}>Overview</NavLink>
            <NavLink to="/dashboards" className={nav}>Dashboards</NavLink>
            <NavLink to="/incidents" className={nav}>Incidents</NavLink>
            {(me?.role === "admin" || me?.role === "operator") && (
              <NavLink to="/admin" className={nav}>Admin</NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-ink-3">
            <button
              className="rounded-control border border-line-2 px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
              title="Temporary while the new look is being reviewed"
              onClick={() => setTheme(theme === "classic" ? "modern" : "classic")}
            >
              {theme === "classic" ? "Classic mode" : "Modern mode"}
            </button>
            {me && (
              <span>
                {me.username}
                {me.role !== "admin" && <span className="ml-1.5 text-ink-3">({me.role})</span>}
              </span>
            )}
            <button
              className="text-ink-2 hover:text-ink"
              onClick={async () => {
                await post("/api/auth/logout");
                navigate("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/wall" element={<Wall />} />
      <Route path="/wall/design" element={<WallDesigner />} />
      <Route path="/" element={<Shell><Overview /></Shell>} />
      <Route path="/servers/:id" element={<Shell><ServerDetail /></Shell>} />
      <Route path="/rules" element={<Shell><Rules /></Shell>} />
      <Route path="/probes" element={<Shell><Probes /></Shell>} />
      <Route path="/dashboards" element={<Shell><Dashboards /></Shell>} />
      <Route path="/dashboards/new" element={<Shell><DashboardEdit /></Shell>} />
      <Route path="/dashboards/:id" element={<Shell><DashboardView /></Shell>} />
      <Route path="/dashboards/:id/edit" element={<Shell><DashboardEdit /></Shell>} />
      <Route path="/incidents" element={<Shell><Incidents /></Shell>} />
      <Route path="/silences" element={<Shell><Silences /></Shell>} />
      <Route path="/maintenance" element={<Navigate to="/silences" replace />} />
      <Route path="/settings" element={<Shell><Settings /></Shell>} />
      <Route path="/admin" element={<Shell><AdminHome /></Shell>} />
      <Route path="/admin/users" element={<Shell><Users /></Shell>} />
      <Route path="/admin/credentials" element={<Shell><Credentials /></Shell>} />
      <Route path="/admin/import-export" element={<Shell><ImportExport /></Shell>} />
    </Routes>
  );
}
