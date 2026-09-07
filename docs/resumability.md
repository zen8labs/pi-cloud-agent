# Runs, sessions, and checkpoints

Runs are bounded executions; sessions are durable conversations that contain ordered runs. The controller stores every fact needed for recovery in Postgres, while each sandbox provider owns the filesystem checkpoint used for a fast warm resume.

## Durable state

| State | Owner | Lifetime |
|---|---|---|
| Session identity, turn order, and retention state | Postgres | Until deleted |
| Run lifecycle and event journal | Postgres | Audit history |
| Pi JSONL conversation checkpoint | Postgres | Until session deletion |
| Repository workspace checkpoint | Sandbox provider | Until inactive/deleted |

The repository image mapping in Settings is a base image/template reference, not executable setup code. A custom image can be hosted in any registry. The controller passes it to the selected provider when a session is created or cold-started. After a completed turn, the provider persists the session's writable layer using its native checkpoint mechanism. These session artifacts are intentionally provider-native filesystem checkpoints, not `docker commit` images. A full OCI image per turn would copy toolchains and make local garbage collection much more expensive, while E2B cannot place its cloud sandbox filesystem on the controller's disk. The checkpoint abstraction gives both providers the same warm-resume contract while keeping the base image immutable.

`retentionStatus=active` means a turn is in progress or a warm checkpoint is retained; `inactive` means the provider artifact has been deleted and only the Postgres conversation checkpoint remains. The session retains the last checkpoint provider identity even when `sandbox_id` is cleared, because its provider-native image alias may only be valid with that backend.

- microSandbox stops the VM and creates an integrity-checked local Snapshot under `MICROSANDBOX_SNAPSHOT_DIR`. The controller commits the snapshot path before asking the provider to remove the stopped source VM, so a crash leaves recoverable state instead of an orphaned checkpoint. Resume creates a new VM from that snapshot.
- E2B pauses the sandbox with `keepMemory: false`; E2B retains the filesystem checkpoint in its service and the session stores the sandbox id. A public OCI image reference is built once into a deterministic E2B template (cached by image reference) before the first run.

Providers therefore boot one image plus one checkpoint. The built-in image and the repository image are not two concurrent roots; the repository image replaces the base image for that repository. The first provisioning pins the resolved repository image on the session, so later Settings changes affect new sessions but cannot silently change a cold resume. A checkpoint also pins the base image used to create it. When a turn replaces a provider checkpoint, the controller deletes the previous artifact, so each session retains at most one warm checkpoint (plus short-lived in-flight compute). `checkpoint_size_bytes` is recorded when the provider reports it, so operators can measure disk/quota growth and alert before the retention policy is reached.

Custom images must include the runtime contract (`/app/run.js`, its `/app/package.json` dependencies including the `tsx` loader, `/workspace`, Node.js, git, gh, and an unprivileged `node` user). Settings > Environments runs a disposable compatibility check before saving. Setup scripts are not supported.

## Run state machine

Every transition is one guarded SQL statement. A transition that loses a race updates zero rows instead of overwriting another worker's decision. There is no in-memory run state: provisioning claims a row, creates a sandbox, records its id, and returns; callbacks and the reconciler write the later facts.

Session teardown uses a durable `session_operation` claim. Delete and expiry claim the row before deleting a provider checkpoint, and follow-up turns, checkpoint writes, and parking refuse to proceed while that claim is held. The claim is released on provider failure; a stale claim can be reclaimed by reconciliation or by a follow-up turn, so a controller crash cannot leave a session permanently busy. The guarded delete or clear then verifies the operation and the previously observed run/workspace ids before changing Postgres.

The reconciler (`apps/controller/reconcile/loop.ts`) asks one question per branch:

| Durable condition | Action |
|---|---|
| `queued` | Claim and provision |
| in-flight past deadline or silent | Fail, then stop sandbox |
| terminal standalone run | Stop sandbox and stamp it |
| terminal session run | Suspend checkpoint, then promote oldest queued turn |
| idle checkpoint past `workspace_expires_at` | Delete checkpoint and mark session inactive |
| provisioning lease expired without sandbox | Return run to `queued` |

