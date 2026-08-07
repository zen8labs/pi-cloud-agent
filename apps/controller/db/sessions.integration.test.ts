import { describe, expect, it } from "vitest";
import { bindTestDatabase, seedSession } from "../test-support";
import type { Database } from "./client";
import { completeRun } from "./runs";
import {
  createSessionTurn,
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

describe("durable sessions", () => {
  it("allows only one active turn against a workspace", async () => {
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

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      SessionBusyError,
    );
    expect(await listSessionRuns(database, session.id)).toHaveLength(2);
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
