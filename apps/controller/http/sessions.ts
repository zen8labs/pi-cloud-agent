import { randomBytes } from "node:crypto";
import {
  createSessionTurnRequestSchema,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
  updateSessionPinRequestSchema,
} from "@pi-cloud-agent/protocol";
import { type Context, Hono } from "hono";
import { findSessionSandboxesToFinalize, getRun } from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import {
  claimSessionOperation,
  releaseSessionOperation,
  startSessionOperationHeartbeat,
} from "../db/session-operations";
import {
  createSessionTurn,
  createSessionWithRun,
  deleteSession as deleteSessionRow,
  getSession,
  listSessionRuns,
  listSessions,
  SessionBusyError,
  SessionNotFoundError,
  setSessionPinned,
} from "../db/sessions";
import type { resolveLlmModel } from "../llm/connections";
import { requireAuthenticatedUser, userOwns } from "./auth";
import type { AppEnv, Deps } from "./deps";
import { readManualRouteRequest } from "./manual";
import { resolveRequestedLlmModel } from "./model-selection";
import { toDetail } from "./runs";

type SessionContext = Context<AppEnv>;

/** Durable chat sessions. Each user turn creates one ordinary run. */
export function sessionRoutes(
  deps: Pick<Deps, "sandbox" | "createSandboxProvider"> = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requireAuthenticatedUser);

  app.get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const rows = await listSessions(c.get("database"), limit, c.get("user")?.id);
    const summaries = await Promise.all(
      rows.map((row) =>
        toSessionSummary(
          c.get("database"),
          row,
          c.get("config").sessionWorkspaceRetentionSeconds,
        ),
      ),
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
    const selected = await resolveRequestedLlmModel(
      c.get("database"),
      config,
      user.id,
      body.modelConnectionId,
      body.modelId,
      body.thinkingLevel,
    );
    if (!selected.ok) return c.json({ error: selected.error }, 422);
    const model = selected.model;

    const created = await createSessionWithRun(c.get("database"), {
      userId: user.id,
      title: titleFrom(body.prompt, body.repo),
      provider: body.provider,
      repoFullName: body.repo,
      repo: manual.repo,
      trigger: manual.trigger,
      model: `${model.provider}/${model.name}`,
      modelConnectionId: model.connectionId,
      thinkingLevel: body.thinkingLevel,
      callbackToken: randomBytes(32).toString("hex"),
    });
    c.get("log").info("session queued", {
      sessionId: created.session.id,
      runId: created.run.id,
      repo: created.session.repoFullName,
    });
    return c.json(
      await toSessionSummary(
        c.get("database"),
        created.session,
        config.sessionWorkspaceRetentionSeconds,
      ),
      201,
    );
  });

  app.get("/:sessionId", async (c) => {
    const database = c.get("database");
    const session = await getSession(database, c.req.param("sessionId"));
    if (!session || !userOwns(c.get("user"), session.userId)) {
      return c.json({ error: "session not found" }, 404);
    }
    const runs = await listSessionRuns(database, session.id, c.get("user")?.id);
    const detail: SessionDetail = {
      ...(await toSessionSummary(
        database,
        session,
        c.get("config").sessionWorkspaceRetentionSeconds,
      )),
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
      parsed.data.modelConnectionId,
      parsed.data.modelId,
      parsed.data.thinkingLevel,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    c.get("log").info("session turn queued", {
      sessionId: result.run.sessionId,
      runId: result.run.id,
      turnNumber: result.run.turnNumber,
    });
    return c.json(toDetail(result.run), 201);
  });

  app.patch("/:sessionId/pin", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = updateSessionPinRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid request" }, 422);
    const changed = await setSessionPinned(
      c.get("database"),
      c.req.param("sessionId"),
      user.id,
      parsed.data.pinned,
    );
    if (!changed) return c.json({ error: "session not found" }, 404);
    return c.json({ ok: true, pinned: parsed.data.pinned });
  });

  app.delete("/:sessionId", async (c) => {
    return deleteSession(c, deps);
  });

  return app;
}

