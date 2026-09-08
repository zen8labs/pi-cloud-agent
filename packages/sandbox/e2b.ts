import { createHash, randomUUID } from "node:crypto";
import {
  SandboxError,
  type SandboxExecutionResult,
  type SandboxProvider,
  type SandboxRef,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import { ApiClient, ConnectionConfig, Sandbox, SandboxNotFoundError, Template } from "e2b";
import { z } from "zod";
import { flattenSecrets } from "./environment.js";
import { readRuntimeArchive, runtimeInstallCommand, runtimeUser } from "./runtime-install.js";

/**
 * E2B: a hosted microVM per run.
 *
 * The one non-obvious thing here is that the command is started explicitly on
 * `create` rather than baked into the template's start command. E2B runs a
 * template's start command when the *template* is built, but our runtime needs
 * per-run values (which run, which prompt, which credentials) that only exist at
 * create time. So the template's start command is a no-op `sleep infinity` and
 * the real work is launched below.
 */

const envSchema = z.object({
  E2B_API_KEY: z.string().default(""),
  E2B_TEMPLATE: z.string().default("pi-cloud-agent"),
  SANDBOX_RUNTIME_DIR: z.string().default(""),
});

/** Same size as microSandbox's defaults (`MICROSANDBOX_CPUS` / `MICROSANDBOX_MEMORY_MB`). */
const TEMPLATE_CPU_COUNT = 2;
const TEMPLATE_MEMORY_MB = 4096;

function sessionOpts(apiKey: string, timeoutMs: number) {
  // The SDK's 60s request timeout is too short for a 120MB runtime upload,
  // especially after a filesystem-only pause that cold-boots the VM.
  return { apiKey, timeoutMs, requestTimeoutMs: timeoutMs };
}

export function createE2BProvider(
  env: Readonly<Record<string, string | undefined>>,
): SandboxProvider {
  const {
    E2B_API_KEY: apiKey,
    E2B_TEMPLATE: defaultTemplate,
    SANDBOX_RUNTIME_DIR: runtimeDirectory,
  } = envSchema.parse(env);
  // Checked here rather than in the schema so the message names the variable and
  // the provider, which is the only useful thing to say at startup.
  if (apiKey === "") {
    throw new Error("E2B_API_KEY is required by the e2b sandbox provider");
  }
  const templateResolutions = new Map<string, Promise<string>>();

  const resolveTemplate = (imageRef: string): Promise<string> => {
    const requested = imageRef || defaultTemplate;
    const pending = templateResolutions.get(requested);
    if (pending) return pending;
    const resolution = resolveTemplateReference(requested, defaultTemplate, apiKey).finally(
      () => {
        // Cache only work already in progress. A tag may be republished in the
        // registry, so a completed resolution must not become a permanent pin.
        templateResolutions.delete(requested);
      },
    );
    templateResolutions.set(requested, resolution);
    return resolution;
  };

  return {
    name: "e2b",

    resolveImage: (imageRef) => resolveTemplate(imageRef),

    async execute(spec: SandboxSpec): Promise<SandboxExecutionResult> {
      const envs = flattenSecrets(spec);
      const timeoutMs = spec.timeoutSeconds * 1000;
      let sandbox: Sandbox | undefined;
      let ownedTemplate: string | undefined;
      try {
        // Preflight owns its materialization exclusively; never delete a build
        // shared with a session's pinned image resolution.
        const template = await resolveTemplateReference(
          spec.image || defaultTemplate,
          defaultTemplate,
          apiKey,
          (name) => {
            ownedTemplate = name;
          },
        );
        sandbox = await Sandbox.create(template, sessionOpts(apiKey, timeoutMs));
        await installRuntime(sandbox, runtimeDirectory, timeoutMs);
        const result = await sandbox.commands.run(spec.command, {
          envs,
          timeoutMs,
          requestTimeoutMs: timeoutMs,
          user: runtimeUser,
        });
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (cause) {
        throw new SandboxError("e2b: environment test failed", {
          retryable: isRetryable(cause),
          cause,
        });
      } finally {
        try {
          if (sandbox) await Sandbox.kill(sandbox.sandboxId, { apiKey });
        } finally {
          if (ownedTemplate) await deletePreflightTemplate(ownedTemplate, apiKey);
        }
      }
    },

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const envs = flattenSecrets(spec);
      const timeoutMs = spec.timeoutSeconds * 1000;

      let sandbox: Sandbox;
      try {
        const template = await resolveTemplate(spec.image);
        sandbox = await Sandbox.create(template, sessionOpts(apiKey, timeoutMs));
      } catch (cause) {
        const requested = spec.image || defaultTemplate;
        throw new SandboxError(`e2b: could not create a sandbox from "${requested}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      try {
        await spec.onAllocated?.({ provider: "e2b", id: sandbox.sandboxId });
        await installRuntime(sandbox, runtimeDirectory, timeoutMs);
        await sandbox.commands.run(spec.command, {
          background: true,
          envs,
          timeoutMs,
          requestTimeoutMs: timeoutMs,
          user: runtimeUser,
        });
      } catch (cause) {
        // The machine exists but will never do anything. Reclaim it now rather
        // than leaving the reconciler to notice it went silent.
        await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch(() => undefined);
        throw new SandboxError("e2b: sandbox started but the runtime command did not", {
          retryable: isRetryable(cause),
          cause,
        });
      }

      return { provider: "e2b", id: sandbox.sandboxId };
    },

    async resume(ref, spec): Promise<SandboxRef> {
      const envs = flattenSecrets(spec);
      const timeoutMs = spec.timeoutSeconds * 1000;
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await Sandbox.connect(ref.id, sessionOpts(apiKey, timeoutMs));
        await spec.onAllocated?.({ provider: "e2b", id: sandbox.sandboxId });
        await installRuntime(sandbox, runtimeDirectory, timeoutMs);
        await sandbox.commands.run(spec.command, {
          background: true,
          envs,
          timeoutMs,
          requestTimeoutMs: timeoutMs,
          user: runtimeUser,
        });
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) {
          throw new WorkspaceNotFoundError(`e2b: workspace "${ref.id}" no longer exists`, {
            cause,
          });
        }
        throw new SandboxError(`e2b: could not resume workspace "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }
      return { provider: "e2b", id: sandbox.sandboxId };
    },

    async suspend(ref) {
      try {
        // The runtime has exited. Preserve its filesystem, not process memory or
        // the per-turn credentials that were injected into that process.
        await Sandbox.pause(ref.id, { apiKey, keepMemory: false });
      } catch (cause) {
        throw new SandboxError(`e2b: could not suspend workspace "${ref.id}"`, {
          retryable: false,
          cause,
        });
      }
      return { provider: "e2b", id: ref.id };
    },

    async finalizeSuspend() {
      // E2B's paused sandbox id is itself the durable workspace reference; it
      // has no separate source resource to release after the database commit.
    },

    async deleteWorkspace(ref): Promise<void> {
      await Sandbox.kill(ref.id, { apiKey });
    },

    async stop(ref: SandboxRef): Promise<void> {
      // Idempotent by construction: killing an already-dead sandbox returns
      // false rather than throwing, and the reconciler may well do exactly that.
      await Sandbox.kill(ref.id, { apiKey });
    },
  };
}

async function installRuntime(sandbox: Sandbox, directory: string, timeoutMs: number) {
  const machine = await sandbox.commands.run("uname -m", {
    user: "root",
    timeoutMs,
    requestTimeoutMs: timeoutMs,
  });
  const archive = await readRuntimeArchive(directory, machine.stdout);
  const target = `/tmp/pi-runtime-${randomUUID()}.tar.gz`;
  await sandbox.files.write(target, new Uint8Array(archive).buffer, {
    user: "root",
    requestTimeoutMs: timeoutMs,
  });
  await sandbox.commands.run(runtimeInstallCommand(target), {
    user: "root",
    timeoutMs,
    requestTimeoutMs: timeoutMs,
  });
}

async function resolveTemplateReference(
  imageRef: string,
  defaultTemplate: string,
  apiKey: string,
  onOwnedTemplate?: (name: string) => void,
): Promise<string> {
  // Preserve the deployment's configured template alias exactly. Repository
  // mappings may instead use a Docker reference, including short official
  // images such as `ubuntu`; those are promoted to cached templates below.
  if (imageRef === defaultTemplate) return imageRef;
  if (isContainerImageReference(imageRef))
    return buildTemplateFromImage(imageRef, apiKey, onOwnedTemplate);
  if (await Template.exists(imageRef, { apiKey })) return imageRef;
  return buildTemplateFromImage(imageRef, apiKey, onOwnedTemplate);
}

function isContainerImageReference(imageRef: string): boolean {
  // A slash covers namespaced registries and `:tag` covers official Docker Hub
  // images such as `node:22`. Untagged official images are handled by probing
  // for an existing E2B template first, then building from the image name.
  return imageRef.includes("/") || imageRef.includes(":");
}

async function buildTemplateFromImage(
  imageRef: string,
  apiKey: string,
  onOwnedTemplate?: (name: string) => void,
): Promise<string> {
  const digest = createHash("sha256").update(imageRef).digest("hex").slice(0, 16);
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const suffix = `${digest}-${unique}`;
  const name = `pi-cloud-agent-${suffix}`;
  onOwnedTemplate?.(name);
  const template = Template().fromImage(imageRef).setStartCmd("sleep infinity", "true");
  // Every materialization gets its own immutable alias. A registry tag can be
  // republished, and a failed build must never silently reuse an older alias.
  await Template.build(template, name, {
    apiKey,
    skipCache: true,
    cpuCount: TEMPLATE_CPU_COUNT,
    memoryMB: TEMPLATE_MEMORY_MB,
  });
  return name;
}

async function deletePreflightTemplate(alias: string, apiKey: string): Promise<void> {
  const client = new ApiClient(new ConnectionConfig({ apiKey }));
  const lookup = await client.api.GET("/templates/aliases/{alias}", {
    params: { path: { alias } },
  });
  if (lookup.response.status === 404) return;
  if (lookup.error || !lookup.data)
    throw new Error(`e2b: could not locate disposable template "${alias}" for cleanup`);
  const result = await client.api.DELETE("/templates/{templateID}", {
    params: { path: { templateID: lookup.data.templateID } },
  });
  if (result.error) throw new Error(`e2b: could not delete disposable template "${alias}"`);
}

const RETRYABLE_PATTERNS = [
  "timeout",
  "timed out",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "502",
  "503",
  "504",
];

/**
 * Distinguish "try again" from "this will never work".
 *
 * Only retryable failures send a run back to the queue; a bad template or a
 * rejected key should fail fast and visibly rather than burning attempts.
 */
function isRetryable(cause: unknown): boolean {
  const text = String(cause instanceof Error ? cause.message : cause).toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => text.includes(pattern));
}
