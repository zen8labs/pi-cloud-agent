import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTables, seedRun, setupTestDatabase } from "../test-support";
import { closeDatabase, type Database } from "./client";
import {
  appendEvent,
  attachSandbox,
  claimNextRun,
  completeRun,
  findExpiredRuns,
  findReclaimableClaims,
  findSandboxesToStop,
  findSilentRuns,
  getRun,
  getRunByCallbackToken,
  listEvents,
  markRunning,
  markSandboxStopped,
  requeueRun,
} from "./runs";
import { runs } from "./schema";

/**
 * The state layer, against a real Postgres.
 *
 * Everything here is a property of the SQL rather than of the TypeScript around
 * it: exclusive claiming, transitions that refuse to fire from the wrong state,
 * and a sequence counter that cannot skip or repeat. Substituting a fake database
 * would test the fake. See docs/resumability.md for why these are the properties
 * that matter.
 */

let database: Database;

beforeAll(async () => {
  database = setupTestDatabase();
});

beforeEach(async () => {
  await resetTables(database);
});

afterAll(async () => {
  await closeDatabase(database);
});

describe("claiming", () => {
  it("hands one run to exactly one worker", async () => {
    await seedRun(database);

    // Concurrent claims: `for update skip locked` means the loser steps over the
    // locked row and gets nothing, rather than blocking or double-claiming.
    const [first, second] = await Promise.all([
      claimNextRun(database, 60),
      claimNextRun(database, 60),
    ]);
    const claimed = [first, second].filter((run) => run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("provisioning");
    expect(claimed[0]?.attempt).toBe(1);
    expect(claimed[0]?.claimExpiresAt).not.toBeNull();
  });

  it("takes the oldest queued run first", async () => {
    const older = await seedRun(database);
    await database
      .update(runs)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, older.id));
    await seedRun(database);

    expect((await claimNextRun(database, 60))?.id).toBe(older.id);
  });

  it("returns null when the queue is empty", async () => {
    expect(await claimNextRun(database, 60)).toBeNull();
  });

  it("does not reclaim a run that already has a sandbox", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      run.id,
      { provider: "fake", id: "sb-1" },
      new Date(Date.now() + 1000),
    );
    expect(await claimNextRun(database, 60)).toBeNull();
  });
});

describe("transitions", () => {
  it("only advances from the state it expects", async () => {
    const run = await seedRun(database);

    // Not claimed yet, so there is nothing to mark running.
    expect(await markRunning(database, run.id)).toBe(false);
    await claimNextRun(database, 60);
    expect(await markRunning(database, run.id)).toBe(true);
    // Already running: a second attempt changes nothing and says so.
    expect(await markRunning(database, run.id)).toBe(false);
  });

  it("lets the first terminal decision win permanently", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);

    // This race is real: a sandbox posting `done` and the reconciler timing the
    // same run out can arrive together.
    expect(await completeRun(database, run.id, "succeeded")).toBe(true);
    expect(await completeRun(database, run.id, "failed", "too late")).toBe(false);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.error).toBeNull();
  });

  it("records the sandbox and the deadline together", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    const deadline = new Date(Date.now() + 30_000);

    expect(
      await attachSandbox(database, run.id, { provider: "fake", id: "sb-9" }, deadline),
    ).toBe(true);
    const stored = await getRun(database, run.id);
    expect(stored?.sandboxId).toBe("sb-9");
    expect(stored?.sandboxProvider).toBe("fake");
    expect(stored?.deadlineAt?.getTime()).toBe(deadline.getTime());
  });

  it("refuses to attach a sandbox to a run that has moved on", async () => {
    // This is what stops a cancelled run from being quietly resurrected by a
    // sandbox that finished booting a moment too late.
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    await completeRun(database, run.id, "cancelled");
    expect(
      await attachSandbox(database, run.id, { provider: "fake", id: "sb-x" }, new Date()),
    ).toBe(false);
  });

  it("only requeues a claim that never produced a sandbox", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    expect(await requeueRun(database, run.id)).toBe(true);
    expect((await getRun(database, run.id))?.status).toBe("queued");

    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      run.id,
      { provider: "fake", id: "sb-2" },
      new Date(Date.now() + 1000),
    );
    // A live sandbox means retrying would double-run the task.
    expect(await requeueRun(database, run.id)).toBe(false);
  });
});

