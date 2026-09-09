import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../db/client";
import { getRun, listEvents } from "../db/runs";
import { runs } from "../db/schema";
import { getSession } from "../db/sessions";
import {
  resetTables,
  seedRun,
  seedSession,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { createApp } from "./app";

const database = setupTestDatabase();
beforeEach(() => resetTables(database));
afterAll(() => closeDatabase(database));

describe("sandbox event retention", () => {
  it("persists the session diff baseline from its standalone event", async () => {
    const { run, session } = await seedSession(database);
    const app = createApp({ config: testConfig(), database, log: silentLogger() });
    const response = await app.request(`/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${run.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "log",
        data: { event: "git.diff_base", baseSha: "base-sha" },
      }),
    });

    expect(await response.json()).toEqual({ seq: 1 });
    expect((await getSession(database, session.id))?.diffBaseSha).toBe("base-sha");
  });

  it("keeps authenticated lifecycle activity in history and refreshes liveness", async () => {
    const run = await seedRun(database);
    const app = createApp({ config: testConfig(), database, log: silentLogger() });
    const request = (body: unknown) =>
      app.request(`/internal/runs/${run.id}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${run.callbackToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const debug = await request({
      type: "log",
      data: { event: "agent.message_start", role: "assistant" },
    });
    expect(await debug.json()).toEqual({ stored: false });

    const lifecycle = await request({
      type: "log",
      data: { event: "agent.retry", attempt: 1, maxAttempts: 3 },
    });
    expect(((await lifecycle.json()) as { seq: number }).seq).toBe(1);

    const core = await request({
      type: "log",
      data: { event: "agent.turn_end", output: "answer", turnNumber: 1 },
    });
    expect(((await core.json()) as { seq: number }).seq).toBe(2);

    expect((await listEvents(database, run.id, 0)).map((event) => event.data.event)).toEqual([
      "agent.retry",
      "agent.turn_end",
    ]);
    expect((await getRun(database, run.id))?.lastEventAt).not.toBeNull();
  });

  it("retains debug lifecycle events only when debug export is enabled", async () => {
    const run = await seedRun(database);
    const app = createApp({
      config: testConfig({ OTEL_EXPORT_DEBUG_EVENTS: "true" }),
      database,
      log: silentLogger(),
    });

    const response = await app.request(`/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${run.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "log",
        data: { event: "agent.message_start", role: "assistant" },
      }),
    });

    expect(await response.json()).toEqual({ seq: 1 });
    expect((await listEvents(database, run.id, 0)).map((event) => event.data.event)).toEqual([
      "agent.message_start",
    ]);
  });
});

describe("trusted publication callbacks", () => {
  it("rejects publication from a cancelled run", async () => {
    const run = await seedRun(database, {
      trigger: {
        kind: "pr_opened",
        source: "github",
        intent: "github_review",
        integrationId: "42",
        prompt: "Review this PR",
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
          prNumber: 7,
        },
      },
    });
    await database.update(runs).set({ status: "cancelled" }).where(eq(runs.id, run.id));
    const app = createApp({ config: testConfig(), database, log: silentLogger() });
    const response = await app.request(`/internal/runs/${run.id}/github-review`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${run.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "Review", comments: [] }),
    });
    expect(response.status).toBe(409);
  });
});
