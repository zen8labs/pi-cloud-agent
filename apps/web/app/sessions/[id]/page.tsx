"use client";

import type { ConfigResponse, RunDetail, RunEvent } from "@pi-cloud-agent/protocol";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ChatComposer } from "@/components/ChatComposer";
import { StatusBadge } from "@/components/StatusBadge";
import { API_BASE, api } from "@/lib/api";
import { absoluteTime, isActiveStatus } from "@/lib/format";
import { useRun } from "@/lib/useRun";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { run, events, error } = useRun(id);
  const [cancelling, setCancelling] = useState(false);

  const active = run ? isActiveStatus(run.status) : false;

  const onCancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await api.cancelRun(run.id);
    } catch {
      // The next status frame reports the real outcome.
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--color-canvas)" }}>
      <SessionHeader run={run} active={active} cancelling={cancelling} onCancel={onCancel} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="conversation-shell">
              {error && !run ? (
                <div className="mt-10 border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-xs text-red-400">
                  {error}
                </div>
              ) : (
                <ActivityFeed
                  events={events}
                  userPrompt={run?.prompt ?? null}
                  active={active}
                />
              )}
            </div>
          </div>

          {run && (
            <div className="composer-dock">
              <div className="conversation-shell pb-4">
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
        </div>

        <SessionAside run={run} id={id} />
      </div>
    </div>
  );
}

function sessionTitle(run: RunDetail | null): string {
  if (!run) return "Session";
  if (run.prompt) return truncate(run.prompt, 72);
  return `${run.profile} · ${run.repo}`;
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
    <header className="flex items-center gap-3 border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-5 py-3">
      <Link
        href="/"
        className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-strong)] text-[var(--color-faint)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
        title="Back to sessions"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[13px] font-semibold text-[var(--color-ink)]">
          {sessionTitle(run)}
        </h1>
        {run && (
          <p className="truncate font-mono text-[10px] text-[var(--color-faint)]">
            {run.repo}
            {run.prNumber !== null ? ` · PR #${run.prNumber}` : ""}
            {` · ${run.id.slice(0, 8)}`}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {active && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="border border-red-500/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-red-400 transition-colors hover:bg-red-500/8 disabled:opacity-40"
          >
            {cancelling ? "Stopping…" : "Cancel"}
          </button>
        )}
        {run && <StatusBadge status={run.status} />}
      </div>
    </header>
  );
}

function SessionAside({ run, id }: { run: RunDetail | null; id: string }) {
  const prUrl =
    run && run.prNumber !== null ? `https://github.com/${run.repo}/pull/${run.prNumber}` : null;

  return (
    <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-[var(--color-line-strong)] bg-[var(--color-surface)] lg:block">
      <Section title="Details">
        <Row label="Status" value={run ? <StatusBadge status={run.status} /> : "—"} />
        <Row label="Profile" value={run?.profile ?? "—"} mono />
        <Row label="Model" value={run?.model ?? "—"} mono />
        <Row label="Repo" value={run?.repo ?? "—"} mono />
        <Row label="Provider" value={run?.provider ?? "—"} />
        <Row label="Run" value={run ? run.id.slice(0, 8) : "—"} mono />
        <Row label="Created" value={run ? absoluteTime(run.createdAt) : "—"} />
      </Section>

      {prUrl && run && (
        <Section title="Pull request">
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-[var(--color-blue)] hover:underline"
          >
            #{run.prNumber} on GitHub ↗
          </a>
        </Section>
      )}

      {run?.error && (
        <Section title="Error">
          <pre className="whitespace-pre-wrap break-words border border-red-500/30 bg-red-500/8 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-red-400">
            {run.error}
          </pre>
        </Section>
      )}

      <Section title="Raw stream">
        <a
          href={`${API_BASE}/runs/${id}/stream`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] text-[var(--color-blue)] hover:underline"
        >
          GET /runs/{id.slice(0, 8)}…/stream ↗
        </a>
      </Section>
    </aside>
  );
}

/**
 * Follow-ups start a new run carrying the previous exchange in the prompt.
 *
 * A run is one sandbox and one session, so there is nothing to resume — and
 * pretending otherwise would mean keeping a machine alive between messages.
 * Replaying the transcript is honest about what is actually happening.
 */
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
      const run = await api.createRun({
        repo,
        profile,
        prompt: buildFollowUpPrompt(previousPrompt, previousEvents, prompt.trim()),
      });
      router.push(`/sessions/${run.id}`);
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
        placeholder={active ? "Waiting for the agent to finish…" : `Follow up on ${repo}…`}
        model={config?.model}
        submitLabel="Start session"
        submitting={submitting}
        disabled={active}
      />
      {error && <p className="mt-2 font-mono text-[11px] text-red-400">{error}</p>}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--color-line)] px-4 py-4 last:border-b-0">
      <h3 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-faint)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-[var(--color-faint)]">{label}</span>
      <span
        className={`truncate text-right text-[11px] text-[var(--color-ink)] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
