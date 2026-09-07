import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "./client";
import { type SessionOperation, sessions } from "./schema";

const SESSION_OPERATION_STALE_MS = 10 * 60 * 1000;
const SESSION_OPERATION_HEARTBEAT_MS = 60 * 1000;

export const CLEARED_SESSION_OPERATION = {
  sessionOperation: null,
  sessionOperationAt: null,
  sessionOperationHeartbeatAt: null,
} as const;

export function isSessionOperationStale(heartbeatAt: Date | null): boolean {
  return (
    heartbeatAt === null || heartbeatAt.getTime() < Date.now() - SESSION_OPERATION_STALE_MS
  );
}

export async function claimSessionOperation(
  database: Database,
  sessionId: string,
  operation: SessionOperation,
  expected: {
    activeRunId?: string | null;
    latestRunId?: string;
    workspaceId?: string | null;
    userId?: string | null;
  } = {},
): Promise<Date | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - SESSION_OPERATION_STALE_MS);
  const currentOperation = or(
    isNull(sessions.sessionOperation),
    and(
      eq(sessions.sessionOperation, operation),
      or(
        isNull(sessions.sessionOperationHeartbeatAt),
        lt(sessions.sessionOperationHeartbeatAt, staleBefore),
      ),
    ),
  );
  const activeRun =
    expected.activeRunId === undefined
      ? []
      : [
          expected.activeRunId === null
            ? isNull(sessions.activeRunId)
            : eq(sessions.activeRunId, expected.activeRunId),
        ];
  const workspace =
    expected.workspaceId === undefined
      ? []
      : [
          expected.workspaceId === null
            ? isNull(sessions.sandboxId)
            : eq(sessions.sandboxId, expected.workspaceId),
        ];
  const [updated] = await database
    .update(sessions)
    .set({
      sessionOperation: operation,
      sessionOperationAt: now,
      sessionOperationHeartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessions.id, sessionId),
        ...(expected.userId ? [eq(sessions.userId, expected.userId)] : []),
        currentOperation,
        ...(expected.latestRunId ? [eq(sessions.latestRunId, expected.latestRunId)] : []),
        ...activeRun,
        ...workspace,
      ),
    )
    .returning({ sessionOperationAt: sessions.sessionOperationAt });
  return updated?.sessionOperationAt ?? null;
}

export async function renewSessionOperation(
  database: Database,
  sessionId: string,
  operation: SessionOperation,
  operationAt: Date,
): Promise<Date | null> {
  const now = new Date();
  const [updated] = await database
    .update(sessions)
    .set({ sessionOperationHeartbeatAt: now, updatedAt: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.sessionOperation, operation),
        eq(sessions.sessionOperationAt, operationAt),
      ),
    )
    .returning({ heartbeatAt: sessions.sessionOperationHeartbeatAt });
  return updated?.heartbeatAt ?? null;
}

/** Keep an external cleanup operation from becoming reclaimable while it runs. */
export function startSessionOperationHeartbeat(
  database: Database,
  sessionId: string,
  operation: SessionOperation,
  operationAt: Date,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void renewSessionOperation(database, sessionId, operation, operationAt)
      .then((heartbeatAt) => {
        if (heartbeatAt || stopped) return;
        stopped = true;
        clearInterval(timer);
        onError?.(new Error("session operation lease was replaced"));
      })
      .catch((error: unknown) => {
        if (!stopped) onError?.(error);
      });
  }, SESSION_OPERATION_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function releaseSessionOperation(
  database: Database,
  sessionId: string,
  operation: SessionOperation,
  operationAt: Date,
): Promise<boolean> {
  const updated = await database
    .update(sessions)
    .set({ ...CLEARED_SESSION_OPERATION, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.sessionOperation, operation),
        eq(sessions.sessionOperationAt, operationAt),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}
