import { getProfile } from "@pi-cloud-agent/profiles";
import {
  SANDBOX_ENV,
  SANDBOX_PATHS,
  SandboxError,
  type SandboxProvider,
  type SandboxRef,
  Secret,
  type TaskSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  appendEvent,
  attachSandbox,
  completeRun,
  markRunning,
  requeueRun,
  setRunPlugins,
} from "../db/runs";
import type { RunRow } from "../db/schema";
import { clearSessionWorkspace, getSessionForRun } from "../db/sessions";
import type { Logger } from "../logger";
import { buildTaskPrompt, resolvePluginsForRun } from "../plugins/catalog";
import type { CredentialBroker } from "../secrets/broker";

/**
 * Take one claimed run from "queued" to "a sandbox is working on it".
 *
 * This function is deliberately short-lived. It does not wait for the agent, does
 * not stream events, and holds nothing in memory once it returns — the Python
 * version's equivalent blocked for the entire run inside an `asyncio.wait_for`,
 * which is exactly why a controller restart used to force-fail live work. Here,
 * the run's whole future is on its row before this returns.
 *
 * See docs/resumability.md.
 */

export interface ProvisionDeps {
  config: Config;
  database: Database;
  broker: CredentialBroker;
  sandbox: SandboxProvider;
  log: Logger;
}

/** How many times a retryable provisioning failure is worth another attempt. */
const MAX_ATTEMPTS = 3;

export async function provisionRun(run: RunRow, deps: ProvisionDeps): Promise<void> {
  const { config, database, broker, sandbox } = deps;
  const log = deps.log.child({ runId: run.id, profile: run.profile, repo: run.repoFullName });

  try {
    const task = buildTask(run);
    const resolved = await resolvePluginsForRun(database, config, run.userId, run.profile);
    await setRunPlugins(database, run.id, resolved.attached);
    if (resolved.attached.length > 0) {
      await appendEvent(database, run.id, "plugins.attached", {
        plugins: resolved.attached,
      });
    }

    const credentials = await broker.mintForRun({
      userId: run.userId,
      provider: run.provider,
      repoFullName: run.repoFullName,
      modelConnectionId: run.modelConnectionId,
      modelSnapshot: run.model,
    });

    const wallClockSeconds = Math.min(
      task.wallClockSeconds ?? config.runWallClockSeconds,
      config.runWallClockSeconds,
    );

    const session = await getSessionForRun(database, run);
    const workspaceResumed = Boolean(session?.sandboxId);
    const env = {
      ...buildEnv(run, task, config, workspaceResumed, resolved.skillText, credentials.model),
      ...credentials.env,
    };
    const secrets: Record<string, Secret> = {
      ...credentials.secrets,
      [SANDBOX_ENV.callbackToken]: new Secret(run.callbackToken, "run callback token"),
    };
    if (resolved.mcpConfig) {
      secrets[SANDBOX_ENV.mcpConfig] = new Secret(
        JSON.stringify(resolved.mcpConfig),
        "mcp config",
      );
    }

    const spec = {
      runId: run.id,
      image: "",
      timeoutSeconds: config.sandbox.timeoutSeconds,
      env,
      secrets,
      command: `node --import tsx ${SANDBOX_PATHS.app}/run.js`,
    };
    const ref = await startSandbox(session, spec, sandbox, database, log);

    // First durable write after the machine exists. Until this commits, a crash
    // would leak the sandbox; after it, the reconciler will always find it.
    const attached = await attachSandbox(
      database,
      run.id,
      ref,
      new Date(Date.now() + wallClockSeconds * 1000),
    );

    if (!attached) {
      // The run left `provisioning` while we were creating the machine — almost
      // always a cancel. The machine is ours to clean up, not the reconciler's,
      // because its id was never stored.
      log.warn("run left provisioning during create; stopping the orphan sandbox", {
        sandboxId: ref.id,
      });
      await sandbox.stop(ref).catch((error) => log.error("orphan stop failed", { error }));
      return;
    }

    await markRunning(database, run.id);
    log.info("sandbox running", {
      sandboxId: ref.id,
      wallClockSeconds,
      workspaceResumed,
      plugins: resolved.attached.map((plugin) => `${plugin.name}@${plugin.version}`),
    });
  } catch (error) {
    await handleFailure(run, error, deps, log);
  }
}

