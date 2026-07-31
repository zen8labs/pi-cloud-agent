import { getProfile } from "@pi-cloud-agent/profiles";
import {
  SANDBOX_ENV,
  SANDBOX_PATHS,
  SandboxError,
  type SandboxProvider,
  Secret,
  type TaskSpec,
} from "@pi-cloud-agent/protocol";
import { createVcsProvider } from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { getRepoConfig } from "../db/repo-config";
import { attachSandbox, completeRun, markRunning, requeueRun } from "../db/runs";
import type { RunRow } from "../db/schema";
import type { Logger } from "../logger";
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
    const task = await buildTask(run, database);
    const vcs = createVcsProvider(run.provider, config.env);
    const credentials = await broker.mintForRun({
      provider: run.provider,
      repoFullName: run.repoFullName,
      host: task.repo.host,
      vcs,
    });

    const wallClockSeconds = Math.min(
      task.wallClockSeconds ?? config.runWallClockSeconds,
      config.runWallClockSeconds,
    );

    const ref = await sandbox.create({
      runId: run.id,
      image: "",
      timeoutSeconds: config.sandbox.timeoutSeconds,
      env: { ...buildEnv(run, task, config), ...credentials.env },
      secrets: {
        ...credentials.secrets,
        [SANDBOX_ENV.callbackToken]: new Secret(run.callbackToken, "run callback token"),
      },
      command: `node ${SANDBOX_PATHS.app}/run.js`,
    });

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
    log.info("sandbox running", { sandboxId: ref.id, wallClockSeconds });
  } catch (error) {
    await handleFailure(run, error, deps, log);
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
 * The controller reads the stored config but never looks inside it — the profile
 * validates and interprets its own settings. Enrichment happens here rather than
 * in the profile because "this webhook did not include a commit SHA" is a fact
 * about forges, not about reviewing code.
 */
async function buildTask(run: RunRow, database: Database): Promise<TaskSpec> {
  const profile = getProfile(run.profile);
  const storedConfig = await getRepoConfig(database, {
    provider: run.provider,
    repoFullName: run.repoFullName,
    profile: run.profile,
  });
  return profile.buildTask(run.trigger, storedConfig);
}

/**
 * The environment the sandbox boots against.
 *
 * Names come from `SANDBOX_ENV` in the protocol package, which both sides import
 * — so a rename here is a type error in the runtime rather than a run that starts
 * with an empty prompt.
 */
function buildEnv(run: RunRow, task: TaskSpec, config: Config): Record<string, string> {
  const { repo } = task;
  return {
    [SANDBOX_ENV.controlPlaneUrl]: config.controlPlaneUrl,
    [SANDBOX_ENV.runId]: run.id,

    [SANDBOX_ENV.profile]: task.profile,
    [SANDBOX_ENV.taskPrompt]: composePrompt(run.profile, task.prompt),

    [SANDBOX_ENV.model]: run.model,
    [SANDBOX_ENV.modelBaseUrl]: config.model.baseUrl,
    [SANDBOX_ENV.modelContextWindow]: String(config.model.contextWindow),
    [SANDBOX_ENV.modelMaxTokens]: String(config.model.maxTokens),

    [SANDBOX_ENV.repoProvider]: repo.provider,
    [SANDBOX_ENV.repoHost]: repo.host,
    [SANDBOX_ENV.repoOwner]: repo.owner,
    [SANDBOX_ENV.repoName]: repo.name,
    [SANDBOX_ENV.repoCloneUrl]: repo.cloneUrl,
    [SANDBOX_ENV.repoDefaultBranch]: repo.defaultBranch,
    [SANDBOX_ENV.repoBaseSha]: repo.baseSha,
    [SANDBOX_ENV.repoHeadSha]: repo.headSha,
    [SANDBOX_ENV.repoHeadBranch]: repo.headBranch,
    [SANDBOX_ENV.prNumber]: repo.prNumber === null ? "" : String(repo.prNumber),
  };
}

/**
 * Prepend the profile's skill to the concrete request.
 *
 * Composed here, on the trusted side, so the sandbox image ships no profile code
 * at all — the runtime receives one finished prompt and never learns that
 * profiles exist.
 */
function composePrompt(profileName: string, prompt: string): string {
  const skill = getProfile(profileName).skill?.trim();
  return skill ? `${skill}\n\n---\n\n${prompt}` : prompt;
}
