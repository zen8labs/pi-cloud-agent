import {
  SANDBOX_ENV,
  SandboxError,
  type SandboxProvider,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../db/client";
import { appendEvent, attachSandbox, claimNextRun, completeRun, getRun } from "../db/runs";
import { runs } from "../db/schema";
import { createSessionTurn, getSession } from "../db/sessions";
import type { CredentialBroker } from "../secrets/broker";
import {
  resetTables,
  seedRun,
  seedSession,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { createReconciler, type Reconciler } from "./loop";

/** The reconciler, driven one tick at a time against real durable state. */

let database: Database;

/** A sandbox provider that records what it was asked to do. */
function fakeProvider(
  behavior: { failWith?: SandboxError; resumeMissing?: boolean } = {},
): SandboxProvider & {
  created: SandboxSpec[];
  resumeSpecs: SandboxSpec[];
  stopped: string[];
  resumed: string[];
  suspended: string[];
  deleted: string[];
} {
  const created: SandboxSpec[] = [];
  const resumeSpecs: SandboxSpec[] = [];
  const stopped: string[] = [];
  const resumed: string[] = [];
  const suspended: string[] = [];
  const deleted: string[] = [];
  return {
    name: "fake",
    created,
    resumeSpecs,
    stopped,
    resumed,
    suspended,
    deleted,
    async create(spec) {
      if (behavior.failWith) throw behavior.failWith;
      created.push(spec);
      return { provider: "fake", id: `sb-${created.length}` };
    },
    async resume(ref, spec) {
      if (behavior.resumeMissing) throw new WorkspaceNotFoundError("workspace expired");
      resumed.push(ref.id);
      resumeSpecs.push(spec);
      return { provider: "fake", id: ref.id };
    },
    async suspend(ref) {
      suspended.push(ref.id);
      return { provider: "fake", id: ref.id };
    },
    async deleteWorkspace(ref) {
      deleted.push(ref.id);
    },
    async stop(ref) {
      stopped.push(ref.id);
    },
  };
}

const broker: CredentialBroker = {
  async mintForRun() {
    return {
      model: {
        connectionId: "00000000-0000-4000-8000-000000000099",
        authType: "api_key",
        provider: "test-provider",
        name: "test-model",
        api: "openai-completions",
        baseUrl: "https://model.example.test/v1",
        contextWindow: 16_384,
        maxTokens: 2_048,
        apiKey: "test-key",
        authJson: null,
      },
      secrets: {},
      env: {},
    };
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

/** One full pass, including detached provisioning. */
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
  it("suspends a session workspace and resumes it for the next turn", async () => {
    const { session, run } = await seedSession(database);
    const provider = fakeProvider();
    const loop = reconciler(provider);

    await tick(loop);
    expect(provider.created[0]?.env[SANDBOX_ENV.sessionId]).toBe(session.id);
    expect(provider.created[0]?.env[SANDBOX_ENV.workspaceResumed]).toBe("false");

    await completeRun(database, run.id, "succeeded");
    let releaseBoth = () => {};
    const bothSuspended = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    provider.suspend = async (ref) => {
      provider.suspended.push(ref.id);
      if (provider.suspended.length === 2) releaseBoth();
      await bothSuspended;
      return ref;
    };
    await Promise.all([loop.tick(), reconciler(provider).tick()]);

    expect(provider.suspended).toEqual(["sb-1", "sb-1"]);
    expect(provider.deleted).toEqual([]);
    expect(provider.stopped).toEqual([]);
    expect((await getSession(database, session.id))?.sandboxId).toBe("sb-1");

    const followUp = await createSessionTurn(
      database,
      session.id,
      "Read the file created in the previous turn.",
      "follow-up-token",
    );
    await tick(loop);

    expect(provider.created).toHaveLength(1);
    expect(provider.resumed).toEqual(["sb-1"]);
    expect(provider.resumeSpecs[0]?.runId).toBe(followUp.id);
    expect(provider.resumeSpecs[0]?.env[SANDBOX_ENV.workspaceResumed]).toBe("true");
    expect(provider.resumeSpecs[0]?.env[SANDBOX_ENV.taskPrompt]).toBe(
      "Read the file created in the previous turn.",
    );
    expect((await getRun(database, followUp.id))?.sandboxId).toBe("sb-1");
  });

  it("cold-starts from the durable checkpoint when a parked workspace disappeared", async () => {
    const { session, run } = await seedSession(database);
    const healthy = fakeProvider();
    const firstLoop = reconciler(healthy);
    await tick(firstLoop);
    await completeRun(database, run.id, "succeeded");
    await tick(firstLoop);

    const followUp = await createSessionTurn(database, session.id, "Continue cold.", "token");
    const missing = fakeProvider({ resumeMissing: true });
    await tick(reconciler(missing));

    expect(missing.created).toHaveLength(1);
    expect(missing.created[0]?.env[SANDBOX_ENV.workspaceResumed]).toBe("false");
    expect((await getRun(database, followUp.id))?.status).toBe("running");
    expect((await getSession(database, session.id))?.sandboxId).toBeNull();
  });

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
