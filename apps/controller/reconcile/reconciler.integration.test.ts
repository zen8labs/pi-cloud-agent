import {
  SANDBOX_ENV,
  SandboxError,
  type SandboxProvider,
  type SandboxSpec,
} from "@pi-cloud-agent/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../db/client";
import { setRepoConfig } from "../db/repo-config";
import { appendEvent, attachSandbox, claimNextRun, completeRun, getRun } from "../db/runs";
import { runs } from "../db/schema";
import type { CredentialBroker } from "../secrets/broker";
import {
  resetTables,
  seedRun,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { createReconciler, type Reconciler } from "./loop";

/**
 * The reconciler, driven one tick at a time against real state.
 *
 * This is the file that demonstrates the central claim of the redesign: the
 * controller holds nothing in memory, so a crash is indistinguishable from a slow
 * tick. Several tests below simulate a crash simply by never calling the rest of
 * the provisioning path and then ticking again — which is exactly what a restart
 * looks like from the database's point of view.
 */

let database: Database;

/** A sandbox provider that records what it was asked to do. */
function fakeProvider(behavior: { failWith?: SandboxError } = {}): SandboxProvider & {
  created: SandboxSpec[];
  stopped: string[];
} {
  const created: SandboxSpec[] = [];
  const stopped: string[] = [];
  return {
    name: "fake",
    created,
    stopped,
    async create(spec) {
      if (behavior.failWith) throw behavior.failWith;
      created.push(spec);
      return { provider: "fake", id: `sb-${created.length}` };
    },
    async stop(ref) {
      stopped.push(ref.id);
    },
  };
}

const broker: CredentialBroker = {
  async mintForRun() {
    return { secrets: {}, env: {} };
  },
};

function reconciler(
  provider: SandboxProvider,
  options: { silenceTimeoutSeconds?: number; claimLeaseSeconds?: number } = {},
): Reconciler {
  return createReconciler({
    config: testConfig({ SANDBOX_PROVIDER: "fake" }),
    database,
    broker,
    log: silentLogger(),
    createProvider: () => provider,
    ...options,
  });
}

/**
 * One full pass, including the provisioning it starts.
 *
 * `tick` deliberately detaches provisioning so a slow sandbox API cannot delay
 * timeouts, which means "the tick returned" is not "the work finished". Draining
 * makes the difference observable instead of racing it with a sleep.
 */
async function tick(loop: Reconciler): Promise<void> {
  await loop.tick();
  await loop.drain();
}

beforeAll(async () => {
  database = setupTestDatabase();
});

beforeEach(async () => {
  await resetTables(database);
});

afterAll(async () => {
  await closeDatabase(database);
});

describe("provisioning", () => {
  it("takes a queued run all the way to running in one tick", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();

    await tick(reconciler(provider));

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("running");
    expect(stored?.sandboxId).toBe("sb-1");
    expect(stored?.deadlineAt).not.toBeNull();
    expect(provider.created).toHaveLength(1);
  });

  it("hands the sandbox a complete environment and the composed prompt", async () => {
    await seedRun(database, { profile: "general" });
    const provider = fakeProvider();

    await tick(reconciler(provider));

    const env = provider.created[0]?.env ?? {};
    expect(env[SANDBOX_ENV.taskPrompt]).toBe("Summarize this repository.");
    expect(env[SANDBOX_ENV.repoCloneUrl]).toBe("https://github.com/acme/widgets.git");
    expect(env[SANDBOX_ENV.controlPlaneUrl]).toBe("http://localhost:8080");
    expect(env[SANDBOX_ENV.callbackToken]).toBeUndefined();
    expect(provider.created[0]?.secrets[SANDBOX_ENV.callbackToken]).toHaveLength(32);
    expect(provider.created[0]?.command).toContain("run.js");
  });

  it("prepends the profile's skill, so the sandbox needs no profile code", async () => {
    await seedRun(database, {
      profile: "pr-review",
      trigger: {
        kind: "pr_opened",
        repo: {
          provider: "github",
          host: "github.com",
          owner: "acme",
          name: "widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          defaultBranch: "main",
          baseSha: "base",
          headSha: "head",
          headBranch: "feature",
          prNumber: 11,
        },
      },
    });
    const provider = fakeProvider();

    await tick(reconciler(provider));

    const prompt = provider.created[0]?.env[SANDBOX_ENV.taskPrompt] ?? "";
    expect(prompt).toContain("# PR review");
    expect(prompt).toContain("Review pull request #11");
  });

  it("applies the repo's stored profile config when building the task", async () => {
    await setRepoConfig(
      database,
      { provider: "github", repoFullName: "acme/widgets", profile: "pr-review" },
      { branch: "release" },
    );
    await seedRun(database, {
      profile: "pr-review",
      trigger: {
        kind: "pr_opened",
        repo: {
          provider: "github",
          host: "github.com",
          owner: "acme",
          name: "widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
          defaultBranch: "main",
          baseSha: "base",
          headSha: "head",
          headBranch: "feature",
          prNumber: 12,
        },
      },
    });
    const provider = fakeProvider();

    await tick(reconciler(provider));

    expect(provider.created[0]?.env[SANDBOX_ENV.repoDefaultBranch]).toBe("release");
  });

  it("fails a run permanently when the sandbox cannot be created", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider({
      failWith: new SandboxError("template missing", { retryable: false }),
    });

    await tick(reconciler(provider));

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("template missing");
  });

  it("returns a run to the queue when the failure was transient", async () => {
    const run = await seedRun(database);
    const flaky = fakeProvider({ failWith: new SandboxError("api blip", { retryable: true }) });

    await tick(reconciler(flaky));

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.attempt).toBe(1);

    // A later tick with a working provider picks it up — the run was never lost.
    const healthy = fakeProvider();
    await tick(reconciler(healthy));
    expect((await getRun(database, run.id))?.status).toBe("running");
  });

  it("stops retrying a transient failure eventually", async () => {
    const run = await seedRun(database);
    const flaky = fakeProvider({ failWith: new SandboxError("api blip", { retryable: true }) });
    const loop = reconciler(flaky);

    for (let attempt = 0; attempt < 4; attempt += 1) await tick(loop);

    expect((await getRun(database, run.id))?.status).toBe("failed");
  });
});

