"use client";

import { useState } from "react";
import { conversations, type Conversation } from "@/lib/mock-data";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { MessageSquare, User, Bot, Stethoscope, Clock, MapPin, Smartphone } from "lucide-react";

const phaseConfig = {
  triage: { label: "Triage", className: "bg-amber-100 text-amber-800 border-amber-200" },
  diagnosis: { label: "Diagnosis", className: "bg-blue-100 text-blue-800 border-blue-200" },
};

const statusConfig = {
  active: { label: "Active", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  resolved: { label: "Resolved", className: "bg-slate-100 text-slate-600 border-slate-200" },
  pending: { label: "Pending", className: "bg-orange-100 text-orange-700 border-orange-200" },
};

const senderConfig = {
  senior: { icon: User, bg: "bg-slate-100", text: "text-slate-600", label: "Senior" },
  agent: { icon: Bot, bg: "bg-violet-100", text: "text-violet-600", label: "AI Agent" },
  human: { icon: Stethoscope, bg: "bg-blue-100", text: "text-blue-600", label: "Staff" },
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
}

function getInitials(name: string) {
  return name.split(" ").slice(-2).map((n) => n[0]).join("").toUpperCase();
}

type FilterTab = "all" | "triage" | "diagnosis";

export default function ConversationsPage() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<Conversation>(conversations[0]);

  const filtered = filter === "all" ? conversations : conversations.filter((c) => c.phase === filter);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: conversations.length },
    { key: "triage", label: "Triage", count: conversations.filter((c) => c.phase === "triage").length },
    { key: "diagnosis", label: "Diagnosis", count: conversations.filter((c) => c.phase === "diagnosis").length },
  ];

  return (
    <div className="flex h-full">
      {/* Left panel — conversation list */}
      <div className="flex flex-col w-80 bg-white border-r border-slate-200 shrink-0">
        {/* Header */}
        <div className="px-4 pt-5 pb-3 border-b border-slate-100">
          <h1 className="text-base font-semibold text-slate-900">Conversations</h1>
          <p className="text-xs text-slate-500 mt-0.5">{conversations.filter((c) => c.status === "active").length} active right now</p>
        </div>

        {/* Filter tabs */}
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

        {/* List */}
        <ScrollArea className="flex-1">
          <div className="py-2">
            {filtered.map((conv) => (
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
                      {getInitials(conv.seniorName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-xs font-semibold text-slate-900 truncate">{conv.seniorName}</p>
                      <span className="text-[10px] text-slate-400 shrink-0">{formatTime(conv.lastActivity)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border", phaseConfig[conv.phase].className)}>
                        {phaseConfig[conv.phase].label}
                      </span>
                      <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border", statusConfig[conv.status].className)}>
                        {statusConfig[conv.status].label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1 truncate">{conv.messages[conv.messages.length - 1].content}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel — conversation detail */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Conversation header */}
        <div className="flex items-start justify-between px-6 py-4 bg-white border-b border-slate-200 gap-4">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10">
              <AvatarFallback className="bg-slate-200 text-slate-700 font-semibold text-sm">
                {getInitials(selected.seniorName)}
              </AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{selected.seniorName}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-slate-500">{selected.seniorAge} y/o</span>
                <span className="text-slate-300">·</span>
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <MapPin className="w-3 h-3" />{selected.town}
                </span>
                <span className="text-slate-300">·</span>
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Smartphone className="w-3 h-3" />
                  {selected.deviceType === "wearable" ? "Wearable PAB" : "Stationary PAB"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={cn("text-xs font-medium px-2.5 py-1 rounded-full border", phaseConfig[selected.phase].className)}>
              {phaseConfig[selected.phase].label} phase
            </span>
            <span className={cn("text-xs font-medium px-2.5 py-1 rounded-full border", statusConfig[selected.status].className)}>
              {statusConfig[selected.status].label}
            </span>
          </div>
        </div>

        {/* Phase context bar */}
        <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="w-3 h-3" />
            Started {formatTime(selected.startedAt)}
          </div>
          {selected.assignedTo && (
            <>
              <Separator orientation="vertical" className="h-3" />
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Stethoscope className="w-3 h-3" />
                Assigned to <span className="font-medium text-slate-700">{selected.assignedTo}</span>
              </div>
            </>
          )}
          <Separator orientation="vertical" className="h-3" />
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <MessageSquare className="w-3 h-3" />
            {selected.messages.length} messages
          </div>
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 px-6 py-4">
          <div className="space-y-4 max-w-3xl">
            {selected.messages.map((msg, i) => {
              const cfg = senderConfig[msg.sender];
              const Icon = cfg.icon;
              const isRight = msg.sender === "senior";

              return (
                <div key={msg.id} className={cn("flex gap-3", isRight && "flex-row-reverse")}>
                  {/* Avatar */}
                  <div className={cn("flex items-center justify-center w-7 h-7 rounded-full shrink-0 mt-0.5", cfg.bg)}>
                    <Icon className={cn("w-3.5 h-3.5", cfg.text)} />
                  </div>

                  {/* Bubble */}
                  <div className={cn("flex flex-col max-w-sm", isRight && "items-end")}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-semibold text-slate-500">{msg.senderName}</span>
                      <span className={cn("text-[9px] px-1 rounded text-slate-400 border border-slate-200 bg-white")}>
                        {cfg.label}
                      </span>
                      <span className="text-[10px] text-slate-400">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div
                      className={cn(
                        "px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed",
                        msg.sender === "senior"
                          ? "bg-slate-900 text-white rounded-tr-sm"
                          : msg.sender === "agent"
                          ? "bg-violet-50 text-slate-800 border border-violet-100 rounded-tl-sm"
                          : "bg-blue-50 text-slate-800 border border-blue-100 rounded-tl-sm"
                      )}
                    >
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
