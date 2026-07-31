"use client";

import type { ConfigResponse, RunDetail, RunEvent } from "@pi-cloud-agent/protocol";
import { ArrowLeftIcon, ExternalLinkIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ChatComposer } from "@/components/ChatComposer";
import { StatusBadge } from "@/components/StatusBadge";
import { API_BASE, api } from "@/lib/api";
import { absoluteTime, isActiveStatus } from "@/lib/format";
import { saveSessionTitle } from "@/lib/session-titles";
import { useRun } from "@/lib/useRun";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { run, events, error } = useRun(id);
  const [cancelling, setCancelling] = useState(false);
  const active = run ? isActiveStatus(run.status) : false;

  const cancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await api.cancelRun(run.id);
    } catch {
      /* The stream reports the durable outcome. */
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SessionHeader run={run} active={active} cancelling={cancelling} onCancel={cancel} />
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {error && !run ? (
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
                <ActivityFeed
                  events={events}
                  userPrompt={displayPrompt(run?.prompt ?? null)}
                  active={active}
                />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          )}
          {run && (
            <div className="border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
              <div className="mx-auto max-w-3xl">
                <FollowUp
                  repo={run.repo}
                  profile={run.profile}
                  active={active}
                  previousPrompt={run.prompt}
                  previousEvents={events}
                />
              </div>
            </div>
          )}
        </section>
        <SessionAside run={run} id={id} />
      </div>
    </div>
  );
}

function SessionHeader({
  run,
  active,
  cancelling,
  onCancel,
}: {
  run: RunDetail | null;
  active: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
      <Link
        href="/"
        aria-label="Back to sessions"
        className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">{sessionTitle(run)}</h1>
        {run && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {run.repo}
            {run.prNumber !== null ? ` · PR #${run.prNumber}` : ""} ·{" "}
            <span className="font-mono">{run.id.slice(0, 8)}</span>
          </p>
        )}
      </div>
      {active && (
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <SquareIcon className="size-3" /> {cancelling ? "Stopping…" : "Cancel"}
        </button>
      )}
      {run && <StatusBadge status={run.status} />}
    </header>
  );
}

function SessionAside({ run, id }: { run: RunDetail | null; id: string }) {
  const prUrl =
    run?.prNumber !== null && run
      ? `https://github.com/${run.repo}/pull/${run.prNumber}`
      : null;
  return (
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border bg-card/50 xl:block">
      <div className="border-b border-border px-5 py-5">
        <h2 className="text-sm font-medium">Details</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          The durable metadata for this run.
        </p>
      </div>
      <dl className="space-y-4 px-5 py-5">
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
        <Detail label="Created">{run ? absoluteTime(run.createdAt) : "—"}</Detail>
      </dl>
      {prUrl && <AsideLink href={prUrl}>Pull request #{run?.prNumber}</AsideLink>}
      <AsideLink href={`${API_BASE}/runs/${id}/stream`}>Raw event stream</AsideLink>
      {run?.error && (
        <div className="border-t border-border px-5 py-5">
          <h3 className="text-xs font-medium text-destructive">Error</h3>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-destructive/10 p-3 font-mono text-xs leading-5 text-destructive">
            {run.error}
          </pre>
        </div>
      )}
    </aside>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xs text-foreground">{children}</dd>
    </div>
  );
}

function AsideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between border-t border-border px-5 py-4 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      {children}
      <ExternalLinkIcon className="size-3.5" />
    </a>
  );
}

/** Transport seam for multi-turn sessions. It can switch from replay to Pi session resume without changing the composer. */
function FollowUp({
  repo,
  profile,
  active,
  previousPrompt,
  previousEvents,
}: {
  repo: string;
  profile: string;
  active: boolean;
  previousPrompt: string | null;
  previousEvents: RunEvent[];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const submit = async () => {
    if (active || submitting || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const nextRun = await api.createRun({
        repo,
        profile,
        prompt: buildFollowUpPrompt(previousPrompt, previousEvents, prompt.trim()),
      });
      saveSessionTitle(nextRun.id, prompt.trim());
      router.push(`/sessions/${nextRun.id}`);
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
        model={config?.model}
        submitLabel="Start session"
        submitting={submitting}
        disabled={active}
        compact
      />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function buildFollowUpPrompt(
  previousPrompt: string | null,
  previousEvents: RunEvent[],
  next: string,
): string {
  const assistant = previousEvents
    .filter((event) => event.type === "token")
    .map((event) => String(event.data.content ?? ""))
    .join("")
    .trim();
  const parts: string[] = [];
  if (previousPrompt || assistant) {
    parts.push("--- Previous conversation ---");
    if (previousPrompt) parts.push(`User: ${previousPrompt}`);
    if (assistant) parts.push(`Assistant: ${assistant}`);
    parts.push("--- End of previous conversation ---", "");
  }
  parts.push(`Follow-up: ${next}`);
  return parts.join("\n");
}

function sessionTitle(run: RunDetail | null): string {
  if (!run) return "Session";
  const prompt = displayPrompt(run.prompt);
  if (!prompt) return `${run.profile} · ${run.repo}`;
  return prompt.length > 76 ? `${prompt.slice(0, 76)}…` : prompt;
}

function displayPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  const marker = "\nFollow-up: ";
  const index = prompt.lastIndexOf(marker);
  return index === -1 ? prompt : prompt.slice(index + marker.length);
}
