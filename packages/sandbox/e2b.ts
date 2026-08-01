import {
  SandboxError,
  type SandboxProvider,
  type SandboxRef,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import { Sandbox, SandboxNotFoundError } from "e2b";
import { z } from "zod";

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
});

export function createE2BProvider(
  env: Readonly<Record<string, string | undefined>>,
): SandboxProvider {
  const { E2B_API_KEY: apiKey, E2B_TEMPLATE: defaultTemplate } = envSchema.parse(env);
  // Checked here rather than in the schema so the message names the variable and
  // the provider, which is the only useful thing to say at startup.
  if (apiKey === "") {
    throw new Error("E2B_API_KEY is required by the e2b sandbox provider");
  }

  return {
    name: "e2b",

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const envs = flatten(spec);
      const template = spec.image || defaultTemplate;
      const timeoutMs = spec.timeoutSeconds * 1000;

      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create(template, { apiKey, envs, timeoutMs });
      } catch (cause) {
        throw new SandboxError(`e2b: could not create a sandbox from "${template}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      try {
        await sandbox.commands.run(spec.command, {
          background: true,
          envs,
          timeoutMs,
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
      const envs = flatten(spec);
      const timeoutMs = spec.timeoutSeconds * 1000;
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.connect(ref.id, { apiKey, timeoutMs });
        await sandbox.commands.run(spec.command, {
          background: true,
          envs,
          timeoutMs,
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

/**
 * Flatten config and credentials into one environment map.
 *
 * Secrets are opened here — the last possible moment, at the boundary where
 * they have to become plain strings to cross into the sandbox.
 */
function flatten(spec: SandboxSpec): Record<string, string> {
  const envs: Record<string, string> = { ...spec.env };
  for (const [key, secret] of Object.entries(spec.secrets)) {
    envs[key] = secret.expose();
  }
  return envs;
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
