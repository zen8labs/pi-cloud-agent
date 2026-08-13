import { randomUUID } from "node:crypto";
import {
  type RepoRef,
  TERMINAL_STATUSES,
  type ThinkingLevel,
  type Trigger,
  type WorkspaceRef,
} from "@pi-cloud-agent/protocol";
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { CHANNELS, type Database, notify } from "./client";
import { type RunRow, runs, type SessionRow, sessions } from "./schema";

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
}

export class SessionNotFoundError extends Error {
  constructor() {
    super("session not found");
    this.name = "SessionNotFoundError";
  }
}

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

    const turnNumber = session.turnCount + 1;
    const startsImmediately = session.activeRunId === null;

    const trigger: Trigger = { kind: "manual", repo: session.repo, prompt };
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
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
    return { run: created, startsImmediately };
  });
  if (result.startsImmediately) await notify(database, CHANNELS.runQueued, result.run.id);
  return result.run;
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

export async function listSessions(
  database: Database,
  limit: number,
  userId?: string | null,
): Promise<SessionRow[]> {
  return database
    .select()
    .from(sessions)
    .where(userId ? eq(sessions.userId, userId) : undefined)
    .orderBy(desc(sessions.updatedAt))
    .limit(limit);
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
    .set({ agentCheckpoint: content, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.activeRunId, run.id)))
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
      ),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}

export async function parkSession(
  database: Database,
  run: RunRow,
  workspace: WorkspaceRef | null,
  expiresAt: Date | null,
): Promise<boolean> {
  const sessionId = run.sessionId;
  if (!sessionId) return false;
  const result = await database.transaction(async (tx) => {
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
    const updated = await tx
      .update(sessions)
      .set({
        activeRunId: next?.id ?? null,
        sandboxProvider: workspace?.provider ?? null,
        sandboxId: workspace?.id ?? null,
        workspaceExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(sessions.id, sessionId), eq(sessions.activeRunId, run.id)))
      .returning({ id: sessions.id });
    if (updated.length === 0) return { parked: false, nextRunId: null };
    await tx
      .update(runs)
      .set({ sandboxStoppedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(runs.id, run.id), isNull(runs.sandboxStoppedAt)));
    return { parked: true, nextRunId: next?.id ?? null };
  });
  if (result.nextRunId) await notify(database, CHANNELS.runQueued, result.nextRunId);
  return result.parked;
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
      ),
    )
    .limit(limit);
}

export async function clearSessionWorkspace(
  database: Database,
  sessionId: string,
  workspaceId: string,
): Promise<boolean> {
  const updated = await database
    .update(sessions)
    .set({
      sandboxProvider: null,
      sandboxId: null,
      workspaceExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(sessions.id, sessionId), eq(sessions.sandboxId, workspaceId)))
    .returning({ id: sessions.id });
  return updated.length > 0;
}
