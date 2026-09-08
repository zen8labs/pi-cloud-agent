import type { SandboxProvider, SandboxRef, WorkspaceRef } from "@pi-cloud-agent/protocol";
import type { Database } from "../db/client";
import {
  findSessionSandboxesToFinalize,
  findSessionSandboxReplacementsToDelete,
  getRun,
  markSessionSandboxFinalized,
} from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import { withSessionOperation } from "../db/session-operations";
import { markSessionSandboxReplacementDeleted } from "../db/session-workspace";
import { getSession } from "../db/sessions";
import type { Logger } from "../logger";

const BATCH = 25;

/** Under the parking claim, finish old cleanup before reusing a snapshot path. */
export async function prepareSessionParking(
  deps: SessionFinalizationDeps,
  run: RunRow & { sessionId: string },
): Promise<boolean> {
  const current = await getRun(deps.database, run.id);
  if (!current || current.sandboxStoppedAt) return false;
  if (current.sandboxReplacementWorkspaceId && current.sandboxReplacementWorkspaceProvider) {
    await deleteMarkedWorkspace(
      deps,
      {
        provider: current.sandboxReplacementWorkspaceProvider,
        id: current.sandboxReplacementWorkspaceId,
      },
      run.sessionId,
      run.id,
    );
    if ((await getRun(deps.database, run.id))?.sandboxReplacementWorkspaceId) return false;
  }
  return true;
}

type FinalizableSessionRun = RunRow & {
  sessionId: string;
  sandboxProvider: string;
  sandboxId: string;
  sandboxFinalizationWorkspaceProvider: string;
  sandboxFinalizationWorkspaceId: string;
};

type ReplacableSessionRun = RunRow & {
  sessionId: string;
  sandboxReplacementWorkspaceProvider: string;
  sandboxReplacementWorkspaceId: string;
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

function isReplacableSessionRun(run: RunRow): run is ReplacableSessionRun {
  return Boolean(
    run.sessionId &&
      run.sandboxReplacementWorkspaceProvider &&
      run.sandboxReplacementWorkspaceId,
  );
}

function providerFor(
  deps: SessionFinalizationDeps,
  providerName: string,
): SandboxProvider | null {
  return providerName === deps.sandbox.name
    ? deps.sandbox
    : (deps.createProvider?.(providerName) ?? null);
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

/** Delete the prior checkpoint and retain its marker if the provider fails. */
export async function deleteReplacedWorkspace(
  deps: SessionFinalizationDeps,
  previous: SessionRow | null,
  workspace: WorkspaceRef,
  sessionId: string,
  runId: string,
): Promise<void> {
  if (
    !previous?.sandboxId ||
    !previous.sandboxProvider ||
    previous.sandboxId === workspace.id
  ) {
    return;
  }
  const replaced = { provider: previous.sandboxProvider, id: previous.sandboxId };
  await deleteMarkedWorkspace(deps, replaced, sessionId, runId);
}

/** Delete a checkpoint whose durable cleanup marker is already recorded. */
export async function deleteMarkedWorkspace(
  deps: SessionFinalizationDeps,
  workspace: WorkspaceRef,
  sessionId: string,
  runId: string,
): Promise<void> {
  try {
    const provider = providerFor(deps, workspace.provider);
    const current = await getRun(deps.database, runId);
    if (
      current?.sandboxReplacementWorkspaceProvider !== workspace.provider ||
      current.sandboxReplacementWorkspaceId !== workspace.id
    )
      return;
    const session = await getSession(deps.database, sessionId);
    if (session?.sandboxProvider === workspace.provider && session.sandboxId === workspace.id)
      return;
    if (!provider) throw new Error(`sandbox provider "${workspace.provider}" is unavailable`);
    await provider.deleteWorkspace(workspace);
    await markSessionSandboxReplacementDeleted(deps.database, runId, workspace);
    deps.log.info("replaced session workspace deleted", {
      sessionId,
      workspaceId: workspace.id,
    });
  } catch (error) {
    deps.log.error("replaced session workspace deletion failed", {
      sessionId,
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
    const provider = providerFor(deps, source.provider);
    if (!provider) {
      deps.log.error("session source cleanup provider is unavailable", {
        sessionId: run.sessionId,
        sourceId: source.id,
        provider: source.provider,
      });
      continue;
    }
    await finalizeSuspendedSource(deps, provider, source, workspace, run.sessionId, run.id);
  }
}

/** Retry deletion of checkpoints superseded by a newer durable checkpoint. */
export async function retryPendingSessionSandboxReplacements(
  deps: SessionFinalizationDeps,
): Promise<void> {
  const pending = await findSessionSandboxReplacementsToDelete(deps.database, BATCH);
  for (const run of pending) {
    if (!isReplacableSessionRun(run)) continue;
    const workspace: WorkspaceRef = {
      provider: run.sandboxReplacementWorkspaceProvider,
      id: run.sandboxReplacementWorkspaceId,
    };
    await withSessionOperation(
      deps.database,
      run.sessionId,
      "replacing",
      { activeRunId: null },
      () => deleteMarkedWorkspace(deps, workspace, run.sessionId, run.id),
      (error) =>
        deps.log.warn("checkpoint deletion heartbeat failed", {
          sessionId: run.sessionId,
          error,
        }),
    );
  }
}
