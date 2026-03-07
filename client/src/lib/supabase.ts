import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);

// --- Types matching the DB schema ---

export interface DBConversation {
  id: string;
  timestamp: string | null;
  triage: string | null;
  classification: string | null;
  pab_id?: string | null;
}

export interface DBMessage {
  id: string;
  author: string;
  content: string | null;
  start: string | null;
  end: string | null;
  conversation_id: string;
}

export interface DBPAB {
  id: string;
  longitude: number | null;
  latitude: number | null;
  unit: string | null;
}

export interface DBElderly {
  id: string;
  name: string | null;
  age: number | null;
  metadata: Record<string, unknown> | null;
}

// --- Fetch helpers ---

export async function fetchConversations(): Promise<DBConversation[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .order("timestamp", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchConversationsWithMessages(): Promise<(DBConversation & { messages: DBMessage[] })[]> {
  const { data: convs, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .order("timestamp", { ascending: false });

  if (convErr) throw convErr;
  if (!convs?.length) return [];

  const { data: msgs, error: msgErr } = await supabase
    .from("messages")
    .select("*")
    .in("conversation_id", convs.map((c) => c.id))
    .order("start", { ascending: true });

  if (msgErr) throw msgErr;

  const msgsByConv = (msgs ?? []).reduce<Record<string, DBMessage[]>>((acc, m) => {
    const cid = m.conversation_id;
    if (!acc[cid]) acc[cid] = [];
    acc[cid].push(m);
    return acc;
  }, {});

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
    const { data, error } = await supabase
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
