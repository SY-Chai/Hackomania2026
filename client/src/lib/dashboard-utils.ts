import type { DBConversation, DBMessage, DBPAB } from "./supabase";
import type {
  UIConversation,
  UIMessage,
} from "@/components/dashboard/conversations-view";
import type { PABMarker } from "@/components/map/singapore-map";

// const CLOSED_STATUSES = new Set(["resolved", "closed", "completed", "done"]);

export function deriveRole(
  userType: string | null | undefined,
): "senior" | "agent" | "human" {
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

export function parseOperatorSummary(
  raw: unknown,
): UIConversation["operatorSummary"] {
  if (!raw) return null;

  try {
    const parsed =
      typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
    if (!parsed || typeof parsed !== "object") return null;

    const asArray = (value: unknown) =>
      Array.isArray(value)
        ? value
            .map((v) => String(v ?? "").trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];

    const incident_overview = String(
      (parsed as { incident_overview?: unknown }).incident_overview ?? "",
    ).trim();
    const recommended_next_step = String(
      (parsed as { recommended_next_step?: unknown }).recommended_next_step ??
        "",
    ).trim();

    if (!incident_overview && !recommended_next_step) return null;

    return {
      incident_overview: incident_overview || "No overview available yet.",
      key_symptoms: asArray((parsed as { key_symptoms?: unknown }).key_symptoms),
      risk_factors: asArray((parsed as { risk_factors?: unknown }).risk_factors),
      actions_taken: asArray((parsed as { actions_taken?: unknown }).actions_taken),
      recommended_next_step:
        recommended_next_step || "Continue monitoring and gather more details.",
    };
  } catch {
    return null;
  }
}

/** Sort messages oldest-first by timestamp. Returns a new array. */
export function sortMessages<T extends { timestamp: string }>(
  messages: T[],
): T[] {
  return [...messages].sort((a, b) => {
    const aTs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bTs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return aTs - bTs;
  });
}

export function isOngoing(c: DBConversation): boolean {
  return !c.end;
}

export function toUIConversations(
  raw: (DBConversation & { messages: DBMessage[] })[],
): UIConversation[] {
  return raw.map((c) => {
    const messages: UIMessage[] = sortMessages(
      c.messages.map((m) => {
        const role = deriveRole(m.users?.type);
        return {
          id: m.id,
          sender: role,
          senderName:
            role === "agent"
              ? "AI Agent"
              : role === "human"
                ? "Operator"
                : "Senior",
          content: m.content ?? "",
          timestamp: m.timestamp ?? "",
        };
      }),
    );

    const seniorMsg = c.messages.find(
      (m) => deriveRole(m.users?.type) === "senior",
    );
    const lastMsg = messages.at(-1);

    return {
      id: c.id,
      pabId: seniorMsg?.author_id ?? null,
      phase: normalizePhase(c.triage),
      // classification: c.classification,
      severity: c.severity,
      severityConf: c.severity_conf,
      severityReason: c.severity_reason,
      operatorSummary: parseOperatorSummary(c.summary),
      startedAt: c.start,
      lastActivity: lastMsg?.timestamp ?? c.start,
      messages,
    };
  });
}

export function toPABMarkers(
  pabs: DBPAB[],
  ongoingConversations: (DBConversation & { messages: DBMessage[] })[],
): PABMarker[] {
  const ongoingPabIds = new Set(
    ongoingConversations
      .map((c) => {
        const userMsg = c.messages.find(
          (m) => deriveRole(m.users?.type) === "senior",
        );
        return userMsg ? userMsg.author_id : null;
      })
      .filter((id): id is string => typeof id === "string"),
  );

  const validPABs = pabs.filter(
    (p) => p.latitude != null && p.longitude != null,
  );

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
