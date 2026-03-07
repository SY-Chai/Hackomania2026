import { createClient } from "@supabase/supabase-js";
import { S3Client } from "@aws-sdk/client-s3";

// Supabase
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables.");
}
export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;
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
// callerSocketId: the user's call socket
// operatorSocketId: operator socket that took over the call (if any)
// takeoverActive: whether AI responses are paused in favor of operator audio
export const liveConversationSessions = new Map();
