import { z } from "zod";

/**
 * What the sandbox reports outward.
 *
 * Two channels, and the difference between them is the whole observability
 * design:
 *
 *   telemetry (`RunEventInput`)  best-effort, high volume, never load-bearing.
 *                               Dropping one loses a line in the feed.
 *   status    (`RunStatusReport`) the terminal contract, delivered with retries.
 *                               This is the only thing that completes a run.
 *
 * Nothing infers completion from telemetry. A run that emits a thousand tokens
 * and never posts a status is a timeout, not a success.
 */

export const toolCallStatusSchema = z.enum(["running", "completed", "error"]);

export const runEventInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("token"),
    data: z.object({ content: z.string() }),
  }),
  z.object({
    type: z.literal("tool_call"),
    data: z.object({
      callId: z.string(),
      tool: z.string(),
      status: toolCallStatusSchema,
      turnNumber: z.number().int().positive().optional(),
      args: z.unknown().optional(),
      output: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("log"),
    data: z.looseObject({ event: z.string() }),
  }),
]);

export type RunEventInput = z.infer<typeof runEventInputSchema>;
/** Sandbox telemetry, terminal status, plus controller-emitted attach metadata. */
export type RunEventType = RunEventInput["type"] | "status" | "plugins.attached";

/** The terminal report. `done` succeeds the run; `error` fails it. */
export const runStatusReportSchema = z.object({
  status: z.enum(["done", "error"]),
  detail: z.string().nullish(),
});

export type RunStatusReport = z.infer<typeof runStatusReportSchema>;

/**
 * A persisted event. `seq` is per-run, gapless, and assigned by the controller;
 * it is the resume cursor for the SSE stream and the dedupe key in the client.
 */
export interface RunEvent {
  seq: number;
  type: RunEventType;
  data: Record<string, unknown>;
  at: string;
}
