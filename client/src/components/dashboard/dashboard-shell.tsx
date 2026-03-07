"use client";

import { useState } from "react";
import {
  PanelLeftOpen,
  MapPin,
  Phone,
  AlertTriangle,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationsView, type UIConversation } from "./conversations-view";
import { SingaporeMap, type PABMarker } from "@/components/map/singapore-map";

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

export function DashboardShell({
  conversations,
  mapPABs,
  stationary,
  ongoing,
}: Props) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Conversations panel */}
      <div
        className={cn(
          "flex flex-col border-r border-slate-200 shrink-0 overflow-hidden transition-[width] duration-200",
          expanded ? "w-[560px]" : "w-0",
        )}
      >
        <ConversationsView
          conversations={conversations}
          onCollapse={() => setExpanded(false)}
        />
      </div>

      {/* Right: Map */}
      <div className="flex-1 flex flex-col min-w-0 gap-3">
        {/* Small re-expand button when conversations is hidden */}
        {!expanded && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-500 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded transition-colors"
            >
              <PanelLeftOpen className="w-3.5 h-3.5" />
              Conversations
            </button>
          </div>
        )}

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
