"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const ModeContext = createContext<"tasks" | "reviews">("tasks");

export function WorkspaceModeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState<"tasks" | "reviews">("tasks");
  useEffect(() => {
    let alive = true;
    if (pathname === "/chat") setMode("tasks");
    else if (pathname === "/reviews") setMode("reviews");
    else if (pathname.startsWith("/sessions/")) {
      void api
        .getSession(pathname.split("/")[2] ?? "")
        .then((session) => {
          if (alive) setMode(session.hasReviews ? "reviews" : "tasks");
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [pathname]);
  const effective = pathname === "/reviews" ? "reviews" : pathname === "/chat" ? "tasks" : mode;
  return <ModeContext value={effective}>{children}</ModeContext>;
}

export function useWorkspaceMode() {
  return useContext(ModeContext);
}

export function WorkspaceModeSwitch() {
  const mode = useWorkspaceMode();
  return (
    <nav aria-label="Workspace" className="flex rounded-lg bg-muted/70 p-0.5 text-xs">
      {(
        [
          ["tasks", "/chat", "Tasks"],
          ["reviews", "/reviews", "Reviews"],
        ] as const
      ).map(([value, href, label]) => (
        <Link
          key={value}
          href={href}
          aria-current={mode === value ? "page" : undefined}
          className={cn(
            "flex-1 rounded-md px-3 py-1.5 text-center transition-colors",
            mode === value
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
