import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type InstallMode, isPluginAttached, loadPluginPackage } from "@pi-cloud-agent/plugins";
import { and, eq, inArray } from "drizzle-orm";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  type InstallMode as DbInstallMode,
  pluginAuditLog,
  pluginOauthTokens,
  pluginSettings,
  plugins,
  pluginUserState,
  pluginUserVariables,
  pluginVersions,
  type ReviewStatus,
} from "../db/schema";
import { encryptSecret } from "../secrets/crypto";
import { oauthStatusForManifest } from "./oauth";

/** Marketplace mutations: publish, review, install, configure. */

export async function listCatalogForUser(
  database: Database,
  userId: string | null,
  includeDrafts: boolean,
) {
  const statusFilter: ReviewStatus[] = includeDrafts
    ? ["draft", "approved", "yanked"]
    : ["approved"];
  const versions = await database
    .select({
      pluginId: plugins.id,
      name: plugins.name,
      publisher: plugins.publisher,
      versionId: pluginVersions.id,
      version: pluginVersions.version,
      source: pluginVersions.source,
      components: pluginVersions.components,
      reviewStatus: pluginVersions.reviewStatus,
      manifest: pluginVersions.manifest,
      installMode: pluginSettings.installMode,
    })
    .from(pluginVersions)
    .innerJoin(plugins, eq(pluginVersions.pluginId, plugins.id))
    .leftJoin(pluginSettings, eq(pluginSettings.pluginId, plugins.id))
    .where(inArray(pluginVersions.reviewStatus, statusFilter));

  const userRows = userId
    ? await database.select().from(pluginUserState).where(eq(pluginUserState.userId, userId))
    : [];
  const userByPlugin = new Map(userRows.map((row) => [row.pluginId, row]));

  const configured = userId
    ? await database
        .select({
          pluginId: pluginUserVariables.pluginId,
          name: pluginUserVariables.name,
        })
        .from(pluginUserVariables)
        .where(eq(pluginUserVariables.userId, userId))
    : [];
  const configuredNames = new Map<string, string[]>();
  for (const row of configured) {
    const list = configuredNames.get(row.pluginId) ?? [];
    list.push(row.name);
    configuredNames.set(row.pluginId, list);
  }

  const oauthConnected = new Set<string>();
  if (userId) {
    const tokenRows = await database
      .select({ pluginId: pluginOauthTokens.pluginId })
      .from(pluginOauthTokens)
      .where(eq(pluginOauthTokens.userId, userId));
    for (const row of tokenRows) oauthConnected.add(row.pluginId);
  }

  return versions.map((row) => {
    const user = userByPlugin.get(row.pluginId);
    const mode = (row.installMode ?? "default_off") as InstallMode;
    const installed = Boolean(user?.installedVersionId);
    return {
      name: row.name,
      publisher: row.publisher,
      version: row.version,
      versionId: row.versionId,
      source: row.source,
      components: row.components,
      reviewStatus: row.reviewStatus,
      installMode: mode,
      description: typeof row.manifest.description === "string" ? row.manifest.description : "",
      variables: row.manifest.variables ?? null,
      oauth: oauthStatusForManifest(row.manifest, oauthConnected.has(row.pluginId), row.name),
      user: {
        installed,
        override: user?.override ?? null,
        attached: isPluginAttached(mode, {
          name: row.name,
          override: user?.override ?? null,
          installed,
        }),
        configuredVariables: configuredNames.get(row.pluginId) ?? [],
      },
    };
  });
}

/** Seed every package under marketplace/plugins that has `.pi-plugin/plugin.json`. */
export async function seedMarketplacePlugins(
  database: Database,
  config: Config,
): Promise<void> {
  const marketplaceRoot = config.plugins.marketplaceRoot;
  if (!existsSync(marketplaceRoot)) return;
  for (const source of listMarketplacePackages(marketplaceRoot)) {
    await publishPlugin(database, config, source, "approved", "default_off");
  }
}

function listMarketplacePackages(marketplaceRoot: string): string[] {
  return readdirSync(marketplaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(marketplaceRoot, entry.name))
    .filter((source) => existsSync(join(source, ".pi-plugin", "plugin.json")))
    .sort();
}

