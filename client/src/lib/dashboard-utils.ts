import type { DBConversation, DBMessage, DBPAB } from "./supabase";
import type { UIConversation, UIMessage } from "@/components/dashboard/conversations-view";
import type { PABMarker } from "@/components/map/singapore-map";

const CLOSED_STATUSES = new Set(["resolved", "closed", "completed", "done"]);

export function deriveRole(author: string): "senior" | "agent" | "human" {
  const lower = author.toLowerCase();
  if (lower.includes("pab assistant") || lower === "agent" || lower === "assistant") return "agent";
  if (lower.startsWith("nurse") || lower.startsWith("dr ") || lower.startsWith("doctor")) return "human";
  return "senior";
}

export function normalizePhase(triage: string | null): "triage" | "diagnosis" {
  if (triage?.toLowerCase() === "diagnosis") return "diagnosis";
  return "triage";
}

export function isOngoing(c: DBConversation): boolean {
  return !c.classification || !CLOSED_STATUSES.has(c.classification.toLowerCase());
}

export function toUIConversations(raw: (DBConversation & { messages: DBMessage[] })[]): UIConversation[] {
  return raw.map((c) => {
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
}

export function toPABMarkers(pabs: DBPAB[], ongoingConversations: DBConversation[]): PABMarker[] {
  const validPABs = pabs.filter((p) => p.latitude != null && p.longitude != null);
  const pabsWithCall = new Set<string>(
    ongoingConversations.flatMap((c) => (c.pab_id ? [c.pab_id] : [])),
  );

  return validPABs.map((p) => ({
    id: p.id,
    name: p.unit ?? p.id,
    lat: p.latitude!,
    lng: p.longitude!,
    status: pabsWithCall.has(p.id) ? ("call" as const) : ("active" as const),
    address: p.unit ?? "",
    town: p.unit ?? "",
  }));
}
