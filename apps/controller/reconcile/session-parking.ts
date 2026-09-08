import type { SandboxProvider, SandboxRef, WorkspaceRef } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { getRun } from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import { withSessionOperation } from "../db/session-operations";
import { markSessionSandboxReplacementPending } from "../db/session-workspace";
import { getSession, parkSession } from "../db/sessions";
import type { Logger } from "../logger";
import {
  deleteMarkedWorkspace,
  deleteReplacedWorkspace,
  finalizeSuspendedSource,
  prepareSessionParking,
  type SessionFinalizationDeps,
} from "./session-finalization";

type ParkableSessionRun = Omit<RunRow, "sessionId" | "sandboxId" | "sandboxProvider"> & {
  sessionId: string;
  sandboxId: string;
  sandboxProvider: string;
};

export interface SessionParkingDeps {
  config: Config;
  database: Database;
  sandbox: SandboxProvider;
  createProvider: (name: string) => SandboxProvider;
  log: Logger;
  finalization: SessionFinalizationDeps;
}

function isParkableSessionRun(run: RunRow): run is ParkableSessionRun {
  return Boolean(run.sessionId && run.sandboxId && run.sandboxProvider);
}

function previousWorkspace(
  previous: SessionRow | null,
  currentId: string,
): WorkspaceRef | null {
  return previous?.sandboxProvider && previous.sandboxId && previous.sandboxId !== currentId
    ? { provider: previous.sandboxProvider, id: previous.sandboxId }
    : null;
}

/** Park a terminal session turn while serializing all provider operations. */
export async function parkSessionRun(
  run: RunRow,
  reason: string,
  deps: SessionParkingDeps,
): Promise<void> {
  if (!run.sessionId) return;
  if (!isParkableSessionRun(run)) {
    // A promoted turn can be cancelled before it resumes the session's parked
    // workspace. It owns no sandbox to suspend, so preserve that workspace.
    await parkSession(deps.database, run, undefined, null);
    return;
  }

  await withSessionOperation(
    deps.database,
    run.sessionId,
    "parking",
    { activeRunId: run.id },
    (token) => parkClaimedSandbox(run, reason, token, deps),
    (error) =>
      deps.log.warn("session parking heartbeat failed", { sessionId: run.sessionId, error }),
  );
}

async function parkClaimedSandbox(
  run: ParkableSessionRun,
  reason: string,
  token: Date,
  deps: SessionParkingDeps,
): Promise<void> {
  if (!(await prepareSessionParking(deps.finalization, run))) return;
  await suspendAndPark(run, reason, token, deps);
}

async function suspendAndPark(
  run: ParkableSessionRun,
  reason: string,
  token: Date,
  deps: SessionParkingDeps,
): Promise<void> {
  const provider =
    run.sandboxProvider === deps.sandbox.name
      ? deps.sandbox
      : deps.createProvider(run.sandboxProvider);
  const ref = { provider: run.sandboxProvider, id: run.sandboxId };
  const previous = await getSession(deps.database, run.sessionId);
  let workspace: WorkspaceRef | undefined;
  try {
    workspace = await provider.suspend(ref);
    const expiresAt = new Date(
      Date.now() + deps.config.sessionWorkspaceRetentionSeconds * 1000,
    );
    const replacedWorkspace = previousWorkspace(previous, workspace.id);
    const parked = await parkSession(
      deps.database,
      run,
      workspace,
      expiresAt,
      replacedWorkspace,
      token,
    );
    if (parked) {
      await deleteReplacedWorkspace(
        deps.finalization,
        previous,
        workspace,
        run.sessionId,
        run.id,
      );
      await finalizeSuspendedSource(
        deps.finalization,
        provider,
        ref,
        workspace,
        run.sessionId,
        run.id,
      );
      deps.log.info("session workspace suspended", {
        sessionId: run.sessionId,
        runId: run.id,
        workspaceId: workspace.id,
        reason,
      });
    } else {
      await cleanupUnownedWorkspace(run, ref, workspace, deps);
    }
  } catch (error) {
    deps.log.error("session workspace suspension failed; retaining last available checkpoint", {
      sessionId: run.sessionId,
      runId: run.id,
      error,
    });
    let replacementPending = false;
    if (workspace && (workspace.provider !== ref.provider || workspace.id !== ref.id)) {
      replacementPending = await cleanupUncommittedWorkspace(run, provider, workspace, deps);
    }
    // Keep the run attached until stopping succeeds so reconciliation retries it.
    await provider.stop(ref);
    // A restored VM is disposable; its separate source checkpoint is not.
    const retained = previousWorkspace(previous, ref.id);
    await parkSession(
      deps.database,
      run,
      retained ? undefined : null,
      null,
      replacementPending ? undefined : null,
      token,
    );
  }
}

async function cleanupUncommittedWorkspace(
  run: ParkableSessionRun,
  provider: SandboxProvider,
  workspace: WorkspaceRef,
  deps: SessionParkingDeps,
): Promise<boolean> {
  // Record the provider artifact before trying to delete it. If the delete
  // fails, the marker gives the next reconciliation pass a safe retry path;
  // without it, a database failure during parking would make this snapshot
  // unreachable forever.
  const marked = await markSessionSandboxReplacementPending(
    deps.database,
    run.id,
    workspace,
  ).catch((error: unknown) => {
    deps.log.error("could not record uncommitted session checkpoint", {
      sessionId: run.sessionId,
      workspaceId: workspace.id,
      error,
    });
    return false;
  });
  if (marked) {
    await deleteMarkedWorkspace(deps.finalization, workspace, run.sessionId, run.id);
  } else {
    // If the marker write was unavailable, make a best-effort direct cleanup.
    // There is no durable retry path until the database is reachable again.
    await provider.deleteWorkspace(workspace).catch((error: unknown) =>
      deps.log.error("uncommitted session checkpoint cleanup failed", {
        sessionId: run.sessionId,
        workspaceId: workspace.id,
        error,
      }),
    );
  }

  const current = await getRun(deps.database, run.id).catch((error: unknown) => {
    deps.log.error("could not verify uncommitted session checkpoint cleanup", {
      sessionId: run.sessionId,
      workspaceId: workspace.id,
      error,
    });
    return null;
  });
  // If the marker cannot be read, preserve it conservatively. The fallback
  // park transaction will either fail as well or leave the marker untouched.
  return current === null || Boolean(current.sandboxReplacementWorkspaceId);
}

async function cleanupUnownedWorkspace(
  run: ParkableSessionRun,
  source: SandboxRef,
  workspace: WorkspaceRef,
  deps: SessionParkingDeps,
): Promise<void> {
  const current = await getSession(deps.database, run.sessionId);
  if (current?.sandboxId === workspace.id) return;
  // E2B uses the paused sandbox id as both source and checkpoint. Deleting it
  // here would destroy the source needed if parking retries after the session
  // operation releases, so leave same-id checkpoints for that retry.
  if (source.id !== workspace.id) {
    const marked = await markSessionSandboxReplacementPending(deps.database, run.id, workspace);
    if (marked) {
      await deleteMarkedWorkspace(deps.finalization, workspace, run.sessionId, run.id);
    }
  }
}
