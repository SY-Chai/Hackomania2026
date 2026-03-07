"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { MessageSquare, User, Bot, Stethoscope, Clock, MapPin } from "lucide-react";

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
  triage: { label: "Triage", className: "bg-amber-100 text-amber-800 border-amber-200" },
  diagnosis: { label: "Diagnosis", className: "bg-blue-100 text-blue-800 border-blue-200" },
};

const senderConfig = {
  senior: { icon: User, bg: "bg-slate-100", text: "text-slate-600", label: "Senior" },
  agent: { icon: Bot, bg: "bg-violet-100", text: "text-violet-600", label: "AI Agent" },
  human: { icon: Stethoscope, bg: "bg-blue-100", text: "text-blue-600", label: "Staff" },
};

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
}

function getInitials(name: string) {
  return name.split(" ").slice(-2).map((n) => n[0]).join("").toUpperCase();
}

type FilterTab = "all" | "triage" | "diagnosis";

interface Props {
  conversations: UIConversation[];
}

export function ConversationsView({ conversations }: Props) {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<UIConversation>(conversations[0] ?? null);

  const filtered = filter === "all" ? conversations : conversations.filter((c) => c.phase === filter);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: conversations.length },
    { key: "triage", label: "Triage", count: conversations.filter((c) => c.phase === "triage").length },
    { key: "diagnosis", label: "Diagnosis", count: conversations.filter((c) => c.phase === "diagnosis").length },
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
    <div className="flex h-full">
      {/* Left panel */}
      <div className="flex flex-col w-80 bg-white border-r border-slate-200 shrink-0">
        <div className="px-4 pt-5 pb-3 border-b border-slate-100">
          <h1 className="text-base font-semibold text-slate-900">Conversations</h1>
          <p className="text-xs text-slate-500 mt-0.5">{conversations.length} total</p>
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
                  : "border-transparent text-slate-500 hover:text-slate-700"
              )}
            >
              {label}
              <span className={cn(
                "text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
                filter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
              )}>
                {count}
              </span>
            </button>
          ))}
        </div>

        <ScrollArea className="flex-1">
          <div className="py-2">
            {filtered.map((conv) => {
              const displayName = getDisplayName(conv);
              const lastMsg = conv.messages[conv.messages.length - 1];
              return (
                <button
                  key={conv.id}
                  onClick={() => setSelected(conv)}
                  className={cn(
                    "w-full text-left px-4 py-3 transition-colors border-b border-slate-50 last:border-0",
                    selected.id === conv.id ? "bg-slate-50" : "hover:bg-slate-50/60"
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
                        <p className="text-xs font-semibold text-slate-900 truncate">{displayName}</p>
                        <span className="text-[10px] text-slate-400 shrink-0">{formatTime(conv.lastActivity)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border", phaseConfig[conv.phase].className)}>
                          {phaseConfig[conv.phase].label}
                        </span>
                        {conv.classification && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                            {conv.classification}
                          </span>
                        )}
                      </div>
                      {lastMsg && (
                        <p className="text-xs text-slate-400 mt-1 truncate">{lastMsg.content}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-start justify-between px-6 py-4 bg-white border-b border-slate-200 gap-4">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10">
              <AvatarFallback className="bg-slate-200 text-slate-700 font-semibold text-sm">
                {getInitials(getDisplayName(selected))}
              </AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{getDisplayName(selected)}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <MapPin className="w-3 h-3" />ID: {selected.id.slice(0, 8)}…
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={cn("text-xs font-medium px-2.5 py-1 rounded-full border", phaseConfig[selected.phase].className)}>
              {phaseConfig[selected.phase].label} phase
            </span>
            {selected.classification && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                {selected.classification}
              </span>
            )}
          </div>
        </div>

        <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="w-3 h-3" />
            Started {formatTime(selected.startedAt)}
          </div>
          <Separator orientation="vertical" className="h-3" />
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <MessageSquare className="w-3 h-3" />
            {selected.messages.length} messages
          </div>
        </div>

        <ScrollArea className="flex-1 px-6 py-4">
          <div className="space-y-4 max-w-3xl">
            {selected.messages.map((msg) => {
              const cfg = senderConfig[msg.sender];
              const Icon = cfg.icon;
              const isRight = msg.sender === "senior";

              return (
                <div key={msg.id} className={cn("flex gap-3", isRight && "flex-row-reverse")}>
                  <div className={cn("flex items-center justify-center w-7 h-7 rounded-full shrink-0 mt-0.5", cfg.bg)}>
                    <Icon className={cn("w-3.5 h-3.5", cfg.text)} />
                  </div>
                  <div className={cn("flex flex-col max-w-sm", isRight && "items-end")}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-semibold text-slate-500">{msg.senderName}</span>
                      <span className="text-[9px] px-1 rounded text-slate-400 border border-slate-200 bg-white">
                        {cfg.label}
                      </span>
                      <span className="text-[10px] text-slate-400">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div className={cn(
                      "px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed",
                      msg.sender === "senior"
                        ? "bg-slate-900 text-white rounded-tr-sm"
                        : msg.sender === "agent"
                        ? "bg-violet-50 text-slate-800 border border-violet-100 rounded-tl-sm"
                        : "bg-blue-50 text-slate-800 border border-blue-100 rounded-tl-sm"
                    )}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
