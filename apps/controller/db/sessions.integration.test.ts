import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bindTestDatabase, seedSession } from "../test-support";
import type { Database } from "./client";
import { claimNextRun, completeRun } from "./runs";
import { sessions } from "./schema";
import { pinSessionSandboxImage } from "./session-images";
import { claimSessionOperation, renewSessionOperation } from "./session-operations";
import {
  clearSessionWorkspace,
  createSessionTurn,
  findSessionRunsToPark,
  getSession,
  listSessionRuns,
  parkSession,
  SessionBusyError,
  saveSessionCheckpoint,
  saveSessionDiffBaseSha,
} from "./sessions";

let database: Database;
bindTestDatabase((value) => {
  database = value;
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSessionLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await database.$client<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query like '%"sessions"%'
    `;
    if ((rows[0]?.count ?? 0) >= count) return;
  }
  throw new Error(`expected ${count} session lock waiters`);
}

describe("durable sessions", () => {
  it("returns one canonical image when concurrent workers pin a session", async () => {
    const { session } = await seedSession(database);

    const [first, second] = await Promise.all([
      pinSessionSandboxImage(database, session.id, "fake:image-a"),
      pinSessionSandboxImage(database, session.id, "fake:image-b"),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect((await getSession(database, session.id))?.sandboxImageRef).toBe(first);
  });

  it("queues concurrent turns while preserving one active workspace owner", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, null, null);

    const results = await Promise.allSettled([
      createSessionTurn(database, session.id, "First follow-up", "token-a", null, {
        model: session.model,
        modelConnectionId: session.modelConnectionId,
      }),
      createSessionTurn(database, session.id, "Racing follow-up", "token-b", null, {
        model: session.model,
        modelConnectionId: session.modelConnectionId,
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const turns = await listSessionRuns(database, session.id);
    expect(turns.map((turn) => turn.turnNumber)).toEqual([1, 2, 3]);
    expect((await getSession(database, session.id))?.activeRunId).toBe(turns[1]?.id);
  });

  it("promotes the oldest queued turn only after the active workspace is parked", async () => {
    const { session, run } = await seedSession(database);
    const second = await createSessionTurn(database, session.id, "Second", "token-2", null, {
      model: session.model,
      modelConnectionId: session.modelConnectionId,
    });
    const third = await createSessionTurn(database, session.id, "Third", "token-3", null, {
      model: session.model,
      modelConnectionId: session.modelConnectionId,
    });

    expect((await getSession(database, session.id))?.activeRunId).toBe(run.id);
    const claimed = await claimNextRun(database, 30);
    expect(claimed?.id).toBe(run.id);
    expect(claimed?.id).not.toBe(second.id);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, { provider: "fake", id: "workspace-1" }, new Date());

    expect((await getSession(database, session.id))?.activeRunId).toBe(second.id);
    expect((await getSession(database, session.id))?.activeRunId).not.toBe(third.id);
  });

  it("cannot orphan a follow-up queued while the active turn is parking", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    const lockAcquired = deferred();
    const releaseLock = deferred();
    const blocker = database.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .for("update");
      lockAcquired.resolve();
      await releaseLock.promise;
    });

    await lockAcquired.promise;
    const creating = createSessionTurn(
      database,
      session.id,
      "Do not lose me",
      "token-2",
      null,
      {
        model: session.model,
        modelConnectionId: session.modelConnectionId,
      },
    );
    await waitForSessionLockWaiters(1);
    const parking = parkSession(database, run, null, null);
    await waitForSessionLockWaiters(2);
    releaseLock.resolve();

    const [created, parked] = await Promise.all([creating, parking]);
    await blocker;
    expect(parked).toBe(true);
    expect((await getSession(database, session.id))?.activeRunId).toBe(created.id);
    expect((await claimNextRun(database, 30))?.id).toBe(created.id);
  });

  it("does not park a queued turn that was cancelled before it owned the workspace", async () => {
    const { session, run } = await seedSession(database);
    const queued = await createSessionTurn(database, session.id, "Delete me", "token-2", null, {
      model: session.model,
      modelConnectionId: session.modelConnectionId,
    });
    await completeRun(database, run.id, "succeeded", null);
    await completeRun(database, queued.id, "cancelled", "removed from queue");

    expect(
      (await findSessionRunsToPark(database, 10)).map((candidate) => candidate.id),
    ).toEqual([run.id]);
  });

  it("preserves the parked workspace when a promoted turn stops before provisioning", async () => {
    const { session, run } = await seedSession(database);
    const promoted = await createSessionTurn(
      database,
      session.id,
      "Stop me early",
      "token-2",
      null,
      {
        model: session.model,
        modelConnectionId: session.modelConnectionId,
      },
    );
    const expiresAt = new Date(Date.now() + 60_000);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, { provider: "fake", id: "workspace-1" }, expiresAt);
    await completeRun(database, promoted.id, "cancelled", "cancelled before provisioning");

    expect(await parkSession(database, promoted, undefined, null)).toBe(true);
    const stored = await getSession(database, session.id);
    expect(stored?.activeRunId).toBeNull();
    expect(stored?.sandboxProvider).toBe("fake");
    expect(stored?.sandboxId).toBe("workspace-1");
    expect(stored?.workspaceExpiresAt).toEqual(expiresAt);
    expect(stored?.retentionStatus).toBe("active");
  });

  it("persists checkpoints only from the active session head", async () => {
    const { session, run } = await seedSession(database);
    expect(await saveSessionCheckpoint(database, run, '{"type":"session"}\n')).toBe(true);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, { provider: "fake", id: "workspace-1" }, new Date());

    expect(await saveSessionCheckpoint(database, run, "stale")).toBe(false);
    const stored = await getSession(database, session.id);
    expect(stored?.agentCheckpoint).toBe('{"type":"session"}\n');
    expect(stored?.sandboxId).toBe("workspace-1");
    expect(stored?.activeRunId).toBeNull();
  });

  it("persists the first turn's revision as the immutable session diff base", async () => {
    const { session, run } = await seedSession(database);

    expect(await saveSessionDiffBaseSha(database, run, "base-sha")).toBe(true);
    expect(await saveSessionDiffBaseSha(database, run, "another-sha")).toBe(false);

    const stored = await getSession(database, session.id);
    expect(stored?.diffBaseSha).toBe("base-sha");
  });

  it("numbers turns monotonically and preserves the session repository", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, null, null);
    expect((await getSession(database, session.id))?.retentionStatus).toBe("inactive");
    const second = await createSessionTurn(
      database,
      session.id,
      "Inspect the same checkout",
      "token",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );

    expect(second.turnNumber).toBe(2);
    expect((await getSession(database, session.id))?.retentionStatus).toBe("active");
    expect(second.trigger.repo).toEqual(session.repo);
    expect(second.trigger.prompt).toBe("Inspect the same checkout");
  });

  it("does not clear an expired checkpoint after a follow-up claims the session", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, { provider: "fake", id: "workspace-1" }, new Date());
    const followUp = await createSessionTurn(
      database,
      session.id,
      "Resume while expiry is being reconciled",
      "token-2",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );

    expect(await clearSessionWorkspace(database, session.id, "workspace-1", null)).toBe(false);
    const stored = await getSession(database, session.id);
    expect(stored?.activeRunId).toBe(followUp.id);
    expect(stored?.sandboxId).toBe("workspace-1");
  });

  it("reclaims a stale cleanup claim so a crashed archive cannot block a follow-up", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, null, null);
    const operationAt = new Date(Date.now() - 60 * 1000);
    await database
      .update(sessions)
      .set({
        sessionOperation: "archiving",
        sessionOperationAt: operationAt,
        sessionOperationHeartbeatAt: new Date(Date.now() - 11 * 60 * 1000),
      })
      .where(eq(sessions.id, session.id));

    const followUp = await createSessionTurn(
      database,
      session.id,
      "Continue after the archive worker crashed.",
      "token-recovery",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );

    expect(followUp.turnNumber).toBe(2);
    expect((await getSession(database, session.id))?.sessionOperation).toBeNull();
  });

  it("does not reclaim a cleanup claim while its heartbeat is current", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, null, null);
    await database
      .update(sessions)
      .set({
        sessionOperation: "archiving",
        sessionOperationAt: new Date(Date.now() - 11 * 60 * 1000),
        sessionOperationHeartbeatAt: new Date(),
      })
      .where(eq(sessions.id, session.id));

    await expect(
      createSessionTurn(database, session.id, "Do not overlap cleanup", "token-busy", null, {
        model: session.model,
        modelConnectionId: session.modelConnectionId,
      }),
    ).rejects.toBeInstanceOf(SessionBusyError);
  });

  it("renews only the operation that still owns the session claim", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, null, null);
    const operationAt = await claimSessionOperation(database, session.id, "archiving", {
      activeRunId: null,
    });
    expect(operationAt).not.toBeNull();
    if (!operationAt) throw new Error("session operation claim missing");

    expect(
      await renewSessionOperation(database, session.id, "archiving", operationAt),
    ).not.toBeNull();
    expect(
      await renewSessionOperation(database, session.id, "archiving", new Date(0)),
    ).toBeNull();
  });

  it("retains the provider identity when a workspace checkpoint is cleared", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded", null);
    await parkSession(database, run, { provider: "e2b", id: "checkpoint-1" }, null);

    expect(await clearSessionWorkspace(database, session.id, "checkpoint-1", null)).toBe(true);
    const stored = await getSession(database, session.id);
    expect(stored?.sandboxProvider).toBe("e2b");
    expect(stored?.sandboxId).toBeNull();
  });
});
