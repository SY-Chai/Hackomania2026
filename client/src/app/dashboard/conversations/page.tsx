import { fetchConversationsWithMessages } from "@/lib/supabase";
import { ConversationsView, type UIConversation, type UIMessage } from "@/components/dashboard/conversations-view";

function deriveRole(author: string): "senior" | "agent" | "human" {
  const lower = author.toLowerCase();
  if (lower.includes("pab assistant") || lower === "agent" || lower === "assistant") return "agent";
  // Names that sound like medical staff (nurse/dr/doctor prefix)
  if (lower.startsWith("nurse") || lower.startsWith("dr ") || lower.startsWith("doctor")) return "human";
  return "senior";
}

function normalizePhase(triage: string | null): "triage" | "diagnosis" {
  if (triage?.toLowerCase() === "diagnosis") return "diagnosis";
  return "triage";
}

export default async function ConversationsPage() {
  let raw: Awaited<ReturnType<typeof fetchConversationsWithMessages>> = [];
  try {
    raw = await fetchConversationsWithMessages();
  } catch {
    // fall back to empty
  }

  const conversations: UIConversation[] = raw.map((c) => {
    const messages: UIMessage[] = c.messages.map((m) => ({
      id: m.id,
      sender: deriveRole(m.author),
      senderName: m.author,
      content: m.content ?? "",
      timestamp: m.start ?? "",
    }));

    const lastMsg = messages[messages.length - 1];

    return {
      id: c.id,
      phase: normalizePhase(c.triage),
      classification: c.classification,
      startedAt: c.timestamp,
      lastActivity: lastMsg?.timestamp ?? c.timestamp,
      messages,
    };
  });

  return <ConversationsView conversations={conversations} />;
}
