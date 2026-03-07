import { createClient } from "@supabase/supabase-js";
import { S3Client } from "@aws-sdk/client-s3";

// Supabase
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SECRET_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables.",
  );
}
export const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
if (supabase) console.log("Supabase client initialized");

// Cloudflare R2
export const r2Bucket = "hackomania-2026";
const rawEndpoint = process.env.CLOUDFLARE_S3_API || "";
const r2Endpoint = rawEndpoint.endsWith(`/${r2Bucket}`)
  ? rawEndpoint.replace(`/${r2Bucket}`, "")
  : rawEndpoint;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_S3_ACCESS_KEY || "",
    secretAccessKey: process.env.CLOUDFLARE_S3_SECRET_ACCESS_KEY || "",
  },
});

// Tracks currently live calls by conversation ID.
// source: "openai" for browser caller socket, "esp32" for hardware bridge
// callerSocketId: the browser caller socket (OpenAI flow)
// operatorSocketId: operator socket that took over the call (if any)
// takeoverActive: whether AI responses are paused in favor of operator audio
// esp32Socket: ESP32 bridge websocket for hardware calls
export const liveConversationSessions = new Map();
