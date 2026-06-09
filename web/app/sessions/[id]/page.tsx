"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { useRun } from "@/lib/useRun";
import { ACTIVE_STATUSES, absoluteTime } from "@/lib/format";
import type { AgentEvent, AppConfig } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { ActivityFeed, extractSubagents } from "@/components/ActivityFeed";
import type { SubagentSession } from "@/components/ActivityFeed";
import { ChatComposer } from "@/components/ChatComposer";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { run, events, error } = useRun(id);
  const [cancelling, setCancelling] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  const subagents: SubagentSession[] = useMemo(
    () => extractSubagents(events),
    [events],
  );

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
    <div className="flex h-screen flex-col" style={{ background: "var(--color-canvas)" }}>
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-5 py-3">
        <Link
          href="/"
          className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-strong)] text-[var(--color-faint)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
          title="Back to sessions"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </Link>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-semibold text-[var(--color-ink)]">
            {run ? (run.prompt ? truncate(run.prompt, 72) : `${run.bundle} · ${run.repo}`) : "Session"}
          </h1>
          {run && (
            <p className="truncate font-mono text-[10px] text-[var(--color-faint)]">
              {run.repo}
              {run.pr_number != null ? ` · PR #${run.pr_number}` : ""}
              {" · "}
              {run.id.slice(0, 8)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
              showLogs
                ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/8 text-[var(--color-accent)]"
                : "border-[var(--color-line-strong)] text-[var(--color-faint)] hover:text-[var(--color-muted)]"
            }`}
          >
            {showLogs ? "Hide Logs" : "Logs"}
          </button>

          {active && (
            <button
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

      <div className="flex min-h-0 flex-1">
        {/* Activity timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedSubagentId && (
            <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-2">
              <button
                onClick={() => setSelectedSubagentId(null)}
                className="font-mono text-[11px] text-[var(--color-accent)] hover:underline"
              >
                ← main
              </button>
              <span className="text-[var(--color-faint)]">/</span>
              <span className="truncate font-mono text-[11px] text-[var(--color-ink)]">
                {subagents.find((s) => s.sessionId === selectedSubagentId)?.description ?? "subagent"}
              </span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="conversation-shell">
              {error && !run ? (
                <div className="mt-10 border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-xs text-red-400">
                  ERROR: {error}
                </div>
              ) : (
                <ActivityFeed
                  events={events}
                  userPrompt={run?.prompt ?? null}
                  active={active}
                  showLogs={showLogs}
                  selectedSubagentId={selectedSubagentId}
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
                  previousPrompt={run.prompt}
                  previousEvents={events}
                />
              </div>
            </div>
          )}
        </div>

        {/* Metadata sidebar */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-[var(--color-line-strong)] bg-[var(--color-surface)] lg:block">
          <Section title="Details">
            <Row label="Status" value={run ? <StatusBadge status={run.status} /> : "—"} />
            <Row label="Agent" value={run?.bundle ?? "—"} mono />
            <Row label="Model" value={run?.model ?? "—"} mono />
            <Row label="Repo" value={run?.repo ?? "—"} mono />
            <Row label="Provider" value={run?.provider ?? "—"} />
            <Row label="Run ID" value={run ? run.id.slice(0, 8) : "—"} mono />
            <Row label="Created" value={run ? absoluteTime(run.created_at) : "—"} />
          </Section>

          {subagents.length > 0 && (
            <Section title={`Subagents (${subagents.length})`}>
              <div className="flex flex-col gap-px">
                {selectedSubagentId && (
                  <button
                    onClick={() => setSelectedSubagentId(null)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left font-mono text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
                  >
                    ← main session
                  </button>
                )}
                {subagents.map((sa) => (
                  <button
                    key={sa.sessionId}
                    onClick={() =>
                      setSelectedSubagentId(
                        selectedSubagentId === sa.sessionId ? null : sa.sessionId,
                      )
                    }
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] transition-colors ${
                      selectedSubagentId === sa.sessionId
                        ? "bg-[var(--color-accent)]/8 text-[var(--color-accent)] border-l border-[var(--color-accent)]"
                        : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
                    }`}
                  >
                    <span className="shrink-0">
                      {sa.status === "done" ? (
                        <span className="text-emerald-400">✓</span>
                      ) : (
                        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-blue)]" />
                      )}
                    </span>
                    <span className="truncate">{sa.description}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          {prUrl && (
            <Section title="Pull Request">
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-[var(--color-blue)] hover:underline"
              >
                #{run!.pr_number} on GitHub ↗
              </a>
            </Section>
          )}

          {run && run.findings.length > 0 && (
            <Section title={`Findings (${run.findings.length})`}>
              <div className="flex flex-col gap-1.5">
                {run.findings.map((f, i) => (
                  <div key={i} className="border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-2">
                    <div className="flex items-start gap-1.5">
                      <span className="mt-px shrink-0 font-mono text-[10px]">
                        {f.severity === "blocker" ? "!!" : f.severity === "warning" ? "!" : "·"}
                      </span>
                      <div>
                        <div className="text-[12px] font-medium text-[var(--color-ink)]">{f.title}</div>
                        {f.file && (
                          <div className="mt-0.5 font-mono text-[10px] text-[var(--color-faint)]">
                            {f.file}{f.line != null ? `:${f.line}` : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {run?.error && (
            <Section title="Error">
              <pre className="border border-red-500/30 bg-red-500/8 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-red-400 whitespace-pre-wrap break-words">
                {run.error}
              </pre>
            </Section>
          )}

          <Section title="Raw Stream">
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
      </div>
    </div>
  );
}

function buildFollowUpPrompt(
  previousPrompt: string | null,
  previousEvents: AgentEvent[],
  newPrompt: string,
): string {
  let assistantText = "";
  for (const e of previousEvents) {
    if (e.type === "token") {
      assistantText += String(e.data.content ?? "");
    }
  }
  assistantText = assistantText.trim();

  const parts: string[] = [];
  if (previousPrompt || assistantText) {
    parts.push("--- Previous conversation ---");
    if (previousPrompt) parts.push(`User: ${previousPrompt}`);
    if (assistantText) parts.push(`Assistant: ${assistantText}`);
    parts.push("--- End of previous conversation ---");
    parts.push("");
  }
  parts.push(`Follow-up: ${newPrompt}`);
  return parts.join("\n");
}

function SessionComposer({
  repo,
  bundle,
  active,
  previousPrompt,
  previousEvents,
}: {
  repo: string;
  bundle: string;
  active: boolean;
  previousPrompt: string | null;
  previousEvents: AgentEvent[];
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
      const fullPrompt = buildFollowUpPrompt(previousPrompt, previousEvents, prompt.trim());
      const run = await api.createRun({ repo, bundle, prompt: fullPrompt });
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
        placeholder={active ? "Waiting for agent to finish…" : `Follow up on ${repo}…`}
        model={config?.model}
        submitLabel="Start session"
        submitting={submitting}
        disabled={active}
      />
      {error && (
        <p className="mt-2 font-mono text-[11px] text-red-400">{error}</p>
      )}
    </div>
  );
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

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-[var(--color-faint)]">{label}</span>
      <span className={`truncate text-right text-[11px] text-[var(--color-ink)] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
