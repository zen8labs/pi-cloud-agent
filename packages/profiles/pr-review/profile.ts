import { readFileSync } from "node:fs";
import { defineProfile } from "@pi-cloud-agent/protocol";
import { z } from "zod";

/**
 * Review one pull request.
 *
 * Everything specific to reviewing lives here or in SKILL.md — including the
 * triggering policy. The controller does not know that "synchronize" events can
 * be noisy or that `/review` is a command; it asks this profile whether a
 * trigger should start a run and takes the answer.
 */

const skill = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8").trim();

const configSchema = z.object({
  /**
   * Clone this branch instead of the repository's default. Empty means "use the
   * real default branch". Only affects triggers that carry no branch of their own.
   */
  branch: z.string().default(""),
  /** Review when a pull request is opened or reopened. */
  onOpened: z.boolean().default(true),
  /** Review again when new commits are pushed. The noisy one. */
  onUpdated: z.boolean().default(true),
  /** Review when someone comments a command. */
  onComment: z.boolean().default(true),
  /** Comment prefixes that count as a request. */
  commands: z.array(z.string()).default(["/review"]),
});

export const prReviewProfile = defineProfile({
  name: "pr-review",
  description: "Review a pull request and post the findings directly",
  configSchema,
  skill,

  accepts(trigger, config) {
    // Nothing to review without a pull request. Checked first so every branch
    // below can assume one exists, and so `accepts` never green-lights a trigger
    // that `buildTask` would then refuse.
    if (trigger.repo.prNumber === null) return false;

    switch (trigger.kind) {
      case "pr_opened":
        return config.onOpened;
      case "pr_updated":
        return config.onUpdated;
      case "pr_comment": {
        if (!config.onComment) return false;
        const command = trigger.command?.trim().toLowerCase() ?? "";
        return config.commands.some((prefix) => command.startsWith(prefix.toLowerCase()));
      }
      case "manual":
        // A human asking directly overrides the automatic triggering policy.
        return true;
      default:
        return false;
    }
  },

  buildTask(trigger, config) {
    const { repo } = trigger;
    if (repo.prNumber === null) {
      throw new Error("the pr-review profile requires a pull request number");
    }
    return {
      profile: "pr-review",
      prompt: `Review pull request #${repo.prNumber} in the current checkout.`,
      repo: config.branch ? { ...repo, defaultBranch: config.branch } : repo,
    };
  },
});
