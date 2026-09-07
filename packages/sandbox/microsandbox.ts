import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SandboxError,
  type SandboxExecutionResult,
  type SandboxProvider,
  type SandboxRef,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";
import {
  MicrosandboxError,
  NetworkPolicy,
  Sandbox,
  type SandboxBuilder,
  SandboxNotFoundError,
  SandboxStillRunningError,
  Snapshot,
} from "microsandbox";
import { z } from "zod";
import { flattenSecrets } from "./environment.js";

const envSchema = z.object({
  MICROSANDBOX_IMAGE: z.string().default("pi-cloud-agent:local"),
  MICROSANDBOX_CPUS: z.coerce.number().int().positive().default(2),
  MICROSANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  MICROSANDBOX_ROOT_DISK_MIB: z.coerce.number().int().positive().default(8192),
  MICROSANDBOX_SNAPSHOT_DIR: z.string().default(""),
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
    MICROSANDBOX_ROOT_DISK_MIB: rootDiskMib,
    MICROSANDBOX_SNAPSHOT_DIR: configuredSnapshotDir,
    MICROSANDBOX_ALLOW_HOST: allowHost,
  } = envSchema.parse(env);
  const snapshotDir = resolve(configuredSnapshotDir.trim() || ".pi-cloud-agent-snapshots");

  return {
    name: "microsandbox",

    async resolveImage(imageRef) {
      return imageRef || defaultImage;
    },

    async execute(spec: SandboxSpec): Promise<SandboxExecutionResult> {
      const id = `pi-test-${randomUUID().slice(0, 12)}`;
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await configureImageSandbox(
          Sandbox.builder(id),
          spec,
          defaultImage,
          rootDiskMib,
          cpus,
          memoryMb,
          allowHost,
        ).create();
        const output = await sandbox.execWith("bash", (exec) =>
          exec
            .args(["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", spec.command])
            .envs(flattenSecrets(spec))
            .timeout(spec.timeoutSeconds * 1000),
        );
        return { code: output.code, stdout: output.stdout(), stderr: output.stderr() };
      } catch (cause) {
        throw new SandboxError("microsandbox: environment test failed", {
          retryable: isRetryable(cause),
          cause,
        });
      } finally {
        if (sandbox) await cleanupCreatedSandbox(id, sandbox);
      }
    },

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const id = `pi-${spec.runId}-${randomUUID().slice(0, 8)}`;
      const image = spec.image || defaultImage;
      let sandbox: Sandbox;

      try {
        sandbox = await configureImageSandbox(
          Sandbox.builder(id),
          spec,
          defaultImage,
          rootDiskMib,
          cpus,
          memoryMb,
          allowHost,
        )
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
        await cleanupCreatedSandbox(id, sandbox);
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
      const liveId = `pi-${spec.runId}-${randomUUID().slice(0, 8)}`;
      let sandbox: Sandbox;
      try {
        const snapshot = await Snapshot.open(ref.id);
        await snapshot.verify();
        sandbox = await Sandbox.builder(liveId)
          .fromSnapshot(snapshot.path)
          .entrypoint(["sleep", "infinity"])
          .user("node")
          .cpus(cpus)
          .memory(memoryMb)
          .network((network) => network.policy(buildNetworkPolicy(spec, allowHost)))
          .detached(true)
          .maxDuration(spec.timeoutSeconds)
          .create();
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError || isMissingSnapshot(cause)) {
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
        await cleanupCreatedSandbox(liveId, sandbox);
        throw new SandboxError(`microsandbox: could not start runtime in "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }

      // The snapshot path is the durable session reference; the live sandbox
      // id is what the reconciler must stop and snapshot at turn completion.
      return { provider: "microsandbox", id: liveId };
    },

    async suspend(ref) {
      let snapshot: Snapshot;
      try {
        const handle = await Sandbox.get(ref.id);
        if (handle.status !== "stopped" && handle.status !== "crashed") {
          await handle.stop();
        }
        await mkdir(snapshotDir, { recursive: true });
        snapshot = await Snapshot.builder(`session-${ref.id}`)
          .destDir(snapshotDir)
          .fromSandbox(ref.id)
          .force()
          .recordIntegrity()
          .create();
      } catch (cause) {
        throw new SandboxError(`microsandbox: could not suspend workspace "${ref.id}"`, {
          retryable: isRetryable(cause),
          cause,
        });
      }
      return {
        provider: "microsandbox",
        id: snapshot.path,
        sizeBytes:
          snapshot.sizeBytes === null || snapshot.sizeBytes === undefined
            ? undefined
            : Number(snapshot.sizeBytes),
      };
    },

    async finalizeSuspend(ref) {
      // The controller calls this only after the snapshot path is committed to
      // Postgres. That ordering makes a controller crash leave a recoverable
      // stopped source rather than an unreachable snapshot.
      await removePersistedSandbox(ref.id);
    },

    async deleteWorkspace(ref): Promise<void> {
      try {
        await Snapshot.remove(ref.id, { force: true });
      } catch (cause) {
        if (isMissingSnapshot(cause)) return;
        throw new SandboxError(`microsandbox: could not delete workspace "${ref.id}"`, {
          retryable: false,
          cause,
        });
      }
    },

    async stop(ref: SandboxRef): Promise<void> {
      try {
        await removePersistedSandbox(ref.id);
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

function configureImageSandbox(
  builder: SandboxBuilder,
  spec: SandboxSpec,
  defaultImage: string,
  rootDiskMib: number,
  cpus: number,
  memoryMb: number,
  allowHost: boolean,
): SandboxBuilder {
  return builder
    .image(spec.image || defaultImage)
    .rootDisk(rootDiskMib)
    .entrypoint(["sleep", "infinity"])
    .user("node")
    .cpus(cpus)
    .memory(memoryMb)
    .network((network) => network.policy(buildNetworkPolicy(spec, allowHost)))
    .maxDuration(spec.timeoutSeconds);
}

function isMissingSnapshot(cause: unknown): boolean {
  const text = String(cause instanceof Error ? cause.message : cause).toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("does not exist") ||
    text.includes("corrupt") ||
    text.includes("checksum") ||
    text.includes("integrity") ||
    text.includes("invalid snapshot")
  );
}

async function cleanupCreatedSandbox(id: string, sandbox: Sandbox): Promise<void> {
  await sandbox.kill().catch(() => undefined);
  await removePersistedSandbox(id).catch(() => undefined);
}

async function removePersistedSandbox(id: string): Promise<void> {
  try {
    const handle = await Sandbox.get(id);
    if (handle.status !== "stopped" && handle.status !== "crashed") {
      await handle.kill();
    }
    await handle.remove();
  } catch (cause) {
    if (!(cause instanceof SandboxStillRunningError)) throw cause;
    await Sandbox.get(id).then((handle) => handle.kill().then(() => handle.remove()));
  }
}

async function startRuntime(sandbox: Sandbox, spec: SandboxSpec): Promise<void> {
  const envs = flattenSecrets(spec);

  const output = await sandbox.execWith("sh", (exec) =>
    exec
      .args([
        "-lc",
        // Keep the detached process from holding the exec pipe open. Its output
        // is available inside the guest at this path; see docs/operations.md.
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
