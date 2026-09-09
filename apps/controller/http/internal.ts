import {
  type GithubCommentSubmission,
  type GithubReviewSubmission,
  githubCommentSubmissionSchema,
  githubReviewSubmissionSchema,
  isDebugAgentEvent,
  oauthCredentialUpdateSchema,
  type RunStatusReport,
  redactUrlCredentials,
  runEventInputSchema,
  runStatusReportSchema,
  sessionCheckpointSchema,
} from "@pi-cloud-agent/protocol";
import {
  createGithubCommentPublisher,
  createGithubInstallationToken,
  createGithubReviewPublisher,
} from "@pi-cloud-agent/vcs";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Database } from "../db/client";
import {
  beginGithubCommentPublication,
  beginGithubReviewPublication,
  finishGithubCommentPublication,
  finishGithubReviewPublication,
  hasPublishedGithubComment,
  hasPublishedGithubReview,
} from "../db/integrations";
import { appendEvent, completeRun, getRunByCallbackToken } from "../db/runs";
import type { RunRow } from "../db/schema";
import {
  getSessionForRun,
  saveSessionCheckpoint,
  saveSessionDiffBaseSha,
} from "../db/sessions";
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
    if (
      parsed.data.type === "log" &&
      !c.get("config").observability.exportDebugEvents &&
      isDebugAgentEvent(parsed.data.data.event)
    ) {
      return c.json({ stored: false });
    }

    if (
      parsed.data.type === "log" &&
      (parsed.data.data.event === "git.diff" || parsed.data.data.event === "git.diff_base")
    ) {
      await saveDiffBase(c.get("database"), run, parsed.data.data);
    }

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

    const database = c.get("database");
    const { status, detail } = await normalizeStatus(database, run, parsed.data);

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

  app.post("/runs/:runId/github-review", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (run instanceof Response) return run;
    if (
      run.status !== "running" ||
      run.trigger.intent !== "github_review" ||
      !run.userId ||
      !run.trigger.integrationId ||
      !run.trigger.repo.prNumber ||
      !run.trigger.repo.headSha
    ) {
      return c.json({ error: "run is not a GitHub review" }, 409);
    }
    const parsed = githubReviewSubmissionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !validReviewSubmission(parsed.data)) {
      return c.json({ error: "invalid GitHub review submission" }, 422);
    }
    return publishGithubReview(c, run, parsed.data, run.trigger.repo.prNumber);
  });

  app.post("/runs/:runId/github-comment", async (c) => {
    const run = await requireRun(c, c.req.param("runId"));
    if (
      run instanceof Response ||
      run.status !== "running" ||
      run.trigger.intent !== "github_task" ||
      !run.userId ||
      !run.trigger.repo.prNumber ||
      !run.trigger.integrationId ||
      !run.trigger.externalMessageId
    ) {
      return c.json({ error: "run is not a GitHub comment task" }, 409);
    }
    const parsed = githubCommentSubmissionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid GitHub comment submission" }, 422);
    return publishGithubComment(c, run, parsed.data, run.trigger.repo.prNumber);
  });

  return app;
}

async function normalizeStatus(
  database: Database,
  run: RunRow,
  report: RunStatusReport,
): Promise<RunStatusReport> {
  if (report.status !== "done") return report;
  if (
    run.trigger.intent === "github_review" &&
    !(await hasPublishedGithubReview(database, run.id))
  ) {
    return {
      status: "error",
      detail: "the review session completed without submitting its structured GitHub review",
    };
  }
  if (
    run.trigger.intent === "github_task" &&
    !(await hasPublishedGithubComment(database, run.id))
  ) {
    return {
      status: "error",
      detail: "the task session completed without submitting its GitHub comment reply",
    };
  }
  const session = await getSessionForRun(database, run);
  if (session && !session.agentCheckpoint) {
    return {
      status: "error",
      detail: "the turn completed without a durable Pi session checkpoint",
    };
  }
  return report;
}

function validReviewSubmission(submission: GithubReviewSubmission): boolean {
  return submission.comments.every(
    (comment) =>
      safeReviewPath(comment.path) &&
      (comment.startLine === undefined
        ? comment.startSide === undefined
        : comment.startLine <= comment.line && comment.startSide !== undefined),
  );
}

