"use client";

import { PanelLeftIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import {
  MAX_WIDTH,
  MIN_WIDTH,
  NavCollapseProvider,
  useNavCollapse,
} from "@/components/nav-collapse";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { SideNav } from "@/components/SideNav";
import { SignIn } from "@/components/SignIn";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The shell owns the left navigation's collapsed state; pages never see it. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <NavCollapseProvider>
      <AuthGate>{children}</AuthGate>
    </NavCollapseProvider>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "signed-in" | "signed-out">("loading");

  useEffect(() => {
    void api
      .getCurrentUser()
      .then(() => setState("signed-in"))
      .catch(() => setState("signed-out"));
  }, []);

  if (state === "loading") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (state === "signed-out") {
    return <SignIn />;
  }
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { collapsed, expand, resetWidth, width, resize } = useNavCollapse();
  const [resizing, setResizing] = useState(false);
  const currentSize = collapsed ? 46 : width;
  return (
    <div
      className={cn(
        "app-shell relative",
        collapsed && "nav-collapsed",
        resizing && "is-resizing",
      )}
      style={{ "--nav-width": `${collapsed ? 46 : width}px` } as React.CSSProperties}
    >
      {collapsed ? <NavRail /> : <SideNav />}
      <main className="app-main">{children}</main>
      <div
        className="sidebar-resize-layer pointer-events-none absolute inset-y-0 z-50"
        style={{ left: currentSize }}
      >
        <div className="relative h-full w-0">
          <SidebarResizeHandle
            side="left"
            currentSize={currentSize}
            minSize={MIN_WIDTH}
            maxSize={MAX_WIDTH}
            onResize={(nextWidth) => {
              if (collapsed) expand();
              resize(nextWidth);
            }}
            onReset={resetWidth}
            onDraggingChange={setResizing}
          />
        </div>
      </div>
    </div>
  );
}

/** Slim icon strip that keeps navigation one click away while the full nav is hidden. */
function NavRail() {
  const { toggle } = useNavCollapse();
  return (
    <div className="nav-rail relative">
      <button type="button" onClick={toggle} aria-label="Expand sidebar" className="rail-link">
        <PanelLeftIcon className="size-4" />
      </button>
      <Link href="/chat" aria-label="New task" className="rail-link mt-1">
        <PlusIcon className="size-4" />
      </Link>
      <div className="flex-1" />
      <AccountMenu compact placement="right" />
    </div>
  );
}
