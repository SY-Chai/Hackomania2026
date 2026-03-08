import WebSocket, { WebSocketServer } from "ws";
import { supabase, liveConversationSessions } from "./config.js";
import { saveMessage, updateConversationAudio } from "./db.js";
import { getUTC8Time, uploadToR2, convertPCM16ToWAV } from "./utils.js";
import { ASSISTANT_PROMPT } from "./prompt.js";
import {
  OPENAI_REALTIME_URL,
  MAX_ROLLING_CHUNKS,
  MAX_CONVERSATION_PCM_BYTES,
  DEFAULT_SEVERITY,
  createTriageManager,
} from "./triage.js";

const DEFAULT_ESP32_PATHS = ["/esp32-phone"];
const ESP32_MAX_FRAME_BYTES = Number(process.env.ESP32_MAX_FRAME_BYTES || 1024);

function resolveEsp32Paths() {
  const fromEnv = process.env.ESP32_WS_PATHS || process.env.ESP32_WS_PATH || "";
  if (!fromEnv.trim()) return new Set(DEFAULT_ESP32_PATHS);

  const normalized = fromEnv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith("/") ? value : `/${value}`));

  return new Set(normalized.length ? normalized : DEFAULT_ESP32_PATHS);
}

function parseRequestUrl(request) {
  const host = request.headers.host || "localhost";
  return new URL(request.url || "/", `http://${host}`);
}

function toPcm16Buffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 2) return Buffer.alloc(0);
  if (buffer.length % 2 === 0) return buffer;
  return buffer.subarray(0, buffer.length - 1);
}

// Send PCM16 to an ESP32 WebSocket in frames no larger than ESP32_MAX_FRAME_BYTES.
function sendPcmChunked(ws, pcm24kBuffer) {
  const pcmBuffer = toPcm16Buffer(pcm24kBuffer);
  if (!pcmBuffer.length) return true;
  try {
    let offset = 0;
    while (offset < pcmBuffer.length) {
      let frameBytes = Math.min(ESP32_MAX_FRAME_BYTES, pcmBuffer.length - offset);
      if (frameBytes % 2 !== 0) frameBytes -= 1;
      if (frameBytes <= 0) break;
      ws.send(pcmBuffer.subarray(offset, offset + frameBytes), { binary: true });
      offset += frameBytes;
    }
    return true;
  } catch (err) {
    console.error("❌ [ESP32] Failed to send PCM:", err);
    return false;
  }
}

function isEsp32Session(session) {
  return session?.source === "esp32";
}

export function isEsp32SessionLive(session) {
  if (!isEsp32Session(session) || !session.esp32Socket) return false;
  const state = session.esp32Socket.readyState;
  return state === WebSocket.OPEN || state === WebSocket.CONNECTING;
}

export function forwardOperatorAudioToEsp32(session, pcm24kBuffer) {
  if (!isEsp32SessionLive(session)) {
    console.log("[ESP32 DEBUG] isEsp32SessionLive is false, not forwarding.");
    return false;
  }

  const buf = Buffer.isBuffer(pcm24kBuffer) ? pcm24kBuffer : Buffer.from(pcm24kBuffer);
  console.log(
    `[ESP32 DEBUG] Forwarding ${buf.length} bytes framesize: ${ESP32_MAX_FRAME_BYTES}...`,
  );

  const forwarded = sendPcmChunked(session.esp32Socket, buf);
  if (!forwarded) {
    console.error("❌ [ESP32] Failed to forward operator audio.");
  }
  return forwarded;
}