export async function publishPlugin(
  database: Database,
  config: Config,
  sourcePath: string,
  reviewStatus: ReviewStatus,
  installMode: DbInstallMode,
  actorUserId: string | null = null,
): Promise<{ name: string; version: string }> {
  const loaded = loadPluginPackage(sourcePath);
  const artifactPath = join(
    config.plugins.artifactRoot,
    loaded.manifest.name,
    loaded.manifest.version,
  );
  mkdirSync(config.plugins.artifactRoot, { recursive: true });
  rmSync(artifactPath, { recursive: true, force: true });
  cpSync(sourcePath, artifactPath, { recursive: true });

  const [existing] = await database
    .select()
    .from(plugins)
    .where(eq(plugins.name, loaded.manifest.name))
    .limit(1);

  let pluginId = existing?.id;
  if (!pluginId) {
    const [created] = await database
      .insert(plugins)
      .values({
        name: loaded.manifest.name,
        publisher: loaded.manifest.author?.name ?? "Zen8",
      })
      .returning();
    if (!created) throw new Error("failed to create plugin row");
    pluginId = created.id;
  }

  const [existingVersion] = await database
    .select()
    .from(pluginVersions)
    .where(
      and(
        eq(pluginVersions.pluginId, pluginId),
        eq(pluginVersions.version, loaded.manifest.version),
      ),
    )
    .limit(1);

  const source = `marketplace:${loaded.manifest.name}@${loaded.manifest.version}`;
  const manifest = loaded.manifest as unknown as Record<string, unknown>;
  if (existingVersion) {
    await database
      .update(pluginVersions)
      .set({
        artifactPath,
        components: loaded.components,
        reviewStatus,
        manifest,
        source,
      })
      .where(eq(pluginVersions.id, existingVersion.id));
  } else {
    await database.insert(pluginVersions).values({
      pluginId,
      version: loaded.manifest.version,
      source,
      artifactPath,
      components: loaded.components,
      reviewStatus,
      manifest,
    });
  }

  await database
    .insert(pluginSettings)
    .values({ pluginId, installMode })
    .onConflictDoUpdate({
      target: pluginSettings.pluginId,
      set: { installMode, updatedAt: new Date() },
    });

  await appendAudit(database, actorUserId, loaded.manifest.name, "publish", {
    version: loaded.manifest.version,
    reviewStatus,
    installMode,
  });

  return { name: loaded.manifest.name, version: loaded.manifest.version };
}

export async function setReviewStatus(
  database: Database,
  name: string,
  version: string,
  reviewStatus: ReviewStatus,
  actorUserId: string | null,
): Promise<void> {
  const row = await findVersion(database, name, version);
  if (!row) throw new Error(`plugin version not found: ${name}@${version}`);
  await database
    .update(pluginVersions)
    .set({ reviewStatus })
    .where(eq(pluginVersions.id, row.versionId));
  await appendAudit(
    database,
    actorUserId,
    name,
    reviewStatus === "yanked" ? "yank" : "review",
    {
      version,
      reviewStatus,
    },
  );
}

export async function setInstallMode(
  database: Database,
  name: string,
  installMode: DbInstallMode,
  actorUserId: string | null,
): Promise<void> {
  const [plugin] = await database.select().from(plugins).where(eq(plugins.name, name)).limit(1);
  if (!plugin) throw new Error(`plugin not found: ${name}`);
  await database
    .insert(pluginSettings)
    .values({ pluginId: plugin.id, installMode })
    .onConflictDoUpdate({
      target: pluginSettings.pluginId,
      set: { installMode, updatedAt: new Date() },
    });
  await appendAudit(database, actorUserId, name, "set_install_mode", { installMode });
}

export async function installPluginForUser(
  database: Database,
  userId: string,
  name: string,
  enable: boolean,
): Promise<void> {
  const approved = await requireApprovedPlugin(database, name, {
    blockIfRequired: !enable,
    requiredAction: "disabled",
  });

  // Install and enable/disable keep installedVersionId so Uninstall stays a separate action.
  await database
    .insert(pluginUserState)
    .values({
      userId,
      pluginId: approved.pluginId,
      override: enable ? "enabled" : "disabled",
      installedVersionId: approved.versionId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pluginUserState.userId, pluginUserState.pluginId],
      set: {
        override: enable ? "enabled" : "disabled",
        installedVersionId: approved.versionId,
        updatedAt: new Date(),
      },
    });

  await appendAudit(database, userId, name, enable ? "install" : "disable", {
    version: approved.version,
  });
}

