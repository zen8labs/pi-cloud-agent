import { randomUUID } from "node:crypto";
import {
  SandboxError,
  type SandboxProvider,
  type SandboxRef,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import {
  MicrosandboxError,
  NetworkPolicy,
  Sandbox,
  SandboxNotFoundError,
  SandboxStillRunningError,
} from "microsandbox";
import { z } from "zod";

const envSchema = z.object({
  MICROSANDBOX_IMAGE: z.string().default("pi-cloud-agent:local"),
  MICROSANDBOX_CPUS: z.coerce.number().int().positive().default(4),
  MICROSANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  MICROSANDBOX_ALLOW_HOST: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

/**
 * microSandbox: local, hardware-isolated OCI sandboxes.
 *
 * The image's normal entrypoint is overridden with an inert command because
 * this provider must inject per-run values before starting the runtime. The
 * runtime is then launched as a detached guest process, which lets the
 * controller keep the existing outbound-only provider contract.
 */
export function createMicroSandboxProvider(
  env: Readonly<Record<string, string | undefined>>,
): SandboxProvider {
  const {
    MICROSANDBOX_IMAGE: defaultImage,
    MICROSANDBOX_CPUS: cpus,
    MICROSANDBOX_MEMORY_MB: memoryMb,
    MICROSANDBOX_ALLOW_HOST: allowHost,
  } = envSchema.parse(env);

  return {
    name: "microsandbox",

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const id = `pi-${spec.runId}-${randomUUID().slice(0, 8)}`;
      const image = spec.image || defaultImage;
      let sandbox: Sandbox;

      try {
        sandbox = await Sandbox.builder(id)
          .image(image)
          .entrypoint(["sleep", "infinity"])
          .cpus(cpus)
          .memory(memoryMb)
          .network((network) => network.policy(buildNetworkPolicy(spec, allowHost)))
          .detached(true)
          .maxDuration(spec.timeoutSeconds)
          .create();
      } catch (cause) {
        throw new SandboxError(`microsandbox: could not create "${image}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      try {
        await startRuntime(sandbox, spec);
        await sandbox.detach();
      } catch (cause) {
        await sandbox.kill().catch(() => undefined);
        throw new SandboxError(
          "microsandbox: sandbox started but the runtime command did not",
          {
            retryable: isRetryable(cause),
            cause,
          },
        );
      }

      return { provider: "microsandbox", id };
    },

    async resume(ref, spec): Promise<SandboxRef> {
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.startDetached(ref.id);
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) {
          throw new WorkspaceNotFoundError(
            `microsandbox: workspace "${ref.id}" no longer exists`,
            { cause },
          );
        }
        throw new SandboxError(`microsandbox: could not resume workspace "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      try {
        await startRuntime(sandbox, spec);
        await sandbox.detach();
      } catch (cause) {
        await sandbox.kill().catch(() => undefined);
        throw new SandboxError(`microsandbox: could not start runtime in "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      return { provider: "microsandbox", id: ref.id };
    },

    async suspend(ref) {
      try {
        const handle = await Sandbox.get(ref.id);
        if (handle.status !== "stopped" && handle.status !== "crashed") {
          await handle.stop();
        }
      } catch (cause) {
        throw new SandboxError(`microsandbox: could not suspend workspace "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }
      return { provider: "microsandbox", id: ref.id };
    },

    async deleteWorkspace(ref): Promise<void> {
      try {
        const handle = await Sandbox.get(ref.id);
        if (handle.status !== "stopped" && handle.status !== "crashed") {
          await handle.kill();
        }
        await handle.remove();
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) return;
        if (cause instanceof SandboxStillRunningError) {
          await Sandbox.get(ref.id)
            .then((handle) => handle.kill().then(() => handle.remove()))
            .catch((error) => {
              if (!(error instanceof SandboxNotFoundError)) throw error;
            });
          return;
        }
        throw new SandboxError(`microsandbox: could not delete workspace "${ref.id}"`, {
          retryable: false,
          cause,
        });
      }
    },

    async stop(ref: SandboxRef): Promise<void> {
      try {
        const handle = await Sandbox.get(ref.id);
        if (handle.status !== "stopped" && handle.status !== "crashed") {
          await handle.kill();
        }
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) return;
        throw new SandboxError(`microsandbox: could not stop sandbox "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }
    },
  };
}

async function startRuntime(sandbox: Sandbox, spec: SandboxSpec): Promise<void> {
  const envs = { ...spec.env };
  for (const [key, secret] of Object.entries(spec.secrets)) {
    // Secrets are opened only at the provider boundary, matching the E2B
    // provider and the existing SandboxProvider contract.
    envs[key] = secret.expose();
  }

  const output = await sandbox.execWith("sh", (exec) =>
    exec
      .args([
        "-lc",
        `nohup ${spec.command} > /tmp/pi-cloud-agent-runtime.log 2>&1 < /dev/null & pid=$!; sleep 0.1; kill -0 "$pid"`,
      ])
      .envs(envs)
      .timeout(spec.timeoutSeconds * 1000),
  );

  if (!output.success) {
    throw new Error(output.stderr() || `runtime launch exited with code ${output.code}`);
  }
}

const RETRYABLE_PATTERNS = [
  "timeout",
  "timed out",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "temporarily unavailable",
  "502",
  "503",
  "504",
];

function isRetryable(cause: unknown): boolean {
  if (cause instanceof MicrosandboxError) {
    return cause.code === "io" || cause.code === "http" || cause.code === "cloudHttp";
  }
  const text = String(cause instanceof Error ? cause.message : cause).toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => text.includes(pattern));
}

function buildNetworkPolicy(spec: SandboxSpec, allowHost: boolean) {
  const policy = NetworkPolicy.builder()
    .defaultDeny()
    .egress((rule) => rule.tcp().ports([80, 443]).allowPublic())
    .egress((rule) => rule.udp().port(53).allowHost())
    .egress((rule) => rule.tcp().port(53).allowHost());

  if (allowHost) {
    const controlPlane = new URL(
      spec.env.CONTROL_PLANE_URL ?? "http://host.microsandbox.internal:8080",
    );
    const port = Number(controlPlane.port || (controlPlane.protocol === "https:" ? 443 : 80));
    policy.egress((rule) => rule.tcp().port(port).allowHost());
  }

  return policy.build();
}
