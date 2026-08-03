import type { RepoRef, RunEventType, RunStatus, Trigger } from "@pi-cloud-agent/protocol";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Seven tables. Users and web sessions own the application identity boundary;
 * runs and sessions own execution state; connections own encrypted VCS tokens
 * and short-lived OAuth state.
 *
 * `runs` is simultaneously the queue, the lifecycle record, and the crash
 * recovery journal — which is deliberate. Because every fact the controller
 * needs to resume a run is a column here, the controller holds nothing in
 * memory and a restart is indistinguishable from a slow tick. See
 * docs/resumability.md for the reasoning and the reconciler's exact queries.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const appUsers = pgTable(
  "app_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubUserId: text("github_user_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("app_users_github_user_idx").on(table.githubUserId)],
);

export const vcsConnections = pgTable(
  "vcs_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    accountName: text("account_name").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("vcs_connections_user_provider_idx").on(table.userId, table.provider),
  ],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    returnTo: text("return_to"),
    codeVerifier: text("code_verifier").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("oauth_states_expiry_idx").on(table.expiresAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    profile: text("profile").notNull(),
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    repo: jsonb("repo").notNull().$type<RepoRef>(),
    model: text("model").notNull(),

    /** Exactly one run may own a session workspace at a time. */
    activeRunId: uuid("active_run_id"),
    latestRunId: uuid("latest_run_id").notNull(),
    turnCount: integer("turn_count").notNull().default(1),

    /** Pi's native JSONL session. Opaque to the controller. */
    agentCheckpoint: text("agent_checkpoint"),

    /** Provider-owned workspace retained while the session is idle. */
    sandboxProvider: text("sandbox_provider"),
    sandboxId: text("sandbox_id"),
    workspaceExpiresAt: timestamptz("workspace_expires_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("sessions_updated_idx").on(table.updatedAt.desc()),
    index("sessions_workspace_expiry_idx")
      .on(table.workspaceExpiresAt)
      .where(sql`${table.sandboxId} is not null and ${table.activeRunId} is null`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),

    /** Null for standalone background runs; set for interactive turns. */
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number"),

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

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("web_sessions_token_hash_idx").on(table.tokenHash),
    index("web_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type VcsConnectionRow = typeof vcsConnections.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type AppUserRow = typeof appUsers.$inferSelect;
export type WebSessionRow = typeof webSessions.$inferSelect;
