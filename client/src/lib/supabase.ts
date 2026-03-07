import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;

export const supabase = typeof window === 'undefined' && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!)
  : null;

// Browser client (publishable key — safe to expose)
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
);
// --- Types matching the DB schema ---

export interface DBConversation {
  id: string;
  start: string | null;
  end: string | null;
  triage: string | null;
  classification: string | null;
  severity: "urgent" | "uncertain" | "non_urgent" | null;
  severity_conf: number | null;
  severity_reason: string | null;
  summary: string | null;
  audio_url: string | null;
}

export interface DBMessage {
  id: string;
  author_id: string | null;
  content: string | null;
  timestamp: string | null;
  conversation_id: string;
}

export interface DBPAB {
  id: string;
  longitude: number | null;
  latitude: number | null;
  unit_no: string | null;
  postal_code: string | null;
  street_name: string | null;
}

export interface DBElderly {
  id: string;
  name: string | null;
  age: number | null;
  metadata: Record<string, unknown> | null;
}

// --- Fetch helpers ---

export async function fetchConversations(): Promise<DBConversation[]> {
  const { data, error } = await supabase!
    .from("conversations")
    .select("*")
    .order("start", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchConversationsWithMessages(): Promise<
  (DBConversation & { messages: DBMessage[] })[]
> {
  const { data: convs, error: convErr } = await supabase!
    .from("conversations")
    .select("*")
    .order("start", { ascending: false });

  if (convErr) throw convErr;
  if (!convs?.length) return [];

  const { data: msgs, error: msgErr } = await supabase!
    .from("messages")
    .select("*")
    .in(
      "conversation_id",
      convs.map((c) => c.id),
    )
    .order("timestamp", { ascending: true });

  if (msgErr) throw msgErr;

  const msgsByConv = (msgs ?? []).reduce<Record<string, DBMessage[]>>(
    (acc, m) => {
      const cid = m.conversation_id;
      if (!acc[cid]) acc[cid] = [];
      acc[cid].push(m);
      return acc;
    },
    {},
  );

  return convs.map((c) => ({
    ...c,
    messages: msgsByConv[c.id] ?? [],
  }));
}

export async function fetchPABs(): Promise<DBPAB[]> {
  const pageSize = 1000;
  let page = 0;
  const all: DBPAB[] = [];

  while (true) {
    const { data, error } = await supabase!
      .from("pabs")
      .select("*")
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  return all;
}
