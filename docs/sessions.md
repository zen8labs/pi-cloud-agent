# Durable sessions

A run is one bounded execution. A session is the durable conversation and
workspace that can contain many runs. Completing a run returns its session to
idle; it does not end the session.

This distinction keeps interactive continuity out of process memory without
turning the controller into an agent server. Pi is still embedded inside the
sandbox and one runtime process still executes one turn from start to finish.

## The four pieces of state

| State | Owner | Lifetime |
|---|---|---|
| Session identity and active run | Postgres | Until the session is deleted |
| Run lifecycle and event journal | Postgres | Durable audit history |
| Pi conversation checkpoint | Postgres, copied into the sandbox for a turn | Across sandbox replacement |
| Repository workspace | Sandbox provider | Across turns until idle retention expires |

The sandbox is compute, not the source of truth for the conversation. A paused
workspace is the fast path: it preserves the checkout, uncommitted edits, and
installed dependencies so the next turn does not clone or set up again. The Pi
checkpoint is the recovery path: if the workspace is gone, a new sandbox can
restore the conversation explicitly while recreating the checkout.

## Lifecycle

```text
create session + first run
        │
        ▼
queued → provisioning → running ── persist Pi checkpoint
                                  │
                                  ▼
                         succeeded / failed / cancelled
                                  │
                                  ▼
                     suspend the workspace
                                  │
                                  ▼
                            session idle
                                  │
                         a new user message
                                  │
                                  ▼
                    resume workspace + new run
```

Only one run may be active for a session. Creating a turn and claiming the
session happen in one database transaction. A concurrent follow-up is rejected
rather than racing two agents against one checkout.

The terminal run status and workspace suspension are separate durable facts.
After a runtime reports completion, the session briefly remains busy while the
reconciler suspends its workspace. A controller restart at any point simply
causes the next reconciliation pass to continue that work.

## Agent checkpoint

Pi's native JSONL session is the continuation format. The runtime uses a
persistent `SessionManager`, never reconstructed token telemetry. Before a turn
it restores the last committed checkpoint; after the turn it commits the new
checkpoint before reporting success.

The checkpoint lives outside the repository checkout. It may contain prompts,
repository excerpts, tool arguments, and tool output, so it has the same access
and retention sensitivity as the workspace. It is size-limited at the callback
boundary and is never rendered or interpreted by the controller.

## Workspace resume

The first turn clones the repository and runs its setup hook. A resumed turn
verifies the existing checkout and continues it without cloning, resetting, or
rerunning setup. Automatic `git reset --hard` is forbidden because it would
destroy the edits the session exists to preserve.

Resumable sandbox providers expose three additional operations:

```ts
suspend(sandbox): workspace
resume(workspace, spec): sandbox
delete(workspace): void
```

The references are opaque to the controller. E2B implements suspension as a
filesystem-only pause, so process memory and old per-run credentials are not
retained. Another provider may use a stopped VM, snapshot, archive, or volume.

When idle retention expires, the reconciler deletes the provider workspace but
keeps the session and Pi checkpoint. The next turn recreates the checkout and
records that only conversation state was restored; it must never silently claim
that the old filesystem survived.

## Credentials

Every turn receives a new callback token, forge credential, and model
credential. Persisted workspace state must not preserve credential values.
Filesystem-only suspension is the default for this reason. The existing git
credential helper writes only environment-variable references to configuration,
not token values.

Session checkpoints are accepted only from the session's active run and only
with that run's callback token. A stale or concurrent run cannot overwrite the
conversation head.

## Failure behavior

- A provisioning failure ends that run and releases the session for another
  turn.
- A runtime failure preserves the workspace when the provider can suspend it.
- A suspension failure destroys the sandbox, clears the workspace reference,
  and leaves the durable Pi checkpoint available for a cold continuation.
- A provider that reports a missing workspace clears the stale reference and
  cold-starts from the durable checkpoint, never as an unexplained new session.
- Cancellation changes run state only; the reconciler owns suspension or
  destruction exactly as it owns teardown for standalone runs.

## What remains ephemeral

Standalone API runs need no continuing session. They keep the
original `create`/`stop` lifecycle and are destroyed when terminal. Warm pools,
repository prebuilds, and dependency caches may optimize creation later, but
none of them are required for correct continuation.

## Validation contract

A real resumability validation must prove all of the following against the
configured sandbox and model provider:

1. The first turn creates an uncommitted file and mentions a unique value.
2. The workspace is suspended after the response.
3. A second turn in the same session reads the file and recalls the value.
4. The second run uses the same provider workspace and emits no clone event.
5. The Pi session id is the same across both turns.
6. The controller may restart between turns without changing the result.
7. Concurrent follow-ups cannot create two active runs.

Unit and integration tests defend the state machine, but they do not replace
this paid live test. See [testing.md](testing.md) and
[operations.md](operations.md).
