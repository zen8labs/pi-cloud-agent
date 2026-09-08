import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendEvent, claimNextRun, completeRun, getRun } from "../db/runs";
import { runs } from "../db/schema";
import { seedRun } from "../test-support";
import { fakeProvider } from "./fake-sandbox-provider";
import { database, reconciler, tick } from "./reconciler-test-support";

async function setRunTimestamp(
  runId: string,
  field: "deadlineAt" | "lastEventAt",
  value: Date,
): Promise<void> {
  const values = field === "deadlineAt" ? { deadlineAt: value } : { lastEventAt: value };
  await database.update(runs).set(values).where(eq(runs.id, runId));
}

describe("recovery", () => {
  it("fails and reclaims a run that passed its deadline", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    await setRunTimestamp(run.id, "deadlineAt", new Date(Date.now() - 1000));
    await tick(loop);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("wall-clock budget");
    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("fails a sandbox that stopped reporting", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider, { silenceTimeoutSeconds: 30 });

    await tick(loop);
    await appendEvent(database, run.id, "token", { content: "working" });
    await setRunTimestamp(run.id, "lastEventAt", new Date(Date.now() - 120_000));
    await tick(loop);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("stopped reporting");
    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("recovers a run whose worker died between claiming and provisioning", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, -1);

    const provider = fakeProvider();
    const loop = reconciler(provider);
    await tick(loop);

    // Requeued and then picked up in the same pass: no operator intervention.
    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("running");
    expect(stored?.attempt).toBe(2);
  });

  it("leaves a live run alone across a restart", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();

    await tick(reconciler(provider));
    // A brand new reconciler, as if the process had just booted.
    await tick(reconciler(provider));

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("running");
    expect(stored?.error).toBeNull();
    expect(provider.stopped).toEqual([]);
  });

  it("completes a run from a callback that arrives after a restart", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    await tick(reconciler(provider));

    // The sandbox kept working while the controller was gone and reports now.
    await appendEvent(database, run.id, "status", { status: "done" });
    expect(await completeRun(database, run.id, "succeeded")).toBe(true);

    await tick(reconciler(provider));
    expect((await getRun(database, run.id))?.status).toBe("succeeded");
    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("cleans up a machine created for a run that was cancelled mid-create", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    provider.create = async (spec) => {
      // Cancel lands while the provider is still working.
      await completeRun(database, spec.runId, "cancelled");
      return { provider: "fake", id: "sb-orphan" };
    };

    await tick(reconciler(provider));

    // attachSandbox refused, so provisioning owns the cleanup — the id was never
    // stored and the reconciler would otherwise never learn about it.
    expect(provider.stopped).toEqual(["sb-orphan"]);
    expect((await getRun(database, run.id))?.sandboxId).toBeNull();
  });

  it("stops an allocated machine when cancellation wins before launch is recorded", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    provider.create = async (spec) => {
      const ref = { provider: "fake", id: "sb-cancelled-after-attach" };
      await spec.onAllocated?.(ref);
      await completeRun(database, spec.runId, "cancelled");
      return ref;
    };

    await tick(reconciler(provider));

    expect(provider.stopped).toEqual(["sb-cancelled-after-attach"]);
    expect((await getRun(database, run.id))?.status).toBe("cancelled");
    expect((await getRun(database, run.id))?.sandboxStoppedAt).not.toBeNull();
  });
});
