import type { RunEventType, RunStatus, Trigger } from "@pi-cloud-agent/protocol";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Three tables. That is the entire persistent state of the system.
 *
 * `runs` is simultaneously the queue, the lifecycle record, and the crash
 * recovery journal — which is deliberate. Because every fact the controller
 * needs to resume a run is a column here, the controller holds nothing in
 * memory and a restart is indistinguishable from a slow tick. See
 * docs/resumability.md for the reasoning and the reconciler's exact queries.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Which profile owns this run's behavior. */
    profile: text("profile").notNull(),
    status: text("status").notNull().default("queued").$type<RunStatus>(),

    /** Coordinates the trusted side needs: token minting, listing, filtering. */
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),

    /**
     * The normalized trigger, verbatim. Profile-specific detail (PR number, the
     * user's prompt, the comment command) lives in here rather than as columns,
     * so adding a profile never adds a column.
     */
    trigger: jsonb("trigger").notNull().$type<Trigger>(),

    /** Resolved at creation so a run is reproducible even if config changes. */
    model: text("model").notNull(),

    /** Bearer token the sandbox uses on its outbound callbacks. */
    callbackToken: text("callback_token").notNull(),

    /** Set the moment a sandbox exists, so teardown survives a crash. */
    sandboxProvider: text("sandbox_provider"),
    sandboxId: text("sandbox_id"),
    sandboxStoppedAt: timestamptz("sandbox_stopped_at"),

    /**
     * Monotonic event counter. Incremented in the same transaction that inserts
     * an event, which is what makes `seq` gapless without a second source of
     * truth and gives `last_event_at` for free.
     */
    eventSeq: integer("event_seq").notNull().default(0),
    lastEventAt: timestamptz("last_event_at"),

    /** Worker claim lease. Expired + no sandbox means the claim is reclaimable. */
    attempt: integer("attempt").notNull().default(0),
    claimedAt: timestamptz("claimed_at"),
    claimExpiresAt: timestamptz("claim_expires_at"),

    /** Wall-clock budget. The reconciler fails runs that pass it. */
    deadlineAt: timestamptz("deadline_at"),

    error: text("error"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The claim query: oldest queued run first.
    index("runs_status_created_idx").on(table.status, table.createdAt),
    // The dashboard's list.
    index("runs_created_idx").on(table.createdAt.desc()),
    // The reconciler's sweep over in-flight work.
    index("runs_sandbox_idx")
      .on(table.sandboxId)
      .where(sql`${table.sandboxId} is not null and ${table.sandboxStoppedAt} is null`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Per-run, starts at 1. The SSE resume cursor and the client dedupe key. */
    seq: integer("seq").notNull(),
    type: text("type").notNull().$type<RunEventType>(),
    data: jsonb("data").notNull().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Composite key rather than a surrogate id: it *is* the identity, and it
    // makes a duplicated sequence number impossible rather than merely unlikely.
    primaryKey({ columns: [table.runId, table.seq] }),
  ],
);

/**
 * Per-repo, per-profile configuration, stored opaquely.
 *
 * The controller never reads inside `config` — the owning profile validates it
 * with its own schema and interprets it. This is what keeps profile-specific
 * settings (which branch to review, which events should trigger) out of the
 * core, and it means a new profile's settings appear in the dashboard without a
 * migration. See docs/adding-a-profile.md.
 */
export const repoConfig = pgTable(
  "repo_config",
  {
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    profile: text("profile").notNull(),
    config: jsonb("config").notNull().default({}).$type<Record<string, unknown>>(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.repoFullName, table.profile] })],
);

export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type RepoConfigRow = typeof repoConfig.$inferSelect;
