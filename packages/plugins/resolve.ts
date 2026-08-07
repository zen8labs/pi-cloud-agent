import type {
  CatalogPluginVersion,
  EffectivePlugin,
  PluginSettings,
  PluginUserState,
} from "./types";

/**
 * Resolve which catalog plugins attach for one user.
 *
 * Required → always on.
 * Default On → on unless user override is disabled.
 * Default Off → on only if user installed/enabled.
 */
export function resolveEffectivePlugins(
  catalog: CatalogPluginVersion[],
  settings: PluginSettings[],
  userStates: PluginUserState[],
): EffectivePlugin[] {
  const settingsByName = new Map(settings.map((row) => [row.name, row]));
  const userByName = new Map(userStates.map((row) => [row.name, row]));

  const effective: EffectivePlugin[] = [];
  for (const version of catalog) {
    if (version.reviewStatus !== "approved") continue;
    const mode = settingsByName.get(version.name)?.installMode ?? "default_off";
    const user = userByName.get(version.name);
    if (!isAttached(mode, user)) continue;
    effective.push({
      name: version.name,
      version: version.version,
      packageRoot: version.packageRoot,
      components: version.components,
      skillTexts: version.skillTexts,
      mcpConfig: version.mcpConfig,
      requiredVariables: version.requiredVariables,
      allVariables: version.allVariables,
      oauth: version.oauth,
    });
  }

  return effective.sort((left, right) => left.name.localeCompare(right.name));
}

function isAttached(
  mode: PluginSettings["installMode"],
  user: PluginUserState | undefined,
): boolean {
  if (mode === "required") return true;
  if (user?.override === "disabled") return false;
  if (user?.override === "enabled") return true;
  if (mode === "default_on") return true;
  // default_off: need an install (installed flag) without an explicit disable
  return Boolean(user?.installed);
}

/** Public alias used by the marketplace list view. */
export function isPluginAttached(
  mode: PluginSettings["installMode"],
  user: PluginUserState | undefined,
): boolean {
  return isAttached(mode, user);
}

/**
 * Compose the skills contributed by enabled plugins.
 */
export function composeSkillText(plugins: EffectivePlugin[]): string | undefined {
  const pluginSkills = plugins
    .flatMap((plugin) =>
      plugin.skillTexts.map((text) => ({ plugin: plugin.name, text: text.trim() })),
    )
    .filter((entry) => entry.text.length > 0)
    .sort((left, right) => left.plugin.localeCompare(right.plugin));

  if (pluginSkills.length > 0) {
    return pluginSkills.map((entry) => entry.text).join("\n\n---\n\n");
  }
  return undefined;
}

/** Prepend skill text to the concrete request, or return the prompt alone. */
export function composePrompt(skill: string | undefined, prompt: string): string {
  return skill ? `${skill}\n\n---\n\n${prompt}` : prompt;
}
