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
import { getRepositorySandboxImage } from "../db/environments";
import { failProvisioningAttempt, renewProvisioningClaim } from "../db/provisioning";
import { appendEvent, attachSandbox, markRunning, requeueRun, setRunPlugins } from "../db/runs";
import type { RunRow } from "../db/schema";
import { pinSessionSandboxImage } from "../db/session-images";
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
  /** Resolve a provider recorded on a parked session after a config change. */
  createProvider?: (name: string) => SandboxProvider;
  log: Logger;
  claimLeaseSeconds?: number;
}

/** How many times a retryable provisioning failure is worth another attempt. */
const MAX_ATTEMPTS = 3;

export async function provisionRun(run: RunRow, deps: ProvisionDeps): Promise<void> {
  const { config, database, broker, sandbox } = deps;
  const log = deps.log.child({ runId: run.id, repo: run.repoFullName });
  const heartbeat = startProvisioningHeartbeat(run, deps);

  try {
    const task = buildTask(run);
    const resolved = await resolvePluginsForRun(database, config, run.userId);
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
      ...buildEnv(
        run,
        task,
        config,
        workspaceResumed,
        resolved.skillText,
        credentials.model,
        session?.diffBaseSha ?? null,
      ),
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
    const environment = await getRepositorySandboxImage(
      database,
      run.userId,
      run.provider,
      run.repoFullName,
    );
    const sessionProvider = sessionProviderName(session, sandbox.name);
    let sessionSandbox = providerFor(deps, sandbox, sessionProvider);
    const requestedImageRef = session?.sandboxImageRef || environment?.imageRef || "";
    let imageRef =
      session?.sandboxImageRef ?? (await sessionSandbox.resolveImage(requestedImageRef));
    if (session && session.sandboxImageRef === null) {
      const pinnedImage = await pinSessionSandboxImage(
        database,
        session.id,
        sessionSandbox.name,
        imageRef,
      );
      if (pinnedImage === null) {
        throw new SandboxError("session image could not be pinned", { retryable: true });
      }
      imageRef = pinnedImage.imageRef;
      sessionSandbox = providerFor(deps, sandbox, pinnedImage.provider);
    }
    let allocated = false;
    const spec = {
      runId: run.id,
      image: imageRef,
      timeoutSeconds: config.sandbox.timeoutSeconds,
      env,
      secrets,
      command: `cd ${SANDBOX_PATHS.app} && ./bin/node --import tsx ./run.js`,
      onAllocated: async (ref: SandboxRef) => {
        await attachOwnedSandbox(database, run, ref, wallClockSeconds);
        allocated = true;
        clearInterval(heartbeat);
      },
    };
    const ref = await startSandbox(session, spec, sessionSandbox, database, log);

    // Every provider must report allocation before launching the runtime.
    if (!allocated) {
      log.warn("provider skipped allocation reporting; stopping the orphan sandbox", {
        sandboxId: ref.id,
      });
      await sessionSandbox
        .stop(ref)
        .catch((error) => log.error("orphan stop failed", { error }));
      throw new Error("sandbox provider did not report allocation before launch");
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
  } finally {
    clearInterval(heartbeat);
  }
}

function sessionProviderName(
  session: Awaited<ReturnType<typeof getSessionForRun>>,
  fallback: string,
): string {
  return session?.sandboxId
    ? (session.sandboxProvider ?? fallback)
    : (session?.sandboxImageProvider ?? fallback);
}

async function attachOwnedSandbox(
  database: Database,
  run: RunRow,
  ref: SandboxRef,
  wallClockSeconds: number,
) {
  const attached = await attachSandbox(
    database,
    run.id,
    ref,
    new Date(Date.now() + wallClockSeconds * 1000),
    run.attempt,
  );
  if (!attached) throw new Error("provisioning ownership was lost before runtime launch");
}

function startProvisioningHeartbeat(run: RunRow, deps: ProvisionDeps) {
  const leaseSeconds = deps.claimLeaseSeconds ?? 120;
  const heartbeat = setInterval(
    () => {
      void renewProvisioningClaim(deps.database, run, leaseSeconds).catch((error: unknown) =>
        deps.log.warn("provisioning heartbeat failed", { runId: run.id, error }),
      );
    },
    Math.max(10, (leaseSeconds * 1000) / 3),
  );
  heartbeat.unref();
  return heartbeat;
}

function providerFor(
  deps: ProvisionDeps,
  sandbox: SandboxProvider,
  providerName: string,
): SandboxProvider {
  if (providerName === sandbox.name) return sandbox;
  const provider = deps.createProvider?.(providerName);
  if (!provider) {
    throw new SandboxError(`sandbox provider "${providerName}" is unavailable`, {
      retryable: false,
    });
  }
  return provider;
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
    await clearSessionWorkspace(database, session.id, workspace.id, session.activeRunId);
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
    if (await requeueRun(deps.database, run.id, { attempt: run.attempt })) return;
  }

  log.error("provisioning failed", { attempt: run.attempt, error });
  await failProvisioningAttempt(deps.database, run, message);
}

function buildTask(run: RunRow): TaskSpec {
  const prompt = run.trigger.prompt?.trim();
  if (!prompt) throw new Error("the request requires a prompt");
  return { prompt, repo: run.trigger.repo };
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
  sessionBaseSha: string | null,
): Record<string, string> {
  const { repo } = task;
  return {
    [SANDBOX_ENV.controlPlaneUrl]: config.controlPlaneUrl,
    [SANDBOX_ENV.runId]: run.id,
    [SANDBOX_ENV.sessionId]: run.sessionId ?? "",
    [SANDBOX_ENV.sessionBaseSha]: sessionBaseSha ?? "",
    [SANDBOX_ENV.workspaceResumed]: String(workspaceResumed),
    [SANDBOX_ENV.debugEvents]: String(config.observability.exportDebugEvents),

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
