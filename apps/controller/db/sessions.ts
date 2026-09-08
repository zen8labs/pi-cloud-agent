import { randomUUID } from "node:crypto";
import {
  type RepoRef,
  TERMINAL_STATUSES,
  type ThinkingLevel,
  type Trigger,
  type WorkspaceRef,
} from "@pi-cloud-agent/protocol";
import { and, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { CHANNELS, type Database, notify } from "./client";
import { bindExternalThread } from "./integrations";
import { type RunRow, runs, type SessionOperation, type SessionRow, sessions } from "./schema";
import { CLEARED_SESSION_OPERATION, isSessionOperationStale } from "./session-operations";
import {
  buildFinalizationUpdate,
  buildReplacementUpdate,
  buildWorkspaceUpdate,
} from "./session-workspace";

export { listSessions } from "./session-list";

export interface CreateSessionInput {
  userId?: string | null;
  title: string;
  provider: string;
  repoFullName: string;
  repo: RepoRef;
  trigger: Trigger;
  model: string;
  thinkingLevel?: ThinkingLevel;
  modelConnectionId?: string | null;
  callbackToken: string;
  externalThreadKey?: string;
}

export class SessionNotFoundError extends Error {
  constructor() {
    super("session not found");
    this.name = "SessionNotFoundError";
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super("session cleanup is in progress; retry shortly");
    this.name = "SessionBusyError";
  }
}

type SessionTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function createSessionWithRun(
  database: Database,
  input: CreateSessionInput,
): Promise<{ session: SessionRow; run: RunRow }> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const result = await database.transaction(async (tx) => {
    const [session] = await tx
      .insert(sessions)
      .values({
        id: sessionId,
        userId: input.userId ?? null,
        title: input.title,
        provider: input.provider,
        repoFullName: input.repoFullName,
        repo: input.repo,
        model: input.model,
        modelConnectionId: input.modelConnectionId ?? null,
        activeRunId: runId,
        latestRunId: runId,
      })
      .returning();
    const [run] = await tx
      .insert(runs)
      .values({
        id: runId,
        userId: input.userId ?? null,
        sessionId,
        turnNumber: 1,
        provider: input.provider,
        repoFullName: input.repoFullName,
        trigger: input.trigger,
        model: input.model,
        modelConnectionId: input.modelConnectionId ?? null,
        thinkingLevel: input.thinkingLevel ?? "medium",
        callbackToken: input.callbackToken,
      })
      .returning();
    if (!session || !run) throw new Error("could not create session and first run");
    await bindExternalThread(tx, input, sessionId);
    return { session, run };
  });
  await notify(database, CHANNELS.runQueued, result.run.id);
  return result;
}

export async function createSessionTurn(
  database: Database,
  sessionId: string,
  prompt: string,
  callbackToken: string,
  userId: string | null,
  modelSelection: {
    model: string;
    modelConnectionId: string | null;
    thinkingLevel?: ThinkingLevel;
    trigger?: Trigger;
  },
): Promise<RunRow> {
  const runId = randomUUID();
  const result = await database.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), ...(userId ? [eq(sessions.userId, userId)] : [])))
      .limit(1)
      .for("update");
    if (!session) throw new SessionNotFoundError();
    await clearStaleSessionOperation(tx, session, sessionId);

    const turnNumber = session.turnCount + 1;
    const startsImmediately = session.activeRunId === null;

    const trigger: Trigger = modelSelection.trigger ?? {
      kind: "manual",
      repo: session.repo,
      prompt,
      source: "manual",
      intent: "general",
    };
    const [created] = await tx
      .insert(runs)
      .values({
        id: runId,
        userId: session.userId,
        sessionId,
        turnNumber,
        provider: session.provider,
        repoFullName: session.repoFullName,
        trigger,
        model: modelSelection.model,
        modelConnectionId: modelSelection.modelConnectionId,
        thinkingLevel: modelSelection.thinkingLevel ?? "medium",
        callbackToken,
      })
      .returning();
    if (!created) throw new Error("could not create session turn");
    await tx
      .update(sessions)
      .set({
        activeRunId: startsImmediately ? runId : session.activeRunId,
        latestRunId: runId,
        turnCount: turnNumber,
        model: modelSelection.model,
        modelConnectionId: modelSelection.modelConnectionId,
        retentionStatus: "active",
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
    return { run: created, startsImmediately };
  });
  if (result.startsImmediately) await notify(database, CHANNELS.runQueued, result.run.id);
  return result.run;
}
async function clearStaleSessionOperation(
  tx: SessionTransaction,
  session: SessionRow,
  sessionId: string,
): Promise<void> {
  if (!session.sessionOperation) return;
  if (!isSessionOperationStale(session.sessionOperationHeartbeatAt))
    throw new SessionBusyError();
  const marker = session.sessionOperationAt
    ? eq(sessions.sessionOperationAt, session.sessionOperationAt)
    : isNull(sessions.sessionOperationAt);
  const reclaimed = await tx
    .update(sessions)
    .set({ ...CLEARED_SESSION_OPERATION, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.sessionOperation, session.sessionOperation),
        marker,
      ),
    )
    .returning({ id: sessions.id });
  if (reclaimed.length === 0) throw new SessionBusyError();
}
export async function getSession(
  database: Database,
  sessionId: string,
  userId?: string | null,
): Promise<SessionRow | null> {
  const [row] = await database
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), ...(userId ? [eq(sessions.userId, userId)] : [])))
    .limit(1);
  return row ?? null;
}