Teardown runs before new provisioning so an idle queue cannot starve resource reclamation. Restarting the controller simply makes the same queries return again; no startup sweep or forced failure is needed.

## Session lifecycle

```text
create session + first run
        │
        ▼
queued → provisioning → running → terminal
                              │
                              ▼
                   checkpoint persisted (active)
                              │
                              ▼
                     idle / follow-up resume
                              │
             retention expiry ─┴─ delete
                              ▼
                  inactive (checkpoint deleted)
```

Only the run named by `sessions.active_run_id` may own a session. Follow-ups submitted while another turn is active are queued rows. Parking atomically stores the checkpoint and promotes the oldest surviving queued row.

An active session has a provider checkpoint and can resume without cloning or installing dependencies. After the configured retention period (the existing `sessionWorkspaceRetentionSeconds` setting, seven days by default), the reconciler deletes that checkpoint and marks the session `inactive`; its Postgres Pi checkpoint remains. The next turn cold-starts from the repository's configured base image, removes only its derived `/workspace/<repo>` path, clones the repository, and restores only the Pi conversation. This is explicit in `WORKSPACE_RESUMED=false` and never pretends filesystem state survived.

The session Delete action permanently deletes the session, all turns, and its provider checkpoint. Deletion is refused while a run is non-terminal. Provider cleanup is idempotent; a repeated HTTP request returns `404` because the chat no longer exists.

## Agent checkpoint and credentials

Pi's native JSONL session is restored before each turn and committed before the runtime reports success. The controller accepts a checkpoint only from the active run and its callback token. The checkpoint is opaque and size-limited.

Each turn receives fresh callback, forge, model, and plugin credentials. The provider checkpoint must not retain their values: E2B uses filesystem-only pause and microSandbox snapshots are created after the runtime exits. Git credential helpers contain environment-variable references, not token values.

## Failure behavior

- A missing or corrupt checkpoint clears the stale reference and cold-starts from the repository image while retaining Pi history.
- A suspension failure destroys the live sandbox, clears the session reference, and leaves the Pi checkpoint available for a cold continuation. If microSandbox has already created a valid snapshot but cannot remove the stopped source VM, it keeps and returns that snapshot; the source is safe to reclaim later and the session does not fall back to a cold start.
- A runtime failure is terminal; the reconciler still attempts to preserve its filesystem checkpoint.
- A run is not resumable mid-turn. The next turn continues from the last completed Pi checkpoint.
- Provider stop/delete operations are idempotent; provider timeouts are the final resource backstop.

## Event sequence numbers

The event counter lives on each run row and increments in the same transaction as its event insert. Concurrent callbacks therefore get gapless `(run_id, seq)` keys and atomically update `last_event_at`, which drives the silence check.

## Validation

`apps/controller/reconcile/reconciler.integration.test.ts` proves that a completed turn is suspended, that a follow-up calls `resume` with the stored checkpoint, and that no second `create` occurs. It also covers a missing checkpoint falling back to the configured repository image.

`apps/controller/http/environments.integration.test.ts` covers image mapping, clearing, and disposable image compatibility tests. The live test in `apps/controller/e2e.live.test.ts` performs two real turns, verifies the same Pi session id and uncommitted file, checks `git.workspace_resumed` without `git.cloned`, and handles the provider-specific checkpoint id behavior.

The SQL race/ownership properties are covered by `apps/controller/db/sessions.integration.test.ts` and `apps/controller/db/runs.integration.test.ts`.

## Provider contract

`SandboxProvider.resolveImage` returns the effective provider-native base image for a requested mapping, including the provider default for an empty mapping. `suspend` returns an opaque `WorkspaceRef` (optionally with `sizeBytes`), `finalizeSuspend` releases any stopped source only after the controller commits that reference, `resume` restores it, and `deleteWorkspace` permanently removes it. The controller never parses provider ids or assumes Docker/OCI details. See [adding-a-sandbox-provider.md](adding-a-sandbox-provider.md).
