import { z } from "zod";
import { repoRefSchema } from "./repo";

/**
 * A normalized reason a run exists.
 *
 * Every entry point — a webhook, the dashboard, a future Slack or Linear
 * adapter — narrows to this shape before anything else runs. The controller
 * stores it verbatim on the run row, which is what makes a run replayable: the
 * trigger plus the profile fully determines the task.
 */
export const TRIGGER_KINDS = [
  /** A human asked for something directly (dashboard, API). */
  "manual",
  "pr_opened",
  "pr_updated",
  "pr_comment",
] as const;

export const triggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const triggerSchema = z.object({
  kind: triggerKindSchema,
  repo: repoRefSchema,
  /** The free-form request, for manual triggers. */
  prompt: z.string().optional(),
  /** The comment body, for pr_comment triggers. */
  command: z.string().optional(),
});

export type Trigger = z.infer<typeof triggerSchema>;

/**
 * What a VCS provider returns from a webhook. `null` means "understood the
 * request, nothing to do" — an event we deliberately ignore, which is not an
 * error and must not look like one.
 */
export type ParsedWebhook = Trigger | null;
