import { z } from "zod";
import { repoRefSchema } from "./repo";

/**
 * The concrete work handed to the agent and the infrastructure.
 */
export const taskSpecSchema = z.object({
  /** The concrete request handed to the agent. */
  prompt: z.string().min(1),
  repo: repoRefSchema,
  /**
   * Optional task budget. The controller clamps it to RUN_WALL_CLOCK_SECONDS.
   */
  wallClockSeconds: z.number().int().positive().optional(),
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;
