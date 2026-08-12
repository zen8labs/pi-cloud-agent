import type { SurfaceRef, SurfaceReport } from "./types";

/**
 * One outbound surface for lifecycle reports.
 *
 * TODO(BA): confirm sinks never post semantic agent outcomes — only lifecycle.
 * TODO(BA): decide progress source — status transitions (current) vs full
 * `run_events` stream vs terminal-only.
 */
export interface ReportSink {
  readonly kind: string;

  /** True when this sink can report for the given surface. */
  supports(surface: SurfaceRef): boolean;

  report(surface: SurfaceRef, report: SurfaceReport): Promise<void>;
}
