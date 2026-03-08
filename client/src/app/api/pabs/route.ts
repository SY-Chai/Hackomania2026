import { NextResponse } from "next/server";
import { fetchPABs, fetchOngoingPabIds } from "@/lib/supabase";
import { toPABMarkers } from "@/lib/dashboard-utils";

export const revalidate = 300; // cache PABs for 5 minutes

export async function GET() {
  const [pabs, { pabIds, count }] = await Promise.all([
    fetchPABs(),
    fetchOngoingPabIds(),
  ]);

  const markers = toPABMarkers(pabs, pabIds);
  const stationary = pabs.filter(
    (p) => p.latitude != null && p.longitude != null,
  ).length;

  return NextResponse.json({ markers, stationary, ongoing: count });
}
