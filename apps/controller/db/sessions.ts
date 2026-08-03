import { randomUUID } from "node:crypto";
import {
  type RepoRef,
  TERMINAL_STATUSES,
  type Trigger,
  type WorkspaceRef,
} from "@pi-cloud-agent/protocol";
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { CHANNELS, type Database, notify } from "./client";
import { type RunRow, runs, type SessionRow, sessions } from "./schema";

export interface CreateSessionInput {
  userId?: string | null;
  title: string;
  profile: string;
  provider: string;
  repoFullName: string;
  repo: RepoRef;
  trigger: Trigger;
  model: string;
  callbackToken: string;
}

export class SessionBusyError extends Error {
  constructor() {
    super("the session already has an active turn");
    this.name = "SessionBusyError";
  }
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
        profile: input.profile,
        provider: input.provider,
        repoFullName: input.repoFullName,
        repo: input.repo,
        model: input.model,
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
        profile: input.profile,
        provider: input.provider,
        repoFullName: input.repoFullName,
        trigger: input.trigger,
        model: input.model,
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
  userId: string | null = null,
): Promise<RunRow> {
  const runId = randomUUID();
  const run = await database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(sessions)
      .set({
        activeRunId: runId,
        latestRunId: runId,
        turnCount: sql`${sessions.turnCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.activeRunId),
          ...(userId ? [eq(sessions.userId, userId)] : []),
        ),
      )
      .returning();

    if (!claimed) {
      const [existing] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      if (!existing) throw new SessionNotFoundError();
      throw new SessionBusyError();
    }

    const trigger: Trigger = { kind: "manual", repo: claimed.repo, prompt };
    const [created] = await tx
      .insert(runs)
      .values({
        id: runId,
        userId: claimed.userId,
        sessionId,
        turnNumber: claimed.turnCount,
        profile: claimed.profile,
        provider: claimed.provider,
        repoFullName: claimed.repoFullName,
        trigger,
        model: claimed.model,
        callbackToken,
      })
      .returning();
    if (!created) throw new Error("could not create session turn");
    return created;
  });
  await notify(database, CHANNELS.runQueued, run.id);
  return run;
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

export async function parkSession(
  database: Database,
  run: RunRow,
  workspace: WorkspaceRef | null,
  expiresAt: Date | null,
): Promise<boolean> {
  const sessionId = run.sessionId;
  if (!sessionId) return false;
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(sessions)
      .set({
        activeRunId: null,
        sandboxProvider: workspace?.provider ?? null,
        sandboxId: workspace?.id ?? null,
        workspaceExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(sessions.id, sessionId), eq(sessions.activeRunId, run.id)))
      .returning({ id: sessions.id });
    if (updated.length === 0) return false;
    await tx
      .update(runs)
      .set({ sandboxStoppedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(runs.id, run.id), isNull(runs.sandboxStoppedAt)));
    return true;
  });
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
