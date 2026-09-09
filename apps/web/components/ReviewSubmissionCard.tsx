"use client";

import type { GithubReviewSubmission } from "@pi-cloud-agent/protocol";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  MessageSquareQuoteIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { GithubMarkIcon } from "@/components/ProviderIcons";
import { cn } from "@/lib/utils";

export function ReviewSubmissionCard({
  submission,
  status,
  onOpenChanges,
}: {
  submission: GithubReviewSubmission;
  status: string;
  onOpenChanges?: (path: string) => void;
}) {
  const failed = status === "error";
  const pending = status !== "completed" && !failed;
  const statusLabel = failed
    ? "Publication failed"
    : pending
      ? "Submitting review"
      : "Published";

  return (
    <article className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm">
      <header className="flex items-start justify-between gap-4 border-b border-border/70 bg-muted/20 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/80 bg-background text-foreground/80">
            <GithubMarkIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-sm font-semibold text-foreground">GitHub review</h2>
              <span className="text-xs text-muted-foreground">
                {submission.comments.length === 0
                  ? "Overall feedback"
                  : `${submission.comments.length} inline ${submission.comments.length === 1 ? "finding" : "findings"}`}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{statusLabel}</p>
          </div>
        </div>
        <StatusIcon failed={failed} pending={pending} />
      </header>

      <div className="px-4 py-4">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <MessageSquareQuoteIcon className="size-3.5" />
          Summary & feedback
        </div>
        <div className="text-[13px] leading-6 text-foreground/90 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_li]:my-1 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_p]:my-2 [&_ul]:my-2">
          <MessageResponse>{submission.body}</MessageResponse>
        </div>
      </div>

      {submission.comments.length > 0 ? (
        <section className="border-t border-border/70 bg-muted/10">
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <FileCode2Icon className="size-3.5" />
              Inline feedback
            </div>
            <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
              {submission.comments.length}
            </span>
          </div>
          <div className="space-y-2 px-3 pb-3">
            {submission.comments.map((comment, index) => (
              <InlineCommentCard
                key={`${comment.path}:${comment.startLine ?? comment.line}:${comment.line}:${comment.side}:${comment.body}`}
                comment={comment}
                index={index}
                onOpenChanges={onOpenChanges}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="flex items-center gap-2 border-t border-border/70 bg-muted/10 px-4 py-3 text-xs text-muted-foreground">
          <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          No inline findings in this review.
        </div>
      )}
    </article>
  );
}

function StatusIcon({ failed, pending }: { failed: boolean; pending: boolean }) {
  if (failed)
    return <AlertCircleIcon className="size-4 shrink-0 text-[var(--status-failed)]" />;
  if (pending) {
    return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />;
  }
  return (
    <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  );
}

function InlineCommentCard({
  comment,
  index,
  onOpenChanges,
}: {
  comment: GithubReviewSubmission["comments"][number];
  index: number;
  onOpenChanges?: (path: string) => void;
}) {
  const lineLabel =
    comment.startLine && comment.startLine !== comment.line
      ? `Lines ${comment.startLine}–${comment.line}`
      : `Line ${comment.line}`;
  const sideLabel = comment.side === "LEFT" ? "old" : "new";

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-2 text-[11px]">
        <span className="grid size-5 shrink-0 place-items-center rounded border border-border/80 text-muted-foreground">
          <ChevronRightIcon className="size-3" />
        </span>
        {onOpenChanges ? (
          <button
            type="button"
            onClick={() => onOpenChanges(comment.path)}
            className="min-w-0 truncate font-mono text-left text-foreground/85 underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/50"
            title={`Open changes for ${comment.path}`}
          >
            {comment.path}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-foreground/85">{comment.path}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-muted-foreground">
          {lineLabel} · {sideLabel}
        </span>
      </div>
      <div className="border-l-2 border-orange-400/80 px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          <span className="text-orange-500">#{index + 1}</span>
          Code comment
        </div>
        <div
          className={cn(
            "text-[13px] leading-5 text-foreground/90",
            "[&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono",
          )}
        >
          <MessageResponse>{comment.body}</MessageResponse>
        </div>
      </div>
    </div>
  );
}
