import type { SandboxProvider, SandboxRef, WorkspaceRef } from "@pi-cloud-agent/protocol";
import type { Database } from "../db/client";
import { findSessionSandboxesToFinalize, markSessionSandboxFinalized } from "../db/runs";
import type { RunRow } from "../db/schema";
import type { Logger } from "../logger";

const BATCH = 25;

type FinalizableSessionRun = RunRow & {
  sessionId: string;
  sandboxProvider: string;
  sandboxId: string;
  sandboxFinalizationWorkspaceProvider: string;
  sandboxFinalizationWorkspaceId: string;
};

export interface SessionFinalizationDeps {
  database: Database;
  sandbox: SandboxProvider;
  createProvider?: (name: string) => SandboxProvider;
  log: Logger;
}

function isFinalizableSessionRun(run: RunRow): run is FinalizableSessionRun {
  return Boolean(
    run.sessionId &&
      run.sandboxProvider &&
      run.sandboxId &&
      run.sandboxFinalizationWorkspaceProvider &&
      run.sandboxFinalizationWorkspaceId,
  );
}

function providerFor(deps: SessionFinalizationDeps, providerName: string): SandboxProvider {
  return providerName === deps.sandbox.name
    ? deps.sandbox
    : (deps.createProvider?.(providerName) ?? deps.sandbox);
}

/** Release a stopped source and clear its marker only after that succeeds. */
export async function finalizeSuspendedSource(
  deps: SessionFinalizationDeps,
  provider: SandboxProvider,
  source: SandboxRef,
  workspace: WorkspaceRef,
  sessionId: string,
  runId?: string,
): Promise<void> {
  try {
    await provider.finalizeSuspend(source, workspace);
    if (runId) {
      await markSessionSandboxFinalized(deps.database, runId, source, workspace);
    }
  } catch (error) {
    // The checkpoint is already durable. The marker keeps this source visible
    // to the next reconciliation pass without risking workspace loss.
    deps.log.error("suspended source cleanup failed", {
      sessionId,
      sourceId: source.id,
      workspaceId: workspace.id,
      error,
    });
  }
}

/** Retry source cleanup left behind by a crash or a transient provider error. */
export async function retryPendingSessionFinalizations(
  deps: SessionFinalizationDeps,
): Promise<void> {
  const pending = await findSessionSandboxesToFinalize(deps.database, BATCH);
  for (const run of pending) {
    if (!isFinalizableSessionRun(run)) continue;
    const source: SandboxRef = { provider: run.sandboxProvider, id: run.sandboxId };
    const workspace: WorkspaceRef = {
      provider: run.sandboxFinalizationWorkspaceProvider,
      id: run.sandboxFinalizationWorkspaceId,
    };
    await finalizeSuspendedSource(
      deps,
      providerFor(deps, source.provider),
      source,
      workspace,
      run.sessionId,
      run.id,
    );
  }
}
