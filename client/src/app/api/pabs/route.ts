import { NextResponse } from "next/server";
import { fetchPABs, fetchConversationsWithMessages } from "@/lib/supabase";
import { toPABMarkers, isOngoing } from "@/lib/dashboard-utils";

export const dynamic = "force-dynamic";

export async function GET() {
  const [pabs, conversations] = await Promise.all([
    fetchPABs(),
    fetchConversationsWithMessages(),
  ]);

  const ongoing = conversations.filter(isOngoing);
  const markers = toPABMarkers(pabs, ongoing);
  const stationary = pabs.filter(
    (p) => p.latitude != null && p.longitude != null,
  ).length;

  return NextResponse.json({ markers, stationary, ongoing: ongoing.length });
}
