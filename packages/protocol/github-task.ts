import { z } from "zod";

export const githubCommentContextSchema = z.object({
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  issueNumber: z.number().int().positive(),
  commentId: z.string().min(1).max(200),
  commentAuthor: z.string().min(1).max(200).optional(),
  replyKind: z.enum(["issue_comment", "review_comment"]),
});

export type GithubCommentContext = z.infer<typeof githubCommentContextSchema>;

export const githubCommentSubmissionSchema = z.object({
  body: z.string().trim().min(1).max(60_000),
});

export type GithubCommentSubmission = z.infer<typeof githubCommentSubmissionSchema>;
