import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import * as runs from "../db/runs";
import { claimSessionOperation, releaseSessionOperation } from "../db/session-operations";
import { markSessionSandboxReplacementPending } from "../db/session-workspace";
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

async function expectDeletionRetried(
  loop: Reconciler,
  provider: ReturnType<typeof fakeProvider>,
  runId: string,
) {
  expect((await runs.getRun(database, runId))?.sandboxReplacementWorkspaceId).toBe(
    "checkpoint-1",
  );
  await tick(loop);
  expect(provider.deleted).toEqual(["checkpoint-1", "checkpoint-1"]);
  expect((await runs.getRun(database, runId))?.sandboxReplacementWorkspaceId).toBeNull();
}

describe("session checkpoint races", () => {
  it("finishes old cleanup before another reconciler can reuse the snapshot path", async () => {
    const { session, run } = await support.seedSession(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);
    await tick(loop);
    await runs.completeRun(database, run.id, "succeeded");
    const checkpoint = { provider: "fake", id: "same-snapshot-path" };
    await markSessionSandboxReplacementPending(database, run.id, checkpoint);
    let entered = () => {};
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.deleteWorkspace = async (ref) => {
      provider.deleted.push(ref.id);
      entered();
      await released;
    };
    provider.suspend = async (ref) => {
      provider.suspended.push(ref.id);
      return checkpoint;
    };
    const first = loop.tick();
    await deleting;
    await reconciler(provider).tick();
    expect(provider.suspended).toEqual([]);
    release();
    await first;
    expect(provider.suspended).toEqual(["sb-1"]);
    await tick(reconciler(provider));
    expect(provider.deleted).toEqual([checkpoint.id]);
    expect((await sessionDb.getSession(database, session.id))?.sandboxId).toBe(checkpoint.id);
  });

  it.each(["suspension", "resume preparation"])(
    "preserves the last valid checkpoint after failed %s",
    async (failure) => {
      const { session, run } = await support.seedSession(database);
      const provider = providerWithFailingCheckpointDelete("checkpoint");
      const loop = reconciler(provider);
      await tick(loop);
      await runs.completeRun(database, run.id, "succeeded");
      await tick(loop);
      const followUp = await sessionDb.createSessionTurn(
        database,
        session.id,
        "Continue",
        "token",
        null,
        { model: session.model, modelConnectionId: session.modelConnectionId },
      );
      provider.resume = async (_ref, spec) => {
        const live = { provider: "fake", id: "resumed-live" };
        await spec.onAllocated?.(live);
        if (failure === "resume preparation")
          throw new Error("runtime installation failed; live copy removed");
        return live;
      };
      await tick(loop);
      provider.suspend = async () => {
        throw new Error("snapshot failed");
      };
      await runs.completeRun(database, followUp.id, "succeeded");
      await tick(loop);
      expect((await sessionDb.getSession(database, session.id))?.sandboxId).toBe(
        "checkpoint-1",
      );
      expect(
        (await runs.getRun(database, followUp.id))?.sandboxReplacementWorkspaceId,
      ).toBeNull();
      await tick(loop);
      expect(provider.deleted).toEqual([]);
      provider.resume = async (ref, spec) => {
        provider.resumed.push(ref.id);
        await spec.onAllocated?.({ provider: "fake", id: "next-live" });
        return { provider: "fake", id: "next-live" };
      };
      const next = await sessionDb.createSessionTurn(
        database,
        session.id,
        "Retry",
        "next-token",
        null,
        { model: session.model, modelConnectionId: session.modelConnectionId },
      );
      await tick(loop);
      expect(provider.resumed).toContain("checkpoint-1");
      expect((await runs.getRun(database, next.id))?.status).toBe("running");
    },
  );

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
    await expectDeletionRetried(loop, provider, followUp.id);
  });

  it("does not create a checkpoint while archiving owns the session", async () => {
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

    expect(provider.deleted).toEqual([]);
    expect(provider.suspended).toEqual([]);

    await releaseSessionOperation(database, session.id, "archiving", operationAt ?? new Date());
    await tick(loop);

    expect(provider.deleted).toEqual([]);
    expect((await sessionDb.getSession(database, session.id))?.sandboxId).toBe(
      "unowned-checkpoint-1",
    );
    expect((await runs.getRun(database, run.id))?.sandboxReplacementWorkspaceId).toBeNull();
  });
});
