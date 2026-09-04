import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Reporter } from "./reporter";

type ReviewSide = "RIGHT" | "LEFT";
const reviewSideSchema = Type.Unsafe<ReviewSide>({
  type: "string",
  enum: ["RIGHT", "LEFT"],
});

/** Structured, controller-owned GitHub review publication. */
export function createGithubReviewTool(reporter: Reporter) {
  return defineTool({
    name: "submit_github_review",
    label: "Submit GitHub review",
    description:
      "Submit one pull-request review containing a Markdown summary and concrete inline findings. Use exactly once at the end of a GitHub code review.",
    parameters: Type.Object({
      body: Type.String({ minLength: 1, maxLength: 60_000 }),
      comments: Type.Array(
        Type.Object({
          path: Type.String({ minLength: 1, maxLength: 1_000 }),
          line: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
          side: Type.Optional(reviewSideSchema),
          startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
          startSide: Type.Optional(reviewSideSchema),
          body: Type.String({ minLength: 1, maxLength: 10_000 }),
        }),
        { maxItems: 100 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      await reporter.review({
        body: params.body,
        comments: params.comments.map((comment) => ({
          ...comment,
          side: comment.side ?? "RIGHT",
          startSide: comment.startLine
            ? (comment.startSide ?? comment.side ?? "RIGHT")
            : undefined,
        })),
      });
      return {
        content: [{ type: "text", text: "GitHub review submitted successfully." }],
        details: { submitted: true, inlineComments: params.comments.length },
      };
    },
  });
}
