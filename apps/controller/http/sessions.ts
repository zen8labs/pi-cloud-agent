import { randomBytes } from "node:crypto";
import {
  createSessionTurnRequestSchema,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import { getLlmConnection } from "../db/llm-connections";
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
import {
  modelIdFromSnapshot,
  type ResolvedLlmModel,
  resolveDefaultLlmModel,
  resolveLlmModel,
} from "../llm/connections";
import { userOwns } from "./auth";
import type { AppEnv } from "./deps";
import { readManualRouteRequest } from "./manual";
import { toDetail } from "./runs";

/** Durable chat sessions. Each user turn creates one ordinary run. */
export function sessionRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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
    const model = await resolveLlmModel(
      c.get("database"),
      config,
      user.id,
      body.modelConnectionId,
      body.modelId,
    );

    const created = await createSessionWithRun(c.get("database"), {
      userId: user.id,
      title: titleFrom(body.prompt, body.repo),
      profile: manual.profile,
      provider: body.provider,
      repoFullName: body.repo,
      repo: manual.repo,
      trigger: manual.trigger,
      model: `${model.provider}/${model.name}`,
      modelConnectionId: model.connectionId,
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
    const result = await queueSessionTurn(
      c.get("database"),
      c.get("config"),
      user.id,
      c.req.param("sessionId"),
      parsed.data.prompt,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    c.get("log").info("session turn queued", {
      sessionId: result.run.sessionId,
      runId: result.run.id,
      turnNumber: result.run.turnNumber,
    });
    return c.json(toDetail(result.run), 201);
  });

  return app;
}

type SessionTurnResult =
  | { ok: true; run: RunRow }
  | { ok: false; error: string; status: 404 | 409 | 422 };

async function queueSessionTurn(
  database: Parameters<typeof getRun>[0],
  config: Parameters<typeof resolveLlmModel>[1],
  userId: string,
  sessionId: string,
  prompt: string,
): Promise<SessionTurnResult> {
  const session = await getSession(database, sessionId, userId);
  if (!session) return { ok: false, error: "session not found", status: 404 };
  const selected = await selectSessionModel(database, config, userId, session);
  if (!selected.ok) return { ok: false, error: selected.error, status: 422 };

  try {
    const run = await createSessionTurn(
      database,
      sessionId,
      prompt,
      randomBytes(32).toString("hex"),
      userId,
      {
        model: `${selected.model.provider}/${selected.model.name}`,
        modelConnectionId: selected.model.connectionId,
      },
    );
    return { ok: true, run };
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return { ok: false, error: error.message, status: 404 };
    }
    if (error instanceof SessionBusyError) {
      return { ok: false, error: error.message, status: 409 };
    }
    throw error;
  }
}

async function selectSessionModel(
  database: Parameters<typeof getRun>[0],
  config: Parameters<typeof resolveLlmModel>[1],
  userId: string,
  session: SessionRow,
): Promise<{ ok: true; model: ResolvedLlmModel } | { ok: false; error: string }> {
  try {
    const connection = session.modelConnectionId
      ? await getLlmConnection(database, userId, session.modelConnectionId)
      : null;
    const model = connection
      ? await resolveLlmModel(
          database,
          config,
          userId,
          connection.id,
          modelIdFromSnapshot(session.model),
        )
      : await resolveDefaultLlmModel(database, config, userId);
    return { ok: true, model };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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

function titleFrom(prompt: string, repo: string): string {
  const title = prompt.replace(/\s+/g, " ").trim() || repo;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}
