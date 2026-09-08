import type {
  LlmApi,
  LlmAuthType,
  LlmModelOption,
  RepoRef,
  RunEventType,
  RunStatus,
  SessionRetentionStatus,
  ThinkingLevel,
  Trigger,
} from "@pi-cloud-agent/protocol";
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { type AttachedPluginRef, definePluginTables } from "./schema-plugins";

import { defineReviewRepositories } from "./schema-reviews";

export type { AttachedPluginRef } from "./schema-plugins";

export type SessionOperation = "archiving" | "expiring" | "parking" | "replacing";

/**
 * Users and web sessions own the application identity boundary; runs and
 * sessions own execution state; connections own encrypted VCS tokens and
 * short-lived OAuth state; plugin tables own the operator marketplace catalog
 * and per-user install/configure state.
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

export const repositorySandboxImages = pgTable(
  "repository_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    /** Provider-specific base image/template reference. Empty mappings are deleted. */
    imageRef: text("image_ref").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("repository_environments_user_repo_idx").on(
      table.userId,
      table.provider,
      table.repoFullName,
    ),
    index("repository_environments_user_updated_idx").on(table.userId, table.updatedAt.desc()),
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

export const llmConnections = pgTable(
  "llm_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    provider: text("provider").notNull(),
    authType: text("auth_type").notNull().$type<LlmAuthType>(),
    api: text("api").notNull().$type<LlmApi>(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    models: jsonb("models").notNull().$type<LlmModelOption[]>(),
    contextWindow: integer("context_window").notNull(),
    maxTokens: integer("max_tokens").notNull(),
    /** Encrypted JSON; never returned by the HTTP API. */
    credential: text("credential").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    deletedAt: timestamptz("deleted_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("llm_connections_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    repo: jsonb("repo").notNull().$type<RepoRef>(),
    model: text("model").notNull(),
    modelConnectionId: uuid("model_connection_id").references(() => llmConnections.id, {
      onDelete: "restrict",
    }),

    /** Exactly one run may own a session workspace at a time. */
    activeRunId: uuid("active_run_id"),
    latestRunId: uuid("latest_run_id").notNull(),
    turnCount: integer("turn_count").notNull().default(1),

    /** Pi's native JSONL session. Opaque to the controller. */
    agentCheckpoint: text("agent_checkpoint"),

    /** Original checkout revision used for the cumulative session diff. */
    diffBaseSha: text("diff_base_sha"),

    /** Repository image/template selected for this session's cold starts. */
    sandboxImageRef: text("sandbox_image_ref"),
    /** Provider that resolved the pinned repository image reference. */
    sandboxImageProvider: text("sandbox_image_provider"),

    /** Provider that owns the checkpoint, retained after expiry for cold resumes. */
    sandboxProvider: text("sandbox_provider"),
    sandboxId: text("sandbox_id"),
    workspaceExpiresAt: timestamptz("workspace_expires_at"),
    /** Retention state for the provider-owned checkpoint. */
    retentionStatus: text("retention_status")
      .notNull()
      .default("active")
      .$type<SessionRetentionStatus>(),
    /** Last user activity, used to transition active sessions to inactive. */
    lastActivityAt: timestamptz("last_activity_at").notNull().defaultNow(),
    /** Provider-reported checkpoint size for quota/retention accounting. */

    /** Durable cleanup operation that blocks new turns until it completes. */
    sessionOperation: text("session_operation").$type<SessionOperation>(),
    sessionOperationAt: timestamptz("session_operation_at"),
    /** Lease heartbeat for long-running cleanup; the operation timestamp is immutable. */
    sessionOperationHeartbeatAt: timestamptz("session_operation_heartbeat_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("sessions_updated_idx").on(table.updatedAt.desc()),
    index("sessions_workspace_expiry_idx")
      .on(table.workspaceExpiresAt)
      .where(sql`${table.sandboxId} is not null and ${table.activeRunId} is null`),
    index("sessions_retention_activity_idx")
      .on(table.retentionStatus, table.lastActivityAt)
      .where(sql`${table.activeRunId} is null`),
  ],
);

/** Provider resource → durable conversation identity. */
export const externalThreads = pgTable(
  "external_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    externalKey: text("external_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_threads_provider_key_idx").on(table.provider, table.externalKey),
    index("external_threads_user_updated_idx").on(table.userId, table.updatedAt.desc()),
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

    status: text("status").notNull().default("queued").$type<RunStatus>(),

    /** Coordinates the trusted side needs: token minting, listing, filtering. */
    provider: text("provider").notNull(),
    repoFullName: text("repo_full_name").notNull(),

    /** The normalized request/event, verbatim, for replay and diagnosis. */
    trigger: jsonb("trigger").notNull().$type<Trigger>(),

    /** Resolved at creation so a run is reproducible even if config changes. */
    model: text("model").notNull(),
    thinkingLevel: text("thinking_level").notNull().default("medium").$type<ThinkingLevel>(),
    modelConnectionId: uuid("model_connection_id").references(() => llmConnections.id, {
      onDelete: "restrict",
    }),

    /**
     * Plugins attached at provision: `{ name, version, components }[]`.
     * Null until provision resolves the effective set (or empty when none).
     */
    plugins: jsonb("plugins").$type<AttachedPluginRef[] | null>(),

    /** Bearer token the sandbox uses on its outbound callbacks. */
    callbackToken: text("callback_token").notNull(),

    /** Set the moment a sandbox exists, so teardown survives a crash. */
    sandboxProvider: text("sandbox_provider"),
    sandboxId: text("sandbox_id"),
    sandboxStoppedAt: timestamptz("sandbox_stopped_at"),

    /** Original checkpoint retained until the stopped source is finalized. */
    sandboxFinalizationWorkspaceProvider: text("sandbox_finalization_workspace_provider"),
    sandboxFinalizationWorkspaceId: text("sandbox_finalization_workspace_id"),
    /** Previous checkpoint retained until replacement cleanup succeeds. */
    sandboxReplacementWorkspaceProvider: text("sandbox_replacement_workspace_provider"),
    sandboxReplacementWorkspaceId: text("sandbox_replacement_workspace_id"),

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

export type IntegrationDeliveryStatus =
  | "pending"
  | "processing"
  | "processed"
  | "ignored"
  | "failed";

/** Verified inbound deliveries. The provider retries; this table makes them idempotent. */
export const integrationDeliveries = pgTable(
  "integration_deliveries",
  {
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending").$type<IntegrationDeliveryStatus>(),
    attempt: integer("attempt").notNull().default(0),
    claimedAt: timestamptz("claimed_at"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.deliveryId] }),
    index("integration_deliveries_status_idx").on(
      table.provider,
      table.status,
      table.createdAt,
    ),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    installationId: text("installation_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("github_installations_user_idx").on(table.userId)],
);

export type GithubReviewPublicationStatus = "processing" | "published" | "failed";

export const githubReviewRepositories = defineReviewRepositories(
  () => githubInstallations.installationId,
);

const githubPublicationIdentityColumns = {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  submission: jsonb("submission").notNull(),
  lastError: text("last_error"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
};

/** One trusted actuation record per review run, preventing ordinary retries from duplicating reviews. */
export const githubReviewPublications = pgTable("github_review_publications", {
  ...githubPublicationIdentityColumns,
  status: text("status").notNull().default("processing").$type<GithubReviewPublicationStatus>(),
  githubReviewId: text("github_review_id"),
});

export type ObservabilityExportStatus = "pending" | "processing" | "exported" | "failed";

export type GithubCommentPublicationStatus = "processing" | "published" | "failed";

/** One trusted actuation record per comment task, preventing duplicate replies. */
export const githubCommentPublications = pgTable("github_comment_publications", {
  ...githubPublicationIdentityColumns,
  status: text("status")
    .notNull()
    .default("processing")
    .$type<GithubCommentPublicationStatus>(),
  githubCommentId: text("github_comment_id"),
});

export type GithubCommentPublicationRow = typeof githubCommentPublications.$inferSelect;

/** Durable delivery state for the configured OTLP destination. */
export const observabilityExports = pgTable(
  "observability_exports",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Hash of the destination configuration; credentials never enter the key. */
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending").$type<ObservabilityExportStatus>(),
    attempt: integer("attempt").notNull().default(0),
    claimedAt: timestamptz("claimed_at"),
    exportedAt: timestamptz("exported_at"),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.destination] }),
    index("observability_exports_pending_idx").on(
      table.destination,
      table.status,
      table.updatedAt,
    ),
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

const pluginTables = definePluginTables(() => appUsers.id);
export const {
  plugins,
  pluginVersions,
  pluginSettings,
  pluginUserState,
  pluginUserVariables,
  pluginAuditLog,
  pluginOauthClients,
  pluginOauthTokens,
} = pluginTables;

export type { InstallMode, ReviewStatus, UserPluginOverride } from "./schema-plugins";

export type RunRow = typeof runs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type ExternalThreadRow = typeof externalThreads.$inferSelect;
export type IntegrationDeliveryRow = typeof integrationDeliveries.$inferSelect;
export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type GithubReviewPublicationRow = typeof githubReviewPublications.$inferSelect;
export type ObservabilityExportRow = typeof observabilityExports.$inferSelect;
export type VcsConnectionRow = typeof vcsConnections.$inferSelect;
export type RepositorySandboxImageRow = typeof repositorySandboxImages.$inferSelect;
export type LlmConnectionRow = typeof llmConnections.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type AppUserRow = typeof appUsers.$inferSelect;
export type WebSessionRow = typeof webSessions.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type PluginVersionRow = typeof pluginVersions.$inferSelect;
export type PluginOauthClientRow = typeof pluginOauthClients.$inferSelect;
export type PluginOauthTokenRow = typeof pluginOauthTokens.$inferSelect;
