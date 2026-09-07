import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import * as runs from "../db/runs";
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
});
