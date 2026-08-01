import { DEFAULT_PROFILE, getProfile } from "@pi-cloud-agent/profiles";
import {
  type CreateRunBody,
  createRunRequestSchema,
  parseRepoFullName,
  type RepoRef,
  type Trigger,
} from "@pi-cloud-agent/protocol";
import { createVcsProvider } from "@pi-cloud-agent/vcs";
import type { Config } from "../config";

interface ManualRequest {
  profile: string;
  repo: RepoRef;
  trigger: Trigger;
}

type ManualRequestResult =
  | { ok: true; body: CreateRunBody; request: ManualRequest }
  | { ok: false; error: { error: string; issues?: unknown } };

/** Parse and resolve the shared request accepted by standalone runs and sessions. */
export async function readManualRequest(
  body: unknown,
  config: Config,
): Promise<ManualRequestResult> {
  const parsed = createRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { error: "invalid request", issues: parsed.error.issues } };
  }
  try {
    return {
      ok: true,
      body: parsed.data,
      request: await resolveManualRequest(parsed.data, config),
    };
  } catch (error) {
    return {
      ok: false,
      error: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Resolve and validate one dashboard request before anything durable is written. */
async function resolveManualRequest(
  body: CreateRunBody,
  config: Config,
): Promise<ManualRequest> {
  const name = parseRepoFullName(body.repo);
  if (!name) throw new Error('repo must be "owner/name"');

  const vcs = createVcsProvider(body.provider, config.env);
  const branch =
    body.branch?.trim() || (await vcs.getDefaultBranch(body.repo).catch(() => null)) || "";
  const repo: RepoRef = {
    provider: body.provider,
    host: body.host,
    owner: name.owner,
    name: name.name,
    cloneUrl: `https://${body.host}/${body.repo}.git`,
    defaultBranch: branch || "main",
    baseSha: "",
    headSha: "",
    headBranch: branch,
    prNumber: null,
  };
  const trigger: Trigger = { kind: "manual", repo, prompt: body.prompt };
  const profile = body.profile || DEFAULT_PROFILE;
  const definition = getProfile(profile);
  if (!definition.accepts(trigger, {})) {
    throw new Error(`the "${profile}" profile does not accept this request`);
  }
  return { profile, repo, trigger };
}
