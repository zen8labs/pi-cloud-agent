import type { PluginOauth } from "./manifest";

/** Deployment-wide install mode for one catalog plugin. */
export type InstallMode = "default_off" | "default_on" | "required";

/** User override on top of the deployment install mode. */
export type UserOverride = "enabled" | "disabled" | null;

export type ReviewStatus = "draft" | "approved" | "yanked";

export interface PluginComponents {
  skills: boolean;
  mcp: boolean;
}

/** What a run actually attached, for replay. */
export interface AttachedPlugin {
  name: string;
  version: string;
  components: PluginComponents;
}

export interface CatalogPluginVersion {
  name: string;
  version: string;
  reviewStatus: ReviewStatus;
  artifactPath: string;
  components: PluginComponents;
  /** Absolute path to the loaded package root (artifact). */
  packageRoot: string;
  skillTexts: string[];
  /** Raw mcp.json contents, or null when the plugin has no MCP. */
  mcpConfig: unknown | null;
  /** Variable names declared required by the manifest. */
  requiredVariables: string[];
  allVariables: string[];
  /** Host-mediated MCP OAuth, when declared. */
  oauth: PluginOauth | null;
}

export interface PluginSettings {
  name: string;
  installMode: InstallMode;
}

export interface PluginUserState {
  name: string;
  override: UserOverride;
  /** True when the user has opted into this plugin (install row exists). */
  installed: boolean;
}

/** One plugin that will attach to a run after resolution. */
export interface EffectivePlugin {
  name: string;
  version: string;
  packageRoot: string;
  components: PluginComponents;
  skillTexts: string[];
  mcpConfig: unknown | null;
  requiredVariables: string[];
  allVariables: string[];
  oauth: PluginOauth | null;
}
