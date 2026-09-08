import type { SandboxProvider } from "@pi-cloud-agent/protocol";
import {
  createSessionTurnRequestSchema,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
  updateSessionPinRequestSchema,
} from "@pi-cloud-agent/protocol";
import { type Context, Hono } from "hono";
import { queueSessionCommand } from "../commands/session";
import {
  findSessionSandboxesToFinalize,
  findSessionSandboxReplacementsToDelete,
  getRun,
  markSessionSandboxFinalized,
} from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import {
  claimSessionOperation,
  releaseSessionOperation,
  startSessionOperationHeartbeat,
} from "../db/session-operations";
import { markSessionSandboxReplacementDeleted } from "../db/session-workspace";
import {
  deleteSession as deleteSessionRow,
  getSession,
  listSessionRuns,
  listSessions,
  SessionBusyError,
  SessionNotFoundError,
  setSessionPinned,
} from "../db/sessions";
import { LlmModelSelectionError } from "../llm/connections";
import { requireAuthenticatedUser, userOwns } from "./auth";
import type { AppEnv, Deps } from "./deps";
import { readManualRouteRequest } from "./manual";
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
      const mapped = mapSessionCommandError(error);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw error;
    }
    const created = await getSession(c.get("database"), queued.sessionId ?? "", user.id);
    if (!created) return c.json({ error: "session could not be created" }, 500);
    c.get("log").info("session queued", {
      sessionId: created.id,
      runId: queued.runId,
      repo: created.repoFullName,
    });
    return c.json(
      await toSessionSummary(
        c.get("database"),
        created,
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
      const mapped = mapSessionCommandError(error);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
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

function mapSessionCommandError(
  error: unknown,
): { error: string; status: 404 | 409 | 422 } | null {
  if (error instanceof LlmModelSelectionError) return { error: error.message, status: 422 };
  if (error instanceof SessionNotFoundError) return { error: error.message, status: 404 };
  if (error instanceof SessionBusyError) return { error: error.message, status: 409 };
  return null;
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
  const pendingReplacements = await findSessionSandboxReplacementsToDelete(
    database,
    25,
    session.id,
  );
  if (!hasSandboxCleanup(deps, session, activeRun, pendingFinalizations, pendingReplacements)) {
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
    await cleanupSessionSandbox(
      database,
      deps,
      session,
      activeRun,
      pendingFinalizations,
      pendingReplacements,
    );
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
  pendingReplacements: RunRow[],
): boolean {
  return (
    (!session.sandboxId &&
      !activeRun?.sandboxId &&
      pendingFinalizations.length === 0 &&
      pendingReplacements.length === 0) ||
    Boolean(deps.sandbox || deps.createSandboxProvider)
  );
}

async function cleanupSessionSandbox(
  database: Parameters<typeof getRun>[0],
  deps: Pick<Deps, "sandbox" | "createSandboxProvider">,
  session: SessionRow,
  activeRun: RunRow | null,
  pendingFinalizations: RunRow[],
  pendingReplacements: RunRow[],
): Promise<void> {
  const providerFor = (name: string | null | undefined) => {
    if (deps.sandbox?.name === name || !name) return deps.sandbox;
    return deps.createSandboxProvider?.(name);
  };
  await cleanupPendingSessionArtifacts(
    database,
    session.id,
    providerFor,
    pendingFinalizations,
    pendingReplacements,
  );
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

type ProviderFor = (name: string | null | undefined) => SandboxProvider | undefined;

async function cleanupPendingSessionArtifacts(
  database: Parameters<typeof getRun>[0],
  sessionId: string,
  providerFor: ProviderFor,
  initialFinalizations: RunRow[],
  initialReplacements: RunRow[],
): Promise<void> {
  let finalizations = initialFinalizations;
  let replacements = initialReplacements;
  while (finalizations.length > 0 || replacements.length > 0) {
    await cleanupPendingFinalizations(database, providerFor, finalizations);
    await cleanupPendingReplacements(database, providerFor, replacements);
    finalizations = await findSessionSandboxesToFinalize(database, 25, sessionId);
    replacements = await findSessionSandboxReplacementsToDelete(database, 25, sessionId);
  }
}

async function cleanupPendingFinalizations(
  database: Parameters<typeof getRun>[0],
  providerFor: ProviderFor,
  pending: RunRow[],
): Promise<void> {
  for (const run of pending) {
    const refs = finalizationRefs(run);
    if (!refs) continue;
    const provider = providerFor(refs.source.provider);
    if (!provider) throw new Error("sandbox cleanup is not available");
    await provider.finalizeSuspend(refs.source, refs.workspace);
    await markSessionSandboxFinalized(database, run.id, refs.source, refs.workspace);
  }
}

async function cleanupPendingReplacements(
  database: Parameters<typeof getRun>[0],
  providerFor: ProviderFor,
  pending: RunRow[],
): Promise<void> {
  for (const run of pending) {
    const workspace = replacementRef(run);
    if (!workspace) continue;
    const provider = providerFor(workspace.provider);
    if (!provider) throw new Error("sandbox cleanup is not available");
    await provider.deleteWorkspace(workspace);
    await markSessionSandboxReplacementDeleted(database, run.id, workspace);
  }
}

function finalizationRefs(run: RunRow) {
  if (
    !run.sandboxProvider ||
    !run.sandboxId ||
    !run.sandboxFinalizationWorkspaceProvider ||
    !run.sandboxFinalizationWorkspaceId
  ) {
    return null;
  }
  return {
    source: { provider: run.sandboxProvider, id: run.sandboxId },
    workspace: {
      provider: run.sandboxFinalizationWorkspaceProvider,
      id: run.sandboxFinalizationWorkspaceId,
    },
  };
}

function replacementRef(run: RunRow) {
  if (!run.sandboxReplacementWorkspaceProvider || !run.sandboxReplacementWorkspaceId)
    return null;
  return {
    provider: run.sandboxReplacementWorkspaceProvider,
    id: run.sandboxReplacementWorkspaceId,
  };
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
