import type { PullRequestReview, ReviewRepository } from "@pi-cloud-agent/protocol";
import type { GithubOpenPull } from "@pi-cloud-agent/vcs";
import type { reviewEvidence } from "../db/reviews";

type Evidence = Awaited<ReturnType<typeof reviewEvidence>>;

/** Publication is the outcome; run success alone never means a published review. */
export function summarizeReview(
  repo: ReviewRepository,
  pull: GithubOpenPull,
  evidence: Evidence,
): PullRequestReview {
  const attempts = evidence.attempts.filter(
    ({ run }) => run.trigger.repo.prNumber === pull.number,
  );
  const attempt =
    attempts.find(({ run }) => run.trigger.repo.headSha === pull.head.sha) ??
    attempts.sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime())[0];
  const delivery = evidence.deliveries.find(
    (item) => Number(item.number) === pull.number && item.headSha === pull.head.sha,
  );
  const result: PullRequestReview = {
    repo: repo.repo,
    number: pull.number,
    title: pull.title,
    headSha: pull.head.sha,
    updatedAt: pull.updated_at,
    status: "not_reviewed",
    detail: "No webhook received for this commit.",
    sessionId: attempt?.run.sessionId ?? null,
    reviewUrl: null,
  };
  if (attempt?.run.trigger.repo.headSha === pull.head.sha) {
    return { ...result, ...attemptStatus(attempt) };
  }
  if (pull.draft)
    return {
      ...result,
      status: "skipped",
      detail: "Draft PR — reviews start when marked ready.",
    };
  if (repo.problem) return { ...result, status: "failed", detail: repo.problem };
  if (!repo.autoReview)
    return { ...result, status: "skipped", detail: "Auto-review is off for this repository." };
  if (delivery) {
    if (delivery.status === "failed")
      return {
        ...result,
        status: "failed",
        detail: deliveryFailureDetail(delivery.reason, delivery.deliveryId),
      };
    if (delivery.status === "ignored")
      return {
        ...result,
        status: "skipped",
        detail: delivery.reason ?? "Event did not request a review.",
      };
    if (delivery.status === "processed")
      return {
        ...result,
        detail: "Event processed; its review session is no longer available.",
      };
    return {
      ...result,
      status: "received",
      detail: "Webhook received; waiting to queue the review.",
    };
  }
  if (attempt)
    return {
      ...result,
      status: "outdated",
      detail: `Last attempt was for ${attempt.run.trigger.repo.headSha?.slice(0, 7)}. No webhook received for this commit.`,
    };
  return result;
}

function attemptStatus({
  run,
  publication,
}: Evidence["attempts"][number]): Pick<PullRequestReview, "status" | "detail" | "reviewUrl"> {
  const state = (status: PullRequestReview["status"], detail: string) => ({
    status,
    detail,
    reviewUrl: null,
  });
  if (publication?.status === "published")
    return {
      status: "reviewed",
      detail: `Published for ${run.trigger.repo.headSha?.slice(0, 7)}.`,
      reviewUrl: `https://github.com/${run.repoFullName}/pull/${run.trigger.repo.prNumber}#pullrequestreview-${publication.githubReviewId}`,
    };
  if (publication?.status === "failed")
    return state(
      "failed",
      "Review generated, but publishing to GitHub failed. Open the session for details.",
    );
  if (publication?.status === "uncertain")
    return state(
      "failed",
      "GitHub may have accepted the review, but publication could not be confirmed. Inspect GitHub before retrying.",
    );
  if (run.status === "failed")
    return state("failed", run.error || "Review failed. Open the session for details.");
  if (run.status === "cancelled") return state("cancelled", "Review cancelled.");
  if (publication?.status === "processing")
    return state("publishing", "Posting the review to GitHub.");
  if (run.status === "queued")
    return state("queued", "Webhook accepted; waiting for an available worker.");
  if (run.status === "provisioning")
    return state("starting", "Starting the environment and preparing the repository.");
  if (run.status === "running")
    return state("reviewing", "Review in progress. Open the session to follow along.");
  return state("failed", "Session ended without a published review.");
}

function deliveryFailureDetail(reason: string | null, deliveryId: string): string {
  if (reason?.startsWith("connect a model") || reason?.includes("thinking is not available"))
    return `Webhook processing failed: ${reason}`;
  return `Webhook processing failed. Delivery ${deliveryId}; the operator can use this ID to find the controller error.`;
}
