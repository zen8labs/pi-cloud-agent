import { readFileSync } from "node:fs";
import { type PluginManifest, pluginManifestSchema } from "./manifest";
import { loadMcpConfig, type McpConfigFile } from "./mcp";
import { resolvePackagePath } from "./paths";
import { discoverSkills } from "./skills";
import type { CatalogPluginVersion, PluginComponents } from "./types";

export interface LoadedPluginPackage {
  root: string;
  manifest: PluginManifest;
  skills: ReturnType<typeof discoverSkills>;
  mcpConfig: McpConfigFile | null;
  components: PluginComponents;
}

/** Load and validate a plugin package directory (`.pi-plugin/plugin.json`). */
export function loadPluginPackage(packageRoot: string): LoadedPluginPackage {
  const manifestPath = resolvePackagePath(packageRoot, ".pi-plugin/plugin.json");
  const manifest = pluginManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
  );

  const skills = manifest.skills
    ? discoverSkills(packageRoot, manifest.skills)
    : discoverSkills(packageRoot);

  let mcpConfig: McpConfigFile | null = null;
  if (manifest.mcpServers) {
    mcpConfig = loadMcpConfig(packageRoot, manifest.mcpServers);
  } else {
    // Convention: mcp.json at package root when present.
    try {
      mcpConfig = loadMcpConfig(packageRoot, "mcp.json");
    } catch {
      mcpConfig = null;
    }
  }

  const components: PluginComponents = {
    skills: skills.length > 0,
    mcp: Boolean(mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0),
  };

  return { root: packageRoot, manifest, skills, mcpConfig, components };
}

/** Turn a loaded package into a catalog version row shape (in-memory). */
export function toCatalogVersion(
  loaded: LoadedPluginPackage,
  reviewStatus: CatalogPluginVersion["reviewStatus"],
  artifactPath: string,
): CatalogPluginVersion {
  const variables = loaded.manifest.variables;
  return {
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    reviewStatus,
    artifactPath,
    components: loaded.components,
    packageRoot: loaded.root,
    skillTexts: loaded.skills.map((skill) => skill.body),
    mcpConfig: loaded.mcpConfig,
    requiredVariables: variables?.required ?? [],
    allVariables: Object.keys(variables?.properties ?? {}),
    oauth: loaded.manifest.oauth ?? null,
  };
}
