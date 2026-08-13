import {
  IN_FLIGHT_STATUSES,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  TERMINAL_STATUSES,
  type ThinkingLevel,
  type Trigger,
} from "@pi-cloud-agent/protocol";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { CHANNELS, type Database, notify } from "./client";
import {
  type AttachedPluginRef,
  type RunEventRow,
  type RunRow,
  runEvents,
  runs,
  sessions,
} from "./schema";

/**
 * Every write to a run goes through this file, and every one of them is a
 * single statement whose WHERE clause contains the state it expects to find.
 *
 * That is the whole concurrency design: no read-then-write, no transaction held
 * open across network I/O, and no in-memory lock. A transition that loses a
 * race updates zero rows and says so, instead of overwriting a decision another
 * worker already made. See docs/resumability.md.
 */

const seconds = (n: number) => new Date(Date.now() + n * 1000);

export interface CreateRunInput {
  userId?: string | null;
  provider: string;
  repoFullName: string;
  trigger: Trigger;
  model: string;
  thinkingLevel?: ThinkingLevel;
  modelConnectionId?: string | null;
  callbackToken: string;
}

export async function createRun(database: Database, input: CreateRunInput): Promise<RunRow> {
  const [row] = await database.insert(runs).values(input).returning();
  if (!row) throw new Error("insert into runs returned no row");
  await notify(database, CHANNELS.runQueued, row.id);
  return row;
}

/**
 * Take the oldest queued run, if there is one.
 *
 * `for update skip locked` is the entire queue implementation: concurrent
 * workers step over each other's locked candidate rather than blocking or
 * double-claiming. The lease means a worker that dies between claiming and
 * creating a sandbox does not strand the run — see `findReclaimableClaims`.
 */
