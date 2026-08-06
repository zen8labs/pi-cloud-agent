import { z } from "zod";

/** Lowercase kebab-case plugin name, unique in the operator catalog. */
export const pluginNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "plugin name must be lowercase kebab-case");

const variablePropertySchema = z.object({
  type: z.literal("string"),
  title: z.string().optional(),
  description: z.string().optional(),
});

export const pluginVariablesSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), variablePropertySchema).default({}),
  required: z.array(z.string()).default([]),
});

/** Host-mediated MCP OAuth (RFC 9728). Resource URL is discovered; controller never hardcodes issuers beyond an allowlist. */
export const pluginOauthSchema = z.object({
  resource: z.string().url(),
  tokenVariable: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(["mcp:tools"]),
});

export const pluginManifestSchema = z.object({
  name: pluginNameSchema,
  version: z.string().min(1),
  description: z.string().default(""),
  author: z
    .object({
      name: z.string().min(1),
    })
    .optional(),
  keywords: z.array(z.string()).default([]),
  skills: z.string().optional(),
  mcpServers: z.string().optional(),
  variables: pluginVariablesSchema.optional(),
  oauth: pluginOauthSchema.optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginVariables = z.infer<typeof pluginVariablesSchema>;
export type PluginOauth = z.infer<typeof pluginOauthSchema>;
