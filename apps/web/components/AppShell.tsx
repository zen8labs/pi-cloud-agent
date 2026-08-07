"use client";

import { PanelLeftIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { NavCollapseProvider, useNavCollapse } from "@/components/nav-collapse";
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
  const { collapsed, width } = useNavCollapse();
  return (
    <div
      className={cn("app-shell", collapsed && "nav-collapsed")}
      style={{ "--nav-width": `${width}px` } as React.CSSProperties}
    >
      {collapsed ? <NavRail /> : <SideNav />}
      <main className="app-main">{children}</main>
    </div>
  );
}

/** Slim icon strip that keeps navigation one click away while the full nav is hidden. */
function NavRail() {
  const { toggle } = useNavCollapse();
  return (
    <div className="nav-rail">
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
