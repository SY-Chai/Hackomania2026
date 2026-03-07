"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MapPin, MessageSquare, Activity, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard/map", label: "Map", icon: MapPin, description: "PAB locations" },
  { href: "/dashboard/conversations", label: "Conversations", icon: MessageSquare, description: "Active logs" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex flex-col w-60 min-h-screen bg-white border-r border-slate-200">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-100">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-900">
          <Shield className="w-4 h-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900 leading-tight">PAB Monitor</p>
          <p className="text-xs text-slate-500 leading-tight">Response Centre</p>
        </div>
      </div>

      {/* Live indicator */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100 bg-slate-50">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span className="text-xs text-slate-600 font-medium">Live monitoring</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 px-3 py-4 flex-1">
        <p className="px-2 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Navigation</p>
        {navItems.map(({ href, label, icon: Icon, description }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all",
                active
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              <Icon className={cn("w-4 h-4 shrink-0", active ? "text-white" : "text-slate-500")} />
              <div>
                <p className={cn("font-medium leading-tight", active ? "text-white" : "text-slate-800")}>{label}</p>
                <p className={cn("text-xs leading-tight", active ? "text-slate-300" : "text-slate-400")}>{description}</p>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer stats */}
      <div className="px-4 py-4 border-t border-slate-100">
        <div className="rounded-lg bg-slate-50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Active alerts</span>
            <span className="text-xs font-semibold text-red-600">3</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Online devices</span>
            <span className="text-xs font-semibold text-slate-800">342</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Open chats</span>
            <span className="text-xs font-semibold text-slate-800">5</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
