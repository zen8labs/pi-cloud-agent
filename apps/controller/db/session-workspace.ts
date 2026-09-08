import type { WorkspaceRef } from "@pi-cloud-agent/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { runs } from "./schema";

export function buildWorkspaceUpdate(
  workspace: WorkspaceRef | null | undefined,
  expiresAt: Date | null,
) {
  if (workspace === undefined) return {};
  if (workspace === null) {
    return {
      sandboxId: null,
      workspaceExpiresAt: expiresAt,
      retentionStatus: "inactive" as const,
    };
  }
  return {
    sandboxProvider: workspace.provider,
    sandboxId: workspace.id,
    workspaceExpiresAt: expiresAt,
    retentionStatus: "active" as const,
  };
}

export function buildFinalizationUpdate(workspace: WorkspaceRef | null | undefined) {
  if (workspace === undefined) return {};
  if (workspace === null) {
    return {
      sandboxFinalizationWorkspaceProvider: null,
      sandboxFinalizationWorkspaceId: null,
    };
  }
  return {
    sandboxFinalizationWorkspaceProvider: workspace.provider,
    sandboxFinalizationWorkspaceId: workspace.id,
  };
}

export function buildReplacementUpdate(workspace: WorkspaceRef | null | undefined) {
  if (workspace === undefined) return {};
  if (workspace === null) {
    return {
      sandboxReplacementWorkspaceProvider: null,
      sandboxReplacementWorkspaceId: null,
    };
  }
  return {
    sandboxReplacementWorkspaceProvider: workspace.provider,
    sandboxReplacementWorkspaceId: workspace.id,
  };
}

/** Record a checkpoint that is no longer owned by the session and needs deletion. */
export async function markSessionSandboxReplacementPending(
  database: Database,
  runId: string,
  workspace: WorkspaceRef,
): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({
      sandboxReplacementWorkspaceProvider: workspace.provider,
      sandboxReplacementWorkspaceId: workspace.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runs.id, runId),
        isNull(runs.sandboxReplacementWorkspaceProvider),
        isNull(runs.sandboxReplacementWorkspaceId),
      ),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}

/** Clear the durable replacement-cleanup marker after deletion succeeds. */
export async function markSessionSandboxReplacementDeleted(
  database: Database,
  runId: string,
  workspace: WorkspaceRef,
): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({
      sandboxReplacementWorkspaceProvider: null,
      sandboxReplacementWorkspaceId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.sandboxReplacementWorkspaceProvider, workspace.provider),
        eq(runs.sandboxReplacementWorkspaceId, workspace.id),
      ),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}
