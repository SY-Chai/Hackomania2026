"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveSocketServerUrl } from "@/lib/socket";
import { type DBConversation, type DBMessage } from "@/lib/supabase";
import { deriveRole, normalizePhase } from "@/lib/dashboard-utils";
import { toPcm16, resampleTo24k, schedulePcm16Playback } from "@/lib/audio";
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
  Mic,
  PhoneOff,
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
  severity: "urgent" | "uncertain" | "non_urgent" | null;
  severityConf: number | null;
  severityReason: string | null;
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
type TakeoverEvent = {
  conversationId: string;
  operatorSocketId?: string;
};
type SeverityUpdateEvent = {
  conversationId: string;
  severity: "urgent" | "uncertain" | "non_urgent";
  severity_conf?: number | null;
  severity_reason?: string | null;
  updatedAt?: string;
};

const severityConfig = {
  urgent: {
    label: "Urgent",
    className: "bg-red-50 text-red-700 border-red-200",
  },
  uncertain: {
    label: "Uncertain",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  non_urgent: {
    label: "Non-urgent",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
} as const;

function getSeverityRank(severity: UIConversation["severity"]) {
  if (severity === "urgent") return 0;
  if (severity === "uncertain") return 1;
  if (severity === "non_urgent") return 2;
  return 3;
}



interface Props {
  conversations: UIConversation[];
  onCollapse?: () => void;
}

export function ConversationsView({ conversations, onCollapse }: Props) {
  const [liveConversations, setLiveConversations] = useState(conversations);
  const [filter, setFilter] = useState<FilterTab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(
    conversations[0]?.id ?? null,
  );
  const [listenTargetId, setListenTargetId] = useState<string | null>(null);
  const [isAudioConnecting, setIsAudioConnecting] = useState(false);
  const [liveAudioStatus, setLiveAudioStatus] = useState("Live audio off");
  const [liveAudioError, setLiveAudioError] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<LiveSpeaker | null>(null);
  const [takeoverConversationId, setTakeoverConversationId] = useState<string | null>(null);
  const [pendingTakeoverConversationId, setPendingTakeoverConversationId] = useState<string | null>(null);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);

  const listenerSocketRef = useRef<Socket | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const joinedConversationIdRef = useRef<string | null>(null);
  const pendingTakeoverConversationIdRef = useRef<string | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const selected =
    liveConversations.find((conv) => conv.id === selectedId) ??
    liveConversations[0] ??
    null;

  const stopOperatorMicrophoneCapture = useCallback(() => {
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      processorRef.current = null;
      sourceRef.current = null;
    } catch {
      // no-op
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close().catch(() => undefined);
      inputAudioContextRef.current = null;
    }
  }, []);

  const startOperatorMicrophoneCapture = useCallback(
    async (socket: Socket, conversationId: string) => {
      stopOperatorMicrophoneCapture();
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

          socket.emit("operator_audio", {
            conversationId,
            audio: pcm16.buffer,
          });
        };
      } catch {
        setTakeoverError("Microphone access is required for operator takeover.");
        pendingTakeoverConversationIdRef.current = null;
        setPendingTakeoverConversationId(null);
        setTakeoverConversationId(null);
        socket.emit("operator_takeover_stop", conversationId);
      }
    },
    [stopOperatorMicrophoneCapture],
  );

  const schedulePlayback = useCallback((pcmChunk: Int16Array) => {
    schedulePcm16Playback(playbackAudioContextRef.current, nextPlaybackTimeRef, pcmChunk);
  }, []);

  useEffect(() => {
    setLiveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (!selectedId && liveConversations.length > 0) {
      setSelectedId(liveConversations[0].id);
    }
  }, [liveConversations, selectedId]);

  useEffect(() => {
    const severitySocket = io(resolveSocketServerUrl(), {
      transports: ["websocket"],
    });

    severitySocket.on("severity_update", (event: SeverityUpdateEvent) => {
      if (!event?.conversationId) return;
      setLiveConversations((prev) =>
        prev.map((conv) =>
          conv.id === event.conversationId
            ? {
                ...conv,
                severity: event.severity ?? conv.severity,
                severityConf:
                  event.severity_conf == null
                    ? conv.severityConf
                    : event.severity_conf,
                severityReason: event.severity_reason ?? conv.severityReason,
              }
            : conv,
        ),
      );
    });

    return () => {
      severitySocket.disconnect();
    };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/realtime");

    es.addEventListener("conversation_insert", (e) => {
      const c = JSON.parse(e.data) as DBConversation;
      setLiveConversations((prev) => {
        if (prev.some((conv) => conv.id === c.id)) return prev;
        return [
          {
            id: c.id,
            phase: normalizePhase(c.triage),
            classification: c.classification,
            severity: c.severity,
            severityConf: c.severity_conf,
            severityReason: c.severity_reason,
            startedAt: c.start,
            lastActivity: c.start,
            messages: [],
          },
          ...prev,
        ];
      });
    });

    es.addEventListener("conversation_update", (e) => {
      const c = JSON.parse(e.data) as DBConversation;
      setLiveConversations((prev) =>
        prev.map((conv) =>
          conv.id === c.id
            ? {
                ...conv,
                phase: normalizePhase(c.triage),
                classification: c.classification,
                severity: c.severity,
                severityConf: c.severity_conf,
                severityReason: c.severity_reason,
              }
            : conv,
        ),
      );
    });

    es.addEventListener("message_insert", (e) => {
      const m = JSON.parse(e.data) as DBMessage;
      const newMsg = {
        id: m.id,
        sender: deriveRole(m.author),
        senderName: m.author,
        content: m.content ?? "",
        timestamp: m.timestamp ?? "",
      };
      setLiveConversations((prev) =>
        prev.map((conv) =>
          conv.id === m.conversation_id
            ? {
                ...conv,
                lastActivity: m.timestamp ?? conv.lastActivity,
                messages: [...conv.messages, newMsg],
              }
            : conv,
        ),
      );
    });

    return () => es.close();
  }, []);

  useEffect(() => {
    if (!listenTargetId) return;

    const socket = io(resolveSocketServerUrl());
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
      joinedConversationIdRef.current = joinedId;
      setIsAudioConnecting(false);
      setLiveAudioStatus("Listening live");
      if (pendingTakeoverConversationIdRef.current === joinedId) {
        socket.emit("operator_takeover_start", joinedId);
      }
    });

    socket.on(
      "conversation_audio",
      (speaker: LiveSpeaker, rawChunk: ArrayBuffer | Uint8Array) => {
        if (isDisposed) return;
        const pcmChunk = toPcm16(rawChunk);
        if (!pcmChunk.length) return;
        schedulePlayback(pcmChunk);
        const normalizedSpeaker: LiveSpeaker =
          speaker === "user" ? "user" : "agent";
        setLastSpeaker(normalizedSpeaker);
        setLiveAudioStatus(
          normalizedSpeaker === "user" ? "Senior speaking" : "Agent speaking",
        );
      },
    );

    socket.on("operator_takeover_started", (event: TakeoverEvent) => {
      if (isDisposed || event?.conversationId !== listenTargetId) return;
      pendingTakeoverConversationIdRef.current = null;
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(event.conversationId);
      setTakeoverError(null);
      setLiveAudioStatus("Operator call active");
      if (event.operatorSocketId === socket.id) {
        startOperatorMicrophoneCapture(socket, event.conversationId);
      }
    });

    socket.on("operator_takeover_stopped", (event: TakeoverEvent) => {
      if (isDisposed || event?.conversationId !== listenTargetId) return;
      stopOperatorMicrophoneCapture();
      pendingTakeoverConversationIdRef.current = null;
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(null);
      setLiveAudioStatus("Listening live");
    });

    socket.on("operator_takeover_error", (message: string) => {
      if (isDisposed) return;
      stopOperatorMicrophoneCapture();
      pendingTakeoverConversationIdRef.current = null;
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(null);
      setTakeoverError(message || "Failed to start operator takeover.");
      setLiveAudioStatus("Listening live");
    });

    socket.on("connect_error", () => {
      if (isDisposed) return;
      stopOperatorMicrophoneCapture();
      setLiveAudioError("Failed to connect to live audio stream.");
      setLiveAudioStatus("Live audio unavailable");
      setIsAudioConnecting(false);
      pendingTakeoverConversationIdRef.current = null;
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(null);
      setListenTargetId(null);
    });

    socket.on("disconnect", () => {
      if (isDisposed) return;
      stopOperatorMicrophoneCapture();
      setLiveAudioStatus("Live audio disconnected");
      setIsAudioConnecting(false);
      pendingTakeoverConversationIdRef.current = null;
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(null);
      setListenTargetId(null);
    });

    return () => {
      isDisposed = true;
      socket.emit("operator_takeover_stop", listenTargetId);
      socket.emit("leave_conversation", listenTargetId);
      socket.disconnect();
      if (listenerSocketRef.current === socket) {
        listenerSocketRef.current = null;
      }
      joinedConversationIdRef.current = null;
      stopOperatorMicrophoneCapture();

      if (playbackAudioContextRef.current === audioContext) {
        audioContext.close().catch(() => undefined);
        playbackAudioContextRef.current = null;
      }
      nextPlaybackTimeRef.current = 0;
      pendingTakeoverConversationIdRef.current = null;
      setIsAudioConnecting(false);
      setLastSpeaker(null);
      setPendingTakeoverConversationId(null);
      setTakeoverConversationId(null);
      setTakeoverError(null);
    };
  }, [
    listenTargetId,
    schedulePlayback,
    startOperatorMicrophoneCapture,
    stopOperatorMicrophoneCapture,
  ]);

  const orderedConversations = [...liveConversations].sort((a, b) => {
    const severityDelta = getSeverityRank(a.severity) - getSeverityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;

    const aTs = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTs = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTs - aTs;
  });

  const filtered =
    filter === "all"
      ? orderedConversations
      : orderedConversations.filter((c) => c.phase === filter);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: liveConversations.length },
    {
      key: "triage",
      label: "Triage",
      count: liveConversations.filter((c) => c.phase === "triage").length,
    },
    {
      key: "diagnosis",
      label: "Diagnosis",
      count: liveConversations.filter((c) => c.phase === "diagnosis").length,
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

  const isListeningSelected = listenTargetId === selected.id;
  const isTakeoverSelected = takeoverConversationId === selected.id;
  const isTakeoverPending = pendingTakeoverConversationId === selected.id;

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
              {liveConversations.length} total
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
                      listenerSocketRef.current?.emit("operator_takeover_stop", listenTargetId);
                      stopOperatorMicrophoneCapture();
                      setLiveAudioStatus("Live audio off");
                      setLiveAudioError(null);
                      setIsAudioConnecting(false);
                      pendingTakeoverConversationIdRef.current = null;
                      setPendingTakeoverConversationId(null);
                      setTakeoverConversationId(null);
                      setTakeoverError(null);
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
                        {conv.severity && (
                          <span
                            title={conv.severityReason ?? undefined}
                            className={cn(
                              "text-[10px] font-medium px-1.5 py-0.5 rounded border",
                              severityConfig[conv.severity].className,
                            )}
                          >
                            {severityConfig[conv.severity].label}
                          </span>
                        )}
                        {/* {conv.classification && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-slate-100 text-slate-600 border-slate-200">
                            {conv.classification}
                          </span>
                        )} */}
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
              variant={isListeningSelected ? "destructive" : "outline"}
              size="sm"
              onClick={() => {
                if (isListeningSelected) {
                  listenerSocketRef.current?.emit("operator_takeover_stop", selected.id);
                  stopOperatorMicrophoneCapture();
                  setLiveAudioStatus("Live audio off");
                  setLiveAudioError(null);
                  setIsAudioConnecting(false);
                  pendingTakeoverConversationIdRef.current = null;
                  setPendingTakeoverConversationId(null);
                  setTakeoverConversationId(null);
                  setTakeoverError(null);
                  setListenTargetId(null);
                  return;
                }
                setLiveAudioError(null);
                setLastSpeaker(null);
                setIsAudioConnecting(true);
                setLiveAudioStatus("Connecting to live audio...");
                setListenTargetId(selected.id);
              }}
              disabled={isAudioConnecting && isListeningSelected}
            >
              {isAudioConnecting && isListeningSelected ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Connecting
                </>
              ) : isListeningSelected ? (
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
            <Button
              variant={isTakeoverSelected ? "destructive" : "default"}
              size="sm"
              onClick={() => {
                if (isTakeoverSelected || isTakeoverPending) {
                  listenerSocketRef.current?.emit("operator_takeover_stop", selected.id);
                  stopOperatorMicrophoneCapture();
                  pendingTakeoverConversationIdRef.current = null;
                  setPendingTakeoverConversationId(null);
                  setTakeoverConversationId(null);
                  setTakeoverError(null);
                  setLiveAudioStatus(isListeningSelected ? "Listening live" : "Live audio off");
                  return;
                }

                setLiveAudioError(null);
                setTakeoverError(null);
                pendingTakeoverConversationIdRef.current = selected.id;
                setPendingTakeoverConversationId(selected.id);
                setLiveAudioStatus("Connecting operator call...");

                const socket = listenerSocketRef.current;
                if (
                  isListeningSelected &&
                  socket?.connected &&
                  joinedConversationIdRef.current === selected.id
                ) {
                  socket.emit("operator_takeover_start", selected.id);
                  return;
                }

                setIsAudioConnecting(true);
                setListenTargetId(selected.id);
              }}
              disabled={isAudioConnecting && !isListeningSelected}
            >
              {isTakeoverPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Taking over
                </>
              ) : isTakeoverSelected ? (
                <>
                  <PhoneOff className="w-3.5 h-3.5" />
                  End call
                </>
              ) : (
                <>
                  <Mic className="w-3.5 h-3.5" />
                  Take over
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
              {selected.severity && (
                <span
                  title={selected.severityReason ?? undefined}
                  className={cn(
                    "text-xs font-medium px-2.5 py-1 rounded border",
                    severityConfig[selected.severity].className,
                  )}
                >
                  {severityConfig[selected.severity].label}
                  {selected.severityConf != null
                    ? ` ${selected.severityConf}%`
                    : ""}
                </span>
              )}
              {/* {selected.classification && (
                <span className="text-xs font-medium px-2.5 py-1 rounded border bg-slate-100 text-slate-600 border-slate-200">
                  {selected.classification}
                </span>
              )} */}
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
              takeoverConversationId
                ? "text-red-600"
                : listenTargetId
                  ? "text-emerald-600"
                  : "text-slate-500",
            )}
          >
            <Volume2 className="w-3 h-3" />
            {liveAudioStatus}
            {takeoverConversationId && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500">
                Operator call
              </span>
            )}
            {lastSpeaker && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {lastSpeaker === "user" ? "Senior" : "Agent"}
              </span>
            )}
          </div>
          {liveAudioError && (
            <span className="text-xs text-red-600">{liveAudioError}</span>
          )}
          {takeoverError && (
            <span className="text-xs text-red-600">{takeoverError}</span>
          )}
          {selected.severityReason && (
            <span className="text-xs text-slate-500">
              Severity note: {selected.severityReason}
            </span>
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