async function publishGithubReview(
  c: Context<AppEnv>,
  run: RunRow,
  submission: GithubReviewSubmission,
  pullNumber: number,
): Promise<Response> {
  const database = c.get("database");
  const claim = await beginGithubReviewPublication(database, run.id, submission);
  if (!claim) return c.json({ error: "could not reserve GitHub review publication" }, 500);
  const publication = claim.publication;
  if (publication.status === "published") {
    return c.json({ ok: true, reviewId: publication.githubReviewId, duplicate: true });
  }
  if (!claim.claimed) {
    const message =
      publication.status === "processing"
        ? "GitHub review publication is still processing"
        : `GitHub review publication is ${publication.status}`;
    return c.json({ error: message }, 409);
  }
  const accessToken = await githubPublicationToken(c, run.trigger.integrationId);
  if (!accessToken) {
    await finishGithubReviewPublication(database, run.id, {
      status: "failed",
      error: "GitHub connection is unavailable",
    });
    return c.json({ error: "GitHub connection is unavailable" }, 409);
  }
  try {
    const review = await createGithubReviewPublisher(accessToken).submitReview({
      owner: run.trigger.repo.owner,
      repo: run.trigger.repo.name,
      pullNumber,
      commitId: run.trigger.repo.headSha,
      body: submission.body,
      comments: submission.comments,
    });
    await finishGithubReviewPublication(database, run.id, {
      status: "published",
      githubReviewId: review.id,
    });
    return c.json({ ok: true, reviewId: review.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishGithubReviewPublication(database, run.id, {
      status: "uncertain",
      error: detail,
    });
    c.get("log").error("GitHub review publication failed", { runId: run.id, error });
    return c.json({ error: "GitHub review publication failed" }, 502);
  }
}

async function publishGithubComment(
  c: Context<AppEnv>,
  run: RunRow,
  submission: GithubCommentSubmission,
  pullNumber: number,
): Promise<Response> {
  const database = c.get("database");
  const claim = await beginGithubCommentPublication(database, run.id, submission);
  if (!claim) return c.json({ error: "could not reserve GitHub comment publication" }, 500);
  const publication = claim.publication;
  if (publication.status === "published") {
    return c.json({ ok: true, commentId: publication.githubCommentId, duplicate: true });
  }
  if (!claim.claimed) {
    const message =
      publication.status === "processing"
        ? "GitHub comment publication is still processing"
        : `GitHub comment publication is ${publication.status}`;
    return c.json({ error: message }, 409);
  }
  const messageId = run.trigger.externalMessageId;
  const integrationId = run.trigger.integrationId;
  if (!messageId || !integrationId) {
    await finishGithubCommentPublication(database, run.id, {
      status: "failed",
      error: "comment target is unavailable",
    });
    return c.json({ error: "comment target is unavailable" }, 409);
  }
  const accessToken = await githubPublicationToken(c, integrationId);
  if (!accessToken) {
    await finishGithubCommentPublication(database, run.id, {
      status: "failed",
      error: "GitHub connection is unavailable",
    });
    return c.json({ error: "GitHub connection is unavailable" }, 409);
  }
  try {
    const comment = await createGithubCommentPublisher(accessToken).submitComment({
      owner: run.trigger.repo.owner,
      repo: run.trigger.repo.name,
      issueNumber: pullNumber,
      commentId: messageId,
      replyKind:
        run.trigger.eventType === "pull_request_review_comment"
          ? "review_comment"
          : "issue_comment",
      body: submission.body,
    });
    await finishGithubCommentPublication(database, run.id, {
      status: "published",
      githubCommentId: comment.id,
    });
    return c.json({ ok: true, commentId: comment.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finishGithubCommentPublication(database, run.id, {
      status: "uncertain",
      error: detail,
    });
    c.get("log").error("GitHub comment publication failed", { runId: run.id, error });
    return c.json({ error: "GitHub comment publication failed" }, 502);
  }
}

async function githubPublicationToken(
  c: Context<AppEnv>,
  installationId: string | undefined,
): Promise<string | null> {
  const config = c.get("config");
  if (config.github.appId && config.github.privateKey && installationId) {
    try {
      const token = await createGithubInstallationToken(
        { appId: config.github.appId, privateKey: config.github.privateKey },
        installationId,
      );
      return token.token;
    } catch (error) {
      c.get("log").error("GitHub App installation token failed", {
        installationId,
        error,
      });
      return null;
    }
  }
  return null;
}

async function saveDiffBase(
  database: Database,
  run: RunRow,
  data: Record<string, unknown>,
): Promise<void> {
  const baseSha = data.baseSha;
  if (typeof baseSha === "string" && baseSha.length > 0) {
    await saveSessionDiffBaseSha(database, run, baseSha);
  }
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

function safeReviewPath(path: string): boolean {
  return !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\");
}
