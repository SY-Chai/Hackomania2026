"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { AlertCircle, Loader2, Mic, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

function extractTextFromContent(content: any): string {
  if (!content) return "";

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        if (part?.transcript) return part.transcript;
        if (part?.content) return extractTextFromContent(part.content);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  if (typeof content === "object") {
    if (content.text) return content.text;
    if (content.transcript) return content.transcript;
    if (content.content) return extractTextFromContent(content.content);
  }

  return "";
}

function mapHistoryToMessages(history: any[]): ChatMessage[] {
  return history
    .map((item: any, index: number) => {
      const role =
        item?.role === "assistant" || item?.role === "user" || item?.role === "system"
          ? item.role
          : item?.type === "message"
          ? item?.role ?? "system"
          : "system";

      const text =
        extractTextFromContent(item?.content) ||
        extractTextFromContent(item?.formatted?.text) ||
        extractTextFromContent(item?.text) ||
        extractTextFromContent(item?.transcript) ||
        "";

      if (!text.trim()) return null;

      return {
        id: item?.id ?? `${role}-${index}`,
        role,
        text: text.trim(),
      };
    })
    .filter(Boolean) as ChatMessage[];
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function resampleTo24k(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 24000) {
    return float32ToInt16(input);
  }

  const ratio = inputSampleRate / 24000;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return float32ToInt16(result);
}

