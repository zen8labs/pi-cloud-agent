/**
 * Integration substrate for ZEN-92 (ingress + report-back).
 *
 * Provisional home: the controller. Do not import this from `packages/runtime`.
 *
 * TODO(BA/maintainer): after confirmation, promote these contracts to
 * `packages/protocol` (or a dedicated package) — AGENTS.md requires consult
 * before widening protocol.
 */

import type { RunStatus, TaskSpec, Trigger } from "@pi-cloud-agent/protocol";
import { z } from "zod";

/**
 * Where progress/final reports should go for a run started by an ingress.
 *
 * TODO(BA): tighten to a discriminated union per surface
 * (`webhook` | `github_issue` | `teams_conversation` | …) once kinds are fixed.
 */
export const surfaceRefSchema = z.object({
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type SurfaceRef = z.infer<typeof surfaceRefSchema>;

/** Successful normalize step: core shapes only — no surface-specific leftovers. */
export interface IngressAccept {
  trigger: Trigger;
  taskSpec: TaskSpec;
  surface: SurfaceRef;
}

/**
 * Lifecycle-only report. Intentionally excludes agent findings / PR text.
 *
 * TODO(BA): confirm ReportSink stays lifecycle-only (VISION: no controller-side
 * publish of semantic outcomes). If semantic posting is allowed later, extend
 * this type deliberately — do not overload `detail` with parsed agent output.
 */
export interface SurfaceReport {
  runId: string;
  status: RunStatus;
  /** Human-safe status detail from the controller (e.g. failure reason), never agent findings. */
  detail?: string | null;
  terminal: boolean;
}
