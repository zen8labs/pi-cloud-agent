# Architecture

## Two trust zones

Everything else follows from this line.

```text
┌─ TRUSTED ───────────────────────────────┐      ┌─ UNTRUSTED ──────────────────┐
│ apps/controller                         │      │ packages/runtime             │
│                                         │      │                              │
│  • authenticates sandbox callbacks      │      │  • clones the repository     │
│  • owns Postgres                        │      │  • runs repository code      │
│  • resolves connected VCS identities    │      │  • runs one agent session    │
│  • mints run credentials                │      │                              │
│  • owns durable session checkpoints     │      │  • posts events/checkpoints  │
│  • decides what runs and when           │      │    outward                   │
│  • never executes repository code       │      │  • holds no database, no     │
│                                         │      │    forge client, no broker   │
└─────────────────────────────────────────┘      └──────────────────────────────┘
              ▲                                            │
              └──────── outbound HTTP only ────────────────┘
```

The controller never dials into a sandbox. The provider lifecycle may create, pause, or reconnect compute, but the runtime always starts from inside the sandbox and calls outward. This keeps local microSandbox, hosted E2B, and future backends interchangeable without an agent server.

The boundary is enforced mechanically, not by convention: `packages/runtime` declares a dependency on `packages/protocol` and nothing else, pnpm's isolated `node_modules` makes an undeclared import unresolvable, and `pnpm boundaries` fails CI on a declared one.

## The seven building blocks, and where they live

The vocabulary for reasoning about a cloud agent, mapped onto the tree. Note that the packages are **not** split along these lines (they are split by what a contributor might substitute), so this table is how you find things.

| Building block | Where it lives |
|---|---|
| **Trigger**: why a run exists | `apps/controller/http/manual.ts`, shared by `http/runs.ts` and `http/sessions.ts` |
| **Sandbox**: isolated compute | `packages/sandbox` |
| **Harness**: the agent loop | `packages/runtime/agent.ts` (Pi, embedded as a library) |
| **Secret broker**: credentials for one run | `apps/controller/secrets/broker.ts` |
| **Actuation**: how work becomes an outcome | *no code.* The agent uses `git` and `gh` itself |
| **Observability**: what happened | `run_events` + `/runs/:id/stream` + `apps/web` |
| **Task behavior**: the user request and attached skills | `packages/protocol`, `packages/plugins` |

Actuation having no implementation is the point, not an omission. A controller that posted the agent's findings would need to parse them, and then it could disagree with what the agent actually did.

## Run lifecycle

```text
trigger ──► runs row (queued)
              │
              │  reconciler tick: claim with `for update skip locked`
              ▼
         provisioning ──► request → TaskSpec
              │           broker.mintForRun()
              │           sandbox.create()
              │           attachSandbox(id, deadline)   ← first durable write
              ▼
           running ──────────────────────────────────────┐
              │                                          │ sandbox posts
              │                                          │ events + status
              ▼                                          │ (outbound only)
      succeeded / failed / cancelled ◄───────────────────┘
              │
              │  standalone: stop compute
              │  session: suspend filesystem and clear active_run_id
              ▼
       reclaimed / session idle
```

Provisioning is a **short transaction**, not a long-lived task. Once `attachSandbox` commits, everything needed to finish or recover the run is on its row, and the process that started it can die without consequence. This is the central difference from the earlier design, where a coroutine held each run's lifecycle in memory and a restart force-failed live work.

→ [docs/resumability.md](docs/resumability.md) for the reconciler's exact queries.

## State

Seven tables. That is the entire persistent state of the system.

| Table | Role |
|---|---|
| `sessions` | ordered turns, the latest Pi JSONL checkpoint, and the parked workspace reference |
| `runs` | the queue, the lifecycle record, and the crash-recovery journal at once |
| `run_events` | append-only log, `(run_id, seq)`. The only observability source |
| `vcs_connections` | one encrypted OAuth connection per provider |
| `oauth_states` | one-time PKCE state for connection callbacks |
| `app_users` | stable application users established by GitHub App authorization |
| `web_sessions` | hashed, expiring browser sessions |

Session state and runtime lifetime are deliberately separate. Postgres owns the conversation checkpoint; the sandbox provider owns a filesystem reference; live compute exists only while a turn runs. If the parked workspace expires, the next turn cold-clones the repository and still opens the same Pi session. See [docs/sessions.md](docs/sessions.md).

## Observability

One source of truth, two access patterns:

- `GET /runs/:id/events?afterSeq=N`: history
- `GET /runs/:id/stream`: Server-Sent Events, live

Every data frame carries `id: <seq>`. A browser echoes the last one back as `Last-Event-ID` on reconnect, so resuming is exact rather than approximate, and history and live tail are the same code path. Status frames are derived from the run row and carry no id, which makes them safe to re-send.

Telemetry (tokens, tool calls, logs) is best-effort and never load-bearing. The terminal status report is delivered with retries and is the *only* thing that completes a run. A run that emits a thousand tokens and never reports a status is a timeout, not a success.

## The contracts

All three live in `packages/protocol`, so an implementation package depends on the contract and never on another implementation.

| Contract | Resolver | Implementations |
|---|---|---|
| `SandboxProvider` | `createSandboxProvider(name, env)` | `microsandbox` (default), `e2b` |
| `VCSProvider` | `createVcsProvider(name, accessToken)` | `github`, `azure-devops` |

`TaskSpec` is the pivot: a user request is resolved into the repository, prompt, and optional budget. Enabled plugin skills are composed into the prompt at provisioning. Everything below that line is infrastructure.

Each factory validates its own slice of the environment, which is why adding a provider requires no change to the controller's configuration schema.

## Deployment shape

The HTTP surface and the reconciler share a process because it is simpler, not because they must. They exchange nothing in memory (all coordination is through Postgres), so splitting them across machines is a deployment decision that needs no code change. That is the payoff for not having an in-process event bus.

The sandbox runtime image is built separately (`pnpm sandbox:image`) and pins the agent harness to the version its bundle was typechecked against. The default local provider is microSandbox; hosted E2B remains available with `SANDBOX_PROVIDER=e2b` and uses `pnpm sandbox:template`. Controller-only changes need a restart, not an image rebuild.