function concatInt16Arrays(chunks: Int16Array[]): Int16Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export default function Page() {
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

  const sessionRef = useRef<RealtimeSession | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const playbackQueueRef = useRef<Int16Array[]>([]);
  const playbackTimerRef = useRef<number | null>(null);

  const agent = useMemo(
    () =>
      new RealtimeAgent({
        name: "PAB Emergency Assistant",
        instructions: `
You are a calm emergency voice assistant helping seniors who pressed a Personal Alert Button.

Your goals:
- Speak clearly, slowly, and briefly.
- Ask what happened.
- Determine if the situation is urgent, uncertain, or non-urgent.
- Ask one question at a time.
- If the senior may be in danger, prioritise questions about breathing, bleeding, consciousness, pain, mobility, and whether they are alone.
- If the senior speaks unclearly, reassure them and ask simple follow-up questions.
- Keep your replies concise and suitable for speech.
        `.trim(),
      }),
    []
  );

  const stopPlaybackLoop = useCallback(() => {
    if (playbackTimerRef.current) {
      window.clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    playbackQueueRef.current = [];
  }, []);

  const startPlaybackLoop = useCallback(() => {
    if (playbackTimerRef.current) return;

    playbackTimerRef.current = window.setInterval(() => {
      const ctx = playbackAudioContextRef.current;
      if (!ctx) return;
      if (playbackQueueRef.current.length === 0) return;

      const chunk = playbackQueueRef.current.shift();
      if (!chunk) return;

      const audioBuffer = ctx.createBuffer(1, chunk.length, 24000);
      const channel = audioBuffer.getChannelData(0);

      for (let i = 0; i < chunk.length; i++) {
        channel[i] = chunk[i] / 32768;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
    }, 40);
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

    try {
      sessionRef.current?.close();
      console.log("🔎 WS DEBUG: session closed");
    } catch (err) {
      console.warn("🔎 WS DEBUG: error closing session", err);
    }

    sessionRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setStatus("Disconnected");
  }, [stopMicrophoneCapture, stopPlaybackLoop]);

  const startMicrophoneCapture = useCallback(async (session: RealtimeSession) => {
    console.log("🎤 WS DEBUG: requesting microphone");

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

      session.sendAudio(pcm16.buffer, { commit: false });
    };

    console.log("🎤 WS DEBUG: microphone streaming started at", audioContext.sampleRate);
  }, []);

  const startConversation = useCallback(async () => {
    console.log("🔎 WS DEBUG: startConversation triggered");

    if (isConnecting || isConnected) {
      console.log("🔎 WS DEBUG: already connecting or connected");
      return;
    }

    setError(null);
    setIsConnecting(true);
    setStatus("Requesting secure session...");

    try {
      const tokenRes = await fetch("/api/realtime/session", {
        method: "POST",
      });

      console.log("🔎 WS DEBUG: token response status:", tokenRes.status);

      if (!tokenRes.ok) {
        throw new Error("Failed to create realtime session token.");
      }

      const tokenJson = await tokenRes.json();
      console.log("🔎 WS DEBUG: token JSON:", tokenJson);

      const clientSecret =
        tokenJson.client_secret ?? tokenJson.value ?? tokenJson.clientSecret;

      if (!clientSecret) {
        throw new Error("No client secret returned from /api/realtime/session.");
      }

      if (!playbackAudioContextRef.current) {
        playbackAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }

      const session = new RealtimeSession(agent, {
        transport: "websocket",
        model: "gpt-realtime",
        config: {
          outputModalities: ["audio"],
          audio: {
            input: {
              format: "pcm16",
              noiseReduction: {
                type: "far_field",
              },
              transcription: {
                model: "gpt-4o-mini-transcribe",
              },
              turnDetection: {
                type: "server_vad",
                threshold: 0.65,
                silenceDurationMs: 1000,
                prefixPaddingMs: 300,
                interruptResponse: true,
                createResponse: true,
              },
            },
            output: {
              format: "pcm16",
            },
          },
        },
      });

      sessionRef.current = session;

      session.on("history_updated", (history: any[]) => {
        console.log("📝 WS DEBUG: history updated", history);
        const nextMessages = mapHistoryToMessages(history);
        setMessages((prev) => {
          const intro = prev.find((m) => m.id === "intro");
          return nextMessages.length > 0 ? nextMessages : intro ? [intro] : prev;
        });
      });

      session.on("audio", (event: any) => {
        console.log("🔊 WS DEBUG: received audio chunk", event);
        const data = event?.data;

        if (!data) return;

        let pcmChunk: Int16Array | null = null;

        if (data instanceof ArrayBuffer) {
          pcmChunk = new Int16Array(data);
        } else if (ArrayBuffer.isView(data)) {
          pcmChunk = new Int16Array(data.buffer.slice(0));
        }

        if (pcmChunk) {
          playbackQueueRef.current.push(pcmChunk);
        }
      });

      session.on("audio_start", () => {
        console.log("🎤 WS DEBUG: audio_start");
        setStatus("Listening...");
      });

      session.on("audio_stopped", () => {
        console.log("🛑 WS DEBUG: audio_stopped");
        // commit the current user turn
        // session.sendAudio(new ArrayBuffer(0), { commit: true });
        setStatus("Processing...");
      });

      session.on("audio_interrupted", () => {
        console.log("⚠️ WS DEBUG: audio_interrupted");
        setStatus("Interrupted");
      });

      session.on("error", (err: any) => {
        console.error("❌ WS DEBUG: realtime session error (full)", err);
        console.error("❌ WS DEBUG: realtime session error.error", err?.error);
        console.error("❌ WS DEBUG: realtime session error.message", err?.message);
        console.error("❌ WS DEBUG: realtime session error JSON", JSON.stringify(err, null, 2));
        setError(
          err?.error?.message ??
          err?.message ??
          "Something went wrong in the voice session."
        );
        setStatus("Error");
      });

      console.log("🔌 WS DEBUG: connecting websocket session...");
      await session.connect({
        apiKey: clientSecret,
      });

      console.log("✅ WS DEBUG: websocket session connected");

      startPlaybackLoop();
      await startMicrophoneCapture(session);

      setIsConnected(true);
      setStatus("Connected — speak now");

      // session.sendMessage(
      //   "The senior has pressed the Personal Alert Button. Please greet them and ask what happened."
      // );
    } catch (err: any) {
      console.error("❌ WS DEBUG: startConversation failed", err);
      setError(err?.message ?? "Failed to start the voice conversation.");
      setStatus("Failed to connect");
      stopConversation();
    } finally {
      setIsConnecting(false);
    }
  }, [
    agent,
    isConnected,
    isConnecting,
    startMicrophoneCapture,
    startPlaybackLoop,
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
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="flex flex-col border-b border-gray-200 lg:border-r lg:border-b-0">
          <div className="border-b border-gray-200 px-6 py-5">
            <p className="text-xs uppercase tracking-[0.2em] text-red-500">
              Personal Alert Button
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-gray-900">
              Live Emergency Conversation
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              Voice conversation appears here after the red button is pressed.
            </p>
          </div>

          <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-4 text-sm">
            <div
              className={`h-2.5 w-2.5 rounded-full ${
                isConnected
                  ? "bg-green-500"
                  : isConnecting
                  ? "bg-yellow-500"
                  : "bg-gray-300"
              }`}
            />
            <span className="text-gray-700">{status}</span>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
            {messages.map((message) => {
              const isUser = message.role === "user";
              const isAssistant = message.role === "assistant";

              return (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                    isUser
                      ? "ml-auto bg-red-600 text-white"
                      : isAssistant
                      ? "bg-gray-100 text-gray-900"
                      : "bg-gray-200 text-gray-700"
                  }`}
                >
                  <div
                    className={`mb-1 text-xs font-medium uppercase tracking-wide ${
                      isUser ? "text-red-100" : "text-gray-500"
                    }`}
                  >
                    {isUser ? "Senior" : isAssistant ? "AI Responder" : "System"}
                  </div>
                  <div>{message.text}</div>
                </div>
              );
            })}

            {error && (
              <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex flex-col items-center justify-center gap-8 px-6 py-10 bg-white">
          <div className="text-center">
            <p className="text-sm uppercase tracking-[0.24em] text-gray-400">
              Emergency Trigger
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-gray-900">
              Press to start voice help
            </h2>
            <p className="mt-2 max-w-sm text-sm text-gray-500">
              The button starts a live voice session with the AI emergency assistant.
            </p>
          </div>

          <Button
            onClick={isConnected ? stopConversation : startConversation}
            disabled={isConnecting}
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

          <div className="max-w-sm rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
            <div className="mb-2 font-medium text-gray-900">Demo notes</div>
            <p>
              This version uses WebSocket transport, so microphone capture and
              speaker playback are handled manually in the browser.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}