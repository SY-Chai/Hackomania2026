import type { DBConversation, DBMessage, DBPAB } from "./supabase";
import type { UIConversation, UIMessage } from "@/components/dashboard/conversations-view";
import type { PABMarker } from "@/components/map/singapore-map";

const CLOSED_STATUSES = new Set(["resolved", "closed", "completed", "done"]);
export function deriveRole(userType: string | null | undefined): "senior" | "agent" | "human" {
  if (!userType) return "senior";
  const t = userType.toLowerCase();
  if (t === "agent") return "agent";
  if (t === "human" || t === "operator") return "human";
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
    const messages: UIMessage[] = c.messages.map((m) => {
      const role = deriveRole(m.users?.type);
      return {
        id: m.id,
        sender: role,
        senderName: role === "agent" ? "AI Agent" : role === "human" ? "Operator" : "Senior",
        content: m.content ?? "",
        timestamp: m.timestamp ?? "",
      };
    });
    const seniorMsg = c.messages.find((m) => deriveRole(m.users?.type) === "senior");
    const lastMsg = messages[messages.length - 1];
    return {
      id: c.id,
      pabId: seniorMsg?.author_id ?? null,
      phase: normalizePhase(c.triage),
      classification: c.classification,
      severity: c.severity,
      severityConf: c.severity_conf,
      severityReason: c.severity_reason,
      startedAt: c.start,
      lastActivity: lastMsg?.timestamp ?? c.start,
      messages,
    };
  });
}

export function toPABMarkers(pabs: DBPAB[], ongoingConversations: (DBConversation & { messages: DBMessage[] })[]): PABMarker[] {
  const ongoingPabIds = new Set(
    ongoingConversations
      .map((c) => {
        const userMsg = c.messages.find(m => deriveRole(m.users?.type) === "senior");
        return userMsg ? userMsg.author_id : null;
      })
      .filter((id): id is string => typeof id === "string")
  );

  const validPABs = pabs.filter((p) => p.latitude != null && p.longitude != null);
  return validPABs.map((p) => ({
    id: p.id,
    name: p.unit_no ?? p.id,
    lat: p.latitude!,
    lng: p.longitude!,
    status: ongoingPabIds.has(p.id) ? "call" : ("active" as const),
    address: [p.unit_no, p.street_name].filter(Boolean).join(" "),
    town: p.street_name ?? "",
  }));
}
