"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ACTIVE_STATUSES, relativeTime } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import type { RunStatus, RunSummary } from "@/lib/types";

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
    if (filter === "active")
      return runs.filter((r) => ACTIVE_STATUSES.includes(r.status));
    return runs.filter((r) => r.status === (filter as RunStatus));
  }, [runs, filter]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-7 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Background PR reviews and manual agent runs.
          </p>
        </div>
        <Link
          href="/chat"
          className="rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          New session
        </Link>
      </header>

      <div className="mb-4 flex items-center gap-1">
        {(["all", "active", "succeeded", "failed"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
              filter === f
                ? "bg-[var(--color-ink)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-line)]"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn&apos;t reach the controller at the API base — {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
        {runs === null ? (
          <SkeletonRows />
        ) : filtered.length === 0 ? (
          <Empty />
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {filtered.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/sessions/${r.id}`}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--color-canvas)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{r.repo}</span>
                      {r.pr_number != null && (
                        <span className="shrink-0 rounded bg-[var(--color-line)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-muted)]">
                          PR #{r.pr_number}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-faint)]">
                      <span>{r.bundle === "pr_review" ? "PR review" : "Agent task"}</span>
                      <span>·</span>
                      <span className="font-mono">{r.id.slice(0, 8)}</span>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-[var(--color-faint)]">
                    {relativeTime(r.created_at)}
                  </span>
                  <StatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="h-3.5 w-40 animate-pulse rounded bg-[var(--color-line)]" />
            <div className="mt-2 h-2.5 w-24 animate-pulse rounded bg-[var(--color-line)]" />
          </div>
          <div className="h-5 w-20 animate-pulse rounded-full bg-[var(--color-line)]" />
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return (
    <div className="px-5 py-16 text-center">
      <p className="text-sm text-[var(--color-muted)]">No sessions yet.</p>
      <Link href="/chat" className="mt-2 inline-block text-sm font-medium text-[var(--color-accent)]">
        Start one →
      </Link>
    </div>
  );
}
