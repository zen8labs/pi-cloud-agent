import {
  type CreateRunBody,
  createRunRequestSchema,
  type RepoRef,
  type Trigger,
} from "@pi-cloud-agent/protocol";
import type { Context } from "hono";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { getVcsProvider } from "../vcs/connections";
import type { AppEnv } from "./deps";

interface ManualRequest {
  repo: RepoRef;
  trigger: Trigger;
}

type ManualRequestResult =
  | { ok: true; body: CreateRunBody; request: ManualRequest }
  | { ok: false; error: { error: string; issues?: unknown } };

/** Parse and resolve the shared request accepted by standalone runs and sessions. */
async function readManualRequest(
  body: unknown,
  config: Config,
  database: Database,
  userId: string | null,
): Promise<ManualRequestResult> {
  const parsed = createRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { error: "invalid request", issues: parsed.error.issues } };
  }
  try {
    return {
      ok: true,
      body: parsed.data,
      request: await resolveManualRequest(parsed.data, config, database, userId),
    };
  } catch (error) {
    return {
      ok: false,
      error: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function readManualRouteRequest(c: Context<AppEnv>): Promise<ManualRequestResult> {
  return readManualRequest(
    await c.req.json().catch(() => null),
    c.get("config"),
    c.get("database"),
    c.get("user")?.id ?? null,
  );
}

/** Resolve and validate one dashboard request before anything durable is written. */
async function resolveManualRequest(
  body: CreateRunBody,
  config: Config,
  database: Database,
  userId: string | null,
): Promise<ManualRequest> {
  const vcs = await getVcsProvider(database, config, body.provider, userId);
  const repository = await vcs.getRepository(body.repo);
  if (!repository)
    throw new Error("repository is not available through the connected identity");
  const branch =
    body.branch?.trim() || (await vcs.getDefaultBranch(body.repo).catch(() => null)) || "";
  const repo: RepoRef = {
    provider: repository.provider,
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
    cloneUrl: repository.cloneUrl,
    defaultBranch: branch || repository.defaultBranch || "main",
    baseSha: "",
    headSha: "",
    headBranch: branch,
    prNumber: null,
  };
  const trigger: Trigger = { kind: "manual", repo, prompt: body.prompt };
  return { repo, trigger };
}
