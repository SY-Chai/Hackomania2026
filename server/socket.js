import WebSocket from "ws";
import { supabase, liveConversationSessions } from "./config.js";
import { getUTC8Time, uploadToR2, convertPCM16ToWAV } from "./utils.js";
import { saveMessage, updateConversationAudio } from "./db.js";
import { ASSISTANT_PROMPT } from "./prompt.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const MAX_ROLLING_CHUNKS = 20; // ~1.6 seconds of rolling historical context (4096 bytes per chunk)
const MAX_CONVERSATION_PCM_BYTES = 50 * 1024 * 1024; // 50 MB cap per call

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

    // ------------------------------------------------------------------
    // Emergency session
    // ------------------------------------------------------------------

    socket.on("start_emergency_session", async () => {
      if (openAiWs) {
        console.log(`[Socket ${socket.id}] WebSocket already exists.`);
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        socket.emit("session_error", "OPENAI_API_KEY is missing on the server.");
        return;
      }

      console.log(`[Socket ${socket.id}] Starting emergency session with OpenAI`);

      // Auto-create a Supabase conversation
      if (supabase) {
        const { data, error } = await supabase
          .from("conversations")
          .insert([{
            start: getUTC8Time(),
            end: getUTC8Time(),
            triage: "agent",
            classification: "uncertain",
          }])
          .select();

        if (error) {
          console.error(`❌ [Socket ${socket.id}] Failed to create conversation:`, error);
        } else if (data?.length > 0) {
          activeConversationId = data[0].id;
          socket.join(activeConversationId);
          liveConversationSessions.set(activeConversationId, {
            callerSocketId: socket.id,
            operatorSocketId: null,
            takeoverActive: false,
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
      });

      function handleTranscriptDone(role, audioBuffer, event) {
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
          saveMessage(activeConversationId, role, event.transcript, notifyDashboard);
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
    });
  });
}
