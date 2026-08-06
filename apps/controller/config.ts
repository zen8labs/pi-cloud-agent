import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "./logger";

/**
 * The only place in the controller that reads the environment.
 *
 * Everything downstream takes typed values, so a missing variable fails at
 * startup with a readable message instead of surfacing as `undefined` in the
 * middle of a run. Provider packages get the raw environment handed to them and
 * validate their own slice — see `env` below. Sandbox providers need no schema
 * change; connected providers add explicit keys here because the controller
 * owns the callback and secret-storage boundary.
 *
 * The `noProcessEnv` lint rule enforces this: no other file may read
 * `process.env`.
 */

// biome-ignore lint/style/noProcessEnv: this module is the single entry point.
const rawEnv = process.env;

function loadEnvFile(): void {
  for (const candidate of [".env", "../../.env"]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /**
   * Where the sandbox dials back. The local microSandbox provider reaches the
   * host through its internal gateway; hosted providers need their own URL.
   */
  CONTROL_PLANE_URL: z.string().url().default("http://host.microsandbox.internal:8080"),

  SANDBOX_PROVIDER: z.string().default("microsandbox"),
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3900),
  RUN_WALL_CLOCK_SECONDS: z.coerce.number().int().positive().default(3600),
  SESSION_WORKSPACE_RETENTION_SECONDS: z.coerce.number().int().positive().default(604_800),

  WEB_URL: z.string().url().default("http://localhost:3000"),
  WEB_CORS_ORIGINS: z.string().default("http://localhost:3000"),

  /** Optional vendor-neutral OTLP/HTTP destination for completed agent traces. */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z
    .string()
    .refine((value) => !value || URL.canParse(value), "must be a valid URL when configured")
    .default(""),
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().min(1).default("pi-cloud-agent"),
  OTEL_EXPORT_DEBUG_EVENTS: z.enum(["true", "false"]).default("false"),

  APP_SESSION_SECRET: z.string().default(""),
  APP_AUTH_REQUIRED: z.enum(["true", "false"]).default("true"),
  VCS_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hexadecimal characters"),
  LLM_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hexadecimal characters"),
  GITHUB_APP_CLIENT_ID: z.string().default(""),
  GITHUB_APP_CLIENT_SECRET: z.string().default(""),
  GITHUB_APP_REDIRECT_URI: z.string().default(""),
  AZURE_DEVOPS_CLIENT_ID: z.string().default(""),
  AZURE_DEVOPS_CLIENT_SECRET: z.string().default(""),
  AZURE_DEVOPS_TENANT_ID: z.string().default("common"),
  AZURE_DEVOPS_REDIRECT_URI: z.string().default(""),

  /** Comma-separated GitHub logins allowed to publish/review plugins. Empty = none. */
  OPERATOR_GITHUB_LOGINS: z.string().default(""),
  /** Directory for published plugin artifacts. */
  PLUGIN_ARTIFACT_ROOT: z.string().default(""),
  /** In-repo marketplace plugins root (single source of truth; seeded into the catalog). */
  PLUGIN_MARKETPLACE_ROOT: z.string().default(""),
  /** Comma-separated binaries allowed for command-based MCP servers. Empty = URL only. */
  MCP_COMMAND_ALLOWLIST: z.string().default(""),
  /** Callback for plugin MCP OAuth. Defaults to CONTROL_PLANE_URL/plugins/oauth/callback. */
  PLUGIN_OAUTH_REDIRECT_URI: z.string().default(""),
  /** Comma-separated authorization-server hostnames allowed for plugin OAuth. */
  PLUGIN_OAUTH_ISSUER_ALLOWLIST: z.string().default("auth.exa.ai"),
});

