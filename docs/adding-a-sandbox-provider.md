# Adding a sandbox provider

A sandbox provider answers one question: *where does this run's compute come from?* The contract is two methods, and it stays that small because of one constraint: **the sandbox is outbound-only**. The controller never dials in, so no provider has to expose port forwarding, tunnels, or reachability.

```ts
export interface SandboxProvider {
  readonly name: string;
  create(spec: SandboxSpec): Promise<SandboxRef>;
  stop(ref: SandboxRef): Promise<void>;
}
```

Every backend worth having (E2B, Modal, Daytona, Fly, plain Docker) can start a container from an image with an environment and a command, and kill it. Snapshots, warm pools, and pre-cloned volumes are optimizations *behind* these two methods, not additions to them.

## 1. Write it

```text
packages/sandbox/
  my-backend.ts     the implementation
  index.ts          add one line to FACTORIES
```

```ts
import { SandboxError, type SandboxProvider, type SandboxSpec } from "@pi-cloud-agent/protocol";
import { z } from "zod";

// Validate your own environment. This is why adding a provider needs no change
// to the controller's config schema.
const envSchema = z.object({
  MY_BACKEND_TOKEN: z.string().default(""),
});

export function createMyBackendProvider(
  env: Readonly<Record<string, string | undefined>>,
): SandboxProvider {
  const { MY_BACKEND_TOKEN: token } = envSchema.parse(env);
  if (token === "") throw new Error("MY_BACKEND_TOKEN is required by the my-backend provider");

  return {
    name: "my-backend",

    async create(spec: SandboxSpec) {
      const envs = { ...spec.env };
      // Secrets are opened here: the last possible moment, at the boundary
      // where they must become plain strings.
      for (const [key, secret] of Object.entries(spec.secrets)) envs[key] = secret.expose();

      const machine = await boot({
        image: spec.image,
        envs,
        command: spec.command,
        timeoutMs: spec.timeoutSeconds * 1000,
      });

      return { provider: "my-backend", id: machine.id };
    },

    async stop(ref) {
      await kill(ref.id);
    },
  };
}
```

## 2. Register it

```ts
// packages/sandbox/index.ts
const FACTORIES: Record<string, Factory> = {
  e2b: createE2BProvider,
  "my-backend": createMyBackendProvider,   // ← this line
};
```

Select it with `SANDBOX_PROVIDER=my-backend`. Nothing else in the system changes.

## What your implementation must guarantee

**`stop` is idempotent.** The reconciler may call it for a machine that is already dead. That is the normal path after a timeout. Killing a nonexistent sandbox must resolve, not throw.

**`create` either returns a working machine or throws.** A machine that exists but whose command never started is the worst outcome: it burns a slot and a credential and goes silent. If you can detect it, reclaim the machine yourself and throw. The E2B provider does exactly this when `commands.run` fails.

**Classify failures.** Throw `SandboxError` with `retryable`:

```ts
throw new SandboxError("api unavailable", { retryable: true, cause });
```

`retryable: true` returns the run to the queue (up to three attempts). `retryable: false` fails it immediately. Getting this wrong means either burning attempts on a missing image, or failing runs on a transient blip.

**Never derive behavior from `spec.runId`.** It is for correlation only. A provider that special-cases a run is a provider that cannot be swapped.

**Respect `timeoutSeconds` as a hard ceiling.** The reconciler is the primary enforcement, but the provider's own timeout is the backstop for the case where the controller is gone entirely. Set it.

## The outbound-only rule in practice

Your sandbox must be able to reach `CONTROL_PLANE_URL` over HTTPS. That is the only network requirement, and it is what makes providers interchangeable.

For a local Docker provider that means the controller has to be reachable from inside the container: `http://host.docker.internal:8080` on macOS and Windows, or `--add-host=host.docker.internal:host-gateway` on Linux.

If you ever find yourself needing to connect *into* the sandbox, stop: that would change the contract for every provider. Consult the maintainer ([../AGENTS.md](../AGENTS.md)) before going down that path.

## The image

`spec.image` is provider-specific: an E2B template name, a Docker tag, a Modal image reference. An empty string means "use this provider's configured default".

Whatever it points at needs Node, `git`, `gh`, and the bundled runtime at `/app/run.js`. `packages/runtime/Dockerfile.sandbox` is the reference; a provider that consumes plain Dockerfiles can use it unchanged.

## Test it

`packages/sandbox/registry.test.ts` covers the registry contract: construction, the unknown-name error, and failing at startup when configuration is missing. Add your provider to those cases.

Do not write a unit test that mocks your backend's SDK; it would only test the mock. Real behavior is verified by the live tests ([testing.md](testing.md)), and by a run that actually works.

```bash
pnpm vitest run packages/sandbox/registry.test.ts
SANDBOX_PROVIDER=my-backend pnpm test:live
```
