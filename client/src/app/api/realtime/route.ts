import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!,
      );

      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // client disconnected
        }
      };

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, 25000);

      const channel = supabase
        .channel("sse-realtime")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "conversations" },
          (payload) => send("conversation_insert", payload.new),
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "conversations" },
          (payload) => send("conversation_update", payload.new),
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          (payload) => send("message_insert", payload.new),
        )
        .subscribe();

      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        supabase.removeChannel(channel);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