/** Remove the user's install row, variables, and OAuth tokens for a plugin. */
export async function uninstallPluginForUser(
  database: Database,
  userId: string,
  name: string,
): Promise<void> {
  const approved = await requireApprovedPlugin(database, name, {
    blockIfRequired: true,
    requiredAction: "uninstalled",
  });

  await database
    .delete(pluginOauthTokens)
    .where(
      and(
        eq(pluginOauthTokens.userId, userId),
        eq(pluginOauthTokens.pluginId, approved.pluginId),
      ),
    );
  await database
    .delete(pluginUserVariables)
    .where(
      and(
        eq(pluginUserVariables.userId, userId),
        eq(pluginUserVariables.pluginId, approved.pluginId),
      ),
    );
  await database
    .delete(pluginUserState)
    .where(
      and(eq(pluginUserState.userId, userId), eq(pluginUserState.pluginId, approved.pluginId)),
    );

  await appendAudit(database, userId, name, "uninstall", { version: approved.version });
}

export async function setUserVariables(
  database: Database,
  config: Config,
  userId: string,
  name: string,
  variables: Record<string, string>,
): Promise<void> {
  const [plugin] = await database.select().from(plugins).where(eq(plugins.name, name)).limit(1);
  if (!plugin) throw new Error(`plugin not found: ${name}`);

  for (const [key, value] of Object.entries(variables)) {
    if (!value) continue;
    const encrypted = encryptSecret(value, config.vcs.encryptionKey);
    await database
      .insert(pluginUserVariables)
      .values({
        userId,
        pluginId: plugin.id,
        name: key,
        valueEncrypted: encrypted,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          pluginUserVariables.userId,
          pluginUserVariables.pluginId,
          pluginUserVariables.name,
        ],
        set: { valueEncrypted: encrypted, updatedAt: new Date() },
      });
  }
  await appendAudit(database, userId, name, "configure", {
    variables: Object.keys(variables),
  });
}

async function findVersion(database: Database, name: string, version: string) {
  const [row] = await database
    .select({ versionId: pluginVersions.id, pluginId: plugins.id })
    .from(pluginVersions)
    .innerJoin(plugins, eq(pluginVersions.pluginId, plugins.id))
    .where(and(eq(plugins.name, name), eq(pluginVersions.version, version)))
    .limit(1);
  return row ?? null;
}

async function requireApprovedPlugin(
  database: Database,
  name: string,
  options: { blockIfRequired: boolean; requiredAction: string },
) {
  const approved = await findApprovedVersion(database, name);
  if (!approved) throw new Error(`no approved version for plugin: ${name}`);

  const [settings] = await database
    .select()
    .from(pluginSettings)
    .where(eq(pluginSettings.pluginId, approved.pluginId))
    .limit(1);
  if (options.blockIfRequired && settings?.installMode === "required") {
    throw new Error(`plugin "${name}" is required and cannot be ${options.requiredAction}`);
  }
  return approved;
}

async function findApprovedVersion(database: Database, name: string) {
  const [row] = await database
    .select({
      versionId: pluginVersions.id,
      pluginId: plugins.id,
      version: pluginVersions.version,
    })
    .from(pluginVersions)
    .innerJoin(plugins, eq(pluginVersions.pluginId, plugins.id))
    .where(and(eq(plugins.name, name), eq(pluginVersions.reviewStatus, "approved")))
    .limit(1);
  return row ?? null;
}

async function appendAudit(
  database: Database,
  actorUserId: string | null,
  pluginName: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await database.insert(pluginAuditLog).values({
    actorUserId,
    pluginName,
    action,
    detail,
  });
}

export function isOperator(config: Config, login: string | undefined): boolean {
  if (!login) return false;
  return config.plugins.operatorLogins.includes(login.toLowerCase());
}
