import { describe, expect, it } from "vitest";
import { bindTestDatabase, seedSession } from "../test-support";
import type { Database } from "./client";
import { claimNextRun, completeRun } from "./runs";
import {
  createSessionTurn,
  findSessionRunsToPark,
  getSession,
  listSessionRuns,
  parkSession,
  saveSessionCheckpoint,
  saveSessionDiffBaseSha,
} from "./sessions";

let database: Database;
bindTestDatabase((value) => {
  database = value;
});

describe("durable sessions", () => {
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
    const second = await createSessionTurn(
      database,
      session.id,
      "Inspect the same checkout",
      "token",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );

    expect(second.turnNumber).toBe(2);
    expect(second.trigger.repo).toEqual(session.repo);
    expect(second.trigger.prompt).toBe("Inspect the same checkout");
  });
});
