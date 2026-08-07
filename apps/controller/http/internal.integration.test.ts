import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../db/client";
import { getRun, listEvents } from "../db/runs";
import {
  resetTables,
  seedRun,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { createApp } from "./app";

const database = setupTestDatabase();
beforeEach(() => resetTables(database));
afterAll(() => closeDatabase(database));

describe("sandbox event retention", () => {
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
});
