import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const { data, error } = await supabase!
    .from("pabs")
    .select("id,unit_no,postal_code,street_name")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json(null);
  }

  return NextResponse.json({
    id: data.id,
    unitNo: data.unit_no,
    postalCode: data.postal_code,
    streetName: data.street_name,
  });
}
