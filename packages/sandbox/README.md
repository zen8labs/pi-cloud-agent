# @pi-cloud-agent/sandbox

Where a run's compute comes from. Two methods:

```ts
create(spec: SandboxSpec): Promise<SandboxRef>
stop(ref: SandboxRef): Promise<void>
```

It stays this small because of one constraint: **the sandbox is outbound-only.**
The controller never dials in, so no backend has to expose port forwarding,
tunnels, or reachability. Snapshots and warm pools are optimizations *behind*
these two methods, not additions to them.

**Depends on:** `@pi-cloud-agent/protocol`, `zod`, and each backend's own SDK.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createSandboxProvider`, `sandboxProviderNames` |
| `e2b.ts` | E2B: one hosted microVM per run |
| `registry.test.ts` | the registry contract — construction and its failure messages |

## Invariants

- **`stop` is idempotent.** The reconciler may call it for a machine that is
  already dead; that is the normal path after a timeout.
- **`create` returns a working machine or throws.** A machine that exists but whose
  command never started is the worst outcome — it burns a slot and a credential and
  then goes silent. Reclaim it yourself and throw.
- **Classify failures with `SandboxError.retryable`.** `true` returns the run to
  the queue (up to three attempts); `false` fails it immediately. Getting this
  wrong means either burning attempts on a missing image or failing runs on a
  transient blip.
- **Secrets are opened here and only here.** `spec.secrets` holds `Secret`
  objects; `expose()` is called at the boundary where they must become plain
  strings to cross into the machine.
- **Never derive behavior from `spec.runId`.** It is correlation only. A provider
  that special-cases a run is a provider that cannot be swapped.
- **Each factory validates its own environment.** That is why adding a backend
  needs no change to the controller's config schema.

## Note on E2B

The runtime command is issued on `create` rather than baked into the template's
start command: E2B runs a template's start command when the *template* is built,
and our command needs per-run values that only exist at create time. The
template's start command is an inert `sleep infinity`.

## Adding a backend

One file and one line in `FACTORIES`:
[../../docs/adding-a-sandbox-provider.md](../../docs/adding-a-sandbox-provider.md).