export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  controlPlaneUrl: string;
  sandbox: {
    provider: string;
    timeoutSeconds: number;
  };
  runWallClockSeconds: number;
  sessionWorkspaceRetentionSeconds: number;
  web: {
    url: string;
    corsOrigins: string[];
  };
  observability: {
    tracesEndpoint: string;
    tracesHeaders: Record<string, string>;
    serviceName: string;
    exportDebugEvents: boolean;
  };
  auth: {
    requireUser: boolean;
    sessionSecret: string;
  };
  vcs: { encryptionKey: string };
  llm: { encryptionKey: string };
  plugins: {
    operatorLogins: string[];
    artifactRoot: string;
    marketplaceRoot: string;
    mcpCommandAllowlist: string[];
    oauthRedirectUri: string;
    oauthIssuerAllowlist: string[];
  };
  /** Handed to provider factories so they can read their own variables. */
  env: Env;
}

function build(env: Env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}\n\nSee .env.example.`);
  }
  const value = parsed.data;

  const requireUser = value.APP_AUTH_REQUIRED === "true";
  if (requireUser && value.APP_SESSION_SECRET.length < 32) {
    throw new Error(
      "APP_SESSION_SECRET must contain at least 32 characters when APP_AUTH_REQUIRED=true",
    );
  }

  const corsOrigins = value.WEB_CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (corsOrigins.includes("*")) {
    throw new Error(
      "WEB_CORS_ORIGINS must list explicit origins because dashboard requests use credentials",
    );
  }

  const tracesHeaders = parseHeaders(value.OTEL_EXPORTER_OTLP_TRACES_HEADERS);

  return {
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    controlPlaneUrl: value.CONTROL_PLANE_URL.replace(/\/$/, ""),
    sandbox: {
      provider: value.SANDBOX_PROVIDER,
      timeoutSeconds: value.SANDBOX_TIMEOUT_SECONDS,
    },
    runWallClockSeconds: value.RUN_WALL_CLOCK_SECONDS,
    sessionWorkspaceRetentionSeconds: value.SESSION_WORKSPACE_RETENTION_SECONDS,
    web: {
      url: value.WEB_URL.replace(/\/$/, ""),
      corsOrigins,
    },
    observability: {
      tracesEndpoint: value.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      tracesHeaders,
      serviceName: value.OTEL_SERVICE_NAME,
      exportDebugEvents: value.OTEL_EXPORT_DEBUG_EVENTS === "true",
    },
    auth: {
      requireUser,
      sessionSecret: value.APP_SESSION_SECRET,
    },
    vcs: { encryptionKey: value.VCS_ENCRYPTION_KEY },
    llm: { encryptionKey: value.LLM_ENCRYPTION_KEY },
    plugins: {
      operatorLogins: value.OPERATOR_GITHUB_LOGINS.split(",")
        .map((login) => login.trim().toLowerCase())
        .filter((login) => login.length > 0),
      artifactRoot:
        value.PLUGIN_ARTIFACT_ROOT.trim() ||
        resolve(import.meta.dirname, "../../.pi-plugin-artifacts"),
      marketplaceRoot:
        value.PLUGIN_MARKETPLACE_ROOT.trim() ||
        resolve(import.meta.dirname, "../../marketplace/plugins"),
      mcpCommandAllowlist: value.MCP_COMMAND_ALLOWLIST.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      oauthRedirectUri:
        value.PLUGIN_OAUTH_REDIRECT_URI.trim() ||
        `${value.CONTROL_PLANE_URL.replace(/\/$/, "")}/plugins/oauth/callback`,
      oauthIssuerAllowlist: value.PLUGIN_OAUTH_ISSUER_ALLOWLIST.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    },
    env,
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached === null) {
    loadEnvFile();
    cached = build(rawEnv);
  }
  return cached;
}

/** For tests: build a config from an explicit environment, bypassing the file. */
export function configFrom(env: Env): Config {
  return build(env);
}

function parseHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS must be comma-separated key=value pairs",
      );
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key || !value) {
      throw new Error(
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS must contain non-empty keys and values",
      );
    }
    headers[key] = value;
  }
  return headers;
}
