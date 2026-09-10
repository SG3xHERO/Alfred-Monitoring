import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, del } from "../api";
import type { Dashboard } from "../types";
import { relTime } from "../format";
import { Button, Panel } from "../components/bits";
import { useCanManage } from "../useMe";

/** Dashboard list — yours and public ones. Building happens in /dashboards/:id/edit. */
export default function Dashboards() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const canManage = useCanManage();

  const load = useCallback(() => {
    get<Dashboard[]>("/api/dashboards").then(setDashboards).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const remove = async (d: Dashboard) => {
    if (!confirm(`Delete the "${d.name}" dashboard? This can't be undone.`)) return;
    await del(`/api/dashboards/${d.id}`);
    load();
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Dashboards</h1>
        {canManage && <Button onClick={() => navigate("/dashboards/new")}>New dashboard</Button>}
      </div>

      <Panel>
        {dashboards.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-ink-3">
            No dashboards yet. Create one, or use “New chart from here” on any server chart.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-3 py-1.5">Name</th>
                <th className="py-1.5 pr-3">Panels</th>
                <th className="py-1.5 pr-3">Owner</th>
                <th className="py-1.5 pr-3">Visibility</th>
                <th className="py-1.5 pr-3 text-right">Updated</th>
                <th className="py-1.5 pr-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {dashboards.map((d) => (
                <tr key={d.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                  <td className="px-3 py-2">
                    <Link to={`/dashboards/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                  </td>
                  <td className="py-2 pr-3 text-ink-2">{d.panel_count ?? 0}</td>
                  <td className="py-2 pr-3 text-ink-2">{d.owner}{d.mine && <span className="ml-1 text-[11px] text-ink-3">(you)</span>}</td>
                  <td className="py-2 pr-3 text-ink-2">{d.is_public ? "everyone" : "private"}</td>
                  <td className="py-2 pr-3 text-right font-mono text-[12px] text-ink-2">{relTime(d.updated_at)}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    {canManage && d.mine && (
                      <>
                        <button className="text-[11px] text-ink-3 hover:text-ink"
                          onClick={() => navigate(`/dashboards/${d.id}/edit`)}>edit</button>
                        <button className="ml-2 text-[11px] text-ink-3 hover:text-crit"
                          onClick={() => remove(d)}>remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
