import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../db/client";
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
  it("drops lifecycle logs by default but keeps core turn data", async () => {
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
      data: { event: "agent.message_start", role: "assistant" },
    });
    expect(((await lifecycle.json()) as { stored: boolean }).stored).toBe(false);

    const core = await request({
      type: "log",
      data: { event: "agent.turn_end", output: "answer", turnNumber: 1 },
    });
    expect(((await core.json()) as { seq: number }).seq).toBe(1);

    const debugApp = createApp({
      config: testConfig({ OTEL_EXPORT_DEBUG_EVENTS: "true" }),
      database,
      log: silentLogger(),
    });
    const debug = await debugApp.request(`/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${run.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "log", data: { event: "agent.message_end" } }),
    });
    expect(((await debug.json()) as { seq: number }).seq).toBe(2);
  });
});
