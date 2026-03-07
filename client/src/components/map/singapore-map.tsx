"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
  pabs?: PABMarker[];
  onStatsLoaded?: (stats: { stationary: number; ongoing: number }) => void;
  isResizing?: boolean;
  leftInset?: number;
}

// --- Mapbox layer styles (stable references) ---

const clusterLayer: CircleLayer = {
  id: "clusters",
  type: "circle",
  source: "pabs",
  filter: ["has", "point_count"],
  paint: {
    "circle-color": [
      "case",
      [">", ["get", "callCount"], 0],
      "#ef4444",
      "#10b981",
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
      "call", "#ef4444",
      "inactive", "#94a3b8",
      "#10b981",
    ],
    "circle-radius": 7,
    "circle-stroke-width": 2,
    "circle-stroke-color": "#fff",
  },
};

// Shifted west so Singapore appears more on the right when the left panel overlays the map.
const INITIAL_VIEW = { longitude: 103.60, latitude: 1.3521, zoom: 10.8 };
const MAP_STYLE = { width: "100%", height: "100%" } as const;
const INTERACTIVE_LAYERS = ["clusters", "unclustered-point"];

function toFeature(p: PABMarker): GeoJSON.Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: {
      id: p.id,
      name: p.name,
      status: p.status,
      address: p.address,
      town: p.town,
      callCount: p.status === "call" ? 1 : 0,
    },
  };
}

export function SingaporeMap({
  pabs: propPabs,
  onStatsLoaded,
  isResizing = false,
  leftInset = 0,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastResizeAtRef = useRef(0);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fetchedPabs, setFetchedPabs] = useState<PABMarker[] | null>(null);
  const [popupInfo, setPopupInfo] = useState<PABMarker | null>(null);
  const [cursor, setCursor] = useState("auto");
  const [filterOngoingOnly, setFilterOngoingOnly] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);

  useEffect(() => {
    if (propPabs) return;
    fetch("/api/pabs")
      .then((r) => r.json())
      .then((data: { markers: PABMarker[]; stationary: number; ongoing: number }) => {
        setFetchedPabs(data.markers);
        onStatsLoaded?.({ stationary: data.stationary, ongoing: data.ongoing });
      })
      .catch(() => {});
  }, [propPabs, onStatsLoaded]);

  const pabs = propPabs ?? fetchedPabs ?? [];

  const allGeojson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: pabs.map(toFeature),
    }),
    [pabs],
  );

  const callGeojson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: pabs.filter((p) => p.status === "call").map(toFeature),
    }),
    [pabs],
  );

  const geojson = filterOngoingOnly ? callGeojson : allGeojson;

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

  const onMouseEnter = useCallback(() => setCursor("pointer"), []);
  const onMouseLeave = useCallback(() => setCursor("auto"), []);
  const onPopupClose = useCallback(() => setPopupInfo(null), []);
  const toggleFilter = useCallback(() => setFilterOngoingOnly((v) => !v), []);

  const ongoingCount = useMemo(
    () => pabs.filter((p) => p.status === "call").length,
    [pabs],
  );

  useEffect(() => {
    if (!isMapReady || !containerRef.current) return;

    const resizeMap = () => {
      lastResizeAtRef.current = Date.now();
      mapRef.current?.resize();
    };

    const observer = new ResizeObserver(() => {
      if (isResizing) return;
      const now = Date.now();
      if (now - lastResizeAtRef.current > 80) {
        resizeMap();
        return;
      }
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(resizeMap, 90);
    });
    observer.observe(containerRef.current);

    const rafId = requestAnimationFrame(resizeMap);
    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      observer.disconnect();
    };
  }, [isMapReady, isResizing]);

  useEffect(() => {
    if (!isMapReady || isResizing) return;
    mapRef.current?.resize();
  }, [isMapReady, isResizing]);

  useEffect(() => {
    if (!isMapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    // Shift the visual center right as the left overlay grows.
    map.setPadding({
      left: Math.max(24, Math.round(leftInset + 24)),
      right: 24,
      top: 24,
      bottom: 24,
    });
  }, [isMapReady, leftInset]);

  return (
    <div ref={containerRef} className="relative w-full h-full min-w-0 overflow-hidden">
      <Map
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        maxBounds={SINGAPORE_BOUNDS}
        style={MAP_STYLE}
        mapStyle="mapbox://styles/mapbox/light-v11"
        mapboxAccessToken={MAPBOX_TOKEN}
        attributionControl={false}
        fadeDuration={0}
        interactiveLayerIds={INTERACTIVE_LAYERS}
        onClick={onClick}
        cursor={cursor}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onLoad={() => setIsMapReady(true)}
      >
        <Source
          id="pabs"
          type="geojson"
          data={geojson}
          cluster={true}
          clusterMaxZoom={14}
          clusterRadius={50}
          clusterProperties={{
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
            onClose={onPopupClose}
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
          onClick={toggleFilter}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border shadow-sm transition-colors",
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
      <div
        className="absolute bottom-4 bg-white rounded border border-slate-200 shadow-sm p-3 text-xs space-y-2"
        style={{ left: `${Math.max(16, leftInset + 16)}px` }}
      >
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
