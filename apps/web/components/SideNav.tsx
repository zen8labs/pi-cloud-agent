"use client";

import type { SessionSummary } from "@pi-cloud-agent/protocol";
import { PanelLeftIcon, PlusIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { useNavCollapse } from "@/components/nav-collapse";
import { api } from "@/lib/api";
import { loadSessionTitles } from "@/lib/session-titles";
import { cn } from "@/lib/utils";

export function SideNav() {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listSessions(40)
        .then((items) => {
          if (alive) {
            setSessions(items);
            setTitles(loadSessionTitles(items.map((item) => item.id)));
          }
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const active = sessions.filter((session) => session.status !== "idle");
  const recent = sessions.filter((session) => session.status === "idle");

  return (
    <>
      <header className="mobile-nav">
        <Brand />
        <div className="flex items-center gap-1">
          <MobileLink href="/chat" label="New task" active={pathname === "/chat"}>
            <PlusIcon />
          </MobileLink>
          <AccountMenu compact placement="bottom" />
        </div>
      </header>

      <aside className="side-nav">
        <div className="flex items-center justify-between px-3.5 pb-2 pt-4">
          <Brand />
          <CollapseButton />
        </div>
        <div className="px-2.5">
          <Link
            href="/chat"
            className={cn("side-nav-link", pathname === "/chat" && "is-active")}
          >
            <PlusIcon className="size-3.5" />
            New task
          </Link>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          {active.length > 0 && (
            <SessionGroup
              label="Running"
              sessions={active}
              pathname={pathname}
              titles={titles}
            />
          )}
          {recent.length > 0 && (
            <SessionGroup
              label="Recent"
              sessions={recent}
              pathname={pathname}
              titles={titles}
            />
          )}
          {sessions.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground/80">
              Your sessions will appear here.
            </p>
          )}
        </div>

        <div className="border-t border-border px-2.5 py-2.5">
          <AccountMenu />
        </div>
      </aside>
    </>
  );
}

function SessionGroup({
  label,
  sessions,
  pathname,
  titles,
}: {
  label: string;
  sessions: SessionSummary[];
  pathname: string;
  titles: Record<string, string>;
}) {
  return (
    <section className="mb-4">
      <h2 className="nav-label">{label}</h2>
      <div className="space-y-px">
        {sessions.map((session) => (
          <Link
            key={session.id}
            href={`/sessions/${session.id}`}
            title={session.repo}
            className={cn(
              "history-link",
              pathname === `/sessions/${session.id}` && "is-active",
            )}
          >
            <span className="truncate">
              {titles[session.id] || session.title || sessionLabel(session)}
            </span>
            {session.status !== "idle" && (
              <span className="ml-auto size-1.5 shrink-0 animate-pulse-dot rounded-full bg-emerald-500" />
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

function sessionLabel(session: SessionSummary): string {
  const repository = session.repo.split("/").at(-1) || session.repo;
  return `${repository} · ${session.profile}`;
}

function Brand() {
  return (
    <Link href="/chat" className="flex items-center gap-2 px-0.5" aria-label="Cloud Agent home">
      <span className="flex size-[26px] items-center justify-center rounded-lg border border-border bg-white">
        <Image src="/assets/z8l-logo.png" alt="" width={16} height={16} priority />
      </span>
      <span className="text-[13px] font-semibold tracking-[-0.01em]">Cloud Agent</span>
    </Link>
  );
}

function CollapseButton() {
  const { toggle } = useNavCollapse();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Collapse sidebar"
      className="grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      <PanelLeftIcon className="size-4" />
    </button>
  );
}

function MobileLink({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn("mobile-nav-link", active && "mobile-nav-link-active")}
    >
      {children}
    </Link>
  );
}