describe("event log", () => {
  it("assigns gapless sequence numbers and stamps liveness", async () => {
    const run = await seedRun(database);

    const first = await appendEvent(database, run.id, "token", { content: "a" });
    const second = await appendEvent(database, run.id, "token", { content: "b" });
    expect([first, second]).toEqual([1, 2]);

    const stored = await getRun(database, run.id);
    expect(stored?.eventSeq).toBe(2);
    expect(stored?.lastEventAt).not.toBeNull();
  });

  it("never repeats a sequence number under concurrency", async () => {
    const run = await seedRun(database);

    // The counter lives on the run row and is bumped in the same transaction as
    // the insert, so concurrent writers serialize on the row lock instead of
    // both reading the same max(seq).
    const assigned = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendEvent(database, run.id, "token", { content: String(index) }),
      ),
    );
    expect(new Set(assigned).size).toBe(25);
    expect([...assigned].sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("reads back in order and supports resuming from a cursor", async () => {
    const run = await seedRun(database);
    for (const content of ["a", "b", "c"]) {
      await appendEvent(database, run.id, "token", { content });
    }

    expect((await listEvents(database, run.id, 0)).map((event) => event.seq)).toEqual([
      1, 2, 3,
    ]);
    expect((await listEvents(database, run.id, 2)).map((event) => event.seq)).toEqual([3]);
  });

  it("reports a missing run instead of inventing one", async () => {
    expect(
      await appendEvent(database, "00000000-0000-0000-0000-000000000000", "log", {
        event: "x",
      }),
    ).toBeNull();
  });
});

describe("callback authentication", () => {
  it("accepts only the run's own token", async () => {
    const run = await seedRun(database);
    const other = await seedRun(database);

    expect(await getRunByCallbackToken(database, run.id, run.callbackToken)).not.toBeNull();
    expect(await getRunByCallbackToken(database, run.id, other.callbackToken)).toBeNull();
    expect(await getRunByCallbackToken(database, run.id, "wrong")).toBeNull();
  });
});

describe("reconciler queries", () => {
  it("finds in-flight runs past their deadline", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      run.id,
      { provider: "fake", id: "sb" },
      new Date(Date.now() - 1000),
    );

    expect((await findExpiredRuns(database, 10)).map((r) => r.id)).toEqual([run.id]);

    await completeRun(database, run.id, "failed", "expired");
    // A terminal run is no longer in flight, whatever its deadline says.
    expect(await findExpiredRuns(database, 10)).toHaveLength(0);
  });

  it("finds a sandbox that has gone quiet, with or without earlier events", async () => {
    const noEvents = await seedRun(database);
    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      noEvents.id,
      { provider: "fake", id: "a" },
      new Date(Date.now() + 60_000),
    );
    await database
      .update(runs)
      .set({ claimedAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, noEvents.id));

    const stale = await seedRun(database);
    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      stale.id,
      { provider: "fake", id: "b" },
      new Date(Date.now() + 60_000),
    );
    await appendEvent(database, stale.id, "token", { content: "hi" });
    await database
      .update(runs)
      .set({ lastEventAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, stale.id));

    const found = (await findSilentRuns(database, 30, 10)).map((run) => run.id).sort();
    expect(found).toEqual([noEvents.id, stale.id].sort());

    // A run that reported recently is not silent.
    expect(await findSilentRuns(database, 3600, 10)).toHaveLength(0);
  });

  it("finds claims that expired before a sandbox existed", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, -1); // lease already in the past
    expect((await findReclaimableClaims(database, 10)).map((r) => r.id)).toEqual([run.id]);

    await attachSandbox(database, run.id, { provider: "fake", id: "sb" }, new Date());
    // Once a sandbox exists the run is not reclaimable — it is someone's work.
    expect(await findReclaimableClaims(database, 10)).toHaveLength(0);
  });

  it("finds finished runs whose machine was never confirmed reclaimed", async () => {
    const run = await seedRun(database);
    await claimNextRun(database, 60);
    await attachSandbox(
      database,
      run.id,
      { provider: "fake", id: "sb" },
      new Date(Date.now() + 1000),
    );

    // Still running: nothing to clean up yet.
    expect(await findSandboxesToStop(database, 10)).toHaveLength(0);

    await completeRun(database, run.id, "succeeded");
    expect((await findSandboxesToStop(database, 10)).map((r) => r.id)).toEqual([run.id]);

    await markSandboxStopped(database, run.id);
    // Stamped, so it is never stopped twice.
    expect(await findSandboxesToStop(database, 10)).toHaveLength(0);
  });
});
