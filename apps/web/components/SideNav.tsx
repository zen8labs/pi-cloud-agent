"use client";

import type { RunSummary } from "@pi-cloud-agent/protocol";
import { MoonIcon, PlusIcon, Settings2Icon, SunIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { api } from "@/lib/api";
import { isActiveStatus } from "@/lib/format";
import { loadSessionTitles } from "@/lib/session-titles";
import { cn } from "@/lib/utils";

export function SideNav() {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listRuns(40)
        .then((items) => {
          if (alive) {
            setRuns(items);
            setTitles(loadSessionTitles(items.map((run) => run.id)));
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

  const active = runs.filter((run) => isActiveStatus(run.status));
  const recent = runs.filter((run) => !isActiveStatus(run.status));

  return (
    <>
      <header className="mobile-nav">
        <Brand />
        <div className="flex items-center gap-1">
          <MobileLink href="/chat" label="New task" active={pathname === "/chat"}>
            <PlusIcon />
          </MobileLink>
          <MobileLink href="/settings" label="Settings" active={pathname === "/settings"}>
            <Settings2Icon />
          </MobileLink>
        </div>
      </header>

      <aside className="side-nav">
        <div className="px-4 pb-3 pt-5">
          <Brand />
        </div>
        <div className="px-3">
          <Link
            href="/chat"
            className={cn("side-nav-link", pathname === "/chat" && "is-active")}
          >
            <PlusIcon className="size-4" />
            New task
          </Link>
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {active.length > 0 && (
            <RunGroup label="Running" runs={active} pathname={pathname} titles={titles} />
          )}
          <RunGroup label="Recent" runs={recent} pathname={pathname} titles={titles} />
        </div>

        <div className="border-t border-border p-3">
          <Link
            href="/settings"
            className={cn("side-nav-link", pathname === "/settings" && "is-active")}
          >
            <Settings2Icon className="size-4" />
            Settings
          </Link>
          <button type="button" onClick={toggle} className="side-nav-link mt-1 w-full">
            {mounted && theme === "light" ? (
              <MoonIcon className="size-4" />
            ) : (
              <SunIcon className="size-4" />
            )}
            {mounted && theme === "light" ? "Dark mode" : "Light mode"}
          </button>
        </div>
      </aside>
    </>
  );
}

function RunGroup({
  label,
  runs,
  pathname,
  titles,
}: {
  label: string;
  runs: RunSummary[];
  pathname: string;
  titles: Record<string, string>;
}) {
  if (runs.length === 0 && label === "Recent") {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">Your sessions will appear here.</p>
    );
  }
  return (
    <section className="mb-5">
      <h2 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground/70">{label}</h2>
      <div className="space-y-0.5">
        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/sessions/${run.id}`}
            title={run.repo}
            className={cn("history-link", pathname === `/sessions/${run.id}` && "is-active")}
          >
            <span className="truncate">{titles[run.id] ?? sessionLabel(run)}</span>
            {isActiveStatus(run.status) && (
              <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-emerald-500" />
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

function sessionLabel(run: RunSummary): string {
  const repository = run.repo.split("/").at(-1) || run.repo;
  return run.prNumber === null
    ? `${repository} · ${run.profile}`
    : `${repository} · PR #${run.prNumber}`;
}

function Brand() {
  return (
    <Link href="/chat" className="flex items-center gap-2.5" aria-label="Cloud Agent home">
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-black dark:bg-white">
        <Image src="/assets/z8l-logo.png" alt="" width={21} height={21} priority />
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Cloud Agent</span>
    </Link>
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
