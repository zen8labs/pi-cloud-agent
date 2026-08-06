"use client";

import type { RunDetail, SessionDetail } from "@pi-cloud-agent/protocol";
import { ArrowLeftIcon, GitBranchIcon, SquareIcon, WaypointsIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ChatComposer } from "@/components/ChatComposer";
import { AzureDevOpsMarkIcon, GithubMarkIcon } from "@/components/ProviderIcons";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { absoluteTime } from "@/lib/format";
import { resolveBranch, summarizeChanges } from "@/lib/session-meta";
import { useSession } from "@/lib/useSession";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { session, turns, error, refresh } = useSession(id);
  const [cancelling, setCancelling] = useState(false);
  const latest = turns.at(-1)?.run ?? null;
  const active = session ? session.status !== "idle" : false;
  const allEvents = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
  const changes = useMemo(() => summarizeChanges(allEvents), [allEvents]);
  const branch = useMemo(
    () => resolveBranch(latest?.branch ?? null, allEvents),
    [allEvents, latest?.branch],
  );

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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SessionHeader
        session={session}
        active={active}
        cancelling={cancelling}
        onCancel={cancel}
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
                  model={latest?.model ?? session.model}
                  active={active}
                  onQueued={refresh}
                />
              </div>
            </div>
          )}
        </section>
        <SessionMeta session={session} run={latest} branch={branch} changes={changes} />
      </div>
    </div>
  );
}

function SessionHeader({
  session,
  active,
  cancelling,
  onCancel,
}: {
  session: SessionDetail | null;
  active: boolean;
  cancelling: boolean;
  onCancel: () => void;
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
    </header>
  );
}

/**
 * Environment strip inside the chat window (not a page-level sidebar).
 * Auto-hides below xl so a future dedicated right rail can own that slot.
 */
function SessionMeta({
  session,
  run,
  branch,
  changes,
}: {
  session: SessionDetail | null;
  run: RunDetail | null;
  branch: string | null;
  changes: { files: { path: string }[]; added: number; removed: number };
}) {
  const repo = run?.repo ?? session?.repo ?? null;
  const provider = run?.provider ?? session?.provider ?? null;
  const profile = run?.profile ?? session?.profile ?? null;

  return (
    <div className="hidden w-60 shrink-0 overflow-y-auto px-4 pb-5 pt-4 xl:block">
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

        <ChangesLine added={changes.added} removed={changes.removed} />

        {profile ? <ProfileLine profile={profile} /> : null}

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

/** Title-case the profile slug and label it so "general" reads as an agent profile. */
function ProfileLine({ profile }: { profile: string }) {
  const label = profile
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return (
    <p
      className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
      title={`Agent profile: ${profile}`}
    >
      <WaypointsIcon className="size-3 shrink-0" />
      <span className="truncate">
        Profile · <span className="text-foreground">{label}</span>
      </span>
    </p>
  );
}

function ChangesLine({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return <p className="text-muted-foreground">No edits yet</p>;
  }
  return (
    <p className="font-mono tabular-nums text-foreground">
      <span className="text-muted-foreground">± Changes </span>
      {added > 0 ? (
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      ) : null}
      {added > 0 && removed > 0 ? <span> </span> : null}
      {removed > 0 ? <span className="text-red-600 dark:text-red-400">-{removed}</span> : null}
    </p>
  );
}

/** Transport seam for multi-turn sessions. It can switch from replay to Pi session resume without changing the composer. */
function FollowUp({
  sessionId,
  repo,
  model,
  active,
  onQueued,
}: {
  sessionId: string;
  repo: string;
  model: string;
  active: boolean;
  onQueued: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (active || submitting || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createSessionTurn(sessionId, prompt.trim());
      setPrompt("");
      await onQueued();
      setSubmitting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        submitting={submitting}
        disabled={active}
        compact
        tools={<ModelHint model={model} />}
      />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ModelHint({ model }: { model: string }) {
  const short = model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
  return (
    <span className="truncate px-1 text-[11px] text-muted-foreground" title={model}>
      {short}
    </span>
  );
}
