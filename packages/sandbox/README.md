# @pi-cloud-agent/sandbox

Where a run's compute comes from. The default backend is local microSandbox; hosted E2B remains available as an explicit alternative. Standalone runs use image resolution plus two lifecycle methods:

```ts
resolveImage(imageRef: string): Promise<string>
create(spec: SandboxSpec): Promise<SandboxRef>
stop(ref: SandboxRef): Promise<void>
execute?(spec: SandboxSpec): Promise<SandboxExecutionResult>
```

It stays this small because of one constraint: **the sandbox is outbound-only.** The controller never dials in, so no backend has to expose port forwarding, tunnels, or reachability. Snapshots and warm pools are optimizations *behind* these two methods, not additions to them.

`execute` is optional and is used only by the Settings preflight test. It creates a disposable sandbox, runs one foreground command, returns bounded output, and destroys the machine. It is not a general controller-side shell or an inbound channel into agent workspaces.

`resolveImage` maps a repository setting to the provider-native image or template and returns the configured default for an empty setting. The controller pins this resolved value and provider on the session before the first create, so a later settings change cannot change an existing session's cold resume or send an alias to another backend. E2B gives each OCI materialization a unique alias and propagates build failures instead of falling back to stale contents. `finalizeSuspend` releases a stopped source only after the controller commits the checkpoint returned by `suspend`, and reconciliation retries it until it succeeds.

Durable chat sessions additionally use `resume`, `suspend`, and `deleteWorkspace`. These remain provider control-plane operations; they do not open an inbound application connection to the sandbox. See [../../docs/resumability.md](../../docs/resumability.md).

**Depends on:** `@pi-cloud-agent/protocol`, `zod`, and each backend's own SDK.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createSandboxProvider`, `sandboxProviderNames` |
| `machine.ts` | CPU and memory for every built-in provider |
| `microsandbox.ts` | microSandbox: local OCI microVM create/kill plus local integrity-checked snapshots |
| `e2b.ts` | E2B: hosted create/kill plus filesystem-only pause/resume |
| `e2b-template.ts` | CLI that applies `machine.ts` when building the hosted default template |
| `runtime-install.ts` | app artifact selection and credential-free in-VM installation |
| `registry.test.ts` | the registry contract: construction and its failure messages |

## Machine size

CPU and memory for every built-in provider live in [`machine.ts`](machine.ts) (`2` vCPU / `4096` MB). microSandbox applies them when it creates a VM. E2B applies them when it materializes a template, including `pnpm sandbox:template` and Settings image builds. Change the constants there to change both; then rebuild hosted templates. An existing E2B workspace keeps the size already baked into its template. Guest disk size is local-only (`MICROSANDBOX_ROOT_DISK_MIB`).

## Invariants

- **`stop` is idempotent.** The reconciler may call it for a machine that is already dead; that is the normal path after a timeout.
- **`create` returns a working machine or throws.** A machine that exists but whose command never started is the worst outcome. It burns a slot and a credential and then goes silent. Reclaim it yourself and throw.
- **Report allocation before installing or launching.** `create` and `resume` await `spec.onAllocated`, when supplied, immediately after allocation. The controller records the machine with an attempt-fenced write; rejection means the worker no longer owns the run and must not launch its runtime.
- **`resume` starts one fresh runtime process.** If the opaque workspace no longer exists, throw `WorkspaceNotFoundError` so the controller can continue cold from the Pi checkpoint.
- **`suspend` retains filesystem state, not process memory.** Per-run credentials must not survive into the next turn.
- **`deleteWorkspace` is idempotent.** Expiry can race another reconciler pass.
- **`resolveImage` returns a non-empty provider-native reference.** The controller persists it on the session for deterministic cold resumes.
- **`finalizeSuspend` runs after the checkpoint is durable and is idempotent.** Providers that create a separate snapshot release the stopped source here, not before returning from `suspend`; the controller retains a marker and retries failures.
- **Classify failures with `SandboxError.retryable`.** `true` returns the run to the queue (up to three attempts); `false` fails it immediately. Getting this wrong means either burning attempts on a missing image or failing runs on a transient blip.
- **Secrets are opened here and only here.** `spec.secrets` holds `Secret` objects; `expose()` is called at the boundary where they must become plain strings to cross into the machine.
- **Never derive behavior from `spec.runId`.** It is correlation only. A provider that special-cases a run is a provider that cannot be swapped.
- **Each factory validates its own environment.** That is why adding a backend needs no change to the controller's config schema.
- **CPU and memory come from `machine.ts`.** Built-in providers do not take size from env vars.

## Notes on providers

microSandbox consumes an OCI image. Build the default project environment with `pnpm sandbox:image`; the command imports the Docker-built archive into the microSandbox cache. `MICROSANDBOX_IMAGE` can point at a different local image or registry reference. The provider overrides the image entrypoint with an inert command and starts the per-run runtime explicitly so credentials and run values are not baked into the image.

microSandbox persists a session by stopping the VM, creating an integrity-checked Snapshot under `MICROSANDBOX_SNAPSHOT_DIR`, and removing the live sandbox. Resume boots from that Snapshot, so process memory and per-run credentials do not survive. The default directory is `.pi-cloud-agent-snapshots` in the controller working directory; mount it on durable local storage in production and monitor its size.

E2B remains selectable with `SANDBOX_PROVIDER=e2b` and uses its hosted template workflow. Public OCI references are materialized as uniquely named E2B templates. A simple name is first checked as an existing template alias and otherwise treated as a Docker Hub image. Preflight owns a separate disposable template and deletes it after the test, including failures; it never deletes existing or session-pinned templates. Cleanup errors are surfaced instead of reporting success. Automatic retirement of session-pinned templates and recovery of preflight artifacts after controller crashes are not implemented.

Both providers install the app-managed runtime archive through their SDK before executing commands, on create, preflight, and resume. Installation runs as root inside the untrusted VM without run credentials; execution runs as `pi-agent`, with credentials attached only to that command. The project image needs no app runtime or app user. Build archives with `pnpm sandbox:runtime`; see [supported images and artifact deployment](../runtime/README.md#image-contract).

For deployment, build the image with an immutable registry tag and push it to an OCI-compatible registry. Set `MICROSANDBOX_IMAGE` to that reference on the machine that runs the controller and microSandbox, or pre-load the image with `msb load` on that machine. The local `pi-cloud-agent:local` tag is not a production artifact name and is not automatically visible on another host.

## Note on E2B

The runtime command is issued on `create` rather than baked into the template's start command: E2B runs a template's start command when the *template* is built, and our command needs per-run values that only exist at create time. The template's start command is an inert `sleep infinity`.

## Adding a backend

One file and one line in `FACTORIES`: [../../docs/adding-a-sandbox-provider.md](../../docs/adding-a-sandbox-provider.md).
