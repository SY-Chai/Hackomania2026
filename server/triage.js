import { supabase } from "./config.js";

export const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

export const MAX_ROLLING_CHUNKS = 20; // ~1.6 seconds of rolling historical context
export const MAX_CONVERSATION_PCM_BYTES = 50 * 1024 * 1024; // 50 MB cap per call
export const TRIAGE_INTERVAL_MS = Number(process.env.SEVERITY_REEVAL_MS || 10000);
export const TRIAGE_MAX_TURNS = 12;

export const DEFAULT_SEVERITY = {
  severity: "uncertain",
  severity_conf: 25,
  severity_reason: "Awaiting enough context to assess severity.",
  operator_summary: {
    incident_overview: "Conversation started. Awaiting transcript details.",
    key_symptoms: [],
    risk_factors: [],
    actions_taken: [],
    recommended_next_step: "Continue gathering details from the senior.",
  },
};

// ------------------------------------------------------------------
// Severity normalization helpers
// ------------------------------------------------------------------

export function normalizeSeverity(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "urgent") return "urgent";
  if (normalized === "non_urgent" || normalized === "not_urgent")
    return "non_urgent";
  return "uncertain";
}

export function normalizeConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  return Math.round(Math.max(0, Math.min(1, num)) * 100);
}

export function normalizeOperatorSummary(value) {
  const summary = value && typeof value === "object" ? value : {};
  const asArray = (arr) =>
    Array.isArray(arr)
      ? arr
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

  return {
    incident_overview:
      String(summary.incident_overview || "").trim() ||
      "Conversation summary unavailable yet.",
    key_symptoms: asArray(summary.key_symptoms),
    risk_factors: asArray(summary.risk_factors),
    actions_taken: asArray(summary.actions_taken),
    recommended_next_step:
      String(summary.recommended_next_step || "").trim() ||
      "Gather more details and continue monitoring.",
  };
}

// ------------------------------------------------------------------
// Severity assessment (OpenAI chat completions)
// ------------------------------------------------------------------

export async function assessConversationSeverity(turns) {
  if (!process.env.OPENAI_API_KEY || !turns.length) return null;

  const transcript = turns
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.text}`)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.SEVERITY_MODEL || "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are a medical triage assistant for emergency elder-care calls.",
            "Classify urgency conservatively and output strict JSON only.",
            "Use this rubric (each score is 0-5):",
            "- life_threat: chest pain, severe breathlessness, stroke signs, unresponsiveness, major bleeding.",
            "- instability: worsening symptoms, confusion, cannot stand/speak, persistent severe distress.",
            "- injury_mechanism: high-risk fall, head impact, possible fracture, anticoagulant risk.",
            "- vulnerability: very old age, lives alone, major comorbidities, no immediate support.",
            "- reliability: clarity and completeness of information from conversation.",
            "Compute weighted_risk = 0.35*life_threat + 0.25*instability + 0.15*injury_mechanism + 0.10*vulnerability + 0.15*(5-reliability).",
            "Then divide weighted_risk by 5 to get risk_0_to_1.",
            "Severity decision rules:",
            "- urgent: life_threat >= 4 OR instability >= 4 OR risk_0_to_1 >= 0.72.",
            "- non_urgent: risk_0_to_1 <= 0.35 AND life_threat <= 1 AND instability <= 1.",
            "- uncertain: all other cases, including conflicting or sparse information.",
            "Confidence calibration rules:",
            "- Build confidence from signal strength, evidence consistency, and reliability.",
            "- Keep confidence lower when transcript is short, noisy, or contradictory.",
            "- If severity is uncertain, cap confidence at 0.75.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Assess this conversation using the rubric and output one severity.",
            "",
            "Return JSON with exactly these keys:",
            [
              "{",
              '  "severity": "urgent|uncertain|non_urgent",',
              '  "severity_conf": 0..1,',
              '  "severity_reason": "short operator-facing reason",',
              '  "operator_summary": {',
              '    "incident_overview": "one-line context",',
              '    "key_symptoms": ["symptom 1", "symptom 2"],',
              '    "risk_factors": ["risk 1"],',
              '    "actions_taken": ["action already done in call"],',
              '    "recommended_next_step": "single immediate next step for operator"',
              "  },",
              '  "rubric_scores": {',
              '    "life_threat": 0..5,',
              '    "instability": 0..5,',
              '    "injury_mechanism": 0..5,',
              '    "vulnerability": 0..5,',
              '    "reliability": 0..5',
              "  },",
              '  "risk_0_to_1": 0..1',
              "}",
            ].join("\n"),
            "",
            "Conversation transcript:",
            transcript,
          ].join("\n"),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "severity_triage",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              severity: {
                type: "string",
                enum: ["urgent", "uncertain", "non_urgent"],
              },
              severity_conf: { type: "number", minimum: 0, maximum: 1 },
              severity_reason: { type: "string", minLength: 1, maxLength: 240 },
              operator_summary: {
                type: "object",
                additionalProperties: false,
                properties: {
                  incident_overview: {
                    type: "string",
                    minLength: 1,
                    maxLength: 240,
                  },
                  key_symptoms: {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 120 },
                    maxItems: 5,
                  },
                  risk_factors: {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 120 },
                    maxItems: 5,
                  },
                  actions_taken: {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 120 },
                    maxItems: 5,
                  },
                  recommended_next_step: {
                    type: "string",
                    minLength: 1,
                    maxLength: 180,
                  },
                },
                required: [
                  "incident_overview",
                  "key_symptoms",
                  "risk_factors",
                  "actions_taken",
                  "recommended_next_step",
                ],
              },
              rubric_scores: {
                type: "object",
                additionalProperties: false,
                properties: {
                  life_threat: { type: "integer", minimum: 0, maximum: 5 },
                  instability: { type: "integer", minimum: 0, maximum: 5 },
                  injury_mechanism: { type: "integer", minimum: 0, maximum: 5 },
                  vulnerability: { type: "integer", minimum: 0, maximum: 5 },
                  reliability: { type: "integer", minimum: 0, maximum: 5 },
                },
                required: [
                  "life_threat",
                  "instability",
                  "injury_mechanism",
                  "vulnerability",
                  "reliability",
                ],
              },
              risk_0_to_1: { type: "number", minimum: 0, maximum: 1 },
            },
            required: [
              "severity",
              "severity_conf",
              "severity_reason",
              "operator_summary",
              "rubric_scores",
              "risk_0_to_1",
            ],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Severity model request failed (${response.status}): ${body || "empty body"}`,
    );
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error("Severity model response missing content.");

  const parsed = JSON.parse(rawContent);
  return {
    severity: normalizeSeverity(parsed?.severity),
    severity_conf: normalizeConfidence(parsed?.severity_conf),
    severity_reason: String(
      parsed?.severity_reason || "No rationale provided.",
    ),
    operator_summary: normalizeOperatorSummary(parsed?.operator_summary),
  };
}

