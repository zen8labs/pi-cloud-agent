import { randomBytes } from "node:crypto";
import {
  createSessionTurnRequestSchema,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import { getRun } from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import {
  createSessionTurn,
  createSessionWithRun,
  getSession,
  listSessionRuns,
  listSessions,
  SessionBusyError,
  SessionNotFoundError,
} from "../db/sessions";
import type { AppEnv } from "./deps";
import { readManualRequest } from "./manual";
import { toDetail } from "./runs";

/** Durable chat sessions. Each user turn creates one ordinary run. */
export function sessionRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const rows = await listSessions(c.get("database"), limit);
    const summaries = await Promise.all(
      rows.map((row) => toSessionSummary(c.get("database"), row)),
    );
    return c.json({ sessions: summaries });
  });

  app.post("/", async (c) => {
    const config = c.get("config");
    const resolved = await readManualRequest(await c.req.json().catch(() => null), config);
    if (!resolved.ok) return c.json(resolved.error, 422);
    const { body, request: manual } = resolved;

    const created = await createSessionWithRun(c.get("database"), {
      title: titleFrom(body.prompt, body.repo),
      profile: manual.profile,
      provider: body.provider,
      repoFullName: body.repo,
      repo: manual.repo,
      trigger: manual.trigger,
      model: config.model.id,
      callbackToken: randomBytes(32).toString("hex"),
    });
    c.get("log").info("session queued", {
      sessionId: created.session.id,
      runId: created.run.id,
      repo: created.session.repoFullName,
    });
    return c.json(await toSessionSummary(c.get("database"), created.session), 201);
  });

  app.get("/:sessionId", async (c) => {
    const database = c.get("database");
    const session = await getSession(database, c.req.param("sessionId"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const runs = await listSessionRuns(database, session.id);
    const detail: SessionDetail = {
      ...(await toSessionSummary(database, session)),
      runs: runs.map(toDetail),
    };
    return c.json(detail);
  });

  app.post("/:sessionId/turns", async (c) => {
    const parsed = createSessionTurnRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid request" }, 422);
    try {
      const run = await createSessionTurn(
        c.get("database"),
        c.req.param("sessionId"),
        parsed.data.prompt,
        randomBytes(32).toString("hex"),
      );
      c.get("log").info("session turn queued", {
        sessionId: run.sessionId,
        runId: run.id,
        turnNumber: run.turnNumber,
      });
      return c.json(toDetail(run), 201);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof SessionBusyError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}

async function toSessionSummary(
  database: Parameters<typeof getRun>[0],
  session: SessionRow,
): Promise<SessionSummary> {
  const activeRun = session.activeRunId ? await getRun(database, session.activeRunId) : null;
  return {
    id: session.id,
    status: sessionStatus(activeRun),
    title: session.title,
    profile: session.profile,
    provider: session.provider,
    repo: session.repoFullName,
    model: session.model,
    activeRunId: session.activeRunId,
    latestRunId: session.latestRunId,
    workspaceAvailable: Boolean(session.sandboxId),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function sessionStatus(run: RunRow | null): SessionStatus {
  if (!run) return "idle";
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return "parking";
  }
  return run.status;
}

function titleFrom(prompt: string, repo: string): string {
  const title = prompt.replace(/\s+/g, " ").trim() || repo;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}
