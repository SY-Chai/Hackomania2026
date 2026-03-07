import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!supabase) {
    return NextResponse.json({ error: "Server unavailable" }, { status: 503 });
  }

  const { severity } = await req.json();
  const allowed = ["urgent", "uncertain", "non_urgent", null];
  if (!allowed.includes(severity)) {
    return NextResponse.json({ error: "Invalid severity" }, { status: 400 });
  }

  const { error } = await supabase
    .from("conversations")
    .update({ severity })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
