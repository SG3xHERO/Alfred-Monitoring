import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext, arrayMove, useSortable, rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { get, post, put } from "../api";
import type { Dashboard, DashPanel, Server } from "../types";
import { Button, inputCls } from "../components/bits";
import { PanelEditorCard, newPanel, type MetricOption } from "../components/PanelEditor";

/**
 * Dashboard builder — add panels, tune each one with a live preview, drag to
 * reorder (same dnd-kit interaction as the wall designer), resize via
 * width/height steppers. /dashboards/new?metric=…&target=… arrives seeded
 * from a server chart's "New chart from here".
 */
export default function DashboardEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [panels, setPanels] = useState<DashPanel[]>([]);
  const [existing, setExisting] = useState<Dashboard | null>(null);
  const [metricOptions, setMetricOptions] = useState<MetricOption[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<MetricOption[]>("/api/dashboards/metrics").then(setMetricOptions).catch(() => {});
    get<Server[]>("/api/servers").then(setServers).catch(() => {});
  }, []);

  useEffect(() => {
    if (id) {
      get<Dashboard>(`/api/dashboards/${id}`).then((d) => {
        setExisting(d);
        setName(d.name);
        setIsPublic(d.is_public);
        setPanels(d.config.panels.map((p) => ({ ...p })));
      }).catch((err) => setError(err.message));
    } else {
      const metric = searchParams.get("metric");
      const target = searchParams.get("target");
      setPanels([newPanel(metric || target ? {
        metrics: metric ? [metric] : ["cpu.percent"],
        target: target || "*",
        title: target && metric ? `${target} — ${metric}` : "",
      } : {})]);
    }
    // seed once on mount / id change only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const targetOptions = useMemo(() => {
    const brands = [...new Set(servers.map((s) => s.brand))].sort();
    const tags = [...new Set(servers.flatMap((s) => s.tags))].sort();
    return [
      { value: "*", label: "All servers" },
      ...brands.map((b) => ({ value: `group:${b}`, label: `group: ${b}` })),
      ...tags.map((t) => ({ value: `tag:${t}`, label: `tag: ${t}` })),
      ...servers.map((s) => ({ value: s.display_name, label: s.display_name })),
    ];
  }, [servers]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setPanels((prev) => {
      const oldIndex = prev.findIndex((p) => p.id === active.id);
      const newIndex = prev.findIndex((p) => p.id === over.id);
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const updatePanel = (pid: string, patch: Partial<DashPanel>) => {
    setPanels((prev) => prev.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  };

  const save = async () => {
    setError("");
    if (!name.trim()) { setError("Give this dashboard a name"); return; }
    if (panels.length === 0) { setError("Add at least one panel"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), is_public: isPublic, config: { panels } };
      const saved = existing?.mine
        ? await put<Dashboard>(`/api/dashboards/${existing.id}`, body)
        : await post<Dashboard>("/api/dashboards", body);
      navigate(`/dashboards/${saved.id}`);
    } catch (err: any) {
      setError(err.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-[15px] font-semibold">
          {existing ? `Edit: ${existing.name}` : "New dashboard"}
        </h1>
        <input className={`${inputCls} !w-56`} placeholder="Dashboard name" value={name}
          onChange={(e) => setName(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Visible to everyone
        </label>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setPanels((prev) => [...prev, newPanel()])}>+ Add panel</Button>
          <Button onClick={() => navigate(existing ? `/dashboards/${existing.id}` : "/dashboards")}>
            Cancel
          </Button>
          <Button kind="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>

      {existing && !existing.mine && (
        <div className="mb-3 border border-line bg-panel p-2 text-[12px] text-ink-2">
          You're editing a copy of “{existing.name}” by {existing.owner}. Saving creates your own dashboard.
        </div>
      )}
      {error && <div className="mb-3 text-[12px] text-crit">{error}</div>}
      <p className="mb-4 text-[12px] text-ink-3">
        Drag a panel header to reorder. Width and height controls sit in each panel's header;
        the chart underneath is a live preview.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={panels.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-3">
            {panels.map((p) => (
              <SortablePanel key={p.id} panel={p} metricOptions={metricOptions}
                targetOptions={targetOptions}
                onChange={(patch) => updatePanel(p.id, patch)}
                onRemove={() => setPanels((prev) => prev.filter((x) => x.id !== p.id))} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {panels.length === 0 && (
        <div className="border border-line bg-panel p-8 text-center text-[13px] text-ink-3">
          No panels. Click “+ Add panel”.
        </div>
      )}
    </div>
  );
}

function SortablePanel({ panel, metricOptions, targetOptions, onChange, onRemove }: {
  panel: DashPanel;
  metricOptions: MetricOption[];
  targetOptions: Array<{ value: string; label: string }>;
  onChange: (patch: Partial<DashPanel>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: panel.id });

  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={panel.width === 2 ? "col-span-2" : "col-span-2 md:col-span-1"}>
      <PanelEditorCard
        panel={panel}
        metricOptions={metricOptions}
        targetOptions={targetOptions}
        onChange={onChange}
        onRemove={onRemove}
        dragHandle={
          <span {...attributes} {...listeners}
            className="cursor-grab px-1 text-ink-3 active:cursor-grabbing" title="Drag to reorder">⠿</span>
        }
      />
    </div>
  );
}
