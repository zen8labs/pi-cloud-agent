import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "./client";
import { type SessionOperation, sessions } from "./schema";

const SESSION_OPERATION_STALE_MS = 10 * 60 * 1000;

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
      or(isNull(sessions.sessionOperationAt), lt(sessions.sessionOperationAt, staleBefore)),
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
    .set({ sessionOperation: operation, sessionOperationAt: now, updatedAt: now })
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

export async function releaseSessionOperation(
  database: Database,
  sessionId: string,
  operation: SessionOperation,
  operationAt: Date,
): Promise<boolean> {
  const updated = await database
    .update(sessions)
    .set({ sessionOperation: null, sessionOperationAt: null, updatedAt: new Date() })
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