describe("completion and teardown", () => {
  it("reclaims the machine of a run that has finished", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    await completeRun(database, run.id, "succeeded");
    await tick(loop);

    expect(provider.stopped).toEqual(["sb-1"]);
    expect((await getRun(database, run.id))?.sandboxStoppedAt).not.toBeNull();
  });

  it("never stops the same machine twice", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    await completeRun(database, run.id, "succeeded");
    await tick(loop);
    await tick(loop);

    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("reclaims a cancelled run's machine, reusing the same path as a crash", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    // Cancelling only writes state; teardown is the reconciler's job.
    await completeRun(database, run.id, "cancelled", "cancelled by an operator");
    await tick(loop);

    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("gives up on a machine the provider cannot kill, rather than looping forever", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    provider.stop = async () => {
      throw new Error("provider is down");
    };
    const loop = reconciler(provider);

    await tick(loop);
    await completeRun(database, run.id, "succeeded");
    await tick(loop);

    expect((await getRun(database, run.id))?.sandboxStoppedAt).not.toBeNull();
  });
});

describe("recovery", () => {
  it("fails and reclaims a run that passed its deadline", async () => {
    const run = await seedRun(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    await database
      .update(runs)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(runs.id, run.id));
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
    await database
      .update(runs)
      .set({ lastEventAt: new Date(Date.now() - 120_000) })
      .where(eq(runs.id, run.id));
    await tick(loop);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("stopped reporting");
    expect(provider.stopped).toEqual(["sb-1"]);
  });

  it("recovers a run whose worker died between claiming and provisioning", async () => {
    // A crash in that window is the one case that used to strand a run. Simulate
    // it by claiming with an already-expired lease and never provisioning.
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
    // The regression that matters most: the previous design force-failed every
    // in-flight run on startup because completion lived in memory.
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
});

describe("concurrency", () => {
  it("provisions up to its limit and leaves the rest queued", async () => {
    for (let index = 0; index < 5; index += 1) await seedRun(database);

    const provider = fakeProvider();
    const loop = createReconciler({
      config: testConfig({ SANDBOX_PROVIDER: "fake" }),
      database,
      broker,
      log: silentLogger(),
      createProvider: () => provider,
      maxConcurrentProvisions: 2,
    });

    await tick(loop);

    expect(provider.created).toHaveLength(2);
    const remaining = await database.select().from(runs).where(eq(runs.status, "queued"));
    expect(remaining).toHaveLength(3);
  });

  it("does not touch a run another worker already provisioned", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 600);
    await attachSandbox(
      database,
      run.id,
      { provider: "other", id: "sb-elsewhere" },
      new Date(Date.now() + 600_000),
    );

    const provider = fakeProvider();
    await tick(reconciler(provider));

    expect(provider.created).toHaveLength(0);
    expect(provider.stopped).toHaveLength(0);
  });
});