async function deleteSession(
  c: SessionContext,
  deps: Pick<Deps, "sandbox" | "createSandboxProvider">,
) {
  const user = c.get("user");
  if (!user) return c.json({ error: "authentication required" }, 401);
  const database = c.get("database");
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "session not found" }, 404);
  const session = await getSession(database, sessionId, user.id);
  if (!session) return c.json({ error: "session not found" }, 404);

  const activeRun = session.activeRunId ? await getRun(database, session.activeRunId) : null;
  if (activeRun && !isTerminalRun(activeRun)) {
    return c.json({ error: "session has an active run" }, 409);
  }
  const sessionRuns = await listSessionRuns(database, session.id, user.id);
  if (sessionRuns.some((run) => run.id !== activeRun?.id && !isTerminalRun(run))) {
    return c.json({ error: "session has a queued run" }, 409);
  }
  const pendingFinalizations = await findSessionSandboxesToFinalize(database, 25, session.id);
  if (!hasSandboxCleanup(deps, session, activeRun, pendingFinalizations)) {
    return c.json({ error: "sandbox cleanup is not available" }, 503);
  }
  const operationAt = await claimSessionOperation(database, session.id, "archiving", {
    activeRunId: activeRun?.id ?? null,
    latestRunId: session.latestRunId,
    userId: user.id,
  });
  if (!operationAt) {
    return c.json({ error: "session changed while it was being deleted; retry" }, 409);
  }
  const stopHeartbeat = startSessionOperationHeartbeat(
    database,
    session.id,
    "archiving",
    operationAt,
    (error) =>
      c.get("log").warn("session deletion heartbeat failed", { sessionId: session.id, error }),
  );
  try {
    await cleanupSessionSandbox(deps, session, activeRun, pendingFinalizations);
  } catch (error) {
    await releaseSessionOperation(database, session.id, "archiving", operationAt);
    c.get("log").error("session checkpoint deletion failed", { sessionId: session.id, error });
    return c.json({ error: "could not delete session checkpoint" }, 502);
  } finally {
    stopHeartbeat();
  }
  const deleted = await deleteSessionRow(
    database,
    session.id,
    user.id,
    activeRun?.id ?? null,
    session.latestRunId,
    "archiving",
    operationAt,
  );
  if (!deleted) {
    await releaseSessionOperation(database, session.id, "archiving", operationAt);
    return c.json({ error: "session changed while it was being deleted; retry" }, 409);
  }
  return c.json({ ok: true });
}

function isTerminalRun(run: RunRow): boolean {
  return ["succeeded", "failed", "cancelled"].includes(run.status);
}

function hasSandboxCleanup(
  deps: Pick<Deps, "sandbox" | "createSandboxProvider">,
  session: SessionRow,
  activeRun: RunRow | null,
  pendingFinalizations: RunRow[],
): boolean {
  return (
    (!session.sandboxId && !activeRun?.sandboxId && pendingFinalizations.length === 0) ||
    Boolean(deps.sandbox || deps.createSandboxProvider)
  );
}

async function cleanupSessionSandbox(
  deps: Pick<Deps, "sandbox" | "createSandboxProvider">,
  session: SessionRow,
  activeRun: RunRow | null,
  pendingFinalizations: RunRow[],
): Promise<void> {
  const providerFor = (name: string | null | undefined) => {
    if (deps.sandbox?.name === name || !name) return deps.sandbox;
    return deps.createSandboxProvider?.(name);
  };
  for (const run of pendingFinalizations) {
    if (
      !run.sandboxProvider ||
      !run.sandboxId ||
      !run.sandboxFinalizationWorkspaceProvider ||
      !run.sandboxFinalizationWorkspaceId
    ) {
      continue;
    }
    const provider = providerFor(run.sandboxProvider);
    if (!provider) throw new Error("sandbox cleanup is not available");
    await provider.finalizeSuspend(
      { provider: run.sandboxProvider, id: run.sandboxId },
      {
        provider: run.sandboxFinalizationWorkspaceProvider,
        id: run.sandboxFinalizationWorkspaceId,
      },
    );
  }
  if (activeRun?.sandboxId && !activeRun.sandboxStoppedAt) {
    const provider = providerFor(activeRun.sandboxProvider);
    if (!provider) throw new Error("sandbox cleanup is not available");
    await provider.stop({
      provider: activeRun.sandboxProvider ?? provider.name,
      id: activeRun.sandboxId,
    });
  }
  if (session.sandboxId) {
    const provider = providerFor(session.sandboxProvider);
    if (!provider) throw new Error("sandbox cleanup is not available");
    await provider.deleteWorkspace({
      provider: session.sandboxProvider ?? provider.name,
      id: session.sandboxId,
    });
  }
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
  modelConnectionId: string,
  modelId: string,
  thinkingLevel: import("@pi-cloud-agent/protocol").ThinkingLevel,
): Promise<SessionTurnResult> {
  const session = await getSession(database, sessionId, userId);
  if (!session) return { ok: false, error: "session not found", status: 404 };
  const selected = await resolveRequestedLlmModel(
    database,
    config,
    userId,
    modelConnectionId,
    modelId,
    thinkingLevel,
  );
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
        thinkingLevel,
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

async function toSessionSummary(
  database: Parameters<typeof getRun>[0],
  session: SessionRow,
  inactiveAfterSeconds: number,
): Promise<SessionSummary> {
  const activeRun = session.activeRunId ? await getRun(database, session.activeRunId) : null;
  return {
    id: session.id,
    status: sessionStatus(activeRun),
    title: session.title,
    inactiveAfterSeconds,
    pinned: session.pinned,
    provider: session.provider,
    repo: session.repoFullName,
    model: session.model,
    modelConnectionId: session.modelConnectionId,
    activeRunId: session.activeRunId,
    latestRunId: session.latestRunId,
    workspaceAvailable: Boolean(session.sandboxId),
    retentionStatus: session.retentionStatus,
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
