# Resumability

A cloud agent's runs outlive the process that started them. A run can take thirty minutes; a deploy takes seconds. So the controller must be able to stop at any instant and be replaced without losing work, and without needing an operator to sort out what was in flight.

This is normally where a workflow engine goes. We do not use one. Three rules plus one loop are enough, and the whole mechanism is about 150 lines.

## The rules

### 1. Every state transition is a single guarded statement

```sql
update runs set status = 'running'
where id = $1 and status = 'provisioning'
```

The state the transition expects is in the `WHERE` clause, and the function returns whether it changed a row:

```ts
export async function markRunning(database: Database, runId: string): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "provisioning")))
    .returning({ id: runs.id });
  return updated.length > 0;
}
```

No read-then-write, no transaction held open across network I/O, no application lock. A transition that loses a race updates zero rows and says so, rather than overwriting a decision another worker already made.

This matters most for completion. A sandbox posting `done` and the reconciler timing the same run out genuinely race, and whichever lands first must win permanently — so `completeRun` guards on *not already terminal*.

### 2. No in-memory run state

If the controller needs a fact to resume a run, that fact is a column. This is the rule that removes the event bus: nothing waits in memory for a run to finish, so there is nothing to wait *with*.

Provisioning is therefore a short transaction — claim, build the task, mint credentials, create the sandbox, write its id, return — measured in seconds, not in the length of the run. `attachSandbox` is the first durable write after a machine exists, and it is deliberately the first thing that happens:

- before it commits, a crash leaks a sandbox that nobody knows about
- after it commits, the reconciler will always find and reclaim it

That is why provisioning owns the cleanup in the one case where `attachSandbox` refuses (the run was cancelled mid-create): the id was never stored, so the reconciler cannot learn about it.

### 3. One writer per fact

Events are written only by the sandbox callback route. Status only by the transition functions. `sandbox_stopped_at` only by the reconciler.

## The loop

`apps/controller/reconcile/loop.ts`. Each branch asks one question about durable state and takes exactly one action.

| Condition in the database | Action |
|---|---|
| `status = 'queued'` | claim and provision |
| in flight and `deadline_at < now()` | fail, then stop the machine |
| in flight, has a sandbox, and `last_event_at` is stale | fail, then stop the machine |
| terminal, has a sandbox, `sandbox_stopped_at is null` | stop the machine, stamp it |
| `provisioning`, no sandbox, `claim_expires_at < now()` | return to `queued` |

Ordering is deliberate: teardown runs *before* new work, so a busy queue can never starve the reclamation of machines that are still costing money.

**Crash recovery is not a special case.** After a restart these same queries simply return more rows. There is no startup sweep, and nothing force-fails in-flight work — the earlier Python design did exactly that, because completion lived in a coroutine, and its own docstring admitted it.

The single loop replaces three separate mechanisms: a blocking wait per run, an `asyncio` wall-clock timeout, and a startup reconciliation pass.

## Sequence numbers

Events need gapless, unique sequence numbers per run: they are the SSE resume cursor and the client's dedupe key. Reading `max(seq)` and inserting would race.

Instead the counter lives on the run row and is incremented in the same transaction as the insert:

```ts
const [bumped] = await tx
  .update(runs)
  .set({ eventSeq: sql`${runs.eventSeq} + 1`, lastEventAt: new Date() })
  .where(eq(runs.id, runId))
  .returning({ seq: runs.eventSeq });

await tx.insert(runEvents).values({ runId, seq: bumped.seq, type, data });
```

Concurrent writers serialize on the row lock. Two things fall out for free:

- `last_event_at` updates atomically with the evidence that produced it, so the reconciler's staleness check cannot drift from the log
- `run_events` has a composite primary key of `(run_id, seq)`, which makes a duplicated sequence number *impossible* rather than merely unlikely

## Why Postgres is also the queue

`select ... for update skip locked` is the entire queue implementation. Concurrent workers step over each other's locked candidate rather than blocking or double-claiming. It is one SQL clause.

Adding Redis or a broker would mean holding work in a second system when it is already durably in the first. The lease (`claim_expires_at`) closes the one gap: a worker that dies between claiming and creating a sandbox would otherwise strand the run, and the reconciler returns it to the queue — safely, because no sandbox exists yet.

`LISTEN/NOTIFY` makes claiming and streaming feel instant, but it is only a wake-up hint. Every listener also polls, so a dropped notification costs latency, not correctness. Unlike an in-memory bus it works across processes, which is what makes splitting the API from the reconciler a deployment choice.

## What is not solved

- **A run is not resumable mid-session.** If a sandbox dies, the run fails; it is not restarted from where the agent had got to. Resuming an agent's reasoning needs harness-level session persistence, which is a different problem.
- **Retries only cover provisioning.** A transient sandbox API failure returns the run to the queue up to three attempts. A failure *inside* the agent is a real outcome and is reported as one.
- **`stop` failures are not retried forever.** A provider that cannot kill a machine will not start succeeding on the next tick, and retrying would turn one stuck sandbox into an endless loop. The run is stamped as reclaimed and the provider's own timeout is the backstop.

## Where this is tested

`apps/controller/db/runs.integration.test.ts` covers the SQL properties: exclusive claiming, guarded transitions, gapless sequences under concurrency.

`apps/controller/reconcile/reconciler.integration.test.ts` drives the loop one tick at a time and simulates crashes by starting a fresh reconciler over existing state — including the case that used to break: *a live run must survive a restart untouched*.
