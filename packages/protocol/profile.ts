import { z } from "zod";
import type { TaskSpec } from "./task";
import type { Trigger } from "./trigger";

/**
 * A profile is the extension surface: it turns a trigger into a task, and owns
 * every decision that is specific to a vertical.
 *
 * Profiles are written against `ProfileDefinition`, which is fully typed in
 * their own config. The controller only ever sees `Profile`, where the config
 * type is erased and parsing has already happened. That split is what keeps the
 * controller free of profile-specific knowledge: it cannot branch on a config
 * field it has no type for.
 *
 * See docs/adding-a-profile.md.
 */
export interface ProfileDefinition<Config> {
  readonly name: string;
  /** One line, shown in the dashboard. */
  readonly description: string;
  /**
   * Per-repo configuration. The dashboard renders this schema, and the
   * controller stores whatever it validates without interpreting it.
   * Every field needs a default so an unconfigured repo still works.
   */
  readonly configSchema: z.ZodType<Config>;
  /** Reusable instructions prepended to the prompt inside the sandbox. */
  readonly skill?: string;
  /**
   * Should this trigger start a run? This is where "don't auto-review on every
   * push" and "only act on /review" live — decisions about a vertical's
   * triggering policy, which the controller must not make.
   */
  accepts(trigger: Trigger, config: Config): boolean;
  buildTask(trigger: Trigger, config: Config): TaskSpec;
}

/** The config-erased view the controller uses. */
export interface Profile {
  readonly name: string;
  readonly description: string;
  readonly skill?: string;
  /** JSON Schema of the config, for the dashboard's settings form. */
  readonly configJsonSchema: Record<string, unknown>;
  /** Validate and apply defaults. Throws on invalid stored config. */
  parseConfig(raw: unknown): unknown;
  accepts(trigger: Trigger, rawConfig: unknown): boolean;
  buildTask(trigger: Trigger, rawConfig: unknown): TaskSpec;
}

export function defineProfile<Config>(definition: ProfileDefinition<Config>): Profile {
  const parse = (raw: unknown): Config => definition.configSchema.parse(raw ?? {});
  return {
    name: definition.name,
    description: definition.description,
    skill: definition.skill,
    configJsonSchema: z.toJSONSchema(definition.configSchema) as Record<string, unknown>,
    parseConfig: parse,
    accepts: (trigger, rawConfig) => definition.accepts(trigger, parse(rawConfig)),
    buildTask: (trigger, rawConfig) => definition.buildTask(trigger, parse(rawConfig)),
  };
}