async function startSandbox(
  session: Awaited<ReturnType<typeof getSessionForRun>>,
  spec: Parameters<SandboxProvider["create"]>[0],
  sandbox: SandboxProvider,
  database: Database,
  log: Logger,
): Promise<SandboxRef> {
  if (!session?.sandboxId) return sandbox.create(spec);
  const workspace = {
    provider: session.sandboxProvider ?? sandbox.name,
    id: session.sandboxId,
  };
  try {
    return await sandbox.resume(workspace, spec);
  } catch (error) {
    if (!(error instanceof WorkspaceNotFoundError)) throw error;
    await clearSessionWorkspace(database, session.id, workspace.id);
    log.warn("stored session workspace is gone; continuing from checkpoint", {
      sessionId: session.id,
      workspaceId: workspace.id,
    });
    return sandbox.create({
      ...spec,
      env: { ...spec.env, [SANDBOX_ENV.workspaceResumed]: "false" },
    });
  }
}

async function handleFailure(
  run: RunRow,
  error: unknown,
  deps: ProvisionDeps,
  log: Logger,
): Promise<void> {
  const retryable = error instanceof SandboxError && error.retryable;
  const message = error instanceof Error ? error.message : String(error);

  if (retryable && run.attempt < MAX_ATTEMPTS) {
    log.warn("provisioning failed, returning the run to the queue", {
      attempt: run.attempt,
      error,
    });
    await requeueRun(deps.database, run.id);
    return;
  }

  log.error("provisioning failed", { attempt: run.attempt, error });
  await completeRun(deps.database, run.id, "failed", message);
}

/**
 * Ask the owning profile what the agent should do.
 *
 * The controller never looks inside a profile's config — the profile validates
 * and interprets its own settings, and an empty object means "apply your
 * defaults".
 */
function buildTask(run: RunRow): TaskSpec {
  const profile = getProfile(run.profile);
  return profile.buildTask(run.trigger, {});
}

/**
 * The environment the sandbox boots against.
 *
 * Names come from `SANDBOX_ENV` in the protocol package, which both sides import
 * — so a rename here is a type error in the runtime rather than a run that starts
 * with an empty prompt.
 */
function buildEnv(
  run: RunRow,
  task: TaskSpec,
  config: Config,
  workspaceResumed: boolean,
  skillText: string | undefined,
  model: import("../llm/connections").ResolvedLlmModel,
): Record<string, string> {
  const { repo } = task;
  return {
    [SANDBOX_ENV.controlPlaneUrl]: config.controlPlaneUrl,
    [SANDBOX_ENV.runId]: run.id,
    [SANDBOX_ENV.sessionId]: run.sessionId ?? "",
    [SANDBOX_ENV.workspaceResumed]: String(workspaceResumed),

    [SANDBOX_ENV.profile]: task.profile,
    [SANDBOX_ENV.taskPrompt]: buildTaskPrompt(skillText, task.prompt, run.turnNumber),

    [SANDBOX_ENV.model]: `${model.provider}/${model.name}`,
    [SANDBOX_ENV.modelApi]: model.api,
    [SANDBOX_ENV.modelAuthType]: model.authType,
    [SANDBOX_ENV.modelBaseUrl]: model.baseUrl,
    [SANDBOX_ENV.modelContextWindow]: String(model.contextWindow),
    [SANDBOX_ENV.modelMaxTokens]: String(model.maxTokens),
    [SANDBOX_ENV.modelThinkingLevel]: run.thinkingLevel,

    [SANDBOX_ENV.repoProvider]: repo.provider,
    [SANDBOX_ENV.repoHost]: repo.host,
    [SANDBOX_ENV.repoOwner]: repo.owner,
    [SANDBOX_ENV.repoName]: repo.name,
    [SANDBOX_ENV.repoCloneUrl]: repo.cloneUrl,
    [SANDBOX_ENV.repoDefaultBranch]: repo.defaultBranch,
    [SANDBOX_ENV.repoBaseSha]: repo.baseSha,
    [SANDBOX_ENV.repoHeadSha]: repo.headSha,
    [SANDBOX_ENV.repoHeadBranch]: repo.headBranch,
  };
}
