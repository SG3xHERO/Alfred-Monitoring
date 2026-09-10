import { useState } from "react";
import { post, del } from "../api";
import type { AlertMute } from "../types";
import { Button, inputCls } from "./bits";
import { useCanManage } from "../useMe";

export interface MuteTarget {
  rule_name: string;
  check_key: string;
  server_id: number;
}

const PRESETS: Array<[string, number]> = [["15m", 15], ["1h", 60], ["4h", 240]];

function tomorrowNineAm(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** "Mute for..." control for one open incident — shown on Overview, Incidents, and ServerDetail. */
export function MuteControl({ target, mute, onChange }: {
  target: MuteTarget;
  mute: AlertMute | null;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const canManage = useCanManage();

  const setMute = async (until: Date) => {
    await post("/api/mutes", { ...target, until: until.toISOString() });
    setOpen(false);
    onChange();
  };

  const unmute = async () => {
    const params = new URLSearchParams({
      rule_name: target.rule_name, check_key: target.check_key, server_id: String(target.server_id),
    });
    await del(`/api/mutes?${params}`);
    onChange();
  };

  if (mute) {
    return (
      <span className="text-[11px] text-ink-3">
        muted until {new Date(mute.until).toLocaleString()}
        {mute.created_by && ` by ${mute.created_by}`}
        {canManage && <button className="ml-1.5 text-ink-2 hover:text-crit" onClick={unmute}>unmute</button>}
      </span>
    );
  }

  if (!canManage) return null;

  return (
    <span className="relative inline-block">
      <button className="text-[11px] text-ink-3 hover:text-ink" onClick={() => setOpen(!open)}>
        mute…
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-5 z-20 w-52 border border-line bg-panel p-2 text-[12px]">
            {PRESETS.map(([label, mins]) => (
              <button key={label} className="block w-full px-1.5 py-1 text-left hover:bg-paper"
                onClick={() => setMute(new Date(Date.now() + mins * 60000))}>
                {label}
              </button>
            ))}
            <button className="block w-full px-1.5 py-1 text-left hover:bg-paper"
              onClick={() => setMute(tomorrowNineAm())}>
              Until tomorrow 9am
            </button>
            <div className="mt-1 flex items-center gap-1 border-t border-line pt-1.5">
              <input type="datetime-local" className={`${inputCls} !py-1 !text-[11px]`} value={custom}
                onChange={(e) => setCustom(e.target.value)} />
              <Button className="!px-1.5 !py-1 !text-[11px]" disabled={!custom}
                onClick={() => setMute(new Date(custom))}>
                Set
              </Button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}
