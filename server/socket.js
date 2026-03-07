import WebSocket from "ws";
import { supabase, liveConversationSessions } from "./config.js";
import { getUTC8Time, uploadToR2, convertPCM16ToWAV } from "./utils.js";
import { saveMessage, updateConversationAudio } from "./db.js";
import { ASSISTANT_PROMPT } from "./prompt.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const MAX_ROLLING_CHUNKS = 20; // ~1.6 seconds of rolling historical context (4096 bytes per chunk)
const MAX_CONVERSATION_PCM_BYTES = 50 * 1024 * 1024; // 50 MB cap per call
const TRIAGE_INTERVAL_MS = Number(process.env.SEVERITY_REEVAL_MS || 10000);
const TRIAGE_MAX_TURNS = 12;

// ------------------------------------------------------------------
// Severity assessment
// ------------------------------------------------------------------

function normalizeSeverity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "urgent") return "urgent";
  if (normalized === "non_urgent" || normalized === "not_urgent") return "non_urgent";
  return "uncertain";
}

function normalizeConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  return Math.round(Math.max(0, Math.min(1, num)) * 100);
}

async function assessConversationSeverity(turns) {
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
            '- urgent: life_threat >= 4 OR instability >= 4 OR risk_0_to_1 >= 0.72.',
            '- non_urgent: risk_0_to_1 <= 0.35 AND life_threat <= 1 AND instability <= 1.',
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
              severity: { type: "string", enum: ["urgent", "uncertain", "non_urgent"] },
              severity_conf: { type: "number", minimum: 0, maximum: 1 },
              severity_reason: { type: "string", minLength: 1, maxLength: 240 },
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
    throw new Error(`Severity model request failed (${response.status}): ${body || "empty body"}`);
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error("Severity model response missing content.");

  const parsed = JSON.parse(rawContent);
  return {
    severity: normalizeSeverity(parsed?.severity),
    severity_conf: normalizeConfidence(parsed?.severity_conf),
    severity_reason: String(parsed?.severity_reason || "No rationale provided."),
  };
}

// ------------------------------------------------------------------
// Socket setup
// ------------------------------------------------------------------

