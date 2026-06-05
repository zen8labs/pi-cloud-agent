"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { useRun } from "@/lib/useRun";
import { ACTIVE_STATUSES, absoluteTime } from "@/lib/format";
import type { AppConfig } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ChatComposer } from "@/components/ChatComposer";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { run, events, error } = useRun(id);
  const [cancelling, setCancelling] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const active = run ? ACTIVE_STATUSES.includes(run.status) : false;

  const onCancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await api.cancelRun(run.id);
    } catch {
      /* surfaced on next poll */
    } finally {
      setCancelling(false);
    }
  };

  const prUrl =
    run && run.pr_number != null
      ? `https://github.com/${run.repo}/pull/${run.pr_number}`
      : null;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-3.5">
        <Link
          href="/"
          className="text-sm text-[var(--color-faint)] transition-colors hover:text-[var(--color-ink)]"
        >
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {run ? (run.prompt ? truncate(run.prompt, 70) : `${run.bundle} · ${run.repo}`) : "Session"}
          </h1>
          {run && (
            <p className="truncate text-xs text-[var(--color-faint)]">
              {run.repo}
              {run.pr_number != null ? ` · PR #${run.pr_number}` : ""}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowLogs((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            showLogs
              ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              : "border-[var(--color-line-strong)] text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
          }`}
          title="Show raw OpenCode server logs"
        >
          {showLogs ? "Hide logs" : "Show logs"}
        </button>
        {run && <StatusBadge status={run.status} />}
        {active && (
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="rounded-lg border border-[var(--color-line-strong)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-canvas)] disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Activity timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="conversation-shell">
              {error && !run ? (
                <div className="mt-10">
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                </div>
              ) : (
                <ActivityFeed
                  events={events}
                  userPrompt={run?.prompt ?? null}
                  active={active}
                  showLogs={showLogs}
                />
              )}
            </div>
          </div>

          {run && (
            <div className="composer-dock">
              <div className="conversation-shell pb-4">
                <SessionComposer
                  repo={run.repo}
                  bundle={run.bundle}
                  active={active}
                />
              </div>
            </div>
          )}
        </div>

        {/* Metadata sidebar */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-6 lg:block">
          <Section title="Details">
            <Row label="Status" value={run ? <StatusBadge status={run.status} /> : "—"} />
            <Row label="Bundle" value={run?.bundle ?? "—"} mono />
            <Row label="Repo" value={run?.repo ?? "—"} mono />
            <Row label="Provider" value={run?.provider ?? "—"} />
            <Row label="Run ID" value={run ? run.id.slice(0, 8) : "—"} mono />
            <Row label="Created" value={run ? absoluteTime(run.created_at) : "—"} />
          </Section>

          {prUrl && (
            <Section title="Pull request">
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-[var(--color-accent)] hover:underline"
              >
                #{run!.pr_number} on GitHub ↗
              </a>
            </Section>
          )}

          {run && run.findings.length > 0 && (
            <Section title={`Findings (${run.findings.length})`}>
              <ul className="flex flex-col gap-2">
                {run.findings.map((f, i) => (
                  <li key={i} className="text-xs">
                    <div className="flex items-center gap-1.5">
                      <span>
                        {f.severity === "blocker" ? "🛑" : f.severity === "warning" ? "⚠️" : "💡"}
                      </span>
                      <span className="font-medium">{f.title}</span>
                    </div>
                    <div className="ml-5 font-mono text-[11px] text-[var(--color-faint)]">
                      {f.file}
                      {f.line != null ? `:${f.line}` : ""}
                      {f.published ? " · published" : f.grounded ? " · grounded" : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {run?.error && (
            <Section title="Error">
              <p className="rounded-md bg-red-50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-red-700">
                {run.error}
              </p>
            </Section>
          )}

          <Section title="Raw stream">
            <a
              href={`${API_BASE}/runs/${id}/stream`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-[var(--color-accent)] hover:underline"
            >
              GET /runs/{id.slice(0, 8)}…/stream ↗
            </a>
          </Section>
        </aside>
      </div>

    </div>
  );
}

function SessionComposer({
  repo,
  bundle,
  active,
}: {
  repo: string;
  bundle: string;
  active: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const submit = async () => {
    if (active || submitting || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun({
        repo,
        bundle,
        prompt: prompt.trim(),
      });
      router.push(`/sessions/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div>
      <ChatComposer
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder={
          active
            ? "Waiting for the agent to finish…"
            : `Message ${repo}…`
        }
        model={config?.model}
        submitLabel="Start session"
        submitting={submitting}
        disabled={active}
      />
      {error && (
        <p className="mt-2 text-center text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
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
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      <span className="text-[var(--color-faint)]">{label}</span>
      <span className={`truncate text-right text-[var(--color-ink)] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
