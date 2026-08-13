import { isTerminal, type RunStatus } from "@pi-cloud-agent/protocol";
import type { RunRow } from "../db/schema";
import type { Logger } from "../logger";
import type { IntegrationRegistry } from "./registry";

/**
 * Best-effort lifecycle ping. Never throws — a dead callback must not fail the run.
 */
export async function reportRunLifecycle(
  registry: IntegrationRegistry,
  log: Logger,
  run: RunRow,
  status: RunStatus,
  detail?: string | null,
): Promise<void> {
  if (!run.surfaceRef) return;
  const sink = registry.resolveSink(run.surfaceRef);
  if (!sink) return;
  try {
    await sink.report(run.surfaceRef, {
      runId: run.id,
      status,
      detail: detail ?? run.error,
      terminal: isTerminal(status),
    });
  } catch (error) {
    log.warn("surface report failed", { runId: run.id, status, error });
  }
}
