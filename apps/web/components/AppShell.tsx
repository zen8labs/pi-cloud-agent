"use client";

import { PanelLeftIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { NavCollapseProvider, useNavCollapse } from "@/components/nav-collapse";
import { SideNav } from "@/components/SideNav";
import { cn } from "@/lib/utils";

/** The shell owns the left navigation's collapsed state; pages never see it. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <NavCollapseProvider>
      <Shell>{children}</Shell>
    </NavCollapseProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { collapsed } = useNavCollapse();
  return (
    <div className={cn("app-shell", collapsed && "nav-collapsed")}>
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
    </div>
  );
}
