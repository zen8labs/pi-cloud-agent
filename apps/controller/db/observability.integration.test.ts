import { createServer } from "node:http";
import type { RunEvent } from "@pi-cloud-agent/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createObservability } from "../observability";
import { projectRun } from "../observability-projection";
import {
  resetTables,
  seedRun,
  seedSession,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { closeDatabase, type Database } from "./client";
import { claimExport, ensurePendingExports, markExported, retryExport } from "./observability";
import { appendEvent, completeRun, listEvents } from "./runs";
import { observabilityExports, runs } from "./schema";

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

  it("advances past terminal runs already seeded for a destination", async () => {
    const oldest = await seedRun(database);
    const newer = await seedRun(database);
    await completeRun(database, oldest.id, "succeeded");
    await completeRun(database, newer.id, "succeeded");
    await database
      .update(runs)
      .set({ updatedAt: new Date(1) })
      .where(eq(runs.id, oldest.id));
    await database
      .update(runs)
      .set({ updatedAt: new Date(2) })
      .where(eq(runs.id, newer.id));

    await ensurePendingExports(database, "destination-a", 1);
    const first = await claimExport(database, "destination-a");
    if (!first) throw new Error("expected oldest export claim");
    expect(first.runId).toBe(oldest.id);
    await markExported(database, first);

    await ensurePendingExports(database, "destination-a", 1);
    expect((await claimExport(database, "destination-a"))?.runId).toBe(newer.id);
  });

  it("stops retrying an export after the attempt limit", async () => {
    const run = await seedRun(database);
    await completeRun(database, run.id, "succeeded");
    await ensurePendingExports(database, "destination-a", 1);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimExport(database, "destination-a");
      if (!claimed) throw new Error(`expected export claim ${attempt}`);
      expect(claimed.attempt).toBe(attempt);
      await retryExport(database, claimed, "collector rejected the trace");
    }

    expect(await claimExport(database, "destination-a")).toBeNull();
    const [delivery] = await database
      .select()
      .from(observabilityExports)
      .where(eq(observabilityExports.runId, run.id));
    expect(delivery?.status).toBe("failed");
    expect(delivery?.lastError).toBe("collector rejected the trace");
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
      await appendShellToolEvents(run.id);
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

  it("keeps production traces concise and nests tools under their step", async () => {
    const run = await seedRun(database);
    await appendEvent(database, run.id, "log", {
      event: "agent.message_start",
      role: "assistant",
    });
    await appendEvent(database, run.id, "log", {
      event: "agent.turn_end",
      turnNumber: 1,
      turnStartAt: new Date(Date.now() - 100).toISOString(),
      output: [
        { type: "thinking", thinking: "inspect the repository before answering" },
        { type: "toolCall", name: "shell", arguments: { command: "echo hi" } },
      ],
      usage: { input: 4, output: 2, reasoning: 1, totalTokens: 7 },
    });
    await appendShellToolEvents(run.id);
    const spans = projectRun(run, await listEvents(database, run.id, 0), testConfig());

    expect(spans.map((span) => span.name)).toEqual([
      "agent.turn",
      "agent.tool.shell",
      "agent.step",
      "agent.run",
    ]);
    const step = spans.find((span) => span.name === "agent.step");
    const turn = spans.find((span) => span.name === "agent.turn");
    const tool = spans.find((span) => span.name === "agent.tool.shell");
    expect(turn?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(tool?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(tool?.attributes["gen_ai.tool.call.arguments"]).toContain("echo hi");
    expect(tool?.attributes["gen_ai.tool.call.result"]).toContain("hi");
    expect(turn?.attributes["gen_ai.output.messages"]).toContain("toolCall");
    expect(turn?.attributes["gen_ai.output.messages"]).toContain("inspect the repository");
    expect(
      spans.find((span) => span.name === "agent.run")?.attributes[
        "langfuse.observation.output"
      ],
    ).toContain("inspect the repository");
    expect(spans.some((span) => span.name.startsWith("agent.event."))).toBe(false);
  });

  it("finishes the tool's own step when a legacy completion has no turn number", async () => {
    const run = await seedRun(database);
    const base = Date.UTC(2026, 0, 1);
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const events: RunEvent[] = [
      {
        seq: 1,
        type: "tool_call",
        data: { callId: "late-tool", tool: "shell", status: "running", turnNumber: 1 },
        at: at(1),
      },
      {
        seq: 2,
        type: "log",
        data: {
          event: "agent.turn_end",
          turnNumber: 1,
          output: [{ type: "toolCall", name: "shell" }],
        },
        at: at(2),
      },
      {
        seq: 3,
        type: "log",
        data: {
          event: "agent.turn_end",
          turnNumber: 2,
          output: [{ type: "toolCall", name: "shell" }],
        },
        at: at(3),
      },
      {
        seq: 4,
        type: "tool_call",
        data: { callId: "late-tool", tool: "shell", status: "completed", output: "ok" },
        at: at(4),
      },
    ];
    const spans = projectRun(
      { ...run, createdAt: new Date(base), updatedAt: new Date(base + 5000) },
      events,
      testConfig(),
    );
    const steps = spans.filter((span) => span.name === "agent.step");
    const endSeconds = (turnNumber: number) => {
      const step = steps.find(
        (span) => span.attributes["agent.step.turn_number"] === turnNumber,
      );
      return step?.endTime[0];
    };

    expect(endSeconds(1)).toBe(base / 1000 + 4);
    expect(endSeconds(2)).toBe(base / 1000 + 5);
  });

  it("propagates the application session to every observation", async () => {
    const { run } = await seedSession(database);
    await appendEvent(database, run.id, "log", {
      event: "agent.turn_end",
      turnNumber: 1,
      output: [{ type: "thinking", thinking: "follow the session" }],
    });
    await appendEvent(database, run.id, "tool_call", {
      callId: "session-tool",
      tool: "shell",
      status: "running",
      turnNumber: 1,
      args: { command: "true" },
    });
    await appendEvent(database, run.id, "tool_call", {
      callId: "session-tool",
      tool: "shell",
      status: "completed",
      turnNumber: 1,
      output: "ok",
    });
    const spans = projectRun(run, await listEvents(database, run.id, 0), testConfig());
    expect(spans.length).toBeGreaterThan(1);
    expect(
      spans.every(
        (span) =>
          span.attributes["session.id"] === run.sessionId &&
          span.attributes["langfuse.session.id"] === run.sessionId,
      ),
    ).toBe(true);
  });

  it("captures complete model output for evaluation", async () => {
    const run = await seedRun(database);
    await appendEvent(database, run.id, "log", {
      event: "agent.turn_end",
      turnNumber: 1,
      output: [
        { type: "thinking", thinking: "important trajectory detail" },
        { type: "text", text: "private final answer" },
      ],
    });
    const spans = projectRun(run, await listEvents(database, run.id, 0), testConfig());
    const turn = spans.find((span) => span.name === "agent.turn");
    expect(turn?.attributes["langfuse.observation.output"]).toContain(
      "important trajectory detail",
    );
    expect(turn?.attributes["langfuse.observation.output"]).toContain("private final answer");
  });

  it("contains a periodic drain rejection when export recovery cannot reach the database", async () => {
    let failWrites = false;
    const server = createServer((_request, response) => {
      failWrites = true;
      response.statusCode = 500;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const flakyDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "update" && failWrites) {
          return () => {
            throw new Error("database unavailable during export recovery");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const log: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => log,
    };
    const observability = createObservability({
      config: testConfig({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      }),
      database: flakyDatabase,
      log,
    });

    try {
      await observability.start();
      const run = await seedRun(database);
      await completeRun(database, run.id, "succeeded");
      await new Promise((resolve) => setTimeout(resolve, 6000));
      expect(log.warn).toHaveBeenCalledWith(
        "OTLP trace export recovery failed",
        expect.objectContaining({ error: "database unavailable during export recovery" }),
      );
    } finally {
      await observability.stop().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

async function appendShellToolEvents(runId: string): Promise<void> {
  await appendEvent(database, runId, "tool_call", {
    callId: "call-1",
    tool: "shell",
    status: "running",
    turnNumber: 1,
    args: { command: "echo hi" },
  });
  await appendEvent(database, runId, "tool_call", {
    callId: "call-1",
    tool: "shell",
    status: "completed",
    turnNumber: 1,
    output: "hi",
  });
}
