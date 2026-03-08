import WebSocket from "ws";
import { supabase, liveConversationSessions } from "./config.js";
import { getUTC8Time, uploadToR2, convertPCM16ToWAV } from "./utils.js";
import { saveMessage, updateConversationAudio } from "./db.js";
import { ASSISTANT_PROMPT } from "./prompt.js";
import {
  forwardOperatorAudioToEsp32,
  isEsp32SessionLive,
} from "./esp32Gateway.js";
import {
  OPENAI_REALTIME_URL,
  MAX_ROLLING_CHUNKS,
  MAX_CONVERSATION_PCM_BYTES,
  DEFAULT_SEVERITY,
  createTriageManager,
} from "./triage.js";

// Set MODAL_AGENT_WS_URL in .env to use the Modal speech agent.
// Falls back to OpenAI Realtime if unset.
const USE_MODAL_AGENT = !!process.env.MODAL_AGENT_WS_URL;
const MODAL_AGENT_WS_URL = process.env.MODAL_AGENT_WS_URL || "";

// ------------------------------------------------------------------
// Socket setup
// ------------------------------------------------------------------

export function setupSocket(io) {
  const notifyDashboard = () => io.emit("dashboard_update");

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    let openAiWs = null;
    let activeConversationId = null;

    // Modal agent processing lock — suppresses commits while a response is in flight
    let agentProcessing = false;

    let assistantAudioBuffer = [];
    let userAudioBuffer = [];
    let rollingBuffer = [];
    let isRecordingUser = false;

    let fullConversationPcm = [];
    let fullConversationPcmBytes = 0;

    const triage = createTriageManager({
      io,
      getConversationId: () => activeConversationId,
      label: `Socket ${socket.id}`,
    });

    // ------------------------------------------------------------------
    // Emergency session
    // ------------------------------------------------------------------

    socket.on("start_emergency_session", async (data) => {
      const pabId = data?.pab_id || null; // Will fallback to null if not provided
      let agentUserId = process.env.AGENT_ID || null;

      if (openAiWs) {
        console.log(`[Socket ${socket.id}] WebSocket already exists.`);
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        socket.emit(
          "session_error",
          "OPENAI_API_KEY is missing on the server.",
        );
        return;
      }

      console.log(
        `[Socket ${socket.id}] Starting emergency session with OpenAI. PAB ID: ${pabId}`,
      );

      // Start OpenAI WS connection immediately — before awaiting DB ops
      const agentUrl = USE_MODAL_AGENT
        ? MODAL_AGENT_WS_URL
        : OPENAI_REALTIME_URL;
      const agentHeaders = USE_MODAL_AGENT
        ? {}
        : {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          };

      openAiWs = new WebSocket(agentUrl, { headers: agentHeaders });

      // DB setup runs in parallel with the OpenAI connection handshake
      const dbSetupPromise = (async () => {
        if (!agentUserId && supabase) {
          const { data: agentData, error: agentErr } = await supabase
            .from("users")
            .select("id")
            .eq("type", "agent")
            .limit(1)
            .single();
          if (agentErr) console.error(`❌ Failed to fetch agent user:`, agentErr);
          if (agentData?.id) agentUserId = agentData.id;
        }

        if (!supabase) return null;

        const { data: dbData, error } = await supabase
          .from("conversations")
          .insert([
            {
              start: getUTC8Time(),
              triage: "agent",
              severity: "uncertain",
              severity_conf: 25,
              severity_reason: "Awaiting enough context to assess severity.",
              summary: JSON.stringify(
                triage.getLatestSeverity().operator_summary,
              ),
            },
          ])
          .select();

        if (error) {
          console.error(
            `❌ [Socket ${socket.id}] Failed to create conversation:`,
            error,
          );
          return null;
        }

        if (dbData?.length > 0) {
          const convId = dbData[0].id;
          socket.join(convId);
          liveConversationSessions.set(convId, {
            source: "openai",
            callerSocketId: socket.id,
            operatorSocketId: null,
            takeoverActive: false,
            pabId: pabId,
          });
          io.emit("severity_update", {
            conversationId: convId,
            ...triage.getLatestSeverity(),
            updatedAt: new Date().toISOString(),
          });
          notifyDashboard();
          if (pabId) {
            // Seed conversation with a PAB-authored marker so map status can
            // resolve active-call location immediately before transcripts arrive.
            await saveMessage(convId, pabId, "", notifyDashboard);
          }
          console.log(
            `✅ [Socket ${socket.id}] Conversation created DB ID: ${convId}`,
          );
          return convId;
        }
        return null;
      })();

      function handleTranscriptDone(role, audioBuffer, event) {
        triage.pushTriageTurn(role, event.transcript);
        socket.emit("history_updated", [
          {
            id: event.item_id || Date.now().toString(),
            role,
            text: event.transcript,
          },
        ]);
        if (activeConversationId) {
          const fullPcmBuffer = Buffer.concat(audioBuffer);
          if (
            fullPcmBuffer.length > 0 &&
            fullConversationPcmBytes < MAX_CONVERSATION_PCM_BYTES
          ) {
            fullConversationPcm.push(fullPcmBuffer);
            fullConversationPcmBytes += fullPcmBuffer.length;
          }

          let authorIdToSave = null;
          if (role === "agent") {
            authorIdToSave = agentUserId;
          } else if (role === "user") {
            const session = liveConversationSessions.get(activeConversationId);
            authorIdToSave = session?.pabId || null;
          }

          saveMessage(
            activeConversationId,
            authorIdToSave,
            event.transcript,
            notifyDashboard,
          );
        }
      }

      openAiWs.on("open", async () => {
        console.log(
          `[Socket ${socket.id}] Connected to ${USE_MODAL_AGENT ? "Modal agent" : "OpenAI Realtime API"}`,
        );

        // Resolve conversation ID — DB may still be in-flight
        activeConversationId = await dbSetupPromise;

        if (USE_MODAL_AGENT) {
          openAiWs.send(
            JSON.stringify({
              type: "session.update",
              session: {
                voice: "alloy",
                system_prompt: ASSISTANT_PROMPT.trim(),
              },
            }),
          );
        } else {
          openAiWs.send(
            JSON.stringify({
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
                  prefix_padding_ms: 200,
                  silence_duration_ms: 600,
                },
              },
            }),
          );
        }

        socket.emit("session_started");
        triage.startTriageLoop();
      });

      openAiWs.on("message", (message) => {
        try {
          const event = JSON.parse(message.toString());
          // Log non-streaming events (skip noisy audio/transcript deltas)
          if (
            event.type !== "response.audio.delta" &&
            event.type !== "response.audio_transcript.delta"
          ) {
            console.log(`[Socket ${socket.id}] ← agent: ${event.type}`);
          }

          switch (event.type) {
            case "response.audio.delta":
              if (event.delta) {
                const isOperatorTakeover = !!(
                  activeConversationId &&
                  liveConversationSessions.get(activeConversationId)
                    ?.takeoverActive
                );
                if (isOperatorTakeover) break;

                const buffer = Buffer.from(event.delta, "base64");
                assistantAudioBuffer.push(buffer);
                socket.emit("server_audio", buffer);
                if (activeConversationId) {
                  socket
                    .to(activeConversationId)
                    .emit("conversation_audio", "agent", buffer);
                }
              }
              break;

            case "response.audio_transcript.done":
              handleTranscriptDone("agent", assistantAudioBuffer, event);
              assistantAudioBuffer = [];
              break;

            // OpenAI Realtime: user transcript
            case "conversation.item.input_audio_transcription.completed":
              handleTranscriptDone("user", userAudioBuffer, event);
              userAudioBuffer = [];
              break;

            // Modal agent: user transcript (FireRedASR/Whisper result)
            case "conversation.item.created":
              if (event.item?.role === "user") {
                const transcript = event.item?.content?.[0]?.transcript;
                if (transcript) {
                  handleTranscriptDone("user", userAudioBuffer, {
                    transcript,
                    item_id: event.item?.id || Date.now().toString(),
                  });
                  userAudioBuffer = [];
                }
              }
              break;

            case "error":
              console.error(`[Socket ${socket.id}] OpenAI error:`, event.error);
              socket.emit(
                "session_error",
                event.error?.message || "Unknown OpenAI error",
              );
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

            case "response.done":
              agentProcessing = false;
              break;
          }
        } catch (err) {
          console.error("Error handling OpenAI message:", err);
        }
      });

      openAiWs.on("close", () => {
        agentProcessing = false;
        console.log(`[Socket ${socket.id}] Agent WebSocket closed`);
        socket.emit("session_stopped");
        triage.stopTriageLoop();

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
                console.log(
                  `[Socket ${socket.id}] Logged end time for conversation ${activeConversationId}`,
                );
                notifyDashboard();
              })
              .catch((err) => console.error("Error logging end time:", err));
          }

          if (fullConversationPcm.length > 0) {
            const finalPcm = Buffer.concat(fullConversationPcm);
            const wavBuffer = convertPCM16ToWAV(finalPcm, 24000);
            const fileName = `calls/conversation-${activeConversationId}.wav`;

            uploadToR2(wavBuffer, fileName, "audio/wav")
              .then(() =>
                updateConversationAudio(
                  activeConversationId,
                  fileName,
                  notifyDashboard,
                ),
              )
              .catch((err) =>
                console.error("Error uploading conversation audio:", err),
              );
          }
        }

        openAiWs = null;
      });

      openAiWs.on("error", (err) => {
        console.error(`[Socket ${socket.id}] Agent WebSocket error:`, err);
        socket.emit("session_error", "WebSocket error connecting to agent");
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
      const isOperatorTakeover = !!(
        session?.takeoverActive && session?.operatorSocketId
      );
      const buf = Buffer.from(pcm16Buffer);

      if (isOperatorTakeover) {
        if (activeConversationId) {
          socket
            .to(activeConversationId)
            .emit("conversation_audio", "user", buf);
        }
        return;
      }

      openAiWs.send(
        `{"type":"input_audio_buffer.append","audio":"${buf.toString("base64")}"}`,
      );

      if (isRecordingUser) {
        userAudioBuffer.push(buf);
        if (activeConversationId) {
          socket
            .to(activeConversationId)
            .emit("conversation_audio", "user", buf);
        }
      } else {
        rollingBuffer.push(buf);
        if (rollingBuffer.length > MAX_ROLLING_CHUNKS) rollingBuffer.shift();
      }
    });

    // Frontend VAD detected end of speech — commit the audio buffer
    socket.on("commit_audio", () => {
      if (!USE_MODAL_AGENT || agentProcessing) return;
      if (openAiWs?.readyState === WebSocket.OPEN) {
        console.log(`[Socket ${socket.id}] → frontend VAD commit`);
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        agentProcessing = true;
      }
    });

    socket.on("stop_emergency_session", () => {
      console.log(`[Socket ${socket.id}] stop_emergency_session`);
      if (openAiWs) {
        openAiWs.close();
        openAiWs = null;
      }
      triage.stopTriageLoop();
    });

    socket.on("operator_end_conversation", (conversationId) => {
      if (!conversationId) return;
      const session = liveConversationSessions.get(conversationId);
      if (!session) {
        socket.emit("operator_takeover_error", "This call is no longer live.");
        return;
      }

      const isOperator = session.operatorSocketId === socket.id;
      const isCaller = session.callerSocketId === socket.id;
      if (!isOperator && !isCaller) {
        socket.emit(
          "operator_takeover_error",
          "Not authorized to end this call.",
        );
        return;
      }

      if (session.callerSocketId) {
        io.to(session.callerSocketId).emit("force_end_emergency_session", {
          conversationId,
          endedBy: "operator",
        });
      }

      if (session.source === "esp32" && isEsp32SessionLive(session)) {
        try {
          session.esp32Socket.close();
        } catch (err) {
          console.error(
            `Failed to close ESP32 session ${conversationId} from operator end:`,
            err,
          );
        }
      }

      io.to(conversationId).emit("operator_takeover_stopped", {
        conversationId,
      });
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
      const hasSocketCaller = !!session?.callerSocketId;
      const hasEsp32Session = !!(
        session?.source === "esp32" && session?.esp32Socket
      );
      const hasEsp32Caller = isEsp32SessionLive(session);
      if (!session || (!hasSocketCaller && !hasEsp32Session)) {
        socket.emit("operator_takeover_error", "This call is no longer live.");
        return;
      }

      if (hasEsp32Session && !hasEsp32Caller) {
        console.warn(
          `⚠ [Socket ${socket.id}] ESP32 session ${conversationId} is not OPEN yet; allowing takeover and waiting for reconnect.`,
        );
      }

      if (session.operatorSocketId && session.operatorSocketId !== socket.id) {
        socket.emit(
          "operator_takeover_error",
          "Another operator is already handling this call.",
        );
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
          console.error(
            `❌ Failed to update triage=operator for ${conversationId}:`,
            error,
          );
        } else {
          console.log(
            `✅ Conversation ${conversationId} triage updated to operator`,
          );
          notifyDashboard();
        }
      }

      io.to(conversationId).emit("operator_takeover_started", {
        conversationId,
        operatorSocketId: socket.id,
      });
      if (session.callerSocketId) {
        io.to(session.callerSocketId).emit(
          "status_update",
          "Operator joined the call",
        );
      }
    });

    socket.on("operator_audio", (payload) => {
      const { conversationId, audio } = payload || {};
      if (!conversationId || !audio) return;

      console.log(
        `[SOCKET DEBUG] Received operator_audio for conv ${conversationId}, audio length: ${audio.byteLength || audio.length}`,
      );

      const session = liveConversationSessions.get(conversationId);
      if (!session) {
        console.log(
          `[SOCKET DEBUG] Session not found for conv ${conversationId}`,
        );
        return;
      }
      if (!session.takeoverActive || session.operatorSocketId !== socket.id) {
        console.log(
          `[SOCKET DEBUG] Takeover inactive or wrong socket: active=${session.takeoverActive}, opSocket=${session.operatorSocketId}, mySocket=${socket.id}`,
        );
        return;
      }

      const buf = Buffer.from(audio);
      let forwarded = false;
      if (isEsp32SessionLive(session)) {
        console.log(`[SOCKET DEBUG] Forwarding audio to ESP32...`);
        forwarded = forwardOperatorAudioToEsp32(session, buf);
        console.log(`[SOCKET DEBUG] Forwarded to ESP32: ${forwarded}`);
      } else if (session.callerSocketId) {
        io.to(session.callerSocketId).emit("server_audio", buf);
        forwarded = true;
      }

      if (forwarded) {
        socket.to(conversationId).emit("conversation_audio", "agent", buf);
      } else if (session.source === "esp32") {
        console.warn(
          `⚠ [Socket ${socket.id}] operator_audio dropped for ESP32 conversation ${conversationId} (${buf.length} bytes)`,
        );
      }
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

      io.to(conversationId).emit("operator_takeover_stopped", {
        conversationId,
      });
      if (session.callerSocketId) {
        io.to(session.callerSocketId).emit(
          "status_update",
          "AI assistant resumed",
        );
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

      for (const [
        conversationId,
        session,
      ] of liveConversationSessions.entries()) {
        if (session.operatorSocketId === socket.id) {
          session.operatorSocketId = null;
          session.takeoverActive = false;
          io.to(conversationId).emit("operator_takeover_stopped", {
            conversationId,
          });
          if (session.callerSocketId) {
            io.to(session.callerSocketId).emit(
              "status_update",
              "AI assistant resumed",
            );
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

      triage.stopTriageLoop();
    });
  });
}
