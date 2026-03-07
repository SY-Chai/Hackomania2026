import { SingaporeMap } from "@/components/map/singapore-map";
import { stationaryPABs, wearablePABAggregates } from "@/lib/mock-data";
import { AlertTriangle, MapPin, Users, Wifi } from "lucide-react";

export default function MapPage() {
  const totalStationary = stationaryPABs.length;
  const alertCount = stationaryPABs.filter((p) => p.status === "alert").length;
  const activeCount = stationaryPABs.filter((p) => p.status === "active").length;
  const totalWearables = wearablePABAggregates.reduce((sum, t) => sum + t.count, 0);

  const stats = [
    { label: "Stationary PABs", value: totalStationary, icon: MapPin, color: "text-slate-700", bg: "bg-slate-100" },
    { label: "Active", value: activeCount, icon: Wifi, color: "text-emerald-700", bg: "bg-emerald-50" },
    { label: "Alerts", value: alertCount, icon: AlertTriangle, color: "text-red-700", bg: "bg-red-50" },
    { label: "Wearables online", value: totalWearables, icon: Users, color: "text-blue-700", bg: "bg-blue-50" },
  ];

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Singapore PAB Map</h1>
        <p className="text-sm text-slate-500 mt-0.5">Real-time overview of all personal alert buttons</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-3">
            <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${bg}`}>
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-900 leading-none">{value}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Map */}
      <div className="flex-1 min-h-0 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <SingaporeMap />
      </div>

      {/* Alert row */}
      {alertCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <p className="text-sm text-red-700">
            <span className="font-semibold">{alertCount} active alerts</span> — Tampines Hub, Clementi CC, Toa Payoh Central require attention
          </p>
        </div>
      )}
    </div>
  );
}
