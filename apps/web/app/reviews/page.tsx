"use client";

import type { PullRequestReview, PullRequestReviewsResponse } from "@pi-cloud-agent/protocol";
import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const LABELS: Record<PullRequestReview["status"], string> = {
  not_reviewed: "Not reviewed",
  skipped: "Skipped",
  received: "Received",
  queued: "Queued",
  starting: "Starting",
  reviewing: "Reviewing",
  publishing: "Publishing",
  reviewed: "Reviewed",
  outdated: "Outdated",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function ReviewsPage() {
  const [data, setData] = useState<PullRequestReviewsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api.listReviews();
      if (current === generation.current) {
        setData(next);
        setError(null);
      }
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="app-header flex h-12 shrink-0 items-center justify-between px-5">
        <h1 className="text-[13px] font-medium">Reviews</h1>
        <Link
          href="/settings?tab=repositories"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Repository settings
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-medium tracking-[-0.02em]">Open pull requests</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                PRs from your connected repositories, including those without a review.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : ""} />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error} {data && "Showing the previous results."}
            </p>
          )}
          {data?.problems.map((problem) => (
            <p key={problem} role="alert" className="mb-3 text-sm text-destructive">
              {problem}
            </p>
          ))}
          {!data && loading && (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              Loading pull requests from GitHub…
            </p>
          )}
          {data && data.pullRequests.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
              <GitPullRequestIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm">
                {data.problems.length
                  ? "Pull requests could not be fully loaded."
                  : "No open pull requests."}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Enable auto-review in repository settings, then open a non-draft PR or push a
                new commit.
              </p>
            </div>
          )}
          {Boolean(data?.pullRequests.length) && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_6rem] gap-6 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground sm:grid">
                <span>Pull request</span>
                <span>Review status</span>
                <span className="text-right">Session</span>
              </div>
              <ul className="divide-y divide-border">
                {data?.pullRequests.map((pr) => (
                  <ReviewRow key={`${pr.repo}:${pr.number}`} pr={pr} />
                ))}
              </ul>
            </div>
          )}
          {data && (
            <p className="mt-4 text-xs text-muted-foreground">
              Last fetched{" "}
              {new Date(data.fetchedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              . Refresh to check for updates.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ pr }: { pr: PullRequestReview }) {
  const color =
    pr.status === "failed"
      ? "text-destructive"
      : pr.status === "reviewed"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-foreground";
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_6rem] sm:gap-6">
      <div className="min-w-0">
        <a
          href={`https://github.com/${pr.repo}/pull/${pr.number}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {pr.title}
        </a>
        <p className="mt-1.5 break-all text-xs text-muted-foreground">
          {pr.repo} #{pr.number} <span className="mx-1">·</span> {pr.headSha.slice(0, 7)}
        </p>
      </div>
      <div className="min-w-0">
        {pr.reviewUrl ? (
          <a
            href={pr.reviewUrl}
            target="_blank"
            rel="noreferrer"
            className={`text-xs font-medium hover:underline ${color}`}
          >
            {LABELS[pr.status]}
          </a>
        ) : (
          <span className={`text-xs font-medium ${color}`}>{LABELS[pr.status]}</span>
        )}
        <p className="mt-1 text-xs leading-5 text-muted-foreground break-words">{pr.detail}</p>
      </div>
      <div className="sm:text-right">
        {pr.sessionId ? (
          <Link
            href={`/sessions/${pr.sessionId}`}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            View session
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </li>
  );
}
