"use client";

import { useState, useCallback, useRef } from "react";
import Map, { Source, Layer, Popup } from "react-map-gl/mapbox";
import type { MapRef, MapMouseEvent } from "react-map-gl/mapbox";
import type { CircleLayer, SymbolLayer } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MapPin, Phone, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

// Restrict panning/zooming to Singapore region
const SINGAPORE_BOUNDS: [[number, number], [number, number]] = [
  [103.49, 1.10],
  [104.20, 1.55],
];

const statusConfig = {
  call: { label: "Active Call", badge: "bg-red-100 text-red-800" },
  active: { label: "No Call", badge: "bg-emerald-100 text-emerald-800" },
  inactive: { label: "Offline", badge: "bg-slate-100 text-slate-600" },
};

export interface PABMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  status: "call" | "active" | "inactive";
  address: string;
  town: string;
}

interface Props {
  pabs: PABMarker[];
}

// --- Mapbox layer styles ---

// Clusters: red if any PAB in cluster has an active call, green otherwise
const clusterLayer: CircleLayer = {
  id: "clusters",
  type: "circle",
  source: "pabs",
  filter: ["has", "point_count"],
  paint: {
    "circle-color": [
      "case",
      [">", ["get", "callCount"], 0],
      "#ef4444", // red — has active calls
      "#10b981", // green — no active calls
    ],
    "circle-radius": ["step", ["get", "point_count"], 18, 50, 24, 200, 30],
    "circle-stroke-width": 2,
    "circle-stroke-color": "#fff",
    "circle-opacity": 0.85,
  },
};

const clusterCountLayer: SymbolLayer = {
  id: "cluster-count",
  type: "symbol",
  source: "pabs",
  filter: ["has", "point_count"],
  layout: {
    "text-field": "{point_count_abbreviated}",
    "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
    "text-size": 13,
  },
  paint: { "text-color": "#ffffff" },
};

const unclusteredPointLayer: CircleLayer = {
  id: "unclustered-point",
  type: "circle",
  source: "pabs",
  filter: ["!", ["has", "point_count"]],
  paint: {
    "circle-color": [
      "match",
      ["get", "status"],
      "call", "#ef4444",    // red — active call
      "inactive", "#94a3b8", // gray — offline
      "#10b981",             // default green — no call
    ],
    "circle-radius": 7,
    "circle-stroke-width": 2,
    "circle-stroke-color": "#fff",
  },
};

export function SingaporeMap({ pabs }: Props) {
  const mapRef = useRef<MapRef>(null);
  const [popupInfo, setPopupInfo] = useState<PABMarker | null>(null);
  const [cursor, setCursor] = useState("auto");
  const [filterOngoingOnly, setFilterOngoingOnly] = useState(false);

  const displayedPABs = filterOngoingOnly
    ? pabs.filter((p) => p.status === "call")
    : pabs;

  const geojson: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: displayedPABs.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        status: p.status,
        address: p.address,
        town: p.town,
        // numeric flag for cluster aggregation (1 = has call)
        callCount: p.status === "call" ? 1 : 0,
      },
    })),
  };

  const onClick = useCallback((e: MapMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature) return;

    if (feature.layer?.id === "clusters") {
      const clusterId = feature.properties?.cluster_id as number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const source = mapRef.current?.getSource("pabs") as any;
      source?.getClusterExpansionZoom(clusterId, (err: Error | null, zoom: number | null) => {
        if (err || zoom === null) return;
        const coords = (feature.geometry as GeoJSON.Point).coordinates;
        mapRef.current?.easeTo({ center: [coords[0], coords[1]], zoom });
      });
    } else if (feature.layer?.id === "unclustered-point") {
      const props = feature.properties!;
      const coords = (feature.geometry as GeoJSON.Point).coordinates;
      setPopupInfo({
        id: props.id,
        name: props.name,
        lat: coords[1],
        lng: coords[0],
        status: props.status as PABMarker["status"],
        address: props.address ?? "",
        town: props.town ?? "",
      });
    }
  }, []);

  const ongoingCount = pabs.filter((p) => p.status === "call").length;

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 103.8198, latitude: 1.3521, zoom: 10.8 }}
        maxBounds={SINGAPORE_BOUNDS}
        style={{ width: "100%", height: "100%" }}
        mapStyle="mapbox://styles/mapbox/light-v11"
        mapboxAccessToken={MAPBOX_TOKEN}
        attributionControl={false}
        interactiveLayerIds={["clusters", "unclustered-point"]}
        onClick={onClick}
        cursor={cursor}
        onMouseEnter={() => setCursor("pointer")}
        onMouseLeave={() => setCursor("auto")}
      >
        <Source
          id="pabs"
          type="geojson"
          data={geojson}
          cluster={true}
          clusterMaxZoom={14}
          clusterRadius={50}
          clusterProperties={{
            // sum call flags so clusters know if any member has a call
            callCount: ["+", ["get", "callCount"]],
          }}
        >
          <Layer {...clusterLayer} />
          <Layer {...clusterCountLayer} />
          <Layer {...unclusteredPointLayer} />
        </Source>

        {popupInfo && (
          <Popup
            longitude={popupInfo.lng}
            latitude={popupInfo.lat}
            onClose={() => setPopupInfo(null)}
            closeButton
            closeOnClick={false}
            offset={14}
          >
            <div className="p-1 min-w-[180px]">
              <div className="flex items-center gap-1.5 mb-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-xs font-semibold text-slate-800">{popupInfo.name}</span>
              </div>
              {popupInfo.address && (
                <p className="text-xs text-slate-500 mb-2">{popupInfo.address}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Status</span>
                <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", statusConfig[popupInfo.status].badge)}>
                  {statusConfig[popupInfo.status].label}
                </span>
              </div>
              {popupInfo.status === "call" && (
                <div className="flex items-center gap-1 mt-2 text-red-600 bg-red-50 rounded px-2 py-1">
                  <Phone className="w-3 h-3" />
                  <span className="text-xs font-medium">Call in progress</span>
                </div>
              )}
            </div>
          </Popup>
        )}
      </Map>

      {/* Filter button */}
      <div className="absolute top-4 right-4">
        <button
          onClick={() => setFilterOngoingOnly((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border shadow-sm transition-colors",
            filterOngoingOnly
              ? "bg-red-500 text-white border-red-500"
              : "bg-white text-slate-700 border-slate-200 hover:border-slate-300",
          )}
        >
          <Filter className="w-3 h-3" />
          {filterOngoingOnly
            ? `Ongoing calls (${ongoingCount})`
            : "Show ongoing calls only"}
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-white rounded-lg border border-slate-200 shadow-sm p-3 text-xs space-y-2">
        <p className="font-semibold text-slate-700 mb-1">Legend</p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-white shadow-[0_0_0_1.5px_#ef4444]" />
            <span className="text-slate-600">Active call / alert</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-white shadow-[0_0_0_1.5px_#10b981]" />
            <span className="text-slate-600">No ongoing call</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-slate-400 border-2 border-white shadow-[0_0_0_1.5px_#94a3b8]" />
            <span className="text-slate-600">Offline PAB</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-full border-2 border-white shadow-[0_0_0_1.5px_#ef4444] flex items-center justify-center bg-red-500 text-[8px] text-white font-bold">n</div>
            <span className="text-slate-600">Cluster — red if any call</span>
          </div>
        </div>
      </div>
    </div>
  );
}
