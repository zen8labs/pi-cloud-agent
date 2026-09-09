import { verifyGithubSignature } from "./github-signature";

export { verifyGithubSignature } from "./github-signature";

import {
  type RepoRef,
  type SessionCommandIntent,
  sessionCommandSchema,
} from "@pi-cloud-agent/protocol";
import { fetchGithubPullRequestRevision, verifyGithubInstallation } from "@pi-cloud-agent/vcs";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { queueSessionCommand } from "../commands/session";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  claimIntegrationDelivery,
  finishIntegrationDelivery,
  GithubInstallationOwnedError,
  getGithubInstallation,
  recordIntegrationDelivery,
  upsertGithubInstallation,
} from "../db/integrations";
import type { AppEnv } from "../http/deps";
import type { Logger } from "../logger";
import { getVcsAccessToken } from "../vcs/connections";
import { integrationThinkingLevel, reviewSkipReason } from "./review-policy";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
const githubPayloadSchema = z.record(z.string(), z.unknown());

/** Public intake and authenticated installation setup for the GitHub App. */
export function githubWebhookRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post(
    "/github",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (c) => c.json({ error: "GitHub webhook payload is too large" }, 413),
    }),
    async (c) => {
      const secret = c.get("config").github.webhookSecret;
      if (!secret) return c.json({ error: "GitHub webhook intake is not configured" }, 503);

      const deliveryId = c.req.header("x-github-delivery")?.trim();
      const eventType = c.req.header("x-github-event")?.trim();
      if (!deliveryId || !eventType) {
        return c.json({ error: "GitHub delivery headers are required" }, 400);
      }
      const body = await c.req.text();
      if (!verifyGithubSignature(body, c.req.header("x-hub-signature-256"), secret)) {
        return c.json({ error: "invalid GitHub webhook signature" }, 401);
      }
      let json: unknown;
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        return c.json({ error: "GitHub webhook payload is not valid JSON" }, 422);
      }
      const parsed = githubPayloadSchema.safeParse(json);
      if (!parsed.success)
        return c.json({ error: "GitHub webhook payload must be an object" }, 422);

      const inserted = await recordIntegrationDelivery(c.get("database"), {
        provider: "github",
        deliveryId,
        eventType,
        action: stringValue(parsed.data.action),
        payload: parsed.data,
      });
      return c.json({ accepted: true, duplicate: !inserted }, 202);
    },
  );

  return app;
}

/** Handoff the public GitHub install callback, then bind it from the dashboard session. */
export function githubSetupRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/setup", async (c) => {
    const installationId = c.req.query("installation_id")?.trim();
    if (!installationId) return c.json({ error: "installation_id is required" }, 400);
    return c.redirect(
      `${c.get("config").web.url}/settings?github=install&installation_id=${encodeURIComponent(installationId)}`,
    );
  });

  app.post("/setup", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const body = await c.req.json().catch(() => null);
    const installationId =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { installationId?: unknown }).installationId === "string"
        ? (body as { installationId: string }).installationId.trim()
        : "";
    if (!installationId) return c.json({ error: "installationId is required" }, 422);
    return bindGithubInstallation(c, installationId);
  });

  return app;
}

