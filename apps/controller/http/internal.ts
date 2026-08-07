import {
  oauthCredentialUpdateSchema,
  redactUrlCredentials,
  runEventInputSchema,
  runStatusReportSchema,
  sessionCheckpointSchema,
} from "@pi-cloud-agent/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { appendEvent, completeRun, getRunByCallbackToken } from "../db/runs";
import type { RunRow } from "../db/schema";
import { getSessionForRun, saveSessionCheckpoint } from "../db/sessions";
import { persistRefreshedOAuthCredential } from "../llm/connections";
import type { Observability } from "../observability";
import type { AppEnv } from "./deps";

/**
 * The sandbox's outbound callbacks.
 *
 * This is the only surface an untrusted sandbox can reach, so it stays as small
 * as it can be: append telemetry, persist a credential Pi rotated, and report
 * the terminal status. There is no endpoint to fetch a credential, read another
 * run, or influence scheduling — the sandbox is handed everything it needs at
 * boot and can only talk about itself afterwards.
 *
 * Authentication is a per-run bearer token compared in constant time, so a token
 * is useless for any run but its own.
 */
export function internalRoutes(observability?: Observability): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/runs/:runId/events", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;

    const parsed = runEventInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "unrecognized event" }, 422);

    // Second line of defence. The runtime scrubs its own secrets before sending —
    // it is the only side that knows all of them — but a URL with embedded
    // credentials is easy to produce by accident, so strip those again on the way
    // into durable storage.
    const seq = await appendEvent(
      c.get("database"),
      run.id,
      parsed.data.type,
      scrub(parsed.data.data),
    );
    if (seq === null) return c.json({ error: "run not found" }, 404);
    return c.json({ seq });
  });

  app.post("/runs/:runId/status", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;

    const parsed = runStatusReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "unrecognized status" }, 422);

    let { status, detail } = parsed.data;
    const database = c.get("database");

    const session = await getSessionForRun(database, run);
    if (status === "done" && session && !session.agentCheckpoint) {
      status = "error";
      detail = "the turn completed without a durable Pi session checkpoint";
    }

    // Recorded as an event first, so the reason survives even if the transition
    // below loses a race with the reconciler.
    await appendEvent(database, run.id, "status", { status, detail: detail ?? null });

    // The agent's own completion is authoritative. Telemetry never implies it.
    const applied = await completeRun(
      database,
      run.id,
      status === "done" ? "succeeded" : "failed",
      status === "done" ? null : (detail ?? "the agent reported an error"),
    );

    observability?.enqueue(run.id);

    c.get("log").info("terminal status from sandbox", { runId: run.id, status, applied });
    return c.json({ ok: true });
  });

  app.get("/runs/:runId/checkpoint", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;
    const session = await getSessionForRun(c.get("database"), run);
    if (!session) return c.json({ content: null });
    if (session.activeRunId !== run.id)
      return c.json({ error: "run is not session head" }, 409);
    return c.json({ content: session.agentCheckpoint });
  });

  app.put("/runs/:runId/checkpoint", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;
    const parsed = sessionCheckpointSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid checkpoint" }, 422);
    const saved = await saveSessionCheckpoint(c.get("database"), run, parsed.data.content);
    if (!saved) return c.json({ error: "run is not an active session turn" }, 409);
    return c.json({ ok: true });
  });

  app.post("/runs/:runId/model-credential", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;
    const parsed = oauthCredentialUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid model credential" }, 422);
    if (!run.userId || !run.modelConnectionId) {
      return c.json({ error: "run has no model connection" }, 409);
    }
    const separator = run.model.indexOf("/");
    const updated = await persistRefreshedOAuthCredential(c.get("database"), c.get("config"), {
      userId: run.userId,
      connectionId: run.modelConnectionId,
      provider: separator < 1 ? "" : run.model.slice(0, separator),
      ...parsed.data,
    });
    return c.json({ updated });
  });

  return app;
}

/** The run behind the callback token, or the 403 to return when there is none. */
async function requireRun(c: Context<AppEnv>, runId: string): Promise<RunRow | Response> {
  const run = await authenticate(c.get("database"), runId, c.req.header("authorization"));
  return run ?? c.json({ error: "invalid run token" }, 403);
}

async function authenticate(
  database: Database,
  runId: string,
  authorization: string | undefined,
): Promise<RunRow | null> {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  return getRunByCallbackToken(database, runId, token);
}

function scrub(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === "string" ? redactUrlCredentials(value) : value;
  }
  return out;
}
