import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import {
  fetchPABs,
  fetchConversations,
  fetchConversationsWithMessages,
} from "@/lib/supabase";
import {
  toUIConversations,
  toPABMarkers,
  isOngoing,
} from "@/lib/dashboard-utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let pabs: Awaited<ReturnType<typeof fetchPABs>> = [];
  let rawConversations: Awaited<
    ReturnType<typeof fetchConversationsWithMessages>
  > = [];
  let allConversations: Awaited<ReturnType<typeof fetchConversations>> = [];

  try {
    [pabs, rawConversations, allConversations] = await Promise.all([
      fetchPABs(),
      fetchConversationsWithMessages(),
      fetchConversations(),
    ]);
  } catch (e) {
    console.error("[dashboard] parallel fetch failed:", e);
    try {
      pabs = await fetchPABs();
    } catch (e2) {
      console.error("[dashboard] fetchPABs failed:", e2);
    }
    try {
      rawConversations = await fetchConversationsWithMessages();
    } catch (e2) {
      console.error("[dashboard] fetchConversationsWithMessages failed:", e2);
    }
    try {
      allConversations = await fetchConversations();
    } catch (e2) {
      console.error("[dashboard] fetchConversations failed:", e2);
    }
  }

  const ongoing = allConversations.filter(isOngoing);

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
