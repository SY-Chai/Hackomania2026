"use client";

import dynamic from "next/dynamic";
import { useState, useRef, useEffect, useCallback } from "react";
import { MapPin, Phone, AlertTriangle, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationsView, type UIConversation } from "./conversations-view";

const SingaporeMap = dynamic(
  () =>
    import("@/components/map/singapore-map").then((mod) => mod.SingaporeMap),
  { ssr: false },
);

interface Props {
  conversations: UIConversation[];
  ongoing: number;
}

const STATS = (stationary: number, ongoing: number) => [
  { label: "PABs", value: stationary, Icon: MapPin },
  { label: "Ongoing", value: ongoing, Icon: Phone },
  { label: "Alerts", value: 0, Icon: AlertTriangle },
  { label: "Wearables", value: 0, Icon: Users },
];

const DEFAULT_WIDTH = 700;
// Must fit: conversation list column (w-80 = 320px) + detail controls comfortably.
const MIN_WIDTH = 700;
const MAX_WIDTH = 1200;
const MIN_RIGHT_PANEL_WIDTH = 360; // keeps Listen live + Take over visible side-by-side
const SEPARATOR_WIDTH = 8;

export function DashboardShell({
  conversations,
  ongoing,
}: Props) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [mapStats, setMapStats] = useState<{ stationary: number; ongoing: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Refs to track drag state without causing re-renders
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const wasDragged = useRef(false);
  const isDragging = useRef(false);

  const onSeparatorMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      wasDragged.current = false;
      isDragging.current = true;
      setIsResizing(true);
      dragRef.current = {
        startX: e.clientX,
        startWidth: panelWidth,
      };
    },
    [panelWidth],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      if (Math.abs(delta) > 4) wasDragged.current = true;
      const newWidth = dragRef.current.startWidth + delta;
      const containerWidth = containerRef.current?.clientWidth ?? 0;
      const computedMaxWidth = containerWidth
        ? Math.max(MIN_WIDTH, containerWidth - MIN_RIGHT_PANEL_WIDTH - SEPARATOR_WIDTH)
        : MAX_WIDTH;
      const effectiveMaxWidth = Math.min(MAX_WIDTH, computedMaxWidth);
      setPanelWidth(Math.max(MIN_WIDTH, Math.min(newWidth, effectiveMaxWidth)));
    };

    const onMouseUp = () => {
      dragRef.current = null;
      isDragging.current = false;
      setIsResizing(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const onSeparatorClick = useCallback(() => {
    if (wasDragged.current) return;
  }, []);

  const onStatsLoaded = useCallback(
    (stats: { stationary: number; ongoing: number }) => setMapStats(stats),
    [],
  );

  const stationary = mapStats?.stationary ?? 0;
  const displayOngoing = mapStats?.ongoing ?? ongoing;

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden select-none">
      {/* Left: Conversations panel */}
      <div
        style={{ width: panelWidth }}
        className="flex flex-col shrink-0 overflow-hidden"
      >
        <ConversationsView conversations={conversations} />
      </div>

      {/* Draggable separator */}
      <div
        onMouseDown={onSeparatorMouseDown}
        onClick={onSeparatorClick}
        title="Drag to resize"
        className={cn(
          "relative w-2 shrink-0 cursor-col-resize flex items-center justify-center group z-10",
          "bg-slate-200 hover:bg-slate-300 active:bg-slate-400 transition-colors duration-100",
        )}
      >
        {/* Grip dots */}
        <div className="flex flex-col gap-[3px] opacity-50 group-hover:opacity-100 transition-opacity">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-1 h-1 rounded-full bg-slate-500" />
          ))}
        </div>
      </div>

      {/* Right: Map */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 min-h-0 min-w-0 relative rounded border border-slate-200 overflow-hidden">
          <SingaporeMap onStatsLoaded={onStatsLoaded} isResizing={isResizing} />
          {/* Compact stats overlay — top left */}
          <div className="absolute top-3 left-3 z-10 bg-white/95 border border-slate-200 rounded p-2 flex flex-col gap-1 text-xs shadow-sm">
            {STATS(stationary, displayOngoing).map(({ label, value, Icon }) => (
              <div key={label} className="flex items-center gap-2">
                <Icon className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="font-semibold text-slate-800 tabular-nums w-10 text-right">
                  {value}
                </span>
                <span className="text-slate-500">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
