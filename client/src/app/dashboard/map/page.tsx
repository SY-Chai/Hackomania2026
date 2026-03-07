import { SingaporeMap } from "@/components/map/singapore-map";
import { fetchPABs, fetchConversations } from "@/lib/supabase";
import { AlertTriangle, MapPin, Users, Phone } from "lucide-react";

export default async function MapPage() {
  let pabs: Awaited<ReturnType<typeof fetchPABs>> = [];
  let conversations: Awaited<ReturnType<typeof fetchConversations>> = [];

  try {
    [pabs, conversations] = await Promise.all([fetchPABs(), fetchConversations()]);
  } catch {
    // fall back to whatever succeeded
    try { pabs = await fetchPABs(); } catch { /* empty */ }
  }

  const validPABs = pabs.filter(
    (p) => p.latitude != null && p.longitude != null,
  );

  // A conversation is "ongoing" if classification doesn't indicate closure.
  const CLOSED = new Set(["resolved", "closed", "completed", "done"]);
  const ongoingConversations = conversations.filter(
    (c) => !c.classification || !CLOSED.has(c.classification.toLowerCase()),
  );

  // Build set of pab_ids that have an ongoing call
  const pabsWithCall = new Set<string>(
    ongoingConversations.flatMap((c) => (c.pab_id ? [c.pab_id] : [])),
  );

  const totalStationary = validPABs.length;
  const ongoingCalls = ongoingConversations.length;

  const stats = [
    {
      label: "Stationary PABs",
      value: totalStationary,
      icon: MapPin,
      color: "text-slate-700",
      bg: "bg-slate-100",
    },
    {
      label: "Ongoing Calls",
      value: ongoingCalls,
      icon: Phone,
      color: "text-emerald-700",
      bg: "bg-emerald-50",
    },
    {
      label: "Alerts",
      value: 0,
      icon: AlertTriangle,
      color: "text-red-700",
      bg: "bg-red-50",
    },
    {
      label: "Wearables",
      value: 0,
      icon: Users,
      color: "text-blue-700",
      bg: "bg-blue-50",
    },
  ];

  // Shape for the map component
  const mapPABs = validPABs.map((p) => ({
    id: p.id,
    name: p.unit ?? p.id,
    lat: p.latitude!,
    lng: p.longitude!,
    status: pabsWithCall.has(p.id) ? ("call" as const) : ("active" as const),
    address: p.unit ?? "",
    town: p.unit ?? "",
  }));

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Singapore PAB Map
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Real-time overview of all personal alert buttons
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div
            key={label}
            className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-3"
          >
            <div
              className={`flex items-center justify-center w-9 h-9 rounded-lg ${bg}`}
            >
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-900 leading-none">
                {value}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Map */}
      <div className="flex-1 min-h-0 rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <SingaporeMap pabs={mapPABs} />
      </div>
    </div>
  );
}
