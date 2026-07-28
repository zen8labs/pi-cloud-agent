import { z } from "zod";

/**
 * The run lifecycle.
 *
 * Six states, and every transition is a single guarded UPDATE (see
 * docs/resumability.md). There is deliberately no "publishing" state: the agent
 * actuates its own outcomes from inside the sandbox, so there is no step
 * between "the agent finished" and "the run is done".
 */
export const RUN_STATUSES = [
  "queued",
  "provisioning",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export const ACTIVE_STATUSES = ["queued", "provisioning", "running"] as const;

/** In-flight states where a sandbox may exist and progress is expected. */
export const IN_FLIGHT_STATUSES = ["provisioning", "running"] as const;

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