export async function setSessionPinned(
  database: Database,
  sessionId: string,
  userId: string,
  pinned: boolean,
): Promise<boolean> {
  const updated = await database
    .update(sessions)
    .set({ pinned, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  return updated.length > 0;
}

export async function listSessionRuns(
  database: Database,
  sessionId: string,
  userId?: string | null,
): Promise<RunRow[]> {
  return database
    .select()
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), ...(userId ? [eq(runs.userId, userId)] : [])))
    .orderBy(runs.turnNumber);
}

export async function getSessionForRun(
  database: Database,
  run: RunRow,
): Promise<SessionRow | null> {
  return run.sessionId ? getSession(database, run.sessionId) : null;
}

export async function saveSessionCheckpoint(
  database: Database,
  run: RunRow,
  content: string,
): Promise<boolean> {
  const sessionId = run.sessionId;
  if (!sessionId) return false;
  const updated = await database
    .update(sessions)
    .set({ agentCheckpoint: content, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.activeRunId, run.id),
        isNull(sessions.sessionOperation),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}

/** Set the immutable original revision when the first turn reports its baseline or diff. */
export async function saveSessionDiffBaseSha(
  database: Database,
  run: RunRow,
  baseSha: string,
): Promise<boolean> {
  const sessionId = run.sessionId;
  if (!sessionId) return false;
  const updated = await database
    .update(sessions)
    .set({ diffBaseSha: baseSha, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.activeRunId, run.id),
        isNull(sessions.diffBaseSha),
        isNull(sessions.sessionOperation),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}

export async function parkSession(
  database: Database,
  run: RunRow,
  workspace: WorkspaceRef | null | undefined,
  expiresAt: Date | null,
  replacedWorkspace?: WorkspaceRef | null,
  operationAt?: Date,
): Promise<boolean> {
  const sessionId = run.sessionId;
  if (!sessionId) return false;
  const result = await database.transaction(async (tx) => {
    const [owner] = await tx
      .select({
        activeRunId: sessions.activeRunId,
        sessionOperation: sessions.sessionOperation,
        sessionOperationAt: sessions.sessionOperationAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .for("update");
    if (!ownsParkLease(owner, run.id, operationAt)) {
      return { parked: false, nextRunId: null };
    }

    const [next] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, sessionId),
          eq(runs.status, "queued"),
          sql`${runs.turnNumber} > ${run.turnNumber ?? 0}`,
        ),
      )
      .orderBy(runs.turnNumber)
      .limit(1)
      .for("update");
    const workspaceUpdate = buildWorkspaceUpdate(workspace, expiresAt);
    const updated = await tx
      .update(sessions)
      .set({
        activeRunId: next?.id ?? null,
        ...workspaceUpdate,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.activeRunId, run.id),
          ...(operationAt
            ? [
                eq(sessions.sessionOperation, "parking"),
                eq(sessions.sessionOperationAt, operationAt),
              ]
            : [isNull(sessions.sessionOperation)]),
        ),
      )
      .returning({ id: sessions.id });
    if (updated.length === 0) return { parked: false, nextRunId: null };
    await tx
      .update(runs)
      .set({
        sandboxStoppedAt: new Date(),
        ...buildFinalizationUpdate(workspace),
        ...buildReplacementUpdate(replacedWorkspace),
        updatedAt: new Date(),
      })
      .where(and(eq(runs.id, run.id), isNull(runs.sandboxStoppedAt)));
    return { parked: true, nextRunId: next?.id ?? null };
  });
  // NOTIFY is a wake-up hint; polling remains the correctness path. A failed
  // notification must not make a committed checkpoint look uncommitted.
  if (result.nextRunId)
    await notify(database, CHANNELS.runQueued, result.nextRunId).catch(() => undefined);
  return result.parked;
}

