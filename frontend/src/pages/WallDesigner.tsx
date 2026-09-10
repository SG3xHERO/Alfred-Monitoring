import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext, DragOverlay, PointerSensor, closestCorners, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { get, post, put, del } from "../api";
import type { DashPanel, Server, WallLayout, WallSection } from "../types";
import { pct } from "../format";
import { PanelEditorCard, newPanel, type MetricOption } from "../components/PanelEditor";
import { Button } from "../components/bits";

const UNPLACED_ID = "unplaced";

/**
 * Drag-and-drop editor for building a custom Monitor Wall layout: arrange
 * servers into your own named columns, save it, and choose whether other
 * signed-in users can see (and use) it too.
 */
export default function WallDesigner() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const layoutId = searchParams.get("layout");

  const [servers, setServers] = useState<Server[]>([]);
  const [sections, setSections] = useState<WallSection[]>([]);
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [existing, setExisting] = useState<WallLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [metricOptions, setMetricOptions] = useState<MetricOption[]>([]);
  const initialised = useRef(false);

  const serversById = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);
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

  useEffect(() => {
    get<Server[]>("/api/servers").then(setServers).catch(() => {}).finally(() => setLoading(false));
    get<MetricOption[]>("/api/dashboards/metrics").then(setMetricOptions).catch(() => {});
  }, []);

  useEffect(() => {
    if (layoutId) {
      get<WallLayout>(`/api/wall-layouts/${layoutId}`).then((l) => {
        setExisting(l);
        setName(l.name);
        setIsPublic(l.is_public);
        setSections(l.config.sections.map((s) => ({
          ...s,
          serverIds: [...s.serverIds],
          panels: (s.panels ?? []).map((p) => ({ ...p })),
        })));
      }).catch(() => setError("Could not load that layout"));
    }
  }, [layoutId]);

  // Seed the board once servers have loaded: either from the loaded layout
  // (topping up with an "unplaced" bucket for any server not yet placed) or,
  // for a brand-new layout, auto-grouped by brand as a sensible starting point.
  useEffect(() => {
    if (initialised.current || loading) return;
    if (layoutId && !existing) return; // still waiting for the layout to load
    initialised.current = true;

    setSections((prev) => {
      const base = prev.length > 0 ? prev : servers.reduce<WallSection[]>((acc, s) => {
        let sec = acc.find((a) => a.title === s.brand);
        if (!sec) { sec = { id: crypto.randomUUID(), title: s.brand, serverIds: [] }; acc.push(sec); }
        sec.serverIds.push(s.id);
        return acc;
      }, []);

      const placed = new Set(base.flatMap((s) => s.serverIds));
      const leftover = servers.map((s) => s.id).filter((id) => !placed.has(id));
      return [...base, { id: UNPLACED_ID, title: "Unplaced — hidden from the wall", serverIds: leftover }];
    });
    if (!name) setName(existing?.name || "");
  }, [loading, existing, layoutId, servers, name]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const findSectionIndex = (serverId: number) =>
    sections.findIndex((sec) => sec.serverIds.includes(serverId));

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeServerId = parseInt(String(active.id).replace("srv-", ""), 10);
    const overId = String(over.id);
    const activeIdx = findSectionIndex(activeServerId);
    let overIdx = sections.findIndex((s) => s.id === overId);
    if (overIdx === -1) {
      const overServerId = parseInt(overId.replace("srv-", ""), 10);
      overIdx = findSectionIndex(overServerId);
    }
    if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return;

    setSections((prev) => {
      const next = prev.map((s) => ({ ...s, serverIds: [...s.serverIds] }));
      next[activeIdx].serverIds = next[activeIdx].serverIds.filter((id) => id !== activeServerId);
      const overServerId = parseInt(overId.replace("srv-", ""), 10);
      const insertAt = next[overIdx].serverIds.includes(overServerId)
        ? next[overIdx].serverIds.indexOf(overServerId)
        : next[overIdx].serverIds.length;
      next[overIdx].serverIds.splice(insertAt, 0, activeServerId);
      return next;
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeServerId = parseInt(String(active.id).replace("srv-", ""), 10);
    const overId = String(over.id);
    if (!overId.startsWith("srv-")) return;
    const overServerId = parseInt(overId.replace("srv-", ""), 10);
    const idx = findSectionIndex(activeServerId);
    if (idx === -1) return;
    setSections((prev) => {
      const next = prev.map((s) => ({ ...s, serverIds: [...s.serverIds] }));
      const arr = next[idx].serverIds;
      const oldIndex = arr.indexOf(activeServerId);
      const newIndex = arr.indexOf(overServerId);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        next[idx].serverIds = arrayMove(arr, oldIndex, newIndex);
      }
      return next;
    });
  };

  const addColumn = () => {
    setSections((prev) => {
      const next = [...prev];
      next.splice(next.length - 1, 0, { id: crypto.randomUUID(), title: "New column", serverIds: [] });
      return next;
    });
  };

  const removeColumn = (id: string) => {
    setSections((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx === -1) return prev;
      const removed = prev[idx];
      const next = prev.filter((s) => s.id !== id);
      const unplacedIdx = next.findIndex((s) => s.id === UNPLACED_ID);
      next[unplacedIdx].serverIds = [...next[unplacedIdx].serverIds, ...removed.serverIds];
      return next;
    });
  };

  const renameColumn = (id: string, title: string) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  };

  const addPanel = (sectionId: string) => {
    setSections((prev) => prev.map((s) =>
      s.id === sectionId ? { ...s, panels: [...(s.panels ?? []), newPanel()] } : s));
  };

  const updatePanel = (sectionId: string, panelId: string, patch: Partial<DashPanel>) => {
    setSections((prev) => prev.map((s) =>
      s.id === sectionId
        ? { ...s, panels: (s.panels ?? []).map((p) => (p.id === panelId ? { ...p, ...patch } : p)) }
        : s));
  };

  const removePanel = (sectionId: string, panelId: string) => {
    setSections((prev) => prev.map((s) =>
      s.id === sectionId ? { ...s, panels: (s.panels ?? []).filter((p) => p.id !== panelId) } : s));
  };

  const moveColumn = (id: string, dir: -1 | 1) => {
    setSections((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= prev.length - 1) return prev; // never past the Unplaced bucket
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const save = async () => {
    setError("");
    if (!name.trim()) { setError("Give this layout a name"); return; }
    setSaving(true);
    try {
      const config = {
        sections: sections.filter((s) => s.id !== UNPLACED_ID),
        hiddenServerIds: sections.find((s) => s.id === UNPLACED_ID)?.serverIds ?? [],
      };
      const body = { name: name.trim(), is_public: isPublic, config };
      const saved = existing?.mine
        ? await put<WallLayout>(`/api/wall-layouts/${existing.id}`, body)
        : await post<WallLayout>("/api/wall-layouts", body);
      navigate(`/wall?layout=${saved.id}`);
    } catch (err: any) {
      setError(err.message || "Could not save layout");
    } finally {
      setSaving(false);
    }
  };

  const removeLayout = async () => {
    if (!existing || !confirm(`Delete the "${existing.name}" layout? This can't be undone.`)) return;
    await del(`/api/wall-layouts/${existing.id}`);
    navigate("/wall");
  };

  if (loading) return <div className="min-h-screen bg-paper p-6 text-[13px] text-ink-3">Loading…</div>;

  return (
    <div className="min-h-screen bg-paper p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-[16px] font-semibold tracking-[0.14em]">ALFRED</span>
        <span className="text-[13px] text-ink-3">Wall designer</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            className="border border-line-2 bg-panel px-2 py-1.5 text-[13px]"
            placeholder="Layout name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Visible to everyone
          </label>
          <button onClick={addColumn} className="border border-line-2 px-2.5 py-1.5 text-[13px] text-ink-2 hover:text-ink">
            + Add column
          </button>
          {existing?.mine && (
            <button onClick={removeLayout} className="border border-crit px-2.5 py-1.5 text-[13px] text-crit hover:bg-crit-bg">
              Delete
            </button>
          )}
          <button
            onClick={() => navigate(layoutId ? `/wall?layout=${layoutId}` : "/wall")}
            className="border border-line-2 px-2.5 py-1.5 text-[13px] text-ink-2 hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="bg-ink px-3 py-1.5 text-[13px] text-ink-contrast hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {existing && !existing.mine && (
        <div className="mb-3 border border-line bg-panel p-2 text-[12px] text-ink-2">
          You're editing a copy of “{existing.name}” by {existing.owner}. Saving will create your own layout.
        </div>
      )}
      {error && <div className="mb-3 text-[12px] text-crit">{error}</div>}
      <p className="mb-4 text-[12px] text-ink-3">
        Drag servers between columns to arrange the wall. Rename or reorder columns with the controls in
        each header. Drop a server in “Unplaced” to hide it from the wall entirely. Add a chart panel to a
        column with “+ Add panel” — same panels as Dashboards, shown under that column's tiles.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="flex items-start gap-4 overflow-x-auto pb-4">
          {sections.map((sec, i) => (
            <Column
              key={sec.id}
              section={sec}
              servers={sec.serverIds.map((id) => serversById.get(id)).filter((s): s is Server => !!s)}
              onRename={(t) => renameColumn(sec.id, t)}
              onRemove={sec.id === UNPLACED_ID ? undefined : () => removeColumn(sec.id)}
              onMoveLeft={sec.id === UNPLACED_ID || i === 0 ? undefined : () => moveColumn(sec.id, -1)}
              onMoveRight={sec.id === UNPLACED_ID || i >= sections.length - 2 ? undefined : () => moveColumn(sec.id, 1)}
              metricOptions={metricOptions}
              targetOptions={targetOptions}
              onAddPanel={sec.id === UNPLACED_ID ? undefined : () => addPanel(sec.id)}
              onChangePanel={(panelId, patch) => updatePanel(sec.id, panelId, patch)}
              onRemovePanel={(panelId) => removePanel(sec.id, panelId)}
            />
          ))}
        </div>

        <DragOverlay>
          {activeId ? (() => {
            const id = parseInt(activeId.replace("srv-", ""), 10);
            const s = serversById.get(id);
            return s ? <MiniTile server={s} dragging /> : null;
          })() : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ section, servers, onRename, onRemove, onMoveLeft, onMoveRight, metricOptions, targetOptions, onAddPanel, onChangePanel, onRemovePanel }: {
  section: WallSection;
  servers: Server[];
  onRename: (title: string) => void;
  onRemove?: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  metricOptions: MetricOption[];
  targetOptions: Array<{ value: string; label: string }>;
  onAddPanel?: () => void;
  onChangePanel: (panelId: string, patch: Partial<DashPanel>) => void;
  onRemovePanel: (panelId: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: section.id });
  const isUnplaced = section.id === UNPLACED_ID;
  const panels = section.panels ?? [];

  return (
    <div className="w-[300px] shrink-0">
      <div className="mb-2 flex items-center gap-1">
        {!isUnplaced ? (
          <input
            value={section.title}
            onChange={(e) => onRename(e.target.value)}
            className="min-w-0 flex-1 border border-transparent bg-transparent px-1 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-ink-2 hover:border-line-2 focus:border-line-2 focus:outline-none"
          />
        ) : (
          <span className="flex-1 truncate px-1 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            {section.title}
          </span>
        )}
        {onMoveLeft && (
          <button onClick={onMoveLeft} title="Move left" className="px-1 text-ink-3 hover:text-ink">←</button>
        )}
        {onMoveRight && (
          <button onClick={onMoveRight} title="Move right" className="px-1 text-ink-3 hover:text-ink">→</button>
        )}
        {onRemove && (
          <button onClick={onRemove} title="Remove column" className="px-1 text-ink-3 hover:text-crit">✕</button>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[100px] flex-col gap-2 rounded-panel border p-2 ${
          isUnplaced ? "border-dashed border-line bg-transparent" : "border-line bg-panel"
        }`}
      >
        <SortableContext items={servers.map((s) => `srv-${s.id}`)} strategy={verticalListSortingStrategy}>
          {servers.map((s) => <MiniTile key={s.id} server={s} />)}
        </SortableContext>
        {servers.length === 0 && (
          <div className="p-2 text-center text-[11px] text-ink-3">drop here</div>
        )}
      </div>

      {onAddPanel && (
        <div className="mt-2 flex flex-col gap-2">
          {panels.map((p) => (
            <PanelEditorCard
              key={p.id}
              panel={p}
              metricOptions={metricOptions}
              targetOptions={targetOptions}
              onChange={(patch) => onChangePanel(p.id, patch)}
              onRemove={() => onRemovePanel(p.id)}
            />
          ))}
          <Button onClick={onAddPanel} className="w-full">+ Add panel</Button>
        </div>
      )}
    </div>
  );
}

function MiniTile({ server, dragging }: { server: Server; dragging?: boolean }) {
  const sortable = useSortable({ id: `srv-${server.id}` });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = dragging
    ? { attributes: {}, listeners: {}, setNodeRef: undefined, transform: null, transition: undefined, isDragging: false }
    : sortable;

  const style = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const dot = server.status === "online" ? "bg-ok" : server.status === "offline" ? "bg-crit" : "bg-idle";

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex cursor-grab items-center gap-2 border border-line bg-paper px-2 py-1.5 text-[12px] active:cursor-grabbing ${
        dragging ? "shadow-lg" : ""
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="flex-1 truncate font-medium">{server.display_name}</span>
      <span className="shrink-0 font-mono text-ink-3">{pct(server.cpu_pct, 0)}</span>
    </div>
  );
}
