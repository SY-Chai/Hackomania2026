import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await supabase!
    .from("pabs")
    .select("id")
    .limit(1)
    .single();

  if (error || !data) {
    return NextResponse.json({ id: null });
  }

  return NextResponse.json({ id: data.id });
}
