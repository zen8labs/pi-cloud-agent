"use client";

import type {
  LlmConnectionSummary,
  RunDetail,
  SessionDetail,
  ThinkingLevel,
} from "@pi-cloud-agent/protocol";
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
import { ChatComposer } from "@/components/ChatComposer";
import { ModelSelect } from "@/components/ModelSelect";
import { AzureDevOpsMarkIcon, GithubMarkIcon } from "@/components/ProviderIcons";
import { StatusBadge } from "@/components/StatusBadge";
import { ThinkingLevelSelect } from "@/components/ThinkingLevelSelect";
import { api } from "@/lib/api";
import { absoluteTime } from "@/lib/format";
import {
  defaultModelSelection,
  parseModelSelection,
  preferredModelSelection,
  preferredThinkingLevel,
  selectedModel,
} from "@/lib/model-selection";
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

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { session, turns, error, refresh } = useSession(id);
  const [cancelling, setCancelling] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const diffRequest = useRef(0);
  const [diffTarget, setDiffTarget] = useState<{ path: string; request: number } | null>(null);
  const latest = turns.at(-1)?.run ?? null;
  const active = session ? session.status !== "idle" : false;
  const allEvents = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
  const changes = useMemo(() => summarizeChanges(allEvents), [allEvents]);
  const branch = useMemo(
    () => resolveBranch(latest?.branch ?? null, allEvents),
    [allEvents, latest?.branch],
  );
  const openChanges = useCallback((path?: string) => {
    setDiffOpen(true);
    setDiffTarget(path ? { path, request: ++diffRequest.current } : null);
  }, []);

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
                  <FollowUp
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
              "hidden h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none xl:block",
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
          "hidden h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none xl:block",
          diffOpen ? "w-[min(52vw,720px)] opacity-100" : "pointer-events-none w-0 opacity-0",
        )}
      >
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
          "hidden size-7 place-items-center rounded-md transition-colors duration-200 motion-reduce:transition-none hover:bg-accent hover:text-foreground xl:grid",
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
 * Auto-hides below xl while the dedicated Changes rail owns the page-level right slot.
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

/** Transport seam for multi-turn sessions. It can switch from replay to Pi session resume without changing the composer. */
function FollowUp({
  sessionId,
  repo,
  previousModel,
  previousModelConnectionId,
  previousThinkingLevel,
  active,
  onQueued,
}: {
  sessionId: string;
  repo: string;
  previousModel: string;
  previousModelConnectionId: string | null;
  previousThinkingLevel: ThinkingLevel;
  active: boolean;
  onQueued: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [modelConnections, setModelConnections] = useState<LlmConnectionSummary[]>([]);
  const [modelSelection, setModelSelection] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active) return;
    let alive = true;
    setModelsLoading(true);
    api
      .listLlmConnections()
      .then((connections) => {
        if (!alive) return;
        setModelConnections(connections);
        const selection = preferredModelSelection(
          connections,
          previousModelConnectionId,
          previousModel,
        );
        setModelSelection(selection);
        setThinkingLevel(
          preferredThinkingLevel(selectedModel(connections, selection), previousThinkingLevel),
        );
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setModelsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [active, previousModel, previousModelConnectionId, previousThinkingLevel]);

  const selected = parseModelSelection(modelSelection);
  const canSubmit = !active && !submitting && Boolean(prompt.trim()) && Boolean(selected);

  const submit = async () => {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createSessionTurn(sessionId, {
        prompt: prompt.trim(),
        modelConnectionId: selected.connectionId,
        modelId: selected.modelId,
        thinkingLevel,
      });
      setPrompt("");
      await onQueued();
      setSubmitting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const connections = await api.listLlmConnections().catch(() => null);
      if (connections) {
        setModelConnections(connections);
        setModelSelection(defaultModelSelection(connections));
        const selection = defaultModelSelection(connections);
        setThinkingLevel(preferredThinkingLevel(selectedModel(connections, selection)));
      }
      setSubmitting(false);
    }
  };

  return (
    <div>
      <ChatComposer
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder={active ? "Pi is still working…" : `Follow up on ${repo}…`}
        submitLabel="Send"
        submitEnabled={canSubmit}
        submitting={submitting}
        disabled={active || modelsLoading || modelConnections.length === 0}
        compact
        tools={
          <div className="flex min-w-0 items-center text-muted-foreground">
            <ModelSelect
              connections={modelConnections}
              value={modelSelection}
              onChange={(value) => {
                setModelSelection(value);
                setThinkingLevel(
                  preferredThinkingLevel(selectedModel(modelConnections, value), thinkingLevel),
                );
              }}
              disabled={active || modelsLoading}
              ariaLabel="Model for next turn"
              placeholder={modelsLoading ? "Loading models…" : "Choose model"}
              className="h-7 min-w-0 max-w-44 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent"
            />
            <ThinkingLevelSelect
              levels={
                selectedModel(modelConnections, modelSelection)?.thinkingLevels ?? ["off"]
              }
              value={thinkingLevel}
              onChange={setThinkingLevel}
              disabled={active || modelsLoading}
              className="h-7 min-w-0 max-w-36 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent"
            />
          </div>
        }
      />
      {modelConnections.length === 0 && !modelsLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Add a model connection in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>{" "}
          before continuing.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
