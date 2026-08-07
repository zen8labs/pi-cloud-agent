"use client";

import type { RunDetail, SessionDetail } from "@pi-cloud-agent/protocol";
import { ArrowLeftIcon, GitBranchIcon, PanelRightIcon, SquareIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { AzureDevOpsMarkIcon, GithubMarkIcon } from "@/components/ProviderIcons";
import { SessionFollowUp } from "@/components/SessionFollowUp";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { absoluteTime } from "@/lib/format";
import { resolveBranch, summarizeChanges } from "@/lib/session-meta";
import { useSession } from "@/lib/useSession";
import { cn } from "@/lib/utils";

const SessionDiffSidebar = dynamic(
  () => import("@/components/SessionDiffSidebar").then((module) => module.SessionDiffSidebar),
  {
    ssr: false,
    loading: () => (
      <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background">
        <div className="flex h-12 shrink-0 items-center border-b border-border px-4 text-[13px] font-semibold">
          Changes
        </div>
      </aside>
    ),
  },
);

const DIFF_WIDTH_STORAGE_KEY = "pca-diff-width-v3";
const DEFAULT_DIFF_WIDTH = 760;
const MIN_DIFF_WIDTH = 320;
const MAX_DIFF_WIDTH = 960;

function getMaxDiffWidth(): number {
  if (typeof window === "undefined") return MAX_DIFF_WIDTH;
  return Math.max(
    MIN_DIFF_WIDTH,
    Math.min(MAX_DIFF_WIDTH, Math.floor(window.innerWidth * 0.56)),
  );
}

function clampDiffWidth(width: number, maxWidth = MAX_DIFF_WIDTH): number {
  return Math.min(maxWidth, Math.max(MIN_DIFF_WIDTH, Math.round(width)));
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { session, turns, error, refresh } = useSession(id);
  const [cancelling, setCancelling] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffWidth, setDiffWidth] = useState(() =>
    clampDiffWidth(DEFAULT_DIFF_WIDTH, getMaxDiffWidth()),
  );
  const diffRequest = useRef(0);
  const [diffTarget, setDiffTarget] = useState<{ path: string; request: number } | null>(null);
  const latest = turns.at(-1)?.run ?? null;
  const active = session ? session.status !== "idle" : false;
  const allEvents = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
  const changes = useMemo(() => summarizeChanges(allEvents), [allEvents]);
  const maxDiffWidth = getMaxDiffWidth();
  const branch = useMemo(
    () => resolveBranch(latest?.branch ?? null, allEvents),
    [allEvents, latest?.branch],
  );
  const openChanges = useCallback((path?: string) => {
    setDiffOpen(true);
    setDiffTarget(path ? { path, request: ++diffRequest.current } : null);
  }, []);

  useEffect(() => {
    try {
      const storedWidth = localStorage.getItem(DIFF_WIDTH_STORAGE_KEY);
      if (storedWidth !== null && Number.isFinite(Number(storedWidth))) {
        setDiffWidth(clampDiffWidth(Number(storedWidth), getMaxDiffWidth()));
      }
    } catch {
      // Storage unavailable: keep the default width.
    }
  }, []);

  const resizeDiff = (nextWidth: number) => {
    const next = clampDiffWidth(nextWidth, maxDiffWidth);
    setDiffWidth(next);
    try {
      localStorage.setItem(DIFF_WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Persisting is best-effort; resizing still works for the session.
    }
  };

  const cancel = async () => {
    if (!latest) return;
    setCancelling(true);
    try {
      await api.cancelRun(latest.id);
    } catch {
      /* The stream reports the durable outcome. */
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <SessionHeader
          session={session}
          active={active}
          cancelling={cancelling}
          onCancel={cancel}
          diffOpen={diffOpen}
          onToggleDiff={() => {
            if (diffOpen) {
              setDiffOpen(false);
              setDiffTarget(null);
            } else {
              openChanges();
            }
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error && !session ? (
              <div className="grid flex-1 place-items-center px-6">
                <div
                  role="alert"
                  className="max-w-lg rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                >
                  {error}
                </div>
              </div>
            ) : (
              <Conversation className="min-h-0 flex-1">
                <ConversationContent className="mx-auto w-full max-w-3xl gap-8 px-5 py-10 sm:px-8">
                  {turns.map((turn, index) => (
                    <ActivityFeed
                      key={turn.run.id}
                      events={turn.events}
                      userPrompt={turn.run.prompt}
                      active={active && index === turns.length - 1}
                      onOpenChanges={openChanges}
                    />
                  ))}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            )}
            {session && (
              <div className="bg-background px-4 pb-5 pt-2 sm:px-6">
                <div className="mx-auto max-w-3xl">
                  <SessionFollowUp
                    sessionId={session.id}
                    repo={session.repo}
                    previousModel={latest?.model ?? session.model}
                    previousModelConnectionId={
                      latest?.modelConnectionId ?? session.modelConnectionId
                    }
                    previousThinkingLevel={latest?.thinkingLevel ?? "medium"}
                    active={active}
                    onQueued={refresh}
                  />
                </div>
              </div>
            )}
          </section>
          <div
            className={cn(
              "hidden h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none lg:block",
              diffOpen ? "pointer-events-none w-0 opacity-0" : "w-60 opacity-100",
            )}
          >
            <SessionMeta
              session={session}
              run={latest}
              branch={branch}
              changes={changes}
              onOpenChanges={openChanges}
            />
          </div>
        </div>
      </div>
      <div
        className={cn(
          "relative hidden h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none lg:block",
          diffOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        style={{ width: diffOpen ? diffWidth : 0 }}
      >
        {diffOpen ? (
          <SidebarResizeHandle
            side="right"
            currentSize={diffWidth}
            minSize={MIN_DIFF_WIDTH}
            maxSize={maxDiffWidth}
            onResize={resizeDiff}
            onReset={() => resizeDiff(DEFAULT_DIFF_WIDTH)}
          />
        ) : null}
        <SessionDiffSidebar
          turns={turns}
          open={diffOpen}
          target={diffTarget}
          onClose={() => {
            setDiffOpen(false);
            setDiffTarget(null);
          }}
        />
      </div>
    </div>
  );
}

function SessionHeader({
  session,
  active,
  cancelling,
  onCancel,
  diffOpen,
  onToggleDiff,
}: {
  session: SessionDetail | null;
  active: boolean;
  cancelling: boolean;
  onCancel: () => void;
  diffOpen: boolean;
  onToggleDiff: () => void;
}) {
  return (
    <header className="app-header flex h-12 shrink-0 items-center gap-2.5 px-3 sm:px-4">
      <Link
        href="/"
        aria-label="Back to sessions"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[13px] font-medium">{session?.title ?? "Session"}</h1>
        {session?.repo ? (
          <p className="mt-px truncate text-[11px] text-muted-foreground">{session.repo}</p>
        ) : null}
      </div>
      {active && (
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <SquareIcon className="size-2.5" /> {cancelling ? "Stopping…" : "Cancel"}
        </button>
      )}
      <button
        type="button"
        onClick={onToggleDiff}
        aria-label={diffOpen ? "Hide changes" : "Show changes"}
        aria-pressed={diffOpen}
        className={cn(
          "hidden size-7 place-items-center rounded-md transition-colors duration-200 motion-reduce:transition-none hover:bg-accent hover:text-foreground lg:grid",
          diffOpen ? "bg-accent text-foreground" : "text-muted-foreground",
        )}
      >
        <PanelRightIcon className="size-3.5" />
      </button>
    </header>
  );
}

/**
 * Environment strip inside the chat window (not a page-level sidebar).
 * Auto-hides below lg while the dedicated Changes rail owns the page-level right slot.
 */
function SessionMeta({
  session,
  run,
  branch,
  changes,
  onOpenChanges,
}: {
  session: SessionDetail | null;
  run: RunDetail | null;
  branch: string | null;
  changes: { files: { path: string }[]; added: number; removed: number };
  onOpenChanges: () => void;
}) {
  const repo = run?.repo ?? session?.repo ?? null;
  const provider = run?.provider ?? session?.provider ?? null;

  return (
    <div className="h-full w-full overflow-y-auto px-4 pb-5 pt-4">
      <div className="flex flex-col gap-3 text-xs">
        {run ? <StatusBadge status={run.status} /> : null}

        {repo ? <RepoLine repo={repo} provider={provider} /> : null}

        {branch ? (
          <p className="flex min-w-0 items-center gap-1.5 text-foreground">
            <span className="text-muted-foreground">On</span>
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono">{branch}</span>
          </p>
        ) : null}

        <ChangesLine
          added={changes.added}
          removed={changes.removed}
          onOpenChanges={onOpenChanges}
        />

        {run ? <p className="text-muted-foreground">{absoluteTime(run.createdAt)}</p> : null}

        {run?.error ? (
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 font-mono text-[11px] leading-5 text-destructive">
            {run.error}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function RepoLine({ repo, provider }: { repo: string; provider: string | null }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-foreground">
      <ForgeIcon provider={provider} />
      <span className="truncate font-mono">{repo}</span>
    </p>
  );
}

function ForgeIcon({ provider }: { provider: string | null }) {
  const name = (provider ?? "").toLowerCase();
  if (name === "azure-devops" || name === "azure_devops" || name === "ado") {
    return (
      <span title="Azure DevOps" className="inline-flex shrink-0 text-muted-foreground">
        <AzureDevOpsMarkIcon className="size-3.5" />
      </span>
    );
  }
  return (
    <span title="GitHub" className="inline-flex shrink-0 text-muted-foreground">
      <GithubMarkIcon className="size-3.5" />
    </span>
  );
}

function ChangesLine({
  added,
  removed,
  onOpenChanges,
}: {
  added: number;
  removed: number;
  onOpenChanges: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenChanges()}
      className="cursor-pointer text-left font-mono tabular-nums text-foreground transition-colors hover:text-foreground/75"
    >
      {added === 0 && removed === 0 ? (
        <span className="text-muted-foreground">No edits yet</span>
      ) : (
        <>
          <span className="text-muted-foreground">± Changes </span>
          {added > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
          ) : null}
          {added > 0 && removed > 0 ? <span> </span> : null}
          {removed > 0 ? (
            <span className="text-red-600 dark:text-red-400">-{removed}</span>
          ) : null}
        </>
      )}
    </button>
  );
}
