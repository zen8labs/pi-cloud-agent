import { existsSync } from "node:fs";
import {
  assertCommandAllowlist,
  type CatalogPluginVersion,
  composePrompt,
  composeSkillText,
  type EffectivePlugin,
  loadPluginPackage,
  type McpConfigFile,
  mergeMcpConfigs,
  type PluginSettings,
  type PluginUserState,
  resolveEffectivePlugins,
  substituteVariables,
  toCatalogVersion,
} from "@pi-cloud-agent/plugins";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  type AttachedPluginRef,
  pluginSettings,
  plugins,
  pluginUserState,
  pluginUserVariables,
  pluginVersions,
} from "../db/schema";
import { decryptSecret } from "../secrets/crypto";
import { resolvePluginOAuthToken } from "./oauth";

/**
 * Resolve which plugins attach to a run and compose skill text + MCP config.
 * Marketplace HTTP mutations live in marketplace.ts.
 */

export interface ResolvedRunPlugins {
  attached: AttachedPluginRef[];
  skillText: string | undefined;
  mcpConfig: McpConfigFile | null;
  /** Secret values substituted into MCP headers/env — for redaction only. */
  secretValues: string[];
}

export async function resolvePluginsForRun(
  database: Database,
  config: Config,
  userId: string | null,
): Promise<ResolvedRunPlugins> {
  const catalog = await loadApprovedCatalog(database);
  const settings = await loadSettings(database);
  const userStates = userId ? await loadUserStates(database, userId) : [];
  const effective = resolveEffectivePlugins(catalog, settings, userStates);

  const skillText = composeSkillText(effective);

  const { mcpConfig, secretValues } = await resolveMcp(database, config, userId, effective);

  return {
    attached: effective.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      components: plugin.components,
    })),
    skillText,
    mcpConfig,
    secretValues,
  };
}

export function buildTaskPrompt(
  skillText: string | undefined,
  prompt: string,
  turnNumber: number | null,
): string {
  if (turnNumber && turnNumber > 1) return prompt;
  return composePrompt(skillText, prompt);
}

async function resolveMcp(
  database: Database,
  config: Config,
  userId: string | null,
  effective: EffectivePlugin[],
): Promise<{ mcpConfig: McpConfigFile | null; secretValues: string[] }> {
  const withMcp = effective.filter((plugin) => plugin.mcpConfig);
  if (withMcp.length === 0) return { mcpConfig: null, secretValues: [] };

  const variablesByPlugin = userId
    ? await loadDecryptedVariables(database, config, userId)
    : new Map<string, Record<string, string>>();
  const pluginIds = userId ? await loadPluginIdsByName(database) : new Map<string, string>();

  const configs: McpConfigFile[] = [];
  const secretValues: string[] = [];
  for (const plugin of withMcp) {
    const vars = await resolvePluginVariables(
      database,
      config,
      userId,
      plugin,
      variablesByPlugin.get(plugin.name) ?? {},
      pluginIds,
    );
    for (const value of Object.values(vars)) secretValues.push(value);
    const substituted = substituteVariables(plugin.mcpConfig as McpConfigFile, vars);
    assertCommandAllowlist(substituted, config.plugins.mcpCommandAllowlist);
    configs.push(substituted);
  }

  const merged = mergeMcpConfigs(configs);
  return {
    mcpConfig: Object.keys(merged.mcpServers).length > 0 ? merged : null,
    secretValues,
  };
}

async function resolvePluginVariables(
  database: Database,
  config: Config,
  userId: string | null,
  plugin: EffectivePlugin,
  configured: Record<string, string>,
  pluginIds: Map<string, string>,
): Promise<Record<string, string>> {
  const vars = { ...configured };
  if (userId && plugin.oauth) {
    const pluginId = pluginIds.get(plugin.name);
    if (pluginId) {
      const access = await resolvePluginOAuthToken(
        database,
        config,
        userId,
        pluginId,
        plugin.name,
        plugin.oauth,
      );
      if (access) vars[plugin.oauth.tokenVariable] = access;
    }
  }
  for (const name of plugin.requiredVariables) {
    if (!vars[name]) {
      const hint = plugin.oauth
        ? `connect OAuth or configure ${name} in the dashboard`
        : "configure it in the dashboard";
      throw new Error(`plugin "${plugin.name}" requires variable ${name}; ${hint}`);
    }
  }
  return vars;
}

async function loadPluginIdsByName(database: Database): Promise<Map<string, string>> {
  const rows = await database.select({ id: plugins.id, name: plugins.name }).from(plugins);
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function loadApprovedCatalog(database: Database): Promise<CatalogPluginVersion[]> {
  const rows = await database
    .select({
      name: plugins.name,
      version: pluginVersions.version,
      reviewStatus: pluginVersions.reviewStatus,
      artifactPath: pluginVersions.artifactPath,
    })
    .from(pluginVersions)
    .innerJoin(plugins, eq(pluginVersions.pluginId, plugins.id))
    .where(eq(pluginVersions.reviewStatus, "approved"));

  const catalog: CatalogPluginVersion[] = [];
  for (const row of rows) {
    if (!existsSync(row.artifactPath)) continue;
    const loaded = loadPluginPackage(row.artifactPath);
    catalog.push(toCatalogVersion(loaded, row.reviewStatus, row.artifactPath));
  }
  return catalog;
}

async function loadSettings(database: Database): Promise<PluginSettings[]> {
  const rows = await database
    .select({
      name: plugins.name,
      installMode: pluginSettings.installMode,
    })
    .from(pluginSettings)
    .innerJoin(plugins, eq(pluginSettings.pluginId, plugins.id));
  return rows.map((row) => ({
    name: row.name,
    installMode: row.installMode,
  }));
}

async function loadUserStates(database: Database, userId: string): Promise<PluginUserState[]> {
  const rows = await database
    .select({
      name: plugins.name,
      override: pluginUserState.override,
      installedVersionId: pluginUserState.installedVersionId,
    })
    .from(pluginUserState)
    .innerJoin(plugins, eq(pluginUserState.pluginId, plugins.id))
    .where(eq(pluginUserState.userId, userId));
  return rows.map((row) => ({
    name: row.name,
    override: row.override,
    installed: Boolean(row.installedVersionId) || row.override === "enabled",
  }));
}

async function loadDecryptedVariables(
  database: Database,
  config: Config,
  userId: string,
): Promise<Map<string, Record<string, string>>> {
  const rows = await database
    .select({
      pluginName: plugins.name,
      name: pluginUserVariables.name,
      valueEncrypted: pluginUserVariables.valueEncrypted,
    })
    .from(pluginUserVariables)
    .innerJoin(plugins, eq(pluginUserVariables.pluginId, plugins.id))
    .where(eq(pluginUserVariables.userId, userId));

  const map = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const vars = map.get(row.pluginName) ?? {};
    vars[row.name] = decryptSecret(row.valueEncrypted, config.vcs.encryptionKey);
    map.set(row.pluginName, vars);
  }
  return map;
}
