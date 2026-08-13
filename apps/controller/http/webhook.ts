import { randomBytes } from "node:crypto";
import type { Trigger } from "@pi-cloud-agent/protocol";
import { thinkingLevelSchema } from "@pi-cloud-agent/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { createRun } from "../db/runs";
import {
  type IngressAccept,
  REST_WEBHOOK_SURFACE_KIND,
  reportRunLifecycle,
} from "../integrations";
import { getVcsProvider } from "../vcs/connections";
import type { AppEnv } from "./deps";
import { resolveRequestedLlmModel } from "./model-selection";

const webhookModelSchema = z.object({
  modelConnectionId: z.string().uuid(),
  modelId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema.default("medium"),
});

type WebhookModel = z.infer<typeof webhookModelSchema>;

/**
 * Machine-to-machine ingress (ZEN-93).
 *
 * Auth is the webhook bearer token, not a browser session. Disabled when
 * WEBHOOK_BEARER_TOKEN is unset.
 */
export function webhookRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const ready = webhookReady(c);
    if (ready instanceof Response) return ready;
    const parsed = await parseWebhookPost(c, ready.token);
    if (parsed instanceof Response) return parsed;
    return enqueueWebhookRun(c, ready.actorId, parsed.accepted, parsed.models);
  });

  return app;
}

function webhookReady(c: Context<AppEnv>): { token: string; actorId: string } | Response {
  const token = c.get("config").webhook.bearerToken;
  if (!token) return c.json({ error: "not found" }, 404);
  const actorId = c.get("config").webhook.userId;
  if (!actorId) return c.json({ error: "webhook actor is not configured" }, 503);
  if (!c.get("integrations").getAdapter(REST_WEBHOOK_SURFACE_KIND)) {
    return c.json({ error: "not found" }, 404);
  }
  return { token, actorId };
}

async function parseWebhookPost(
  c: Context<AppEnv>,
  token: string,
): Promise<{ accepted: IngressAccept; models: WebhookModel } | Response> {
  const authorization = c.req.header("authorization");
  if (!bearerMatches(authorization, token)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const adapter = c.get("integrations").getAdapter(REST_WEBHOOK_SURFACE_KIND);
  if (!adapter) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => null);
  const accepted = await adapter.accept({ authorizationHeader: authorization, body });
  if (!accepted) return c.json({ error: "invalid request" }, 422);
  const models = webhookModelSchema.safeParse(body);
  if (!models.success) {
    return c.json({ error: "invalid request", issues: models.error.issues }, 422);
  }
  return { accepted, models: models.data };
}

async function enqueueWebhookRun(
  c: Context<AppEnv>,
  actorId: string,
  accepted: IngressAccept,
  models: WebhookModel,
): Promise<Response> {
  const config = c.get("config");
  const selected = await resolveRequestedLlmModel(
    c.get("database"),
    config,
    actorId,
    models.modelConnectionId,
    models.modelId,
    models.thinkingLevel,
  );
  if (!selected.ok) return c.json({ error: selected.error }, 422);

  const trigger = await webhookTrigger(c.get("database"), config, actorId, accepted.trigger);
  if (trigger instanceof Response) return trigger;

  const run = await createRun(c.get("database"), {
    userId: actorId,
    provider: trigger.repo.provider,
    repoFullName: `${trigger.repo.owner}/${trigger.repo.name}`,
    trigger,
    model: `${selected.model.provider}/${selected.model.name}`,
    modelConnectionId: selected.model.connectionId,
    thinkingLevel: models.thinkingLevel,
    callbackToken: randomBytes(32).toString("hex"),
    surfaceRef: accepted.surface,
  });

  await reportRunLifecycle(c.get("integrations"), c.get("log"), run, "queued");
  c.get("log").info("webhook run queued", { runId: run.id, repo: run.repoFullName });
  return c.json({ id: run.id, status: run.status }, 202);
}

async function webhookTrigger(
  database: Database,
  config: Config,
  actorId: string,
  trigger: Trigger,
): Promise<Trigger | Response> {
  try {
    const repo = await resolveWebhookRepo(
      database,
      config,
      actorId,
      trigger.repo.provider,
      `${trigger.repo.owner}/${trigger.repo.name}`,
      trigger.repo.headBranch,
    );
    return { ...trigger, repo };
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
  }
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] === expected;
}

async function resolveWebhookRepo(
  database: Database,
  config: Config,
  userId: string,
  provider: string,
  repoFullName: string,
  branch: string,
) {
  const vcs = await getVcsProvider(database, config, provider, userId);
  const repository = await vcs.getRepository(repoFullName);
  if (!repository) {
    throw new Error("repository is not available through the connected identity");
  }
  const resolvedBranch =
    branch.trim() || (await vcs.getDefaultBranch(repoFullName).catch(() => null)) || "";
  return {
    provider: repository.provider,
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
    cloneUrl: repository.cloneUrl,
    defaultBranch: resolvedBranch || repository.defaultBranch || "main",
    baseSha: "",
    headSha: "",
    headBranch: resolvedBranch,
    prNumber: null,
  };
}
