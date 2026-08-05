import { createServer } from "node:http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createObservability } from "../observability";
import {
  resetTables,
  seedRun,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { closeDatabase, type Database } from "./client";
import { claimExport, ensurePendingExports, markExported, retryExport } from "./observability";
import { appendEvent, completeRun } from "./runs";

let database: Database;

beforeEach(async () => {
  database ??= setupTestDatabase();
  await resetTables(database);
});

afterAll(async () => {
  if (database) await closeDatabase(database);
});

describe("durable observability delivery", () => {
  it("claims, retries, and completes one destination exactly once", async () => {
    const run = await seedRun(database);
    await completeRun(database, run.id, "succeeded");

    await ensurePendingExports(database, "destination-a", 10);
    await ensurePendingExports(database, "destination-a", 10);

    const first = await claimExport(database, "destination-a");
    if (!first) throw new Error("expected first export claim");
    expect(first?.runId).toBe(run.id);
    expect(first?.attempt).toBe(1);
    expect(first?.status).toBe("processing");
    expect(await claimExport(database, "destination-a")).toBeNull();

    await retryExport(database, first, "collector unavailable");
    const second = await claimExport(database, "destination-a");
    if (!second) throw new Error("expected retried export claim");
    expect(second?.attempt).toBe(2);

    await markExported(database, second);
    expect(await claimExport(database, "destination-a")).toBeNull();
  });

  it("keeps destinations independent", async () => {
    const run = await seedRun(database);
    await completeRun(database, run.id, "failed", "agent failed");

    await ensurePendingExports(database, "destination-a", 10);
    await ensurePendingExports(database, "destination-b", 10);

    expect((await claimExport(database, "destination-a"))?.destination).toBe("destination-a");
    expect((await claimExport(database, "destination-b"))?.destination).toBe("destination-b");
  });

  it("exports a completed run as OTLP/HTTP", async () => {
    const requests: Array<{ path: string; body: Buffer }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body: Buffer.concat(chunks) });
        response.statusCode = 200;
        response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const observability = createObservability({
      config: testConfig({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
        OTEL_CAPTURE_CONTENT: "true",
      }),
      database,
      log: silentLogger(),
    });

    try {
      const run = await seedRun(database);
      await appendEvent(database, run.id, "log", {
        event: "agent.session_start",
        model: run.model,
      });
      await appendEvent(database, run.id, "tool_call", {
        callId: "call-1",
        tool: "shell",
        status: "running",
        args: { command: "echo hi" },
      });
      await appendEvent(database, run.id, "tool_call", {
        callId: "call-1",
        tool: "shell",
        status: "completed",
        output: "hi",
      });
      await appendEvent(database, run.id, "token", { content: "agent result" });
      await appendEvent(database, run.id, "log", {
        event: "agent.turn_end",
        output: "agent result",
        usage: { input: 4, output: 2, totalTokens: 6 },
      });
      await completeRun(database, run.id, "succeeded");

      await observability.start();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/v1/traces");
      expect(requests[0]?.body.length).toBeGreaterThan(0);
      const payload = (requests[0]?.body ?? Buffer.alloc(0)).toString("utf8");
      expect(payload).toContain("langfuse.observation.input");
      expect(payload).toContain("langfuse.observation.output");
      expect(payload).toContain("Summarize this repository.");
      expect(payload).toContain("agent result");
      expect(payload).toContain("echo hi");
      expect(payload).toContain("hi");
    } finally {
      await observability.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
