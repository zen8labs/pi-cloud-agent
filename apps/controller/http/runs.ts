import { randomBytes } from "node:crypto";
import {
  isTerminal,
  type RunDetail,
  type RunStatus,
  type RunSummary,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Database } from "../db/client";
import { completeRun, createRun, getRun, listEvents, listRuns } from "../db/runs";
import type { RunRow } from "../db/schema";
import type { AppEnv } from "./deps";
import { readManualRequest } from "./manual";

/** The operator API: start runs, read them, watch them, stop them. */
export function runRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const status = c.req.query("status") as RunStatus | undefined;
    const rows = await listRuns(c.get("database"), { limit, status });
    return c.json({ runs: rows.map(toSummary) });
  });

  app.post("/", async (c) => {
    const config = c.get("config");
    const resolved = await readManualRequest(await c.req.json().catch(() => null), config);
    if (!resolved.ok) return c.json(resolved.error, 422);
    const { body, request: manual } = resolved;

    const run = await createRun(c.get("database"), {
      profile: manual.profile,
      provider: body.provider,
      repoFullName: body.repo,
      trigger: manual.trigger,
      // Pinned at creation, so a run stays reproducible if configuration changes.
      model: config.model.id,
      callbackToken: randomBytes(32).toString("hex"),
    });

    c.get("log").info("run queued", {
      runId: run.id,
      profile: manual.profile,
      repo: body.repo,
    });
    return c.json(toSummary(run), 201);
  });

  app.get("/:runId", async (c) => {
    const run = await getRun(c.get("database"), c.req.param("runId"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(toDetail(run));
  });

  app.get("/:runId/events", async (c) => {
    const database = c.get("database");
    const runId = c.req.param("runId");
    if (!(await getRun(database, runId))) return c.json({ error: "run not found" }, 404);
    const afterSeq = Number(c.req.query("afterSeq") ?? 0) || 0;
    return c.json({ events: await listEvents(database, runId, afterSeq) });
  });

  app.post("/:runId/cancel", async (c) => {
    const database = c.get("database");
    const runId = c.req.param("runId");
    const run = await getRun(database, runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (isTerminal(run.status)) return c.json({ status: run.status });

    // Only the state transition happens here. The sandbox is reclaimed by the
    // reconciler, which already has to handle "terminal run with a live sandbox"
    // for crashes and timeouts — cancelling is the same shape, so it reuses the
    // same path instead of duplicating teardown.
    await completeRun(database, runId, "cancelled", "cancelled by an operator");
    c.get("log").info("run cancelled", { runId });
    return c.json({ status: "cancelled" satisfies RunStatus });
  });

  /**
   * Live event stream, resumable.
   *
   * Every data frame carries `id: <seq>`. A browser `EventSource` echoes the last
   * one back as `Last-Event-ID` when it reconnects, so a dropped connection
   * resumes exactly where it stopped with no gap and no duplicate. The
   * append-only log is the only source, which is why history and live tail are
   * the same code path.
   */
  app.get("/:runId/stream", (c) => {
    const database = c.get("database");
    const runId = c.req.param("runId");
    // `Last-Event-ID` is what a browser sends on reconnect; `afterSeq` is for
    // anything driving the stream by hand, such as curl.
    const resumeFrom = c.req.header("last-event-id") ?? c.req.query("afterSeq");
    const startSeq = Number(resumeFrom ?? 0) || 0;

    return streamSSE(c, (stream) => tailRun(stream, database, runId, startSeq));
  });

  return app;
}

type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0];

/** Follow one run's log to its terminal state, then close. */
async function tailRun(
  stream: SSEStream,
  database: Database,
  runId: string,
  startSeq: number,
): Promise<void> {
  if (!(await getRun(database, runId))) {
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({ message: "run not found" }),
    });
    return;
  }

  /** Ship every event after `from`, returning the new cursor. */
  const flush = async (from: number): Promise<number> => {
    let seq = from;
    for (const event of await listEvents(database, runId, seq)) {
      seq = event.seq;
      await stream.writeSSE({
        id: String(event.seq),
        event: event.type,
        // `at` rides alongside the payload so replayed frames keep real
        // timestamps; consumers treat it as metadata, not event data.
        data: JSON.stringify({ ...event.data, at: event.at }),
      });
    }
    return seq;
  };

  let cursor = startSeq;
  let lastStatus: RunStatus | null = null;

  while (!stream.aborted) {
    cursor = await flush(cursor);

    const run = await getRun(database, runId);
    if (!run) return;

    if (run.status !== lastStatus) {
      lastStatus = run.status;
      // Status frames carry no id: they are derived from the run row rather than
      // the log, so re-sending one after a reconnect is harmless.
      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({ status: run.status, error: run.error }),
      });
    }

    if (isTerminal(run.status)) {
      // Drain what landed alongside the terminal transition, so a client that
      // disconnects on `end` has not missed the last few events.
      await flush(cursor);
      await stream.writeSSE({ event: "end", data: JSON.stringify({ status: run.status }) });
      return;
    }

    await stream.sleep(400);
  }
}

function toSummary(run: RunRow): RunSummary {
  return {
    id: run.id,
    status: run.status,
    profile: run.profile,
    provider: run.provider,
    repo: run.repoFullName,
    model: run.model,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    sessionId: run.sessionId,
    turnNumber: run.turnNumber,
  };
}

export function toDetail(run: RunRow): RunDetail {
  return {
    ...toSummary(run),
    prompt: run.trigger.prompt ?? null,
    headSha: run.trigger.repo.headSha || null,
    sandboxStoppedAt: run.sandboxStoppedAt?.toISOString() ?? null,
  };
}
