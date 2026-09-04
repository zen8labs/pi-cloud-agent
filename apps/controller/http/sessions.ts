import {
  createSessionTurnRequestSchema,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import { queueSessionCommand } from "../commands/session";
import { getRun } from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import { getSession, listSessionRuns, listSessions } from "../db/sessions";
import { LlmModelSelectionError } from "../llm/connections";
import { requireAuthenticatedUser, userOwns } from "./auth";
import type { AppEnv } from "./deps";
import { readManualRouteRequest } from "./manual";
import { toDetail } from "./runs";

/** Durable chat sessions. Each user turn creates one ordinary run. */
export function sessionRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requireAuthenticatedUser);

  app.get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const rows = await listSessions(c.get("database"), limit, c.get("user")?.id);
    const summaries = await Promise.all(
      rows.map((row) => toSessionSummary(c.get("database"), row)),
    );
    return c.json({ sessions: summaries });
  });

  app.post("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const config = c.get("config");
    const resolved = await readManualRouteRequest(c);
    if (!resolved.ok) return c.json(resolved.error, 422);
    const { body, request: manual } = resolved;
    let queued: Awaited<ReturnType<typeof queueSessionCommand>>;
    try {
      queued = await queueSessionCommand(c.get("database"), config, {
        userId: user.id,
        repo: manual.repo,
        prompt: body.prompt,
        mode: "new_session",
        intent: "general",
        modelConnectionId: body.modelConnectionId,
        modelId: body.modelId,
        thinkingLevel: body.thinkingLevel,
        provenance: { source: "dashboard", eventType: "manual" },
      });
    } catch (error) {
      if (error instanceof LlmModelSelectionError) return c.json({ error: error.message }, 422);
      throw error;
    }
    const created = await getSession(c.get("database"), queued.sessionId ?? "", user.id);
    if (!created) return c.json({ error: "session could not be created" }, 500);
    c.get("log").info("session queued", {
      sessionId: created.id,
      runId: queued.runId,
      repo: created.repoFullName,
    });
    return c.json(await toSessionSummary(c.get("database"), created), 201);
  });

  app.get("/:sessionId", async (c) => {
    const database = c.get("database");
    const session = await getSession(database, c.req.param("sessionId"));
    if (!session || !userOwns(c.get("user"), session.userId)) {
      return c.json({ error: "session not found" }, 404);
    }
    const runs = await listSessionRuns(database, session.id, c.get("user")?.id);
    const detail: SessionDetail = {
      ...(await toSessionSummary(database, session)),
      runs: runs.map(toDetail),
    };
    return c.json(detail);
  });

  app.post("/:sessionId/turns", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = createSessionTurnRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid request" }, 422);
    const session = await getSession(c.get("database"), c.req.param("sessionId"), user.id);
    if (!session) return c.json({ error: "session not found" }, 404);
    let queued: Awaited<ReturnType<typeof queueSessionCommand>>;
    try {
      queued = await queueSessionCommand(c.get("database"), c.get("config"), {
        userId: user.id,
        sessionId: session.id,
        repo: session.repo,
        prompt: parsed.data.prompt,
        mode: "append_turn",
        intent: "general",
        modelConnectionId: parsed.data.modelConnectionId,
        modelId: parsed.data.modelId,
        thinkingLevel: parsed.data.thinkingLevel,
        provenance: { source: "dashboard", eventType: "session_turn" },
      });
    } catch (error) {
      if (error instanceof LlmModelSelectionError) return c.json({ error: error.message }, 422);
      throw error;
    }
    const run = await getRun(c.get("database"), queued.runId);
    if (!run) return c.json({ error: "run could not be created" }, 500);
    c.get("log").info("session turn queued", {
      sessionId: run.sessionId,
      runId: run.id,
      turnNumber: run.turnNumber,
    });
    return c.json(toDetail(run), 201);
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
    provider: session.provider,
    repo: session.repoFullName,
    model: session.model,
    modelConnectionId: session.modelConnectionId,
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