// ------------------------------------------------------------------
// Per-session triage state manager
// ------------------------------------------------------------------

/**
 * Creates a triage state manager for a single conversation session.
 *
 * @param {object} opts
 * @param {import('socket.io').Server} opts.io
 * @param {() => string|null} opts.getConversationId - returns current conversation ID
 * @param {string} opts.label - label for log messages
 */
export function createTriageManager({ io, getConversationId, label }) {
  let triageTurns = [];
  let triageIntervalHandle = null;
  let triageInFlight = false;
  let triageQueued = false;
  let triageDirty = false;
  let urgentDowngradeStreak = 0;
  let latestSeverity = {
    severity: DEFAULT_SEVERITY.severity,
    severity_conf: DEFAULT_SEVERITY.severity_conf,
    severity_reason: DEFAULT_SEVERITY.severity_reason,
    operator_summary: { ...DEFAULT_SEVERITY.operator_summary },
  };

  const queueTriage = () => {
    triageDirty = true;
  };

  const pushTriageTurn = (role, text) => {
    const cleaned = String(text || "").trim();
    if (!cleaned) return;
    triageTurns.push({ role, text: cleaned });
    if (triageTurns.length > TRIAGE_MAX_TURNS) {
      triageTurns = triageTurns.slice(-TRIAGE_MAX_TURNS);
    }
    queueTriage();
  };

  const resolveSeverityTransition = (nextSeverity) => {
    const current = latestSeverity.severity;
    const proposed = nextSeverity.severity;

    if (proposed === "urgent") {
      urgentDowngradeStreak = 0;
      return nextSeverity;
    }

    if (current === "urgent" && proposed !== "urgent") {
      urgentDowngradeStreak += 1;
      if (urgentDowngradeStreak < 2) {
        return {
          ...latestSeverity,
          operator_summary:
            nextSeverity.operator_summary ?? latestSeverity.operator_summary,
          severity_reason: `Holding urgent until reconfirmed: ${nextSeverity.severity_reason}`,
        };
      }
      urgentDowngradeStreak = 0;
      return nextSeverity;
    }

    urgentDowngradeStreak = 0;
    return nextSeverity;
  };

  const persistAndBroadcastSeverity = async (assessment) => {
    const conversationId = getConversationId();
    if (!conversationId) return;
    latestSeverity = assessment;
    const serializedSummary = assessment.operator_summary
      ? JSON.stringify(assessment.operator_summary)
      : null;

    if (supabase) {
      const { error } = await supabase
        .from("conversations")
        .update({
          severity: assessment.severity,
          severity_conf: assessment.severity_conf,
          severity_reason: assessment.severity_reason,
          summary: serializedSummary,
        })
        .eq("id", conversationId);

      if (error) {
        console.error(
          `❌ Failed to persist severity for ${conversationId}:`,
          error,
        );
      } else {
        io.emit("dashboard_update");
      }
    }

    io.emit("severity_update", {
      conversationId,
      severity: assessment.severity,
      severity_conf: assessment.severity_conf,
      severity_reason: assessment.severity_reason,
      operator_summary: assessment.operator_summary ?? null,
      updatedAt: new Date().toISOString(),
    });
  };

  const runTriage = async () => {
    const conversationId = getConversationId();
    if (!triageDirty || !triageTurns.length || !conversationId) return;
    if (triageInFlight) {
      triageQueued = true;
      return;
    }

    triageInFlight = true;
    triageDirty = false;
    try {
      const assessment = await assessConversationSeverity(triageTurns);
      if (!assessment) return;
      const stabilized = resolveSeverityTransition(assessment);
      await persistAndBroadcastSeverity(stabilized);
    } catch (err) {
      console.error(`[${label}] Severity triage failed:`, err);
    } finally {
      triageInFlight = false;
      if (triageQueued) {
        triageQueued = false;
        queueTriage();
      }
    }
  };

  const startTriageLoop = () => {
    if (triageIntervalHandle) return;
    triageIntervalHandle = setInterval(() => {
      runTriage().catch((err) => {
        console.error(`[${label}] Severity loop error:`, err);
      });
    }, TRIAGE_INTERVAL_MS);
  };

  const stopTriageLoop = () => {
    if (!triageIntervalHandle) return;
    clearInterval(triageIntervalHandle);
    triageIntervalHandle = null;
  };

  return {
    pushTriageTurn,
    startTriageLoop,
    stopTriageLoop,
    getLatestSeverity: () => latestSeverity,
  };
}