async function createEsp32Conversation(io, pabId) {
  if (!supabase) {
    const id = `esp32-${Date.now().toString(36)}`;
    return { id, persisted: false };
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert([
      {
        start: getUTC8Time(),
        end: null,
        triage: "agent",
        severity: DEFAULT_SEVERITY.severity,
        severity_conf: DEFAULT_SEVERITY.severity_conf,
        severity_reason: DEFAULT_SEVERITY.severity_reason,
        summary: JSON.stringify(DEFAULT_SEVERITY.operator_summary),
      },
    ])
    .select();

  if (error) throw error;

  const id = data?.[0]?.id;
  if (!id) throw new Error("Conversation insert returned no ID.");

  if (pabId) {
    await saveMessage(id, pabId, "ESP32 call connected.", () =>
      io.emit("dashboard_update"),
    );
  }

  return { id, persisted: true };
}

async function closeEsp32Conversation(io, conversationId, persisted) {
  if (!conversationId || !persisted || !supabase) return;

  const { error } = await supabase
    .from("conversations")
    .update({ end: getUTC8Time() })
    .eq("id", conversationId);

  if (error) {
    console.error(
      `❌ [ESP32] Failed to set end time for conversation ${conversationId}:`,
      error,
    );
    return;
  }

  io.emit("dashboard_update");
}

async function handleEsp32Connection(io, ws, request) {
  let conversationId = null;
  let persistedConversation = false;
  let finished = false;

  // OpenAI Realtime connection for this ESP32 session
  let openAiWs = null;

  // Audio tracking (mirrors socket.js per-socket state)
  let assistantAudioBuffer = [];
  let userAudioBuffer = [];
  let rollingBuffer = [];
  let isRecordingUser = false;
  let fullConversationPcm = [];
  let fullConversationPcmBytes = 0;

  const requestUrl = parseRequestUrl(request);
  const pabId = requestUrl.searchParams.get("pab_id") || null;
  const remoteAddress = request.socket.remoteAddress || "unknown";

  const triage = createTriageManager({
    io,
    getConversationId: () => conversationId,
    label: `ESP32 ${remoteAddress}`,
  });

  function handleTranscriptDone(role, audioBuffer, transcript, itemId) {
    triage.pushTriageTurn(role, transcript);

    if (conversationId) {
      const fullPcmBuffer = Buffer.concat(audioBuffer);
      if (
        fullPcmBuffer.length > 0 &&
        fullConversationPcmBytes < MAX_CONVERSATION_PCM_BYTES
      ) {
        fullConversationPcm.push(fullPcmBuffer);
        fullConversationPcmBytes += fullPcmBuffer.length;
      }

      // For ESP32 sessions: user audio is authored by the PAB, agent has no DB user
      const authorId = role === "user" ? pabId : null;
      saveMessage(conversationId, authorId, transcript, () =>
        io.emit("dashboard_update"),
      );
    }
  }

  function connectToOpenAI() {
    if (!process.env.OPENAI_API_KEY) {
      console.warn(
        "[ESP32] No OPENAI_API_KEY — skipping OpenAI Realtime connection.",
      );
      return;
    }

    openAiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openAiWs.on("open", () => {
      console.log(
        `[ESP32] Connected to OpenAI Realtime for conversation ${conversationId}`,
      );

      openAiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: ASSISTANT_PROMPT.trim(),
            voice: "sage",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "gpt-4o-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.65,
              prefix_padding_ms: 300,
              silence_duration_ms: 1000,
            },
          },
        }),
      );

      triage.startTriageLoop();
    });

    openAiWs.on("message", (message) => {
      try {
        const event = JSON.parse(message.toString());
        if (
          event.type !== "response.audio.delta" &&
          event.type !== "response.audio_transcript.delta"
        ) {
          console.log(`[ESP32 ${conversationId}] ← agent: ${event.type}`);
        }

        switch (event.type) {
          case "response.audio.delta": {
            if (!event.delta) break;

            const session = conversationId
              ? liveConversationSessions.get(conversationId)
              : null;
            // Suppress AI audio to device during operator takeover
            if (session?.takeoverActive) break;

            const buffer = Buffer.from(event.delta, "base64");
            assistantAudioBuffer.push(buffer);

            // Forward AI speech to the ESP32 device
            if (ws.readyState === WebSocket.OPEN) {
              sendPcmChunked(ws, buffer);
            }

            // Notify operators/listeners watching this conversation
            if (conversationId) {
              io.to(conversationId).emit("conversation_audio", "agent", buffer);
            }
            break;
          }

          case "response.audio_transcript.done":
            handleTranscriptDone(
              "agent",
              assistantAudioBuffer,
              event.transcript,
              event.item_id,
            );
            assistantAudioBuffer = [];
            break;

          case "conversation.item.input_audio_transcription.completed":
            handleTranscriptDone(
              "user",
              userAudioBuffer,
              event.transcript,
              event.item_id,
            );
            userAudioBuffer = [];
            break;

          case "error":
            console.error(
              `[ESP32 ${conversationId}] OpenAI error:`,
              event.error,
            );
            break;

          case "input_audio_buffer.speech_started":
            isRecordingUser = true;
            userAudioBuffer = [...rollingBuffer];
            rollingBuffer = [];
            break;

          case "input_audio_buffer.speech_stopped":
            isRecordingUser = false;
            break;
        }
      } catch (err) {
        console.error("[ESP32] Error handling OpenAI message:", err);
      }
    });

    openAiWs.on("close", () => {
      console.log(
        `[ESP32] OpenAI Realtime WS closed for conversation ${conversationId}`,
      );
      triage.stopTriageLoop();
      openAiWs = null;
    });

    openAiWs.on("error", (err) => {
      console.error(
        `[ESP32] OpenAI Realtime WS error (${conversationId}):`,
        err,
      );
    });
  }

  const finish = async () => {
    if (finished) return;
    finished = true;

    triage.stopTriageLoop();

    if (openAiWs) {
      openAiWs.close();
      openAiWs = null;
    }

    if (conversationId) {
      const session = liveConversationSessions.get(conversationId);
      if (session?.esp32Socket === ws) {
        io.to(conversationId).emit("operator_takeover_stopped", {
          conversationId,
        });
        liveConversationSessions.delete(conversationId);
      }

      await closeEsp32Conversation(io, conversationId, persistedConversation);

      // Upload full conversation audio to R2
      if (fullConversationPcm.length > 0) {
        const finalPcm = Buffer.concat(fullConversationPcm);
        const wavBuffer = convertPCM16ToWAV(finalPcm, 24000);
        const fileName = `calls/conversation-${conversationId}.wav`;

        uploadToR2(wavBuffer, fileName, "audio/wav")
          .then(() =>
            updateConversationAudio(conversationId, fileName, () =>
              io.emit("dashboard_update"),
            ),
          )
          .catch((err) =>
            console.error("[ESP32] Error uploading conversation audio:", err),
          );
      }

      console.log(
        `[ESP32] Device disconnected from conversation ${conversationId}.`,
      );
    }
  };

  try {
    const created = await createEsp32Conversation(io, pabId);
    conversationId = created.id;
    persistedConversation = created.persisted;

    liveConversationSessions.set(conversationId, {
      source: "esp32",
      callerSocketId: null,
      operatorSocketId: null,
      takeoverActive: false,
      pabId,
      esp32Socket: ws,
    });

    io.emit("severity_update", {
      conversationId,
      ...DEFAULT_SEVERITY,
      updatedAt: new Date().toISOString(),
    });

    io.emit("dashboard_update");

    console.log(
      `[ESP32] Device connected from ${remoteAddress}. Conversation: ${conversationId}`,
    );

    // Establish the OpenAI Realtime voice session for this ESP32 call
    connectToOpenAI();

    ws.on("message", (message, isBinary) => {
      if (!conversationId || !isBinary) return;

      const pcmBuffer = toPcm16Buffer(message);
      if (!pcmBuffer.length) return;

      const session = liveConversationSessions.get(conversationId);
      if (!session || session.esp32Socket !== ws) return;

      // Always forward raw audio to operators/listeners in the room
      io.to(conversationId).emit("conversation_audio", "user", pcmBuffer);

      // Forward to OpenAI Realtime only when operator takeover is not active
      if (!session.takeoverActive && openAiWs?.readyState === WebSocket.OPEN) {
        openAiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBuffer.toString("base64"),
          }),
        );

        if (isRecordingUser) {
          userAudioBuffer.push(pcmBuffer);
        } else {
          rollingBuffer.push(pcmBuffer);
          if (rollingBuffer.length > MAX_ROLLING_CHUNKS) rollingBuffer.shift();
        }
      }
    });

    ws.on("close", () => {
      void finish();
    });

    ws.on("error", (err) => {
      console.error(
        `[ESP32] WebSocket error (${conversationId || "unknown"}):`,
        err,
      );
      void finish();
    });
  } catch (err) {
    console.error("❌ [ESP32] Failed to start ESP32 session:", err);
    ws.close(1011, "Failed to create session");
    await finish();
  }
}

export function setupEsp32Gateway(server, io) {
  const wsPaths = resolveEsp32Paths();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "/";
    try {
      pathname = parseRequestUrl(request).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (!wsPaths.has(pathname)) return;

    wss.handleUpgrade(request, socket, head, (upgradedSocket) => {
      wss.emit("connection", upgradedSocket, request);
    });
  });

  wss.on("connection", (ws, request) => {
    void handleEsp32Connection(io, ws, request);
  });

  console.log(
    `[ESP32] Gateway listening on WebSocket path(s): ${Array.from(wsPaths).join(", ")}`,
  );
}
