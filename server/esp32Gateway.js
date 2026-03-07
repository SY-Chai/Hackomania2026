import WebSocket, { WebSocketServer } from "ws";
import { supabase, liveConversationSessions } from "./config.js";
import { saveMessage } from "./db.js";
import { getUTC8Time } from "./utils.js";

const DEFAULT_ESP32_PATHS = ["/esp32-phone"];

const DEFAULT_SEVERITY = {
  severity: "uncertain",
  severity_conf: 25,
  severity_reason: "Awaiting enough context to assess severity.",
  operator_summary: {
    incident_overview: "Call started. Awaiting transcript details.",
    key_symptoms: [],
    risk_factors: [],
    actions_taken: [],
    recommended_next_step: "Continue gathering details from the senior.",
  },
};

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

function isEsp32Session(session) {
  return session?.source === "esp32";
}

export function isEsp32SessionLive(session) {
  if (!isEsp32Session(session) || !session.esp32Socket) return false;
  const state = session.esp32Socket.readyState;
  return state === WebSocket.OPEN || state === WebSocket.CONNECTING;
}

export function forwardOperatorAudioToEsp32(session, pcm24kBuffer) {
  if (!isEsp32SessionLive(session)) return false;

  const pcmBuffer = toPcm16Buffer(pcm24kBuffer);
  if (!pcmBuffer.length) return true;

  try {
    session.esp32Socket.send(pcmBuffer, { binary: true });
    return true;
  } catch (err) {
    console.error("❌ [ESP32] Failed to forward operator audio:", err);
    return false;
  }
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
        triage: "operator",
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

  const requestUrl = parseRequestUrl(request);
  const pabId = requestUrl.searchParams.get("pab_id") || null;
  const remoteAddress = request.socket.remoteAddress || "unknown";

  const finish = async () => {
    if (finished) return;
    finished = true;

    if (conversationId) {
      const session = liveConversationSessions.get(conversationId);
      if (session?.esp32Socket === ws) {
        io.to(conversationId).emit("operator_takeover_stopped", {
          conversationId,
        });
        liveConversationSessions.delete(conversationId);
      }

      await closeEsp32Conversation(io, conversationId, persistedConversation);
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

    ws.on("message", (message, isBinary) => {
      if (!conversationId || !isBinary) return;

      const pcmBuffer = toPcm16Buffer(message);
      if (!pcmBuffer.length) return;

      const session = liveConversationSessions.get(conversationId);
      if (!session || session.esp32Socket !== ws) return;

      io.to(conversationId).emit("conversation_audio", "user", pcmBuffer);
    });

    ws.on("close", () => {
      void finish();
    });

    ws.on("error", (err) => {
      console.error(`[ESP32] WebSocket error (${conversationId || "unknown"}):`, err);
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
