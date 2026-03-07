"use client";

import { useState, useCallback } from "react";
import Map, { Marker, Popup } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { stationaryPABs, wearablePABAggregates } from "@/lib/mock-data";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

const statusConfig = {
  active: { color: "bg-emerald-500", border: "border-emerald-600", label: "Active", badge: "bg-emerald-100 text-emerald-800" },
  alert: { color: "bg-red-500", border: "border-red-600", label: "Alert", badge: "bg-red-100 text-red-800" },
  inactive: { color: "bg-slate-400", border: "border-slate-500", label: "Inactive", badge: "bg-slate-100 text-slate-600" },
};

function getWearableColor(count: number) {
  if (count >= 30) return "#1e40af";
  if (count >= 20) return "#3b82f6";
  if (count >= 10) return "#93c5fd";
  return "#dbeafe";
}

function getWearableSize(count: number) {
  if (count >= 30) return 44;
  if (count >= 20) return 36;
  if (count >= 10) return 30;
  return 24;
}

type SelectedItem =
  | { type: "stationary"; data: (typeof stationaryPABs)[number] }
  | { type: "wearable"; data: (typeof wearablePABAggregates)[number] }
  | null;

export function SingaporeMap() {
  const [selected, setSelected] = useState<SelectedItem>(null);

  const handleClose = useCallback(() => setSelected(null), []);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden">
      <Map
        initialViewState={{
          longitude: 103.8198,
          latitude: 1.3521,
          zoom: 10.8,
        }}
        style={{ width: "100%", height: "100%" }}
        mapStyle="mapbox://styles/mapbox/light-v11"
        mapboxAccessToken={MAPBOX_TOKEN}
        attributionControl={false}
      >
        {/* Wearable PAB aggregate circles */}
        {wearablePABAggregates.map((agg) => {
          const size = getWearableSize(agg.count);
          const color = getWearableColor(agg.count);
          return (
            <Marker
              key={`wearable-${agg.town}`}
              longitude={agg.lng}
              latitude={agg.lat}
              anchor="center"
            >
              <button
                className="flex items-center justify-center rounded-full border-2 border-white shadow-md transition-transform hover:scale-110 cursor-pointer"
                style={{ width: size, height: size, backgroundColor: color }}
                onClick={() => setSelected({ type: "wearable", data: agg })}
                title={`${agg.town}: ${agg.count} wearables`}
              >
                <span className="text-white font-bold" style={{ fontSize: size > 36 ? 12 : 10 }}>
                  {agg.count}
                </span>
              </button>
            </Marker>
          );
        })}

        {/* Stationary PAB markers */}
        {stationaryPABs.map((pab) => {
          const cfg = statusConfig[pab.status as keyof typeof statusConfig];
          const isAlert = pab.status === "alert";
          return (
            <Marker
              key={pab.id}
              longitude={pab.lng}
              latitude={pab.lat}
              anchor="center"
            >
              <button
                className={cn(
                  "flex items-center justify-center w-5 h-5 rounded-full border-2 shadow transition-transform hover:scale-125 cursor-pointer",
                  cfg.color,
                  cfg.border,
                  isAlert && "animate-pulse"
                )}
                onClick={() => setSelected({ type: "stationary", data: pab })}
                title={pab.name}
              />
            </Marker>
          );
        })}

        {/* Popup for stationary PAB */}
        {selected?.type === "stationary" && (
          <Popup
            longitude={selected.data.lng}
            latitude={selected.data.lat}
            onClose={handleClose}
            closeButton
            closeOnClick={false}
            offset={14}
            className="rounded-lg"
          >
            <div className="p-1 min-w-[180px]">
              <div className="flex items-center gap-1.5 mb-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-xs font-semibold text-slate-800">{selected.data.name}</span>
              </div>
              <p className="text-xs text-slate-500 mb-2">{selected.data.address}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Status</span>
                <span
                  className={cn(
                    "text-xs font-medium px-2 py-0.5 rounded-full",
                    statusConfig[selected.data.status as keyof typeof statusConfig].badge
                  )}
                >
                  {statusConfig[selected.data.status as keyof typeof statusConfig].label}
                </span>
              </div>
              {selected.data.status === "alert" && (
                <div className="flex items-center gap-1 mt-2 text-red-600 bg-red-50 rounded px-2 py-1">
                  <AlertTriangle className="w-3 h-3" />
                  <span className="text-xs font-medium">Alert in progress</span>
                </div>
              )}
            </div>
          </Popup>
        )}

        {/* Popup for wearable aggregate */}
        {selected?.type === "wearable" && (
          <Popup
            longitude={selected.data.lng}
            latitude={selected.data.lat}
            onClose={handleClose}
            closeButton
            closeOnClick={false}
            offset={22}
          >
            <div className="p-1 min-w-[160px]">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Users className="w-3.5 h-3.5 text-blue-500" />
                <span className="text-xs font-semibold text-slate-800">{selected.data.town}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Wearable PABs</span>
                <span className="text-xs font-bold text-blue-700">{selected.data.count}</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-slate-500">Trend</span>
                <span className={cn(
                  "text-xs font-medium",
                  selected.data.trend === "up" ? "text-emerald-600" : selected.data.trend === "down" ? "text-red-500" : "text-slate-500"
                )}>
                  {selected.data.trend === "up" ? "↑ Rising" : selected.data.trend === "down" ? "↓ Falling" : "→ Stable"}
                </span>
              </div>
            </div>
          </Popup>
        )}
      </Map>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-white rounded-lg border border-slate-200 shadow-sm p-3 text-xs space-y-2">
        <p className="font-semibold text-slate-700 mb-1">Legend</p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-emerald-600" />
            <span className="text-slate-600">Stationary PAB — Active</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-red-600" />
            <span className="text-slate-600">Stationary PAB — Alert</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-slate-400 border-2 border-slate-500" />
            <span className="text-slate-600">Stationary PAB — Offline</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-blue-500 border-2 border-white flex items-center justify-center">
              <span className="text-white font-bold text-[8px]">N</span>
            </div>
            <span className="text-slate-600">Wearable count by town</span>
          </div>
        </div>
      </div>
    </div>
  );
}
