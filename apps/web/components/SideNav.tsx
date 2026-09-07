"use client";

import type { SessionSummary } from "@pi-cloud-agent/protocol";
import { PanelLeftIcon, PinIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { useNavCollapse } from "@/components/nav-collapse";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { loadSessionTitles } from "@/lib/session-titles";
import { cn } from "@/lib/utils";

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listSessions(100)
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
  const pinned = sessions.filter((session) => session.status === "idle" && session.pinned);
  const recent = sessions.filter((session) => session.status === "idle" && !session.pinned);

  const togglePin = async (session: SessionSummary) => {
    setPendingActionId(session.id);
    try {
      const result = await api.setSessionPinned(session.id, !session.pinned);
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id ? { ...item, pinned: result.pinned } : item,
        ),
      );
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingActionId(null);
    }
  };

  const requestDelete = (session: SessionSummary) => {
    setDeleteError(null);
    setDeleteTarget(session);
  };

  const deleteSession = async () => {
    if (!deleteTarget) return;
    const session = deleteTarget;
    setPendingActionId(session.id);
    try {
      await api.deleteSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setDeleteTarget(null);
      if (pathname === `/sessions/${session.id}`) router.push("/");
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingActionId(null);
    }
  };

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

      <aside className="side-nav relative">
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
              pendingActionId={pendingActionId}
              onTogglePin={togglePin}
              onDelete={requestDelete}
            />
          )}
          {pinned.length > 0 && (
            <SessionGroup
              label="Pinned"
              sessions={pinned}
              pathname={pathname}
              titles={titles}
              pendingActionId={pendingActionId}
              onTogglePin={togglePin}
              onDelete={requestDelete}
            />
          )}
          {recent.length > 0 && (
            <SessionGroup
              label="Recent"
              sessions={recent}
              pathname={pathname}
              titles={titles}
              pendingActionId={pendingActionId}
              onTogglePin={togglePin}
              onDelete={requestDelete}
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
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `Delete “${deleteTarget.title || "session"}”` : "Delete session"}
        description="This permanently deletes the session, its chat history, and its sandbox checkpoint."
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={pendingActionId === deleteTarget?.id}
        error={deleteError}
        onCancel={() => {
          if (pendingActionId === null) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => void deleteSession()}
      />
    </>
  );
}

function SessionGroup({
  label,
  sessions,
  pathname,
  titles,
  pendingActionId,
  onTogglePin,
  onDelete,
}: {
  label: string;
  sessions: SessionSummary[];
  pathname: string;
  titles: Record<string, string>;
  pendingActionId: string | null;
  onTogglePin: (session: SessionSummary) => Promise<void>;
  onDelete: (session: SessionSummary) => void;
}) {
  return (
    <section className="mb-4">
      <h2 className="nav-label">{label}</h2>
      <div className="space-y-px">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={cn(
              "history-link group",
              pathname === `/sessions/${session.id}` && "is-active",
            )}
          >
            <Link
              href={`/sessions/${session.id}`}
              title={session.repo}
              className="min-w-0 flex-1 truncate"
            >
              {titles[session.id] || session.title || sessionLabel(session)}
            </Link>
            {session.retentionStatus === "inactive" && (
              <span
                title={`Inactive after ${formatDuration(session.inactiveAfterSeconds)} without activity`}
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                inactive
              </span>
            )}
            {session.status !== "idle" && (
              <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-emerald-500" />
            )}
            <div className="flex shrink-0 items-center gap-0.5 border-l border-transparent pl-1 opacity-0 transition-opacity group-hover:border-border/70 group-hover:opacity-100 group-focus-within:border-border/70 group-focus-within:opacity-100">
              <button
                type="button"
                aria-label={session.pinned ? "Unpin session" : "Pin session"}
                title={session.pinned ? "Unpin session" : "Pin session"}
                disabled={pendingActionId === session.id}
                onClick={() => void onTogglePin(session)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <PinIcon className="size-3.5" fill={session.pinned ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                aria-label="Delete session"
                title="Delete session"
                disabled={pendingActionId === session.id}
                onClick={() => onDelete(session)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function sessionLabel(session: SessionSummary): string {
  const repository = session.repo.split("/").at(-1) || session.repo;
  return repository;
}

function Brand() {
  return (
    <Link href="/chat" className="flex items-center gap-2 px-0.5" aria-label="zen8agent home">
      <span className="flex size-[26px] items-center justify-center rounded-lg border border-border bg-white">
        <Image src="/assets/z8l-logo.png" alt="" width={16} height={16} priority />
      </span>
      <span className="text-[13px] font-semibold tracking-[-0.01em]">zen8agent</span>
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
