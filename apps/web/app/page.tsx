"use client";

import type { RunStatus, RunSummary } from "@pi-cloud-agent/protocol";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { isActiveStatus, relativeTime } from "@/lib/format";

type Filter = "all" | "active" | "succeeded" | "failed";

export default function SessionsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.listRuns();
        if (alive) {
          setRuns(r);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!runs) return [];
    if (filter === "all") return runs;
    if (filter === "active") return runs.filter((r) => isActiveStatus(r.status));
    return runs.filter((r) => r.status === (filter as RunStatus));
  }, [runs, filter]);

  const activeCount = runs ? runs.filter((r) => isActiveStatus(r.status)).length : 0;

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--color-canvas)" }}>
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-8 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Sessions</h1>
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5 border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/8 px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--color-accent)]">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-accent)]" />
              {activeCount} live
            </span>
          )}
        </div>
        <Link
          href="/chat"
          className="flex items-center gap-2 border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <span className="font-mono text-xs">+</span>
          New Session
        </Link>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center border-b border-[var(--color-line)] bg-[var(--color-surface)] px-6">
        {(["all", "active", "succeeded", "failed"] as Filter[]).map((f) => (
          <button
            type="button"
            key={f}
            onClick={() => setFilter(f)}
            className={`border-b-2 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
              filter === f
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-transparent text-[var(--color-faint)] hover:text-[var(--color-muted)]"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-8 mt-4 border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-xs text-red-400">
          ERROR: {error}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto" style={{ background: "var(--color-canvas)" }}>
        {/* Column headers */}
        <div className="flex items-center gap-4 border-b border-[var(--color-line)] px-6 py-2">
          <span className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
            Repository
          </span>
          <span className="w-24 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
            Type
          </span>
          <span className="w-20 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
            Run ID
          </span>
          <span className="w-28 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
            Status
          </span>
          <span className="w-16 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
            Time
          </span>
        </div>

        {runs === null ? (
          <SkeletonRows />
        ) : filtered.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <div className="divide-y divide-[var(--color-line)]">
            {filtered.map((r) => (
              <Link
                key={r.id}
                href={`/sessions/${r.id}`}
                className="flex items-center gap-4 px-6 py-3 transition-colors hover:bg-[var(--color-surface-2)]"
              >
                {/* Repository */}
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                    {r.repo}
                  </span>
                  {r.prNumber != null && (
                    <span className="shrink-0 border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                      PR #{r.prNumber}
                    </span>
                  )}
                </div>

                {/* Type */}
                <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wide text-[var(--color-faint)]">
                  {r.profile}
                </span>

                {/* Run ID */}
                <span className="w-20 shrink-0 font-mono text-[11px] text-[var(--color-faint)]">
                  {r.id.slice(0, 8)}
                </span>

                {/* Status */}
                <div className="w-28 shrink-0">
                  <StatusBadge status={r.status} />
                </div>

                {/* Time */}
                <span className="w-16 shrink-0 text-right font-mono text-[11px] text-[var(--color-faint)]">
                  {relativeTime(r.createdAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-surface)] px-8 py-2">
        <span className="font-mono text-[10px] text-[var(--color-faint)]">
          {runs !== null ? `${filtered.length} of ${runs.length} runs` : "loading…"}
        </span>
        <span className="font-mono text-[10px] text-[var(--color-faint)]">auto-refresh 3s</span>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-[var(--color-line)]">
      {Array.from({ length: 7 }, (_, index) => `skeleton-${index}`).map((key) => (
        <div key={key} className="flex items-center gap-4 px-6 py-3">
          <div className="min-w-0 flex-1 h-3.5 w-40 animate-pulse bg-[var(--color-surface-2)]" />
          <div className="w-24 h-3 animate-pulse bg-[var(--color-surface-2)]" />
          <div className="w-20 h-3 animate-pulse bg-[var(--color-surface-2)]" />
          <div className="w-28 h-4 animate-pulse bg-[var(--color-surface-2)]" />
          <div className="w-16 h-3 animate-pulse bg-[var(--color-surface-2)]" />
        </div>
      ))}
    </div>
  );
}

function Empty({ filter }: { filter: Filter }) {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
        No {filter === "all" ? "" : `${filter} `}sessions
      </p>
      <Link
        href="/chat"
        className="mt-4 border border-[var(--color-line-strong)] px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Start a session →
      </Link>
    </div>
  );
}