function ownsParkLease(
  owner:
    | {
        activeRunId: string | null;
        sessionOperation: SessionOperation | null;
        sessionOperationAt: Date | null;
      }
    | undefined,
  runId: string,
  operationAt?: Date,
): boolean {
  return (
    owner?.activeRunId === runId &&
    (operationAt
      ? owner.sessionOperation === "parking" &&
        owner.sessionOperationAt?.getTime() === operationAt.getTime()
      : owner.sessionOperation === null)
  );
}

export async function findExpiredSessionWorkspaces(
  database: Database,
  limit: number,
): Promise<SessionRow[]> {
  return database
    .select()
    .from(sessions)
    .where(
      and(
        isNull(sessions.activeRunId),
        isNotNull(sessions.sandboxId),
        isNotNull(sessions.workspaceExpiresAt),
        lt(sessions.workspaceExpiresAt, new Date()),
        or(isNull(sessions.sessionOperation), eq(sessions.sessionOperation, "expiring")),
      ),
    )
    .limit(limit);
}

/** Terminal session turns whose workspace has not yet been suspended or released. */
export async function findSessionRunsToPark(
  database: Database,
  limit: number,
): Promise<RunRow[]> {
  return database
    .select()
    .from(runs)
    .where(
      and(
        isNotNull(runs.sessionId),
        inArray(runs.status, [...TERMINAL_STATUSES]),
        isNull(runs.sandboxStoppedAt),
        sql`exists (select 1 from ${sessions} where ${sessions.id} = ${runs.sessionId} and ${sessions.activeRunId} = ${runs.id})`,
      ),
    )
    .limit(limit);
}

export async function clearSessionWorkspace(
  database: Database,
  sessionId: string,
  workspaceId: string,
  expectedActiveRunId?: string | null,
  expectedOperation?: SessionOperation | null,
  expectedOperationAt?: Date,
): Promise<boolean> {
  const guards = sessionGuards(expectedActiveRunId, expectedOperation, expectedOperationAt);
  const updated = await database
    .update(sessions)
    .set({
      sandboxId: null,
      workspaceExpiresAt: null,
      retentionStatus: "inactive",
      updatedAt: new Date(),
    })
    .where(and(eq(sessions.id, sessionId), eq(sessions.sandboxId, workspaceId), ...guards))
    .returning({ id: sessions.id });
  return updated.length > 0;
}

/** Permanently delete a session and its turns after the checkpoint is reclaimed. */
export async function deleteSession(
  database: Database,
  sessionId: string,
  userId?: string | null,
  expectedActiveRunId?: string | null,
  /** Prevent an archive from deleting a turn queued after its initial read. */
  expectedLatestRunId?: string,
  expectedOperation?: SessionOperation | null,
  expectedOperationAt?: Date,
): Promise<boolean> {
  const ownership = userId ? [eq(sessions.userId, userId)] : [];
  const guards = sessionGuards(expectedActiveRunId, expectedOperation, expectedOperationAt);
  const deleted = await database
    .delete(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        ...ownership,
        ...guards,
        ...(expectedLatestRunId ? [eq(sessions.latestRunId, expectedLatestRunId)] : []),
      ),
    )
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

function sessionGuards(
  expectedActiveRunId: string | null | undefined,
  expectedOperation: SessionOperation | null | undefined,
  expectedOperationAt: Date | undefined,
): SQL[] {
  const operation =
    expectedOperation === undefined || expectedOperation === null
      ? isNull(sessions.sessionOperation)
      : eq(sessions.sessionOperation, expectedOperation);
  const operationAt = expectedOperationAt
    ? [eq(sessions.sessionOperationAt, expectedOperationAt)]
    : [];
  if (expectedActiveRunId === undefined) return [operation, ...operationAt];
  const activeRun =
    expectedActiveRunId === null
      ? isNull(sessions.activeRunId)
      : eq(sessions.activeRunId, expectedActiveRunId);
  return [activeRun, operation, ...operationAt];
}
