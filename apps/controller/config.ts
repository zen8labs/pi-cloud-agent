import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Secret } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import type { LogLevel } from "./logger";

/**
 * The only place in the controller that reads the environment.
 *
 * Everything downstream takes typed values, so a missing variable fails at
 * startup with a readable message instead of surfacing as `undefined` in the
 * middle of a run. Provider packages get the raw environment handed to them and
 * validate their own slice — see `env` below — which is why adding a sandbox or
 * VCS provider needs no change here.
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

const commaList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /**
   * Where the sandbox dials back. Must be reachable from inside the sandbox,
   * so for a hosted provider this is a public URL, not localhost.
   */
  CONTROL_PLANE_URL: z.string().url().default("http://localhost:8080"),

  /** provider/model. The provider segment names an OpenAI-compatible gateway. */
  AGENT_MODEL: z.string().min(1).default("aigateway/MiniMax/MiniMax-M2.7"),
  AIGATEWAY_BASE_URL: z.string().default(""),
  AIGATEWAY_API_KEY: z.string().default(""),
  MODEL_CONTEXT_WINDOW: z.coerce.number().int().positive().default(196_608),
  MODEL_MAX_TOKENS: z.coerce.number().int().positive().default(32_000),

  SANDBOX_PROVIDER: z.string().default("e2b"),
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3900),
  RUN_WALL_CLOCK_SECONDS: z.coerce.number().int().positive().default(3600),

  WEB_REPOS: commaList,
  WEB_CORS_ORIGINS: z.string().default("http://localhost:3000"),
});

export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  controlPlaneUrl: string;
  model: {
    /** Full id as written in config, e.g. "aigateway/MiniMax/MiniMax-M2.7". */
    id: string;
    /** The gateway name — the first path segment. */
    provider: string;
    /** The model name the gateway expects — everything after the first segment. */
    name: string;
    baseUrl: string;
    apiKey: Secret;
    contextWindow: number;
    maxTokens: number;
  };
  sandbox: {
    provider: string;
    timeoutSeconds: number;
  };
  runWallClockSeconds: number;
  web: {
    repos: string[];
    corsOrigins: string[];
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

  const separator = value.AGENT_MODEL.indexOf("/");
  if (separator <= 0 || separator === value.AGENT_MODEL.length - 1) {
    throw new Error(`AGENT_MODEL must be "provider/model", got "${value.AGENT_MODEL}"`);
  }

  return {
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    controlPlaneUrl: value.CONTROL_PLANE_URL.replace(/\/$/, ""),
    model: {
      id: value.AGENT_MODEL,
      provider: value.AGENT_MODEL.slice(0, separator),
      name: value.AGENT_MODEL.slice(separator + 1),
      baseUrl: value.AIGATEWAY_BASE_URL.replace(/\/$/, ""),
      apiKey: new Secret(value.AIGATEWAY_API_KEY, "model api key"),
      contextWindow: value.MODEL_CONTEXT_WINDOW,
      maxTokens: value.MODEL_MAX_TOKENS,
    },
    sandbox: {
      provider: value.SANDBOX_PROVIDER,
      timeoutSeconds: value.SANDBOX_TIMEOUT_SECONDS,
    },
    runWallClockSeconds: value.RUN_WALL_CLOCK_SECONDS,
    web: {
      repos: value.WEB_REPOS,
      corsOrigins: value.WEB_CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
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
