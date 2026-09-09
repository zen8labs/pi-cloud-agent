import { z } from "zod";

export const githubReviewCommentSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  line: z.number().int().positive().max(1_000_000),
  side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
  startLine: z.number().int().positive().max(1_000_000).optional(),
  startSide: z.enum(["RIGHT", "LEFT"]).optional(),
  body: z.string().trim().min(1).max(10_000),
});

export type GithubReviewComment = z.infer<typeof githubReviewCommentSchema>;

export const githubReviewSubmissionSchema = z.object({
  /** Markdown body containing the PR summary and overall feedback. */
  body: z.string().trim().min(1).max(60_000),
  comments: z.array(githubReviewCommentSchema).max(100).default([]),
});

export type GithubReviewSubmission = z.infer<typeof githubReviewSubmissionSchema>;

export const githubReviewContextSchema = z.object({
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  pullNumber: z.number().int().positive(),
  headSha: z.string().min(1).max(200),
});

export type GithubReviewContext = z.infer<typeof githubReviewContextSchema>;
