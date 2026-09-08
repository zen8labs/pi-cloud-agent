import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { renewProvisioningClaim } from "../db/provisioning";
import * as runDb from "../db/runs";
import { runs, sessions } from "../db/schema";
import { releaseStaleReconcilerOperations } from "../db/session-operations";
import * as support from "../test-support";
import { fakeProvider } from "./fake-sandbox-provider";
import { createReconciler } from "./loop";

let database: Database;
support.bindTestDatabase((value) => {
  database = value;
});

describe("provisioning ownership", () => {
  it("recovers a stale parking claim without clearing a live operation", async () => {
    const { session } = await support.seedSession(database);
    await database
      .update(sessions)
      .set({
        sessionOperation: "parking",
        sessionOperationAt: new Date(),
        sessionOperationHeartbeatAt: new Date(),
      })
      .where(eq(sessions.id, session.id));
    await releaseStaleReconcilerOperations(database);
    expect(await runDb.claimNextRun(database, 120)).toBeNull();
    await database
      .update(sessions)
      .set({ sessionOperationHeartbeatAt: new Date(0) })
      .where(eq(sessions.id, session.id));
    await releaseStaleReconcilerOperations(database);
    expect((await runDb.claimNextRun(database, 120))?.sessionId).toBe(session.id);
  });

  it("does not launch or fail a newer attempt after a slow image build loses its lease", async () => {
    const run = await support.seedRun(database);
    const provider = fakeProvider();
    let entered = () => {};
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolutions = 0;
    provider.resolveImage = async () => {
      resolutions += 1;
      if (resolutions === 1) {
        entered();
        await released;
      }
      return "fake:pinned";
    };
    const launched: string[] = [];
    provider.create = async (spec) => {
      const ref = { provider: "fake", id: `machine-${resolutions}-${launched.length}` };
      await spec.onAllocated?.(ref);
      launched.push(ref.id);
      return ref;
    };
    const makeLoop = () =>
      createReconciler({
        config: support.testConfig({ SANDBOX_PROVIDER: "fake" }),
        database,
        broker: support.testCredentialBroker,
        log: support.silentLogger(),
        createProvider: () => provider,
      });
    const first = makeLoop();
    await first.tick();
    await resolving;
    await database
      .update(runs)
      .set({ claimExpiresAt: new Date(0) })
      .where(eq(runs.id, run.id));
    const second = makeLoop();
    await second.tick();
    await second.drain();
    release();
    await first.drain();
    expect(launched).toHaveLength(1);
    expect((await runDb.getRun(database, run.id))?.status).toBe("running");
    expect((await runDb.getRun(database, run.id))?.attempt).toBe(2);
  });

  it("renews only a live claim and does not reclaim a renewed lease", async () => {
    const run = await support.seedRun(database);
    const claimed = await runDb.claimNextRun(database, 30);
    if (!claimed) throw new Error("missing claim");
    expect(await renewProvisioningClaim(database, claimed, 120)).toBe(true);
    expect(
      await runDb.requeueRun(database, run.id, { attempt: claimed.attempt, expired: true }),
    ).toBe(false);
    await database
      .update(runs)
      .set({ claimExpiresAt: new Date(0) })
      .where(eq(runs.id, run.id));
    expect(await renewProvisioningClaim(database, claimed, 120)).toBe(false);
    expect(
      await runDb.attachSandbox(
        database,
        run.id,
        { provider: "fake", id: "expired" },
        new Date(),
        claimed.attempt,
      ),
    ).toBe(false);
  });
});