async function bindGithubInstallation(
  c: Context<AppEnv>,
  installationId: string,
): Promise<Response> {
  const user = c.get("user");
  if (!user) return c.json({ error: "authentication required" }, 401);
  const config = c.get("config");
  let accessToken: string;
  try {
    accessToken = await getVcsAccessToken(c.get("database"), config, "github", user.id);
  } catch (error) {
    c.get("log").warn("GitHub connection could not be loaded for installation binding", {
      userId: user.id,
      error,
    });
    return c.json({ error: "reconnect GitHub before installing the App" }, 409);
  }
  if (!accessToken) return c.json({ error: "connect GitHub before installing the App" }, 409);
  let installation: Awaited<ReturnType<typeof verifyGithubInstallation>>;
  try {
    installation = await verifyGithubInstallation(
      accessToken,
      installationId,
      config.github.appId || undefined,
    );
  } catch (error) {
    c.get("log").warn("GitHub installation verification failed", {
      installationId,
      error,
    });
    return c.json({ error: "could not verify GitHub installation" }, 502);
  }
  if (!installation) {
    return c.json(
      { error: "GitHub installation is not accessible to the connected user" },
      403,
    );
  }
  try {
    await upsertGithubInstallation(c.get("database"), {
      installationId: installation.id,
      userId: user.id,
      accountId: installation.accountId,
      accountLogin: installation.accountLogin,
    });
  } catch (error) {
    if (error instanceof GithubInstallationOwnedError) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
  if (c.req.method === "POST")
    return c.json({ ok: true, accountLogin: installation.accountLogin });
  return c.redirect(`${config.web.url}/settings?github=connected`);
}

/** Drain a bounded number of durable deliveries. Safe to call from every tick. */
export async function processPendingGithubDeliveries(
  database: Database,
  config: Config,
  log: Logger,
  limit = 10,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const delivery = await claimIntegrationDelivery(database, "github");
    if (!delivery) return;
    try {
      const projection = await projectGithubDelivery(
        database,
        config,
        delivery.payload,
        delivery.eventType,
        delivery.deliveryId,
      );
      await finishIntegrationDelivery(database, delivery, projection);
      log.info("GitHub delivery processed", {
        deliveryId: delivery.deliveryId,
        eventType: delivery.eventType,
        status: projection.status,
        runId: projection.runId ?? null,
        error: projection.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishIntegrationDelivery(database, delivery, { status: "failed", error: message });
      log.error("GitHub delivery failed", { deliveryId: delivery.deliveryId, error });
    }
  }
}

export function githubInstallationId(payload: Record<string, unknown>): string | null {
  const id = numberValue(record(payload, "installation")?.id);
  return id ? String(id) : null;
}

async function projectGithubDelivery(
  database: Database,
  config: Config,
  rawPayload: unknown,
  eventType: string,
  deliveryId: string,
): Promise<{ status: "processed" | "ignored"; runId?: string | null; error?: string }> {
  const payload = githubPayloadSchema.parse(rawPayload);
  if (isBotSender(payload))
    return { status: "ignored", error: "Events from bots are skipped." };
  const installationId = githubInstallationId(payload);
  if (!installationId)
    return { status: "ignored", error: "Event has no GitHub App installation." };
  const installation = await getGithubInstallation(database, installationId);
  if (!installation)
    return {
      status: "ignored",
      error: "GitHub App installation is not connected to an app user.",
    };

  if (eventType === "pull_request") {
    const reason = await reviewSkipReason(database, installationId, payload);
    if (reason) return { status: "ignored", error: reason };
  }

  const projection = projectGithubEvent(payload, eventType, config.github.mention);
  if (!projection)
    return { status: "ignored", error: "Event did not request a review or mention the agent." };
  const resolved = await resolveTaskRevision(database, config, installation.userId, projection);

  const command = sessionCommandSchema.parse({
    repo: resolved.repo,
    prompt: resolved.prompt,
    mode: "new_session",
    intent: projection.intent,
    thinkingLevel: await integrationThinkingLevel(database, config, installation.userId),
    provenance: {
      source: "github",
      deliveryId,
      eventType,
      action: stringValue(payload.action),
      externalThreadKey: projection.externalThreadKey,
      integrationId: installationId,
      externalMessageId: projection.externalMessageId,
      externalActor: projection.externalActor,
    },
  });
  const queued = await queueSessionCommand(database, config, {
    ...command,
    userId: installation.userId,
  });
  return { status: "processed", runId: queued.runId };
}

async function resolveTaskRevision(
  database: Database,
  config: Config,
  userId: string,
  projection: GithubProjection,
): Promise<GithubProjection> {
  if (
    projection.intent !== "github_task" ||
    projection.repo.headSha ||
    !projection.repo.prNumber
  ) {
    return projection;
  }
  const accessToken = await getVcsAccessToken(database, config, "github", userId);
  if (!accessToken) throw new Error("GitHub connection is unavailable for PR task resolution");
  const revision = await fetchGithubPullRequestRevision(
    accessToken,
    projection.repo.owner,
    projection.repo.name,
    projection.repo.prNumber,
  );
  return {
    ...projection,
    repo: { ...projection.repo, ...revision },
    prompt: `${projection.prompt}\n\nResolved pull-request head: ${revision.headBranch} at ${revision.headSha}; base ${revision.defaultBranch} at ${revision.baseSha}.`,
  };
}

interface GithubProjection {
  repo: RepoRef;
  prompt: string;
  intent: SessionCommandIntent;
  externalThreadKey: string;
  externalMessageId?: string;
  externalActor?: string;
}

export function projectGithubEvent(
  payload: Record<string, unknown>,
  eventType: string,
  mention: string,
): GithubProjection | null {
  if (eventType === "pull_request") return projectPullRequestReview(payload);
  if (eventType === "issue_comment") return projectIssueComment(payload, mention);
  if (eventType === "pull_request_review_comment")
    return projectInlineComment(payload, mention);
  return null;
}

function projectPullRequestReview(payload: Record<string, unknown>): GithubProjection | null {
  if (!isReviewAction(stringValue(payload.action))) return null;
  const pullRequest = record(payload, "pull_request");
  if (!pullRequest) return null;
  const repo = repoFromPullRequest(payload, pullRequest);
  if (!repo) return null;
  const pullNumber = repo.prNumber;
  if (!pullNumber) return null;
  return {
    repo,
    intent: "github_review",
    externalThreadKey: `github:pr:${repo.owner}/${repo.name}:${pullNumber}`,
    prompt: reviewPrompt(payload, pullRequest, repo),
  };
}

function projectIssueComment(
  payload: Record<string, unknown>,
  mention: string,
): GithubProjection | null {
  if (stringValue(payload.action) !== "created") return null;
  const issue = record(payload, "issue");
  const body = stringValue(record(payload, "comment")?.body);
  if (!issue || !record(issue, "pull_request") || !body || !mentionsAgent(body, mention))
    return null;
  const repo = repoFromIssue(payload, issue);
  if (!repo) return null;
  const pullNumber = repo.prNumber;
  if (!pullNumber) return null;
  return {
    repo,
    intent: "github_task",
    externalThreadKey: `github:pr:${repo.owner}/${repo.name}:${pullNumber}`,
    prompt: taskPrompt(body, repo, "issue comment"),
    externalMessageId: identifierValue(record(payload, "comment")?.id),
    externalActor: stringValue(record(record(payload, "comment"), "user")?.login) ?? undefined,
  };
}

function projectInlineComment(
  payload: Record<string, unknown>,
  mention: string,
): GithubProjection | null {
  if (stringValue(payload.action) !== "created") return null;
  const comment = record(payload, "comment");
  const body = stringValue(comment?.body);
  const pullRequest = record(payload, "pull_request");
  if (!body || !mentionsAgent(body, mention) || !pullRequest) return null;
  const repo = repoFromPullRequest(payload, pullRequest);
  if (!repo) return null;
  const pullNumber = repo.prNumber;
  if (!pullNumber) return null;
  return {
    repo,
    intent: "github_task",
    externalThreadKey: `github:pr:${repo.owner}/${repo.name}:${pullNumber}`,
    prompt: taskPrompt(body, repo, "inline review comment"),
    externalMessageId: identifierValue(comment?.id),
    externalActor: stringValue(record(comment, "user")?.login) ?? undefined,
  };
}

function repoFromPullRequest(
  payload: Record<string, unknown>,
  pullRequest: Record<string, unknown>,
): RepoRef | null {
  const base = record(pullRequest, "base");
  const head = record(pullRequest, "head");
  const baseRepo = record(base, "repo");
  const headRepo = record(head, "repo");
  const fullName =
    stringValue(baseRepo?.full_name) ??
    stringValue(payload.repository && record(payload, "repository")?.full_name);
  const [owner, name] = fullName?.split("/") ?? [];
  const baseSha = stringValue(base?.sha);
  const headSha = stringValue(head?.sha);
  const headBranch = stringValue(head?.ref);
  const prNumber = numberValue(payload.number);
  if (!owner || !name || !baseSha || !headSha || !headBranch || !prNumber) return null;
  return {
    provider: "github",
    host: "github.com",
    owner,
    name,
    cloneUrl: stringValue(headRepo?.clone_url) ?? `https://github.com/${fullName}.git`,
    baseCloneUrl: stringValue(baseRepo?.clone_url) ?? `https://github.com/${fullName}.git`,
    defaultBranch: stringValue(base?.ref) ?? "main",
    baseSha,
    headSha,
    headBranch,
    prNumber,
  };
}

function repoFromIssue(
  payload: Record<string, unknown>,
  issue: Record<string, unknown>,
): RepoRef | null {
  const repository = record(payload, "repository");
  const fullName = stringValue(repository?.full_name);
  const [owner, name] = fullName?.split("/") ?? [];
  const pullRequest = record(issue, "pull_request");
  const prNumber = numberValue(issue.number);
  if (!owner || !name || !pullRequest || !prNumber) return null;
  return {
    provider: "github",
    host: "github.com",
    owner,
    name,
    cloneUrl: `https://github.com/${fullName}.git`,
    baseCloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    baseSha: "",
    headSha: "",
    headBranch: "",
    prNumber,
  };
}

function reviewPrompt(
  payload: Record<string, unknown>,
  pullRequest: Record<string, unknown>,
  repo: RepoRef,
): string {
  const title = stringValue(pullRequest.title) ?? "(untitled)";
  const body = stringValue(pullRequest.body) ?? "(no description)";
  return [
    "Perform a thorough pull-request code review.",
    `Repository: ${repo.owner}/${repo.name}`,
    `Pull request: #${numberValue(payload.number) ?? "?"} ${title}`,
    `Base: ${repo.defaultBranch} at ${repo.baseSha}`,
    `Head: ${repo.headBranch} at ${repo.headSha}`,
    "The workspace must be reviewed at the exact head SHA above; do not substitute main or a newer commit.",
    "Use the submit_github_review tool exactly once after inspecting the diff. Do not call gh or post review comments yourself.",
    "The review body must contain (1) a concise summary of what the PR changes, with a Mermaid diagram only when it materially clarifies the change, and (2) an overall feedback summary.",
    "Put each actionable finding in the tool's comments array as an inline comment targeting the changed line. Include only concrete, fixable issues and explain the impact.",
    "PR description:",
    body,
  ].join("\n\n");
}

function taskPrompt(body: string, repo: RepoRef, source: string): string {
  return [
    `A GitHub ${source} mentioned the configured agent handle. Treat this as a task delegation request.`,
    `Repository: ${repo.owner}/${repo.name}; pull request #${repo.prNumber ?? "?"}.`,
    "Work against the pull request head if available, and keep the task scoped to the request below.",
    "Use the reply_github_comment tool exactly once at the end to answer the triggering comment. Do not call gh or post to GitHub directly.",
    "Comment:",
    body,
  ].join("\n\n");
}

function isReviewAction(action: string | null): boolean {
  return action !== null && REVIEW_ACTIONS.has(action);
}

function mentionsAgent(body: string | null, mention: string): boolean {
  if (!body) return false;
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i").test(body);
}

function isBotSender(payload: Record<string, unknown>): boolean {
  const sender = record(payload, "sender");
  return (
    stringValue(sender?.type) === "Bot" ||
    stringValue(sender?.login)?.endsWith("[bot]") === true
  );
}

function record(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const candidate = value?.[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  return undefined;
}
