"use client";

import type { RunDetail, SessionDetail } from "@pi-cloud-agent/protocol";
import { ArrowLeftIcon, PanelRightIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ChatComposer } from "@/components/ChatComposer";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { absoluteTime } from "@/lib/format";
import { useSession } from "@/lib/useSession";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { session, turns, error, refresh } = useSession(id);
  const [cancelling, setCancelling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const latest = turns.at(-1)?.run ?? null;
  const active = session ? session.status !== "idle" : false;

  useEffect(() => {
    try {
      setDetailsOpen(localStorage.getItem("pca-details-open") !== "0");
    } catch {
      // Storage unavailable: keep the panel visible.
    }
  }, []);
  const toggleDetails = () =>
    setDetailsOpen((current) => {
      try {
        localStorage.setItem("pca-details-open", current ? "0" : "1");
      } catch {
        // Persisting is best-effort.
      }
      return !current;
    });

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
          run={latest}
          active={active}
          cancelling={cancelling}
          onCancel={cancel}
          detailsOpen={detailsOpen}
          onToggleDetails={toggleDetails}
        />
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
            <div className="bg-background/95 px-4 pb-5 pt-2 backdrop-blur sm:px-6">
              <div className="mx-auto max-w-3xl">
                <FollowUp
                  sessionId={session.id}
                  repo={session.repo}
                  active={active}
                  onQueued={refresh}
                />
              </div>
            </div>
          )}
        </section>
      </div>
      {detailsOpen && <SessionAside session={session} run={latest} />}
    </div>
  );
}

function SessionHeader({
  session,
  run,
  active,
  cancelling,
  onCancel,
  detailsOpen,
  onToggleDetails,
}: {
  session: SessionDetail | null;
  run: RunDetail | null;
  active: boolean;
  cancelling: boolean;
  onCancel: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 px-3 sm:px-4">
      <Link
        href="/"
        aria-label="Back to sessions"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[13px] font-medium">{session?.title ?? "Session"}</h1>
        {session && run && (
          <p className="mt-px truncate text-[11px] text-muted-foreground">
            {session.repo} · turn {run.turnNumber ?? 1} ·{" "}
            <span className="font-mono">{session.id.slice(0, 8)}</span>
          </p>
        )}
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
      {run && <StatusBadge status={run.status} />}
      <button
        type="button"
        onClick={onToggleDetails}
        aria-label={detailsOpen ? "Hide details" : "Show details"}
        className="hidden size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground xl:grid"
      >
        <PanelRightIcon className="size-4" />
      </button>
    </header>
  );
}

function SessionAside({
  session,
  run,
}: {
  session: SessionDetail | null;
  run: RunDetail | null;
}) {
  return (
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border xl:block">
      <div className="flex h-12 items-center border-b border-border px-4">
        <h2 className="text-[13px] font-medium">Details</h2>
      </div>
      <dl className="divide-y divide-border/60 px-4">
        <Detail label="Status">{run ? <StatusBadge status={run.status} /> : "—"}</Detail>
        <Detail label="Profile">
          <span className="font-mono">{run?.profile ?? "—"}</span>
        </Detail>
        <Detail label="Model">
          <span className="font-mono break-all">{run?.model ?? "—"}</span>
        </Detail>
        <Detail label="Repository">
          <span className="font-mono break-all">{run?.repo ?? "—"}</span>
        </Detail>
        <Detail label="Sandbox">{run?.provider ?? "—"}</Detail>
        <Detail label="Workspace">
          {session?.workspaceAvailable ? "Preserved" : "Cold next turn"}
        </Detail>
        <Detail label="Created">{run ? absoluteTime(run.createdAt) : "—"}</Detail>
      </dl>
      {run?.error && (
        <div className="border-t border-border px-4 py-4">
          <h3 className="text-xs font-medium text-destructive">Error</h3>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 font-mono text-[11px] leading-5 text-destructive">
            {run.error}
          </pre>
        </div>
      )}
    </aside>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-foreground">{children}</dd>
    </div>
  );
}

/** Transport seam for multi-turn sessions. It can switch from replay to Pi session resume without changing the composer. */
function FollowUp({
  sessionId,
  repo,
  active,
  onQueued,
}: {
  sessionId: string;
  repo: string;
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
      />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
