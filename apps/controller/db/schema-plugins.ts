import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export interface AttachedPluginRef {
  name: string;
  version: string;
  components: { skills: boolean; mcp: boolean };
}

export type InstallMode = "default_off" | "default_on" | "required";
export type ReviewStatus = "draft" | "approved" | "yanked";
export type UserPluginOverride = "enabled" | "disabled";

export function definePluginTables(userReference: () => AnyPgColumn) {
  const plugins = pgTable(
    "plugins",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      publisher: text("publisher").notNull().default("Zen8"),
      createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [uniqueIndex("plugins_name_idx").on(table.name)],
  );

  const pluginVersions = pgTable(
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

  const pluginSettings = pgTable("plugin_settings", {
    pluginId: uuid("plugin_id")
      .primaryKey()
      .references(() => plugins.id, { onDelete: "cascade" }),
    installMode: text("install_mode").notNull().default("default_off").$type<InstallMode>(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  });

  const ownerColumns = () => ({
    userId: uuid("user_id").notNull().references(userReference, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
  });

  const pluginUserState = pgTable(
    "plugin_user_state",
    {
      ...ownerColumns(),
      override: text("override").$type<UserPluginOverride | null>(),
      installedVersionId: uuid("installed_version_id").references(() => pluginVersions.id, {
        onDelete: "set null",
      }),
      updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.pluginId] })],
  );

  const pluginUserVariables = pgTable(
    "plugin_user_variables",
    {
      ...ownerColumns(),
      name: text("name").notNull(),
      valueEncrypted: text("value_encrypted").notNull(),
      updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.pluginId, table.name] })],
  );

  const pluginAuditLog = pgTable(
    "plugin_audit_log",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      actorUserId: uuid("actor_user_id").references(userReference, { onDelete: "set null" }),
      pluginName: text("plugin_name").notNull(),
      action: text("action").notNull(),
      detail: jsonb("detail").notNull().default({}),
      createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [index("plugin_audit_log_created_idx").on(table.createdAt.desc())],
  );

  const pluginOauthClients = pgTable(
    "plugin_oauth_clients",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      issuer: text("issuer").notNull(),
      redirectUri: text("redirect_uri").notNull(),
      clientId: text("client_id").notNull(),
      createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex("plugin_oauth_clients_issuer_redirect_idx").on(
        table.issuer,
        table.redirectUri,
      ),
    ],
  );

  const pluginOauthTokens = pgTable(
    "plugin_oauth_tokens",
    {
      ...ownerColumns(),
      accessEncrypted: text("access_encrypted").notNull(),
      refreshEncrypted: text("refresh_encrypted"),
      expiresAt: timestamptz("expires_at"),
      updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.pluginId] })],
  );

  return {
    plugins,
    pluginVersions,
    pluginSettings,
    pluginUserState,
    pluginUserVariables,
    pluginAuditLog,
    pluginOauthClients,
    pluginOauthTokens,
  };
}