export async function claimNextRun(
  database: Database,
  leaseSeconds: number,
  /** Runs a caller has already claimed in this pass and must not be handed twice. */
  excludeIds: string[] = [],
): Promise<RunRow | null> {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.status, "queued"),
          // Session turns may be created ahead of time, but only the turn that
          // owns activeRunId is eligible to provision against the workspace.
          or(
            isNull(runs.sessionId),
            sql`exists (select 1 from ${sessions} where ${sessions.id} = ${runs.sessionId} and ${sessions.activeRunId} = ${runs.id})`,
          ),
          ...(excludeIds.length > 0 ? [notInArray(runs.id, excludeIds)] : []),
        ),
      )
      .orderBy(asc(runs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) return null;

    const [claimed] = await tx
      .update(runs)
      .set({
        status: "provisioning",
        claimedAt: new Date(),
        claimExpiresAt: seconds(leaseSeconds),
        attempt: sql`${runs.attempt} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(runs.id, candidate.id), eq(runs.status, "queued")))
      .returning();

    return claimed ?? null;
  });
}

/**
 * Record the sandbox and the deadline in one statement.
 *
 * This write is what makes teardown crash-safe: after it commits, the reconciler
 * can find and stop the machine even if this process never runs again. It is
 * therefore the first thing that happens once a sandbox exists.
 */
export async function attachSandbox(
  database: Database,
  runId: string,
  sandbox: { provider: string; id: string },
  deadlineAt: Date,
): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({
      sandboxProvider: sandbox.provider,
      sandboxId: sandbox.id,
      deadlineAt,
      updatedAt: new Date(),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "provisioning")))
    .returning({ id: runs.id });
  return updated.length > 0;
}

/** Persist the plugin set resolved for this run (replay + events). */
export async function setRunPlugins(
  database: Database,
  runId: string,
  attached: AttachedPluginRef[],
): Promise<void> {
  await database
    .update(runs)
    .set({ plugins: attached, updatedAt: new Date() })
    .where(eq(runs.id, runId));
}

export async function markRunning(database: Database, runId: string): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "provisioning")))
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Move a run to a terminal state, unless it already reached one.
 *
 * The guard matters more than it looks: a sandbox posting `done` and the
 * reconciler timing the same run out can genuinely race, and whichever lands
 * first should win permanently.
 */
export async function completeRun(
  database: Database,
  runId: string,
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
  error?: string | null,
): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), notInArray(runs.status, [...TERMINAL_STATUSES])))
    .returning({ id: runs.id });
  return updated.length > 0;
}

/** Put a claimed-but-unprovisioned run back on the queue for another attempt. */
export async function requeueRun(database: Database, runId: string): Promise<boolean> {
  const updated = await database
    .update(runs)
    .set({ status: "queued", claimedAt: null, claimExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "provisioning"), isNull(runs.sandboxId)))
    .returning({ id: runs.id });
  if (updated.length > 0) await notify(database, CHANNELS.runQueued, runId);
  return updated.length > 0;
}

export async function markSandboxStopped(database: Database, runId: string): Promise<void> {
  await database
    .update(runs)
    .set({ sandboxStoppedAt: new Date(), updatedAt: new Date() })
    .where(eq(runs.id, runId));
}

/**
 * Append one event and return its sequence number.
 *
 * The counter lives on the run row and is incremented in the same transaction
 * as the insert, so sequence numbers are gapless without a second source of
 * truth, and `last_event_at` — which the reconciler reads to detect a silently
 * dead sandbox — updates atomically with the evidence that produced it.
 */
export async function appendEvent(
  database: Database,
  runId: string,
  type: RunEventType,
  data: Record<string, unknown>,
): Promise<number | null> {
  const seq = await database.transaction(async (tx) => {
    const [bumped] = await tx
      .update(runs)
      .set({
        eventSeq: sql`${runs.eventSeq} + 1`,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
      .returning({ seq: runs.eventSeq });

    if (!bumped) return null;

    await tx.insert(runEvents).values({ runId, seq: bumped.seq, type, data });
    return bumped.seq;
  });

  if (seq !== null) await notify(database, CHANNELS.runEvent, runId);
  return seq;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getRun(database: Database, runId: string): Promise<RunRow | null> {
  const [row] = await database.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row ?? null;
}

/** Authenticate a sandbox callback. Constant-time compare on the token. */
export async function getRunByCallbackToken(
  database: Database,
  runId: string,
  token: string,
): Promise<RunRow | null> {
  const row = await getRun(database, runId);
  if (!row) return null;
  const expected = Buffer.from(row.callbackToken);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return null;
  const { timingSafeEqual } = await import("node:crypto");
  return timingSafeEqual(expected, actual) ? row : null;
}

export async function listRuns(
  database: Database,
  options: { limit: number; status?: RunStatus; userId?: string | null },
): Promise<RunRow[]> {
  const predicates = [];
  if (options.userId) predicates.push(eq(runs.userId, options.userId));
  if (options.status) predicates.push(eq(runs.status, options.status));
  return database
    .select()
    .from(runs)
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(options.limit);
}

export async function listEvents(
  database: Database,
  runId: string,
  afterSeq: number,
): Promise<RunEvent[]> {
  const rows = await database
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq));
  return rows.map(toRunEvent);
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    seq: row.seq,
    type: row.type,
    data: row.data as Record<string, unknown>,
    at: row.createdAt.toISOString(),
  };
}

// ── reconciler queries ───────────────────────────────────────────────────────
//
// Each of these answers one question about durable state, and each maps to
// exactly one repair action. Crash recovery is not a special case: after a
// restart these same queries simply return more rows.

/** In-flight past its wall-clock budget. */
export async function findExpiredRuns(database: Database, limit: number): Promise<RunRow[]> {
  return database
    .select()
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...IN_FLIGHT_STATUSES]),
        isNotNull(runs.deadlineAt),
        lt(runs.deadlineAt, new Date()),
      ),
    )
    .limit(limit);
}

/**
 * In-flight with a sandbox that has gone quiet.
 *
 * A sandbox that dies without posting a terminal status would otherwise sit
 * until its deadline, holding a slot and a credential. Silence longer than
 * `staleSeconds` since the last event — or since the claim, if it never emitted
 * one — means nobody is coming.
 */
export async function findSilentRuns(
  database: Database,
  staleSeconds: number,
  limit: number,
): Promise<RunRow[]> {
  const cutoff = seconds(-staleSeconds);
  return database
    .select()
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...IN_FLIGHT_STATUSES]),
        isNotNull(runs.sandboxId),
        or(
          and(isNotNull(runs.lastEventAt), lt(runs.lastEventAt, cutoff)),
          and(isNull(runs.lastEventAt), isNotNull(runs.claimedAt), lt(runs.claimedAt, cutoff)),
        ),
      ),
    )
    .limit(limit);
}

/** Claimed, never provisioned, lease expired. Safe to hand to another worker. */
export async function findReclaimableClaims(
  database: Database,
  limit: number,
): Promise<RunRow[]> {
  return database
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, "provisioning"),
        isNull(runs.sandboxId),
        isNotNull(runs.claimExpiresAt),
        lt(runs.claimExpiresAt, new Date()),
      ),
    )
    .limit(limit);
}

/** Finished, but its machine was never confirmed reclaimed. */
export async function findSandboxesToStop(
  database: Database,
  limit: number,
): Promise<RunRow[]> {
  return database
    .select()
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...TERMINAL_STATUSES]),
        isNull(runs.sessionId),
        isNotNull(runs.sandboxId),
        isNull(runs.sandboxStoppedAt),
      ),
    )
    .limit(limit);
}
