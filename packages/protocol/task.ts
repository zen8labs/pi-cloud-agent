import { z } from "zod";
import { repoRefSchema } from "./repo";

/**
 * The pivot between behavior and infrastructure.
 *
 * A profile turns a trigger into a TaskSpec. The controller reads it to
 * provision a sandbox and never inspects the prompt. Everything specific to a
 * vertical lives on the far side of this type.
 */
export const taskSpecSchema = z.object({
  profile: z.string().min(1),
  /** The concrete request handed to the agent. */
  prompt: z.string().min(1),
  repo: repoRefSchema,
  /**
   * Budget for this task, when the profile has an opinion. The controller
   * clamps it to RUN_WALL_CLOCK_SECONDS.
   */
  wallClockSeconds: z.number().int().positive().optional(),
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;
