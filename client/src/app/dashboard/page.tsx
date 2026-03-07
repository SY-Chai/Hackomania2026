import { Suspense } from "react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import {
  fetchPABs,
  fetchConversationsWithMessages,
} from "@/lib/supabase";
import {
  toUIConversations,
  toPABMarkers,
  isOngoing,
} from "@/lib/dashboard-utils";

async function DashboardContent() {
  const [pabs, rawConversations] = await Promise.all([
    fetchPABs(),
    fetchConversationsWithMessages(),
  ]);

  const ongoing = rawConversations.filter(isOngoing);

  return (
    <DashboardShell
      conversations={toUIConversations(rawConversations)}
      mapPABs={toPABMarkers(pabs, ongoing)}
      stationary={
        pabs.filter((p) => p.latitude != null && p.longitude != null).length
      }
      ongoing={ongoing.length}
    />
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex h-full overflow-hidden animate-pulse">
      <div className="w-[700px] shrink-0 border-r border-slate-200 bg-white p-4 space-y-4">
        <div className="h-5 w-32 bg-slate-200 rounded" />
        <div className="h-8 w-full bg-slate-100 rounded" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-200 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-40 bg-slate-200 rounded" />
              <div className="h-3 w-24 bg-slate-100 rounded" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex-1 bg-slate-100" />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
