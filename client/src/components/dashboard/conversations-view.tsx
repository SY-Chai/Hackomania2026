"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MessageSquare,
  User,
  Bot,
  Stethoscope,
  Clock,
  MapPin,
  PanelLeftClose,
  Headphones,
  Loader2,
  Volume2,
} from "lucide-react";

// --- Types derived from Supabase data ---

export interface UIMessage {
  id: string;
  sender: "senior" | "agent" | "human";
  senderName: string;
  content: string;
  timestamp: string;
}

export interface UIConversation {
  id: string;
  phase: "triage" | "diagnosis";
  classification: string | null;
  startedAt: string | null;
  lastActivity: string | null;
  messages: UIMessage[];
}

// --- Config ---

const phaseConfig = {
  triage: {
    label: "Triage",
    className: "bg-slate-100 text-slate-700 border-slate-200",
  },
  diagnosis: {
    label: "Diagnosis",
    className: "bg-slate-800 text-white border-slate-800",
  },
};

const senderConfig = {
  senior: {
    icon: User,
    bg: "bg-slate-200",
    text: "text-slate-700",
    label: "Senior",
  },
  agent: {
    icon: Bot,
    bg: "bg-slate-100",
    text: "text-slate-500",
    label: "AI Agent",
  },
  human: {
    icon: Stethoscope,
    bg: "bg-slate-100",
    text: "text-slate-500",
    label: "Staff",
  },
};

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name: string) {
  return name
    .split(" ")
    .slice(-2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

type FilterTab = "all" | "triage" | "diagnosis";
type LiveSpeaker = "user" | "agent";

const SOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_SOCKET_SERVER_URL ?? "http://localhost:3001";

function toPcm16(chunk: ArrayBuffer | Uint8Array) {
  if (chunk instanceof ArrayBuffer) {
    return new Int16Array(chunk);
  }
  return new Int16Array(
    chunk.buffer,
    chunk.byteOffset,
    Math.floor(chunk.byteLength / 2),
  );
}

interface Props {
  conversations: UIConversation[];
  onCollapse?: () => void;
}

export function ConversationsView({ conversations, onCollapse }: Props) {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(
    conversations[0]?.id ?? null,
  );
  const [listenTargetId, setListenTargetId] = useState<string | null>(null);
  const [isAudioConnecting, setIsAudioConnecting] = useState(false);
  const [liveAudioStatus, setLiveAudioStatus] = useState("Live audio off");
  const [liveAudioError, setLiveAudioError] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<LiveSpeaker | null>(null);

  const listenerSocketRef = useRef<Socket | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const selected =
    conversations.find((conv) => conv.id === selectedId) ??
    conversations[0] ??
    null;

  const schedulePcm16Playback = useCallback((pcmChunk: Int16Array) => {
    const ctx = playbackAudioContextRef.current;
    if (!ctx || pcmChunk.length === 0) return;

    const audioBuffer = ctx.createBuffer(1, pcmChunk.length, 24000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcmChunk.length; i++) {
      channel[i] = pcmChunk[i] / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime =
      nextPlaybackTimeRef.current > now ? nextPlaybackTimeRef.current : now;

    source.start(startTime);
    nextPlaybackTimeRef.current = startTime + audioBuffer.duration;
  }, []);

  useEffect(() => {
    if (!listenTargetId) return;

    const socket = io(SOCKET_SERVER_URL);
    listenerSocketRef.current = socket;

    const audioContext = new AudioContext({ sampleRate: 24000 });
    playbackAudioContextRef.current = audioContext;
    nextPlaybackTimeRef.current = audioContext.currentTime;

    let isDisposed = false;

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {
        if (isDisposed) return;
        setLiveAudioError("Browser blocked audio playback for live monitor.");
        setLiveAudioStatus("Live audio unavailable");
        setIsAudioConnecting(false);
        setListenTargetId(null);
      });
    }

    socket.on("connect", () => {
      socket.emit("join_conversation", listenTargetId);
    });

    socket.on("conversation_joined", (joinedId: string) => {
      if (isDisposed || joinedId !== listenTargetId) return;
      setIsAudioConnecting(false);
      setLiveAudioStatus("Listening live");
    });

    socket.on(
      "conversation_audio",
      (speaker: LiveSpeaker, rawChunk: ArrayBuffer | Uint8Array) => {
        if (isDisposed) return;
        const pcmChunk = toPcm16(rawChunk);
        if (!pcmChunk.length) return;
        schedulePcm16Playback(pcmChunk);
        const normalizedSpeaker: LiveSpeaker =
          speaker === "user" ? "user" : "agent";
        setLastSpeaker(normalizedSpeaker);
        setLiveAudioStatus(
          normalizedSpeaker === "user" ? "Senior speaking" : "Agent speaking",
        );
      },
    );

    socket.on("connect_error", () => {
      if (isDisposed) return;
      setLiveAudioError("Failed to connect to live audio stream.");
      setLiveAudioStatus("Live audio unavailable");
      setIsAudioConnecting(false);
      setListenTargetId(null);
    });

    socket.on("disconnect", () => {
      if (isDisposed) return;
      setLiveAudioStatus("Live audio disconnected");
      setIsAudioConnecting(false);
      setListenTargetId(null);
    });

    return () => {
      isDisposed = true;
      socket.emit("leave_conversation", listenTargetId);
      socket.disconnect();
      if (listenerSocketRef.current === socket) {
        listenerSocketRef.current = null;
      }

      if (playbackAudioContextRef.current === audioContext) {
        audioContext.close().catch(() => undefined);
        playbackAudioContextRef.current = null;
      }
      nextPlaybackTimeRef.current = 0;
      setIsAudioConnecting(false);
      setLastSpeaker(null);
    };
  }, [listenTargetId, schedulePcm16Playback]);

  const filtered =
    filter === "all"
      ? conversations
      : conversations.filter((c) => c.phase === filter);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: conversations.length },
    {
      key: "triage",
      label: "Triage",
      count: conversations.filter((c) => c.phase === "triage").length,
    },
    {
      key: "diagnosis",
      label: "Diagnosis",
      count: conversations.filter((c) => c.phase === "diagnosis").length,
    },
  ];

  // Derive a display name from the first non-agent message author
  function getDisplayName(conv: UIConversation) {
    const firstNonAgent = conv.messages.find((m) => m.sender !== "agent");
    return firstNonAgent?.senderName ?? `Conversation ${conv.id.slice(0, 8)}`;
  }

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400 text-sm">
        No conversations found.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Left panel */}
      <div className="flex flex-col w-80 bg-white border-r border-slate-200 shrink-0 h-full min-h-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-slate-100">
          <div>
            <h1 className="text-sm font-semibold text-slate-900">
              Conversations
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {conversations.length} total
            </p>
          </div>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="flex items-center justify-center w-6 h-6 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex border-b border-slate-100 px-4">
          {tabs.map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                "flex items-center gap-1.5 px-1 py-3 text-xs font-medium border-b-2 mr-4 transition-colors",
                filter === key
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700",
              )}
            >
              {label}
              <span
                className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded",
                  filter === key
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-500",
                )}
              >
                {count}
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="py-2">
            {filtered.map((conv) => {
              const displayName = getDisplayName(conv);
              const lastMsg = conv.messages[conv.messages.length - 1];
              return (
                <button
                  key={conv.id}
                  onClick={() => {
                    setSelectedId(conv.id);
                    if (listenTargetId && listenTargetId !== conv.id) {
                      setLiveAudioStatus("Live audio off");
                      setLiveAudioError(null);
                      setIsAudioConnecting(false);
                      setListenTargetId(null);
                    }
                  }}
                  className={cn(
                    "w-full text-left px-4 py-3 transition-colors border-b border-slate-50 last:border-0",
                    selected.id === conv.id
                      ? "bg-slate-50"
                      : "hover:bg-slate-50/60",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Avatar className="w-8 h-8 shrink-0 mt-0.5">
                      <AvatarFallback className="text-[10px] bg-slate-200 text-slate-600 font-semibold">
                        {getInitials(displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {displayName}
                        </p>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {formatTime(conv.lastActivity)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={cn(
                            "text-[10px] font-medium px-1.5 py-0.5 rounded border",
                            phaseConfig[conv.phase].className,
                          )}
                        >
                          {phaseConfig[conv.phase].label}
                        </span>
                        {conv.classification && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-slate-100 text-slate-600 border-slate-200">
                            {conv.classification}
                          </span>
                        )}
                      </div>
                      {lastMsg && (
                        <p className="text-xs text-slate-400 mt-1 truncate">
                          {lastMsg.content}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-start justify-between px-6 py-4 bg-white border-b border-slate-200 gap-4">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10">
              <AvatarFallback className="bg-slate-200 text-slate-700 font-semibold text-sm">
                {getInitials(getDisplayName(selected))}
              </AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {getDisplayName(selected)}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <MapPin className="w-3 h-3" />
                  ID: {selected.id.slice(0, 8)}…
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Button
              variant={
                listenTargetId === selected.id ? "destructive" : "outline"
              }
              size="sm"
              onClick={() => {
                if (listenTargetId === selected.id) {
                  setLiveAudioStatus("Live audio off");
                  setLiveAudioError(null);
                  setIsAudioConnecting(false);
                  setListenTargetId(null);
                  return;
                }
                setLiveAudioError(null);
                setLastSpeaker(null);
                setIsAudioConnecting(true);
                setLiveAudioStatus("Connecting to live audio...");
                setListenTargetId(selected.id);
              }}
              disabled={isAudioConnecting && listenTargetId === selected.id}
            >
              {isAudioConnecting && listenTargetId === selected.id ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Connecting
                </>
              ) : listenTargetId === selected.id ? (
                <>
                  <Headphones className="w-3.5 h-3.5" />
                  Stop listening
                </>
              ) : (
                <>
                  <Headphones className="w-3.5 h-3.5" />
                  Listen live
                </>
              )}
            </Button>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-xs font-medium px-2.5 py-1 rounded border",
                  phaseConfig[selected.phase].className,
                )}
              >
                {phaseConfig[selected.phase].label} phase
              </span>
              {selected.classification && (
                <span className="text-xs font-medium px-2.5 py-1 rounded border bg-slate-100 text-slate-600 border-slate-200">
                  {selected.classification}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="w-3 h-3" />
            Started {formatTime(selected.startedAt)}
          </div>
          <Separator orientation="vertical" className="h-3" />
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <MessageSquare className="w-3 h-3" />
            {selected.messages.length} messages
          </div>
          <Separator orientation="vertical" className="h-3" />
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs",
              listenTargetId ? "text-emerald-600" : "text-slate-500",
            )}
          >
            <Volume2 className="w-3 h-3" />
            {liveAudioStatus}
            {lastSpeaker && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {lastSpeaker === "user" ? "Senior" : "Agent"}
              </span>
            )}
          </div>
          {liveAudioError && (
            <span className="text-xs text-red-600">{liveAudioError}</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2">
          <div className="space-y-4 max-w-3xl">
            {selected.messages.map((msg) => {
              const cfg = senderConfig[msg.sender];
              const Icon = cfg.icon;
              const isRight = msg.sender === "senior";

              return (
                <div
                  key={msg.id}
                  className={cn("flex gap-3", isRight && "flex-row-reverse")}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center w-7 h-7 rounded-full shrink-0 mt-0.5",
                      cfg.bg,
                    )}
                  >
                    <Icon className={cn("w-3.5 h-3.5", cfg.text)} />
                  </div>
                  <div
                    className={cn(
                      "flex flex-col max-w-sm",
                      isRight && "items-end",
                    )}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-semibold text-slate-500">
                        {msg.senderName}
                      </span>
                      <span className="text-[9px] px-1 rounded text-slate-400 border border-slate-200 bg-white">
                        {cfg.label}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "px-2 py-1 rounded-xl text-xs leading-relaxed",
                        msg.sender === "senior"
                          ? "bg-slate-900 text-white"
                          : msg.sender === "agent"
                            ? "bg-slate-100 text-slate-800 border border-slate-200"
                            : "bg-white text-slate-800 border border-slate-200",
                      )}
                    >
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
