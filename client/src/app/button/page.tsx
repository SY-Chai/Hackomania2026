"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { AlertCircle, Loader2, Mic, PhoneOff } from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { resolveSocketServerUrl } from "@/lib/socket";
import { resampleTo24k, schedulePcm16Playback } from "@/lib/audio";

type ChatMessage = {
  id: string;
  role: "pab" | "user" | "operator" | "agent" | "system";
  text: string;
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

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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

  const stopMicrophoneCapture = useCallback(() => {
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      processorRef.current = null;
      sourceRef.current = null;
    } catch {}

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close().catch(() => {});
      inputAudioContextRef.current = null;
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
      console.log("🎤 WS DEBUG: requesting microphone");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });

        mediaStreamRef.current = stream;

        const audioContext = new AudioContext();
        inputAudioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const copied = new Float32Array(input);
          const pcm16 = resampleTo24k(copied, audioContext.sampleRate);

          socket.emit("client_audio", pcm16.buffer);
        };

        console.log(
          "🎤 WS DEBUG: microphone streaming started at",
          audioContext.sampleRate,
        );
      } catch (err) {
        console.error("Microphone access denied:", err);
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
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:h-screen lg:overflow-hidden">
      <div className="grid min-h-screen grid-cols-1 lg:h-full lg:min-h-0 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="flex flex-col border-b border-slate-200 lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="border-b border-slate-200 px-6 py-5">
            <p className="text-xs uppercase tracking-[0.2em] text-red-500">
              Personal Alert Button
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900">
              Live Emergency Conversation
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Voice conversation appears here after the red button is pressed.
            </p>
          </div>

          <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4 text-sm">
            <div
              className={`h-2.5 w-2.5 rounded-full ${
                isConnected
                  ? "bg-green-500"
                  : isConnecting
                    ? "bg-yellow-500"
                    : "bg-slate-300"
              }`}
            />
            <span className="text-slate-700">{status}</span>
          </div>

          <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-6 py-6">
            {messages.map((message) => {
              const isUser = message.role === "user";
              const isAgent = message.role === "agent";

              return (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded px-4 py-3 text-sm leading-6 ${
                    isUser
                      ? "ml-auto bg-slate-900 text-white"
                      : isUser
                        ? "bg-slate-100 text-slate-900 border border-slate-200"
                        : "bg-white text-slate-600 border border-slate-200"
                  }`}
                >
                  <div
                    className={`mb-1 text-xs font-medium uppercase tracking-wide ${
                      isUser ? "text-slate-400" : "text-slate-400"
                    }`}
                  >
                    {isUser ? "User" : isAgent ? "AI Agent" : "System"}
                  </div>
                  <div>{message.text}</div>
                </div>
              );
            })}

            {error && (
              <div className="flex items-start gap-3 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex flex-col items-center justify-center gap-8 px-6 py-10 bg-white lg:min-h-0">
          <div className="text-center">
            <p className="text-sm uppercase tracking-[0.24em] text-slate-400">
              Emergency Trigger
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">
              Press to start voice help
            </h2>
            <p className="mt-2 max-w-sm text-sm text-slate-500">
              The button starts a live voice session with the AI emergency
              assistant.
            </p>
          </div>

          <Button
            onClick={isConnected ? stopConversation : startConversation}
            disabled={isConnecting || (!isConnected && !pabId)}
            className="h-44 w-44 rounded-full border-0 bg-red-600 text-lg font-semibold text-white shadow-[0_0_80px_rgba(239,68,68,0.22)] transition hover:bg-red-500 focus-visible:ring-red-400/50 disabled:opacity-70"
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

          <div className="max-w-sm rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <div className="mb-2 font-medium text-slate-900">
              System Architecture
            </div>
            <p className="mb-2">
              This version securely proxies bidirectional audio via WebSockets
              on the Node.js backend. The frontend captures audio, streams to
              the backend, and the backend communicates with OpenAI.
            </p>
            {pabId ? (
              <p className="font-semibold text-blue-600 break-all">
                Active PAB ID: {pabId}
              </p>
            ) : (
              <p className="text-slate-400">
                No specific PAB specified for this test.
              </p>
            )}
          </div>
        </aside>
      </div>
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
