# @pi-cloud-agent/protocol

The contracts. Types and schemas that make this core extensible.

**Depends on:** `zod`, and nothing else, not even another workspace package. Depending on an implementation would make this not a contract. Everything else in the repository depends on it, including the browser and the untrusted sandbox runtime, which is what lets all three agree on one vocabulary instead of restating it.

Nothing here executes anything or touches the network.

## Files

| File | Contents |
|---|---|
| `index.ts` | the single public entry point; everything is re-exported here |
| `run.ts` | `RunStatus` and the six lifecycle states, plus terminal/active helpers |
| `trigger.ts` | `Trigger`: the normalized reason a run exists, and `TriggerKind` |
| `task.ts` | `TaskSpec`: the concrete request handed to infrastructure |
| `repo.ts` | `RepoRef`: everything needed to clone and address a repo at one revision |
| `events.ts` | the two outbound channels: `RunEventInput` (telemetry) and `RunStatusReport` (terminal) |
| `secret.ts` | `Secret`, `createRedactor`, `redactUrlCredentials` |
| `env.ts` | `SANDBOX_ENV` and `SANDBOX_PATHS`: the controller/sandbox environment contract |
| `sandbox.ts` | `SandboxProvider` lifecycle and disposable preflight execution, `SandboxSpec`, `SandboxRef`, `WorkspaceRef`, `SandboxError` |
| `vcs.ts` | `VCSProvider` |
| `api.ts` | the controller's HTTP request/response shapes, shared with the dashboard |

## Invariants

- **One export surface.** Add to `index.ts`; consumers import from `@pi-cloud-agent/protocol`, never a deep path. One canonical import style is worth more than a marginally smaller bundle.
- **`SANDBOX_ENV` is imported by both sides.** The controller writes those variables and `packages/runtime` reads them, so a rename is a type error rather than a run that boots with an empty prompt. Never hard-code one of those strings anywhere else.
- **`Secret` has no implicit escape hatch.** `expose()` is deliberately ugly to call. See [../../docs/secrets.md](../../docs/secrets.md).

## Changing a contract

Widening one of these interfaces affects every implementation and is expensive to undo, so it is one of the changes to raise before writing code. See [../../CONTRIBUTING.md](../../CONTRIBUTING.md).
