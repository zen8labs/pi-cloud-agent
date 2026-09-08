import { z } from "zod";

export const reviewRepositoryRequestSchema = z.object({
  installationId: z.string().regex(/^\d+$/),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  autoReview: z.boolean(),
});

export type ReviewRepositoryRequest = z.infer<typeof reviewRepositoryRequestSchema>;

export interface ReviewRepository {
  installationId: string;
  repo: string;
  autoReview: boolean;
  /** A concrete reason enabling reviews is blocked, never a health score. */
  problem: string | null;
}

export interface ReviewRepositoriesResponse {
  repositories: ReviewRepository[];
  installUrl: string | null;
  problem: string | null;
}

export interface PullRequestReview {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  updatedAt: string;
  status:
    | "not_reviewed"
    | "skipped"
    | "received"
    | "queued"
    | "starting"
    | "reviewing"
    | "publishing"
    | "reviewed"
    | "outdated"
    | "failed"
    | "cancelled";
  detail: string;
  sessionId: string | null;
  reviewUrl: string | null;
}

export interface PullRequestReviewsResponse {
  pullRequests: PullRequestReview[];
  /** Partial GitHub failures remain visible alongside successful results. */
  problems: string[];
  fetchedAt: string;
}
