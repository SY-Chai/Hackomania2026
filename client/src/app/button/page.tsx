"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { AlertCircle, Loader2, Mic, PhoneOff } from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { resolveSocketServerUrl } from "@/lib/socket";
import { float32ToPcm16Buffer, schedulePcm16Playback } from "@/lib/audio";

type ChatMessage = {
  id: string;
  role: "pab" | "user" | "operator" | "agent" | "system";
  text: string;
};

type MicVADInstance = {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
  listening: boolean;
};

// Extracted inner component to use useSearchParams
function ButtonPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const paramPabId = searchParams.get("pab_id");
  const [fetchedPabId, setFetchedPabId] = useState<string | null>(null);
  const pabId = paramPabId ?? fetchedPabId;

  useEffect(() => {
    if (paramPabId) return;
    // No pab_id in URL — fetch a default PAB ID and reflect it in the URL
    fetch("/api/pab-default")
      .then((r) => r.json())
      .then((data: { id: string | null }) => {
        if (data.id) {
          setFetchedPabId(data.id);
          router.replace(`?pab_id=${data.id}`);
        }
      })
      .catch(() => {});
  }, [paramPabId, router]);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      text: "Press the red Personal Alert Button to start the voice conversation.",
    },
  ]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const vadRef = useRef<MicVADInstance | null>(null);

  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);

  const stopPlaybackLoop = useCallback(() => {
    nextPlaybackTimeRef.current = 0;
  }, []);

  const schedulePlayback = useCallback((pcmChunk: Int16Array) => {
    schedulePcm16Playback(
      playbackAudioContextRef.current,
      nextPlaybackTimeRef,
      pcmChunk,
    );
  }, []);

  const stopMicrophoneCapture = useCallback(async () => {
    if (vadRef.current) {
      try {
        await vadRef.current.destroy();
      } catch {}
      vadRef.current = null;
    }
  }, []);

  const stopConversation = useCallback(() => {
    console.log("🔎 WS DEBUG: stopConversation called");

    stopMicrophoneCapture();
    stopPlaybackLoop();

    if (playbackAudioContextRef.current) {
      playbackAudioContextRef.current.close().catch(() => {});
      playbackAudioContextRef.current = null;
    }

    if (socketRef.current) {
      socketRef.current.emit("stop_emergency_session");
      socketRef.current.disconnect();
      socketRef.current = null;
      console.log("🔎 WS DEBUG: socket disconnected");
    }

    setIsConnected(false);
    setIsConnecting(false);
    setStatus("Disconnected");
  }, [stopMicrophoneCapture, stopPlaybackLoop]);

  const startMicrophoneCapture = useCallback(
    async (socket: Socket) => {
      console.log("🎤 WS DEBUG: initializing Silero VAD");

      try {
        const { MicVAD } = await import("@ricky0123/vad-web");

        const vad = await MicVAD.new({
          model: "v5",
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/vad/",

          // VAD tuning
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          redemptionMs: 900,       // ~900ms grace period before ending speech
          minSpeechMs: 500,        // minimum 500ms of speech required
          preSpeechPadMs: 300,     // include 300ms before speech start

          onSpeechStart: () => {
            console.log("🎤 VAD: speech started");
          },

          onSpeechRealStart: () => {
            console.log("🎤 VAD: speech confirmed (past minSpeechMs)");
          },

          onSpeechEnd: (audio: Float32Array) => {
            // audio is Float32Array at 16kHz from Silero VAD
            console.log(`🎤 VAD: speech ended, ${audio.length} samples (${(audio.length / 16000).toFixed(1)}s)`);

            // Resample 16kHz → 24kHz PCM16 and send
            const pcmBuffer = float32ToPcm16Buffer(audio, 16000);
            socket.emit("client_audio", pcmBuffer);
            socket.emit("commit_audio");
          },

          onVADMisfire: () => {
            console.log("🎤 VAD: misfire (speech too short, discarded)");
          },

          onFrameProcessed: () => {},
        });

        await vad.start();
        vadRef.current = vad;
        console.log("🎤 WS DEBUG: Silero VAD started");
      } catch (err) {
        console.error("Microphone access denied or VAD init failed:", err);
        setError(
          "Microphone access is required to use the emergency voice assistant.",
        );
        stopConversation();
      }
    },
    [stopConversation],
  );

  const startConversation = useCallback(() => {
    console.log("🔎 WS DEBUG: startConversation triggered");

    if (isConnecting || isConnected) {
      console.log("🔎 WS DEBUG: already connecting or connected");
      return;
    }

    setError(null);
    setIsConnecting(true);
    setStatus("Requesting secure session...");

    if (!playbackAudioContextRef.current) {
      playbackAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    nextPlaybackTimeRef.current = playbackAudioContextRef.current.currentTime;

    // Connect to Node.js backend
    const socket = io(resolveSocketServerUrl());
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log(
        `✅ WS DEBUG: Connected to backend Socket.IO. Sending PAB ID: ${pabId}`,
      );
      socket.emit("start_emergency_session", { pab_id: pabId });
    });

    socket.on("session_started", () => {
      console.log("✅ WS DEBUG: OpenAI emergency session started");
      setStatus("Connected — speak now");
      setIsConnected(true);
      setIsConnecting(false);
      startMicrophoneCapture(socket);
    });

    socket.on("server_audio", (buffer: ArrayBuffer) => {
      // The backend sends a Node.js Buffer, which arrives as an ArrayBuffer in the browser
      const pcmChunk = new Int16Array(buffer);
      schedulePlayback(pcmChunk);
    });

    socket.on("history_updated", (newMessages: ChatMessage[]) => {
      setMessages((prev) => {
        const next = [...prev];
        for (const msg of newMessages) {
          if (!msg.text) continue;
          next.push(msg);
        }
        return next;
      });
    });

    socket.on("status_update", (newStatus: string) => {
      setStatus(newStatus);
    });

    socket.on("session_error", (errMsg: string) => {
      console.error("❌ WS DEBUG: backend session error", errMsg);
      setError(errMsg);
      setStatus("Error");
      stopConversation();
    });

    socket.on("session_stopped", () => {
      console.log("🛑 WS DEBUG: emergency session stopped by server");
      stopConversation();
    });

    socket.on("disconnect", () => {
      console.log("🛑 WS DEBUG: Socket disconnected");
      stopConversation();
    });

    socket.on("connect_error", (err) => {
      console.error("❌ WS DEBUG: Socket connection error", err);
      setError("Failed to connect to the backend server.");
      setStatus("Failed to connect");
      stopConversation();
    });
  }, [
    pabId,
    isConnected,
    isConnecting,
    schedulePlayback,
    startMicrophoneCapture,
    stopConversation,
  ]);

  useEffect(() => {
    console.log("🔎 WS DEBUG: component mounted");

    return () => {
      console.log("🔎 WS DEBUG: component unmounting");
      stopConversation();
    };
  }, [stopConversation]);

  return (
    <main className="flex h-screen min-h-0 flex-col bg-slate-50 text-slate-900">
      <section className="flex flex-1 min-h-0 items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4">
          <Button
            onClick={isConnected ? stopConversation : startConversation}
            disabled={isConnecting || (!isConnected && !pabId)}
            className="h-44 w-44 rounded-full border-0 bg-red-600 text-lg font-semibold text-white shadow-[0_0_90px_rgba(239,68,68,0.25)] transition hover:bg-red-500 focus-visible:ring-red-400/50 disabled:opacity-70"
          >
            {isConnecting ? (
              <span className="flex flex-col items-center gap-2">
                <Loader2 className="size-7 animate-spin" />
                Connecting
              </span>
            ) : isConnected ? (
              <span className="flex flex-col items-center gap-2">
                <PhoneOff className="size-7" />
                End Call
              </span>
            ) : (
              <span className="flex flex-col items-center gap-2">
                <Mic className="size-7" />
              </span>
            )}
          </Button>

          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span
              className={`h-2 w-2 rounded-full ${
                isConnected
                  ? "bg-green-500"
                  : isConnecting
                    ? "bg-yellow-500"
                    : "bg-slate-300"
              }`}
            />
            <span>{status}</span>
          </div>
        </div>
      </section>

      <section className="h-[35vh] min-h-[220px] border-t border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Conversation
            </p>
          </div>
          <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 py-3">
            {messages
              .filter((message) => message.role !== "system")
              .map((message) => {
              const isUser = message.role === "user";
              const isAgent = message.role === "agent";

              return (
                <div
                  key={message.id}
                  className={`max-w-[90%] rounded px-3 py-2 text-sm leading-6 ${
                    isUser
                      ? "ml-auto bg-slate-900 text-white"
                      : isAgent
                        ? "border border-slate-200 bg-slate-100 text-slate-900"
                        : "border border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    {isUser ? "User" : isAgent ? "AI Agent" : "System"}
                  </div>
                  <div>{message.text}</div>
                </div>
              );
            })}

            {error && (
              <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
          <Loader2 className="mr-2 h-6 w-6 animate-spin" />
          Loading...
        </div>
      }
    >
      <ButtonPageContent />
    </Suspense>
  );
}
