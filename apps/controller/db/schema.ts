import type {
  LlmApi,
  LlmAuthType,
  LlmModelOption,
  RepoRef,
  RunEventType,
  RunStatus,
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
    profile: text("profile").notNull(),
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

export type ObservabilityExportStatus = "pending" | "processing" | "exported";

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

/** Replay pin for plugins attached to a run. */
export interface AttachedPluginRef {
  name: string;
  version: string;
  components: { skills: boolean; mcp: boolean };
}

export type InstallMode = "default_off" | "default_on" | "required";
export type ReviewStatus = "draft" | "approved" | "yanked";
export type UserPluginOverride = "enabled" | "disabled";

export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    publisher: text("publisher").notNull().default("Zen8"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("plugins_name_idx").on(table.name)],
);

export const pluginVersions = pgTable(
  "plugin_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    source: text("source").notNull(),
    artifactPath: text("artifact_path").notNull(),
    components: jsonb("components")
      .notNull()
      .$type<{ skills: boolean; mcp: boolean }>()
      .default({ skills: false, mcp: false }),
    reviewStatus: text("review_status").notNull().default("draft").$type<ReviewStatus>(),
    manifest: jsonb("manifest").notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("plugin_versions_plugin_version_idx").on(table.pluginId, table.version),
    index("plugin_versions_status_idx").on(table.reviewStatus),
  ],
);

export const pluginSettings = pgTable("plugin_settings", {
  pluginId: uuid("plugin_id")
    .primaryKey()
    .references(() => plugins.id, { onDelete: "cascade" }),
  installMode: text("install_mode").notNull().default("default_off").$type<InstallMode>(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** Shared owner columns for per-user plugin state tables. */
function userPluginOwner() {
  return {
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
  };
}

export const pluginUserState = pgTable(
  "plugin_user_state",
  {
    ...userPluginOwner(),
    override: text("override").$type<UserPluginOverride | null>(),
    installedVersionId: uuid("installed_version_id").references(() => pluginVersions.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.pluginId] })],
);

export const pluginUserVariables = pgTable(
  "plugin_user_variables",
  {
    ...userPluginOwner(),
    name: text("name").notNull(),
    /** AES-GCM ciphertext from encryptSecret. */
    valueEncrypted: text("value_encrypted").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.pluginId, table.name] })],
);

export const pluginAuditLog = pgTable(
  "plugin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => appUsers.id, { onDelete: "set null" }),
    pluginName: text("plugin_name").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("plugin_audit_log_created_idx").on(table.createdAt.desc())],
);

/** Cached OAuth Dynamic Client Registration result (public client, PKCE). */
export const pluginOauthClients = pgTable(
  "plugin_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    clientId: text("client_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("plugin_oauth_clients_issuer_redirect_idx").on(table.issuer, table.redirectUri),
  ],
);

/** Per-user OAuth tokens for a marketplace plugin (host-mediated MCP OAuth). */
export const pluginOauthTokens = pgTable(
  "plugin_oauth_tokens",
  {
    ...userPluginOwner(),
    accessEncrypted: text("access_encrypted").notNull(),
    refreshEncrypted: text("refresh_encrypted"),
    expiresAt: timestamptz("expires_at"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.pluginId] })],
);

export type RunRow = typeof runs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type ObservabilityExportRow = typeof observabilityExports.$inferSelect;
export type VcsConnectionRow = typeof vcsConnections.$inferSelect;
export type LlmConnectionRow = typeof llmConnections.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type AppUserRow = typeof appUsers.$inferSelect;
export type WebSessionRow = typeof webSessions.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type PluginVersionRow = typeof pluginVersions.$inferSelect;
export type PluginOauthClientRow = typeof pluginOauthClients.$inferSelect;
export type PluginOauthTokenRow = typeof pluginOauthTokens.$inferSelect;
