import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import * as runs from "../db/runs";
import { claimSessionOperation, releaseSessionOperation } from "../db/session-operations";
import * as sessionDb from "../db/sessions";
import * as support from "../test-support";
import { fakeProvider } from "./fake-sandbox-provider";
import { createReconciler, type Reconciler } from "./loop";

let database: Database;
support.bindTestDatabase((value) => {
  database = value;
});

function reconciler(provider: ReturnType<typeof fakeProvider>): Reconciler {
  return createReconciler({
    config: support.testConfig({ SANDBOX_PROVIDER: "fake" }),
    database,
    broker: support.testCredentialBroker,
    log: support.silentLogger(),
    createProvider: () => provider,
  });
}

async function tick(loop: Reconciler): Promise<void> {
  await loop.tick();
  await loop.drain();
}

function providerWithFailingCheckpointDelete(prefix: string) {
  const provider = fakeProvider();
  let deleteAttempts = 0;
  provider.suspend = async (ref) => {
    provider.suspended.push(ref.id);
    return { provider: "fake", id: `${prefix}-${provider.suspended.length}` };
  };
  provider.deleteWorkspace = async (ref) => {
    provider.deleted.push(ref.id);
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("checkpoint cleanup unavailable");
  };
  return provider;
}

describe("session checkpoint races", () => {
  it("rejects a follow-up while expiry is deleting its checkpoint", async () => {
    const { session, run } = await support.seedSession(database);
    await runs.completeRun(database, run.id, "succeeded");
    await sessionDb.parkSession(
      database,
      run,
      { provider: "fake", id: "checkpoint-expiry-race" },
      new Date(Date.now() - 1_000),
    );

    const provider = fakeProvider();
    let deletionStarted = () => {};
    const deletionEntered = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    let releaseDeletion = () => {};
    const deletionReleased = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    provider.deleteWorkspace = async () => {
      deletionStarted();
      await deletionReleased;
    };
    const expiry = reconciler(provider).tick();
    await deletionEntered;

    await expect(
      sessionDb.createSessionTurn(
        database,
        session.id,
        "Must not cold-start during expiry",
        "follow-up-token",
        null,
        { model: session.model, modelConnectionId: session.modelConnectionId },
      ),
    ).rejects.toBeInstanceOf(sessionDb.SessionBusyError);

    releaseDeletion();
    await expiry;
    const stored = await sessionDb.getSession(database, session.id);
    expect(stored?.sandboxId).toBeNull();
    expect(stored?.sessionOperation).toBeNull();
  });

  it("pins a provider default image for stable cold resumes", async () => {
    const { session, run } = await support.seedSession(database);
    const provider = fakeProvider();
    provider.resolveImage = async () => "fake:default-v1";
    const loop = reconciler(provider);

    await tick(loop);
    expect((await sessionDb.getSession(database, session.id))?.sandboxImageRef).toBe(
      "fake:default-v1",
    );

    await runs.completeRun(database, run.id, "succeeded");
    await tick(loop);
    provider.resolveImage = async () => "fake:default-v2";
    const followUp = await sessionDb.createSessionTurn(
      database,
      session.id,
      "Resume the existing workspace",
      "follow-up-token",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );
    await tick(loop);

    expect(provider.resumeSpecs[0]?.image).toBe("fake:default-v1");
    expect((await runs.getRun(database, followUp.id))?.status).toBe("running");
  });

  it("retries source finalization after the checkpoint commit survives a failure", async () => {
    const { session, run } = await support.seedSession(database);
    const provider = fakeProvider();
    let attempts = 0;
    provider.finalizeSuspend = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider cleanup unavailable");
    };
    const loop = reconciler(provider);

    await tick(loop);
    await runs.completeRun(database, run.id, "succeeded");
    await tick(loop);

    expect(attempts).toBe(1);
    expect((await sessionDb.getSession(database, session.id))?.sandboxId).toBe("sb-1");
    expect((await runs.getRun(database, run.id))?.sandboxFinalizationWorkspaceId).toBe("sb-1");

    await tick(loop);

    expect(attempts).toBe(2);
    expect((await runs.getRun(database, run.id))?.sandboxFinalizationWorkspaceId).toBeNull();
  });

  it("retries deletion of a replaced checkpoint after a provider failure", async () => {
    const { session, run } = await support.seedSession(database);
    const provider = providerWithFailingCheckpointDelete("checkpoint");
    const loop = reconciler(provider);

    await tick(loop);
    await runs.completeRun(database, run.id, "succeeded");
    await tick(loop);
    const followUp = await sessionDb.createSessionTurn(
      database,
      session.id,
      "Continue with the replacement checkpoint",
      "follow-up-token",
      null,
      { model: session.model, modelConnectionId: session.modelConnectionId },
    );
    await tick(loop);
    await runs.completeRun(database, followUp.id, "succeeded");
    await tick(loop);

    expect((await sessionDb.getSession(database, session.id))?.sandboxId).toBe("checkpoint-2");
    expect((await runs.getRun(database, followUp.id))?.sandboxReplacementWorkspaceId).toBe(
      "checkpoint-1",
    );

    await tick(loop);

    expect(provider.deleted).toEqual(["checkpoint-1", "checkpoint-1"]);
    expect(
      (await runs.getRun(database, followUp.id))?.sandboxReplacementWorkspaceId,
    ).toBeNull();
  });

  it("retains an unowned checkpoint cleanup marker after a lost park lease", async () => {
    const { session, run } = await support.seedSession(database);
    const provider = providerWithFailingCheckpointDelete("unowned-checkpoint");
    const loop = reconciler(provider);

    await tick(loop);
    await runs.completeRun(database, run.id, "succeeded");
    const operationAt = await claimSessionOperation(database, session.id, "archiving", {
      activeRunId: run.id,
      latestRunId: session.latestRunId,
    });
    expect(operationAt).not.toBeNull();

    await tick(loop);

    expect(provider.deleted).toEqual(["unowned-checkpoint-1"]);
    expect((await runs.getRun(database, run.id))?.sandboxReplacementWorkspaceId).toBe(
      "unowned-checkpoint-1",
    );

    await releaseSessionOperation(database, session.id, "archiving", operationAt ?? new Date());
    await tick(loop);

    expect(provider.deleted).toEqual(["unowned-checkpoint-1", "unowned-checkpoint-1"]);
    expect((await runs.getRun(database, run.id))?.sandboxReplacementWorkspaceId).toBeNull();
  });
});
