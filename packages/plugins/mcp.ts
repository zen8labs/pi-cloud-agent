import { readFileSync } from "node:fs";
import { resolvePackagePath } from "./paths";

export interface McpServerDef {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  lifecycle?: string;
  [key: string]: unknown;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerDef>;
}

/** Load and lightly validate mcp.json from a plugin package. */
export function loadMcpConfig(packageRoot: string, relativePath: string): McpConfigFile {
  const path = resolvePackagePath(packageRoot, relativePath);
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mcp.json must be an object");
  }
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("mcp.json must contain an mcpServers object");
  }
  return { mcpServers: servers as Record<string, McpServerDef> };
}

/**
 * Substitute `${VAR}` placeholders from a variables map.
 * Unresolved placeholders throw so provision fails closed.
 */
export function substituteVariables(
  config: McpConfigFile,
  variables: Record<string, string>,
): McpConfigFile {
  const json = JSON.stringify(config);
  const replaced = json.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`missing plugin variable: ${name}`);
    }
    return JSON.stringify(value).slice(1, -1);
  });
  return JSON.parse(replaced) as McpConfigFile;
}

/**
 * Reject command-based MCP servers unless the binary is on the operator allowlist.
 * Empty allowlist means URL/SSE only.
 */
export function assertCommandAllowlist(
  config: McpConfigFile,
  allowlist: readonly string[],
): void {
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!server.command) continue;
    if (!allowlist.includes(server.command)) {
      throw new Error(
        `MCP server "${name}" uses command "${server.command}" which is not on MCP_COMMAND_ALLOWLIST`,
      );
    }
  }
}

/** Merge several plugin MCP configs into one snapshot (later names win on collision). */
export function mergeMcpConfigs(configs: McpConfigFile[]): McpConfigFile {
  const mcpServers: Record<string, McpServerDef> = {};
  for (const config of configs) {
    Object.assign(mcpServers, config.mcpServers);
  }
  return { mcpServers };
}