export function setupSocket(io) {
  const notifyDashboard = () => io.emit("dashboard_update");

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    let openAiWs = null;
    let activeConversationId = null;

    let assistantAudioBuffer = [];
    let userAudioBuffer = [];
    let rollingBuffer = [];
    let isRecordingUser = false;

    let fullConversationPcm = [];
    let fullConversationPcmBytes = 0;

    // Triage state
    let triageTurns = [];
    let triageIntervalHandle = null;
    let triageInFlight = false;
    let triageQueued = false;
    let triageDirty = false;
    let urgentDowngradeStreak = 0;
    let latestSeverity = {
      severity: "uncertain",
      severity_conf: 25,
      severity_reason: "Awaiting enough context to assess severity.",
    };

    const queueTriage = () => { triageDirty = true; };

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
      if (!activeConversationId) return;
      latestSeverity = assessment;

      if (supabase) {
        const { error } = await supabase
          .from("conversations")
          .update({
            severity: assessment.severity,
            severity_conf: assessment.severity_conf,
            severity_reason: assessment.severity_reason,
          })
          .eq("id", activeConversationId);

        if (error) {
          console.error(`❌ Failed to persist severity for ${activeConversationId}:`, error);
        } else {
          notifyDashboard();
        }
      }

      io.emit("severity_update", {
        conversationId: activeConversationId,
        severity: assessment.severity,
        severity_conf: assessment.severity_conf,
        severity_reason: assessment.severity_reason,
        updatedAt: new Date().toISOString(),
      });
    };

    const runTriage = async () => {
      if (!triageDirty || !triageTurns.length || !activeConversationId) return;
      if (triageInFlight) { triageQueued = true; return; }

      triageInFlight = true;
      triageDirty = false;
      try {
        const assessment = await assessConversationSeverity(triageTurns);
        if (!assessment) return;
        const stabilized = resolveSeverityTransition(assessment);
        await persistAndBroadcastSeverity(stabilized);
      } catch (err) {
        console.error(`[Socket ${socket.id}] Severity triage failed:`, err);
      } finally {
        triageInFlight = false;
        if (triageQueued) { triageQueued = false; queueTriage(); }
      }
    };

    const startTriageLoop = () => {
      if (triageIntervalHandle) return;
      triageIntervalHandle = setInterval(() => {
        runTriage().catch((err) => {
          console.error(`[Socket ${socket.id}] Severity loop error:`, err);
        });
      }, TRIAGE_INTERVAL_MS);
    };

    const stopTriageLoop = () => {
      if (!triageIntervalHandle) return;
      clearInterval(triageIntervalHandle);
      triageIntervalHandle = null;
    };

    // ------------------------------------------------------------------
    // Emergency session
    // ------------------------------------------------------------------

    socket.on("start_emergency_session", async (data) => {
      const pabId = data?.pab_id || null; // Will fallback to null if not provided
      
      if (openAiWs) {
        console.log(`[Socket ${socket.id}] WebSocket already exists.`);
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        socket.emit("session_error", "OPENAI_API_KEY is missing on the server.");
        return;
      }

      console.log(`[Socket ${socket.id}] Starting emergency session with OpenAI. PAB ID: ${pabId}`);

      if (supabase) {
        const { data: dbData, error } = await supabase
          .from("conversations")
          .insert([{
            start: getUTC8Time(),
            end: getUTC8Time(),
            triage: "agent",
            classification: "uncertain",
            severity: "uncertain",
            severity_conf: 25,
            severity_reason: "Awaiting enough context to assess severity.",
          }])
          .select();

        if (error) {
          console.error(`❌ [Socket ${socket.id}] Failed to create conversation:`, error);
        } else if (dbData?.length > 0) {
          activeConversationId = dbData[0].id;
          socket.join(activeConversationId);
          liveConversationSessions.set(activeConversationId, {
            callerSocketId: socket.id,
            operatorSocketId: null,
            takeoverActive: false,
            pabId: pabId // Store it in session map
          });
          io.emit("severity_update", {
            conversationId: activeConversationId,
            ...latestSeverity,
            updatedAt: new Date().toISOString(),
          });
          console.log(`✅ [Socket ${socket.id}] Conversation created DB ID: ${activeConversationId}`);
        }
      }

      openAiWs = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      openAiWs.on("open", () => {
        console.log(`[Socket ${socket.id}] Connected to OpenAI Realtime API`);
        openAiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: ASSISTANT_PROMPT.trim(),
            voice: "sage",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.65,
              prefix_padding_ms: 300,
              silence_duration_ms: 1000,
            },
          },
        }));
        socket.emit("session_started");
        startTriageLoop();
      });

      function handleTranscriptDone(role, audioBuffer, event) {
        pushTriageTurn(role, event.transcript);
        socket.emit("history_updated", [{
          id: event.item_id || Date.now().toString(),
          role,
          text: event.transcript,
        }]);
        if (activeConversationId) {
          const fullPcmBuffer = Buffer.concat(audioBuffer);
          if (fullPcmBuffer.length > 0 && fullConversationPcmBytes < MAX_CONVERSATION_PCM_BYTES) {
            fullConversationPcm.push(fullPcmBuffer);
            fullConversationPcmBytes += fullPcmBuffer.length;
          }
          
          let authorIdToSave = null;
          if (role === "agent") {
            authorIdToSave = process.env.AGENT_ID;
          } else if (role === "user") {
            const session = liveConversationSessions.get(activeConversationId);
            authorIdToSave = session?.pabId || null;
          }
           
          saveMessage(activeConversationId, authorIdToSave, event.transcript, notifyDashboard);
        }
      }

      openAiWs.on("message", (message) => {
        try {
          const event = JSON.parse(message.toString());

          switch (event.type) {
            case "response.audio.delta":
              if (event.delta) {
                const isOperatorTakeover = !!(
                  activeConversationId &&
                  liveConversationSessions.get(activeConversationId)?.takeoverActive
                );
                if (isOperatorTakeover) break;

                const buffer = Buffer.from(event.delta, "base64");
                assistantAudioBuffer.push(buffer);
                socket.emit("server_audio", buffer);
                if (activeConversationId) {
                  socket.to(activeConversationId).emit("conversation_audio", "agent", buffer);
                }
              }
              break;

            case "response.audio_transcript.done":
              handleTranscriptDone("agent", assistantAudioBuffer, event);
              assistantAudioBuffer = [];
              break;

            case "conversation.item.input_audio_transcription.completed":
              handleTranscriptDone("user", userAudioBuffer, event);
              userAudioBuffer = [];
              break;

            case "error":
              console.error(`[Socket ${socket.id}] OpenAI error:`, event.error);
              socket.emit("session_error", event.error?.message || "Unknown OpenAI error");
              break;

            case "input_audio_buffer.speech_started":
              socket.emit("status_update", "Listening...");
              isRecordingUser = true;
              userAudioBuffer = [...rollingBuffer];
              rollingBuffer = [];
              break;

            case "input_audio_buffer.speech_stopped":
              socket.emit("status_update", "Processing...");
              isRecordingUser = false;
              break;
          }
        } catch (err) {
          console.error("Error handling OpenAI message:", err);
        }
      });

      openAiWs.on("close", () => {
        console.log(`[Socket ${socket.id}] OpenAI WebSocket closed`);
        socket.emit("session_stopped");
        stopTriageLoop();

        if (activeConversationId) {
          io.to(activeConversationId).emit("operator_takeover_stopped", {
            conversationId: activeConversationId,
          });
          liveConversationSessions.delete(activeConversationId);

          if (supabase) {
            supabase
              .from("conversations")
              .update({ end: getUTC8Time() })
              .eq("id", activeConversationId)
              .then(() => {
                console.log(`[Socket ${socket.id}] Logged end time for conversation ${activeConversationId}`);
                notifyDashboard();
              })
              .catch((err) => console.error("Error logging end time:", err));
          }

          if (fullConversationPcm.length > 0) {
            const finalPcm = Buffer.concat(fullConversationPcm);
            const wavBuffer = convertPCM16ToWAV(finalPcm, 24000);
            const fileName = `calls/conversation-${activeConversationId}.wav`;

            uploadToR2(wavBuffer, fileName, "audio/wav")
              .then(() => updateConversationAudio(activeConversationId, fileName, notifyDashboard))
              .catch((err) => console.error("Error uploading conversation audio:", err));
          }
        }

        openAiWs = null;
      });

      openAiWs.on("error", (err) => {
        console.error(`[Socket ${socket.id}] OpenAI WebSocket error:`, err);
        socket.emit("session_error", "WebSocket error connecting to OpenAI");
      });
    });

    // ------------------------------------------------------------------
    // Audio forwarding
    // ------------------------------------------------------------------

    socket.on("client_audio", (pcm16Buffer) => {
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;

      const session = activeConversationId
        ? liveConversationSessions.get(activeConversationId)
        : null;
      const isOperatorTakeover = !!(session?.takeoverActive && session?.operatorSocketId);
      const buf = Buffer.from(pcm16Buffer);

      if (isOperatorTakeover) {
        if (activeConversationId) {
          socket.to(activeConversationId).emit("conversation_audio", "user", buf);
        }
        return;
      }

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.toString("base64") }));

      if (isRecordingUser) {
        userAudioBuffer.push(buf);
        if (activeConversationId) {
          socket.to(activeConversationId).emit("conversation_audio", "user", buf);
        }
      } else {
        rollingBuffer.push(buf);
        if (rollingBuffer.length > MAX_ROLLING_CHUNKS) rollingBuffer.shift();
      }
    });

    socket.on("stop_emergency_session", () => {
      console.log(`[Socket ${socket.id}] stop_emergency_session`);
      if (openAiWs) {
        openAiWs.close();
        openAiWs = null;
      }
      stopTriageLoop();
    });

    // ------------------------------------------------------------------
    // Operator takeover
    // ------------------------------------------------------------------

    socket.on("operator_takeover_start", async (conversationId) => {
      if (!conversationId) {
        socket.emit("operator_takeover_error", "Conversation ID is required.");
        return;
      }

      const session = liveConversationSessions.get(conversationId);
      if (!session?.callerSocketId) {
        socket.emit("operator_takeover_error", "This call is no longer live.");
        return;
      }

      if (session.operatorSocketId && session.operatorSocketId !== socket.id) {
        socket.emit("operator_takeover_error", "Another operator is already handling this call.");
        return;
      }

      session.operatorSocketId = socket.id;
      session.takeoverActive = true;
      socket.join(conversationId);

      if (supabase) {
        const { error } = await supabase
          .from("conversations")
          .update({ triage: "operator" })
          .eq("id", conversationId);

        if (error) {
          console.error(`❌ Failed to update triage=operator for ${conversationId}:`, error);
        } else {
          console.log(`✅ Conversation ${conversationId} triage updated to operator`);
          notifyDashboard();
        }
      }

      io.to(conversationId).emit("operator_takeover_started", {
        conversationId,
        operatorSocketId: socket.id,
      });
      io.to(session.callerSocketId).emit("status_update", "Operator joined the call");
    });

    socket.on("operator_audio", (payload) => {
      const { conversationId, audio } = payload || {};
      if (!conversationId || !audio) return;

      const session = liveConversationSessions.get(conversationId);
      if (!session?.callerSocketId) return;
      if (!session.takeoverActive || session.operatorSocketId !== socket.id) return;

      const buf = Buffer.from(audio);
      io.to(session.callerSocketId).emit("server_audio", buf);
      socket.to(conversationId).emit("conversation_audio", "agent", buf);
    });

    socket.on("operator_takeover_stop", (conversationId) => {
      if (!conversationId) return;
      const session = liveConversationSessions.get(conversationId);
      if (!session) return;

      const isOperator = session.operatorSocketId === socket.id;
      const isCaller = session.callerSocketId === socket.id;
      if (!isOperator && !isCaller) return;

      session.operatorSocketId = null;
      session.takeoverActive = false;

      io.to(conversationId).emit("operator_takeover_stopped", { conversationId });
      if (session.callerSocketId) {
        io.to(session.callerSocketId).emit("status_update", "AI assistant resumed");
      }
    });

    // ------------------------------------------------------------------
    // Room management
    // ------------------------------------------------------------------

    socket.on("join_conversation", (conversationId) => {
      if (!conversationId) return;
      socket.join(conversationId);
      socket.emit("conversation_joined", conversationId);
      console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
    });

    socket.on("leave_conversation", (conversationId) => {
      if (!conversationId) return;
      socket.leave(conversationId);
      socket.emit("conversation_left", conversationId);
      console.log(`Socket ${socket.id} left conversation ${conversationId}`);
    });

    socket.on("send_message_stream", (data) => {
      socket.to(data.conversationId).emit("receive_message_stream", data);
    });

    // ------------------------------------------------------------------
    // Disconnect
    // ------------------------------------------------------------------

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);

      for (const [conversationId, session] of liveConversationSessions.entries()) {
        if (session.operatorSocketId === socket.id) {
          session.operatorSocketId = null;
          session.takeoverActive = false;
          io.to(conversationId).emit("operator_takeover_stopped", { conversationId });
          if (session.callerSocketId) {
            io.to(session.callerSocketId).emit("status_update", "AI assistant resumed");
          }
        }
      }

      if (activeConversationId) {
        const session = liveConversationSessions.get(activeConversationId);
        if (session?.callerSocketId === socket.id) {
          liveConversationSessions.delete(activeConversationId);
        }
      }

      if (openAiWs) {
        openAiWs.close();
        openAiWs = null;
      }

      stopTriageLoop();
    });
  });
}
