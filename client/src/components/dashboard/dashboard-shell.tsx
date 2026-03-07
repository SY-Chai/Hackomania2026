"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io as socketIO } from "socket.io-client";
import { MapPin, Phone, AlertTriangle, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationsView, type UIConversation } from "./conversations-view";
import { SingaporeMap, type PABMarker } from "@/components/map/singapore-map";
import { resolveSocketServerUrl } from "@/lib/socket";

interface Props {
  conversations: UIConversation[];
  mapPABs: PABMarker[];
  stationary: number;
  ongoing: number;
}

const STATS = (stationary: number, ongoing: number) => [
  { label: "PABs", value: stationary, Icon: MapPin },
  { label: "Ongoing", value: ongoing, Icon: Phone },
  { label: "Alerts", value: 0, Icon: AlertTriangle },
  { label: "Wearables", value: 0, Icon: Users },
];

const DEFAULT_WIDTH = 700;
const MIN_WIDTH = 280;
const COLLAPSE_THRESHOLD = 120;

export function DashboardShell({
  conversations,
  mapPABs,
  stationary,
  ongoing,
}: Props) {
  const router = useRouter();
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Connect to the Node backend listening on port 3001
    const socket = socketIO(resolveSocketServerUrl());

    socket.on("dashboard_update", () => {
      console.log("Dashboard update received, refreshing data...");
      // router.refresh() triggers a re-fetch of Server Components data without resetting client state (e.g. panelWidth)
      router.refresh();
    });

    return () => {
      socket.disconnect();
    };
  }, [router]);

  // Refs to track drag state without causing re-renders
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const wasDragged = useRef(false);
  const isDragging = useRef(false);

  const onSeparatorMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      wasDragged.current = false;
      isDragging.current = true;
      dragRef.current = {
        startX: e.clientX,
        startWidth: collapsed ? 0 : panelWidth,
      };
    },
    [collapsed, panelWidth],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      if (Math.abs(delta) > 4) wasDragged.current = true;
      const newWidth = dragRef.current.startWidth + delta;
      if (newWidth < COLLAPSE_THRESHOLD) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
        setPanelWidth(Math.max(MIN_WIDTH, Math.min(newWidth, 1000)));
      }
    };

    const onMouseUp = () => {
      dragRef.current = null;
      isDragging.current = false;
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
    setCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="flex h-full overflow-hidden select-none">
      {/* Left: Conversations panel */}
      <div
        style={{ width: collapsed ? 0 : panelWidth }}
        className="flex flex-col shrink-0 overflow-hidden"
      >
        <ConversationsView
          conversations={conversations}
          onCollapse={() => setCollapsed(true)}
        />
      </div>

      {/* Draggable separator */}
      <div
        onMouseDown={onSeparatorMouseDown}
        onClick={onSeparatorClick}
        title={collapsed ? "Click to expand" : "Drag to resize · Click to collapse"}
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
        <div className="flex-1 min-h-0 relative rounded border border-slate-200 overflow-hidden">
          <SingaporeMap pabs={mapPABs} />
          {/* Compact stats overlay — top left */}
          <div className="absolute top-3 left-3 z-10 bg-white/95 border border-slate-200 rounded p-2 flex flex-col gap-1 text-xs shadow-sm">
            {STATS(stationary, ongoing).map(({ label, value, Icon }) => (
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
