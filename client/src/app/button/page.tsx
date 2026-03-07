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

  const stopConversation = useCallback(() => {
    console.log("🔎 DEBUG: stopConversation called");

    try {
      sessionRef.current?.close();
      console.log("🔎 DEBUG: session closed");
    } catch (err) {
      console.warn("🔎 DEBUG: error closing session", err);
    }

    sessionRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setStatus("Disconnected");
  }, []);

  const startConversation = useCallback(async () => {
    console.log("🔎 DEBUG: startConversation triggered");

    if (isConnecting || isConnected) {
      console.log("🔎 DEBUG: already connecting or connected");
      return;
    }

    setError(null);
    setIsConnecting(true);
    setStatus("Requesting microphone and secure session...");

    try {
      console.log("🔎 DEBUG: requesting token from /api/realtime/session");

      const tokenRes = await fetch("/api/realtime/session", {
        method: "POST",
      });

      console.log("🔎 DEBUG: token response status:", tokenRes.status);

      if (!tokenRes.ok) {
        throw new Error("Failed to create realtime session token.");
      }

      const tokenJson = await tokenRes.json();
      console.log("🔎 DEBUG: token JSON:", tokenJson);

      const clientSecret =
        tokenJson.client_secret ?? tokenJson.value ?? tokenJson.clientSecret;

      console.log("🔎 DEBUG: extracted clientSecret:", clientSecret);

      if (!clientSecret) {
        throw new Error("No client secret returned from /api/realtime/session.");
      }

      console.log("🔎 DEBUG: creating RealtimeSession");

      const session = new RealtimeSession(agent, {
        model: "gpt-realtime",
      });

      sessionRef.current = session;

      console.log("🔎 DEBUG: session created", session);

      session.on("history_updated", (history: any[]) => {
        console.log("🔎 DEBUG: history_updated event", history);

        const nextMessages = mapHistoryToMessages(history);

        setMessages((prev) => {
          const intro = prev.find((m) => m.id === "intro");
          return nextMessages.length > 0 ? nextMessages : intro ? [intro] : prev;
        });
      });

      session.on("audio_start", () => {
        console.log("🎤 DEBUG: audio_start detected");
        setStatus("Listening...");
      });

      session.on("audio_stopped", () => {
        console.log("🛑 DEBUG: audio_stopped");
        setStatus("Processing...");
      });

      session.on("audio_interrupted", () => {
        console.log("⚠️ DEBUG: audio_interrupted");
        setStatus("Interrupted");
      });

      session.on("error", (err: any) => {
        console.error("❌ DEBUG: realtime session error", err);
        setError(err?.message ?? "Something went wrong in the voice session.");
        setStatus("Error");
      });

      console.log("🔎 DEBUG: connecting to realtime session...");

      await session.connect({
        apiKey: clientSecret,
      });

      // session.sendMessage(
      //   "The senior has pressed the Personal Alert Button. Please greet them and ask what happened."
      // );

      console.log("✅ DEBUG: session connected successfully");

      setIsConnected(true);
      setStatus("Connected — speak now");

      console.log("🎤 DEBUG: waiting for microphone input...");
    } catch (err: any) {
      console.error("❌ DEBUG: startConversation failed", err);

      setError(err?.message ?? "Failed to start the voice conversation.");
      setStatus("Failed to connect");

      stopConversation();
    } finally {
      setIsConnecting(false);
    }
  }, [agent, isConnected, isConnecting, stopConversation]);

  useEffect(() => {
    console.log("🔎 DEBUG: component mounted");

    return () => {
      console.log("🔎 DEBUG: component unmounting");

      try {
        sessionRef.current?.close();
      } catch (err) {
        console.warn("🔎 DEBUG: error during cleanup", err);
      }
    };
  }, []);

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
                      isUser
                        ? "text-red-100"
                        : isAssistant
                        ? "text-gray-500"
                        : "text-gray-500"
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
                {/* Press for Help */}
              </span>
            )}
          </Button>
  
          <div className="max-w-sm rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
            <div className="mb-2 font-medium text-gray-900">Demo notes</div>
            <p>
              On first press, the browser will ask for microphone permission. The
              transcript updates on the left as the live conversation progresses.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}