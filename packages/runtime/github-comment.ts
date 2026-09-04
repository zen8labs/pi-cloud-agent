import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Reporter } from "./reporter";

/** Structured, controller-owned reply to the triggering GitHub comment. */
export function createGithubCommentTool(reporter: Reporter) {
  return defineTool({
    name: "reply_github_comment",
    label: "Reply to GitHub comment",
    description:
      "Reply once to the GitHub comment that triggered this task. Use exactly once at the end, with the complete Markdown answer.",
    parameters: Type.Object({
      body: Type.String({ minLength: 1, maxLength: 60_000 }),
    }),
    execute: async (_toolCallId, params) => {
      await reporter.comment({ body: params.body });
      return {
        content: [{ type: "text", text: "GitHub comment reply submitted successfully." }],
        details: { submitted: true },
      };
    },
  });
}
