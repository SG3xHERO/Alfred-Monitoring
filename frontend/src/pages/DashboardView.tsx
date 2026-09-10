import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { get } from "../api";
import type { Dashboard } from "../types";
import { Button, Panel } from "../components/bits";
import { PanelChart } from "../components/PanelChart";
import { useLive } from "../useLive";
import { useCanManage } from "../useMe";

/** Read-only dashboard viewer; charts refresh as new metrics arrive. */
export default function DashboardView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const canManage = useCanManage();

  useEffect(() => {
    get<Dashboard>(`/api/dashboards/${id}`).then(setDash).catch((err) => setError(err.message));
  }, [id]);
  // metrics land server-side on ingest; a slow debounce keeps refetch load sane
  useLive(["server"], () => setTick((t) => t + 1), 30_000);

  if (error) return <div className="text-[13px] text-crit">{error}</div>;
  if (!dash) return <div className="text-[13px] text-ink-3">Loading…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-semibold">{dash.name}</h1>
          <span className="text-[12px] text-ink-3">
            by {dash.owner}{dash.is_public ? " · visible to everyone" : " · private"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate("/dashboards")}>All dashboards</Button>
          {canManage && dash.mine && (
            <Button onClick={() => navigate(`/dashboards/${dash.id}/edit`)}>Edit</Button>
          )}
        </div>
      </div>

      {dash.config.panels.length === 0 ? (
        <div className="border border-line bg-panel p-8 text-center text-[13px] text-ink-3">
          This dashboard has no panels yet.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {dash.config.panels.map((p) => (
            <div key={p.id} className={p.width === 2 ? "col-span-2" : "col-span-2 md:col-span-1"}>
              <Panel title={p.title || p.metrics.join(", ")}>
                <PanelChart panel={p} refreshKey={tick} />
              </Panel>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
