# @pi-cloud-agent/sandbox

Where a run's compute comes from. The default backend is local microSandbox; hosted E2B remains available as an explicit alternative. Standalone runs use two methods:

```ts
create(spec: SandboxSpec): Promise<SandboxRef>
stop(ref: SandboxRef): Promise<void>
execute?(spec: SandboxSpec): Promise<SandboxExecutionResult>
```

It stays this small because of one constraint: **the sandbox is outbound-only.** The controller never dials in, so no backend has to expose port forwarding, tunnels, or reachability. Snapshots and warm pools are optimizations *behind* these two methods, not additions to them.

`execute` is optional and is used only by the Settings preflight test. It creates a disposable sandbox, runs one foreground command, returns bounded output, and destroys the machine. It is not a general controller-side shell or an inbound channel into agent workspaces.

Durable chat sessions additionally use `resume`, `suspend`, and
`deleteWorkspace`. These remain provider control-plane operations; they do not
open an inbound application connection to the sandbox. See
[../../docs/sessions.md](../../docs/sessions.md).

**Depends on:** `@pi-cloud-agent/protocol`, `zod`, and each backend's own SDK.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createSandboxProvider`, `sandboxProviderNames` |
| `microsandbox.ts` | microSandbox: local OCI microVM create/kill plus stop/start resume |
| `e2b.ts` | E2B: hosted create/kill plus filesystem-only pause/resume |
| `registry.test.ts` | the registry contract: construction and its failure messages |

## Invariants

- **`stop` is idempotent.** The reconciler may call it for a machine that is already dead; that is the normal path after a timeout.
- **`create` returns a working machine or throws.** A machine that exists but whose command never started is the worst outcome. It burns a slot and a credential and then goes silent. Reclaim it yourself and throw.
- **`resume` starts one fresh runtime process.** If the opaque workspace no longer exists, throw `WorkspaceNotFoundError` so the controller can continue cold from the Pi checkpoint.
- **`suspend` retains filesystem state, not process memory.** Per-run credentials must not survive into the next turn.
- **`deleteWorkspace` is idempotent.** Expiry can race another reconciler pass.
- **Classify failures with `SandboxError.retryable`.** `true` returns the run to the queue (up to three attempts); `false` fails it immediately. Getting this wrong means either burning attempts on a missing image or failing runs on a transient blip.
- **Secrets are opened here and only here.** `spec.secrets` holds `Secret` objects; `expose()` is called at the boundary where they must become plain strings to cross into the machine.
- **Never derive behavior from `spec.runId`.** It is correlation only. A provider that special-cases a run is a provider that cannot be swapped.
- **Each factory validates its own environment.** That is why adding a backend needs no change to the controller's config schema.

## Notes on providers

microSandbox consumes an OCI image. Build the repository's local runtime image with `pnpm sandbox:image`; the command imports the Docker-built archive into the microSandbox cache. `MICROSANDBOX_IMAGE` can point at a different local image or registry reference. The provider overrides the image entrypoint with an inert command and starts the per-run runtime explicitly so credentials and run values are not baked into the image.

microSandbox's default root filesystem is persisted by stopping and restarting the named sandbox. Its snapshots are an optional filesystem-only optimization; they do not preserve process memory.

E2B remains selectable with `SANDBOX_PROVIDER=e2b` and uses its hosted template workflow.

For deployment, build the image with an immutable registry tag and push it to an OCI-compatible registry. Set `MICROSANDBOX_IMAGE` to that reference on the machine that runs the controller and microSandbox, or pre-load the image with `msb load` on that machine. The local `pi-cloud-agent:local` tag is not a production artifact name and is not automatically visible on another host.

## Note on E2B

The runtime command is issued on `create` rather than baked into the template's start command: E2B runs a template's start command when the *template* is built, and our command needs per-run values that only exist at create time. The template's start command is an inert `sleep infinity`.

## Adding a backend

One file and one line in `FACTORIES`: [../../docs/adding-a-sandbox-provider.md](../../docs/adding-a-sandbox-provider.md).
