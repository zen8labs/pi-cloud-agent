import { join } from "node:path";
import {
  createRedactor,
  redactUrlCredentials,
  SANDBOX_ENV,
  SANDBOX_PATHS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@pi-cloud-agent/protocol";

/**
 * Everything this process knows, read once from the environment.
 *
 * Variable names come from the protocol package, which the controller also
 * imports — so the two sides cannot drift apart silently. A missing required
 * value throws here, before a clone or a model call can half-happen.
 */

export interface RuntimeConfig {
  runId: string;
  controlPlaneUrl: string;
  callbackToken: string;
  sessionId: string;
  sessionBaseSha: string;
  workspaceResumed: boolean;
  debugEvents: boolean;

  prompt: string;
  /** Optional setup script saved in the app's repository environment setting. */
  appSetupScript: string;

  model: {
    provider: string;
    name: string;
    api: string;
    authType: "api_key" | "oauth";
    authJson: string;
    baseUrl: string;
    contextWindow: number;
    maxTokens: number;
    thinkingLevel: ThinkingLevel;
  };

  repo: {
    owner: string;
    name: string;
    cloneUrl: string;
    defaultBranch: string;
    headBranch: string;
    headSha: string;
    baseSha: string;
    path: string;
  };

  git: { username: string; hasToken: boolean };

  /** Parsed MCP config JSON when plugins attached MCP; null means zero MCP. */
  mcpConfig: unknown | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function positiveInteger(name: string): number {
  const parsed = Number(required(name));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function readConfig(): RuntimeConfig {
  const modelRef = required(SANDBOX_ENV.model);
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error(`${SANDBOX_ENV.model} must be "provider/model", got "${modelRef}"`);
  }

  const repoName = optional(SANDBOX_ENV.repoName, "repo");
  const appSetupScript = optional(SANDBOX_ENV.setupScript);
  // The app-managed script is setup-only material. Keep its value in the typed
  // config, but remove the injected environment variable before the agent starts
  // so repository code cannot read it from the inherited process environment.
  delete process.env[SANDBOX_ENV.setupScript];

  return {
    runId: required(SANDBOX_ENV.runId),
    controlPlaneUrl: required(SANDBOX_ENV.controlPlaneUrl).replace(/\/$/, ""),
    callbackToken: required(SANDBOX_ENV.callbackToken),
    sessionId: optional(SANDBOX_ENV.sessionId),
    sessionBaseSha: optional(SANDBOX_ENV.sessionBaseSha),
    workspaceResumed: optional(SANDBOX_ENV.workspaceResumed) === "true",
    debugEvents: optional(SANDBOX_ENV.debugEvents) === "true",

    prompt: required(SANDBOX_ENV.taskPrompt),
    appSetupScript,

    model: {
      provider: modelRef.slice(0, separator),
      name: modelRef.slice(separator + 1),
      api: required(SANDBOX_ENV.modelApi),
      authType: readAuthType(),
      authJson: optional(SANDBOX_ENV.modelAuthJson),
      baseUrl: required(SANDBOX_ENV.modelBaseUrl),
      contextWindow: positiveInteger(SANDBOX_ENV.modelContextWindow),
      maxTokens: positiveInteger(SANDBOX_ENV.modelMaxTokens),
      thinkingLevel: readThinkingLevel(),
    },

    repo: {
      owner: optional(SANDBOX_ENV.repoOwner),
      name: repoName,
      cloneUrl: required(SANDBOX_ENV.repoCloneUrl),
      defaultBranch: optional(SANDBOX_ENV.repoDefaultBranch, "main"),
      headBranch: optional(SANDBOX_ENV.repoHeadBranch),
      headSha: optional(SANDBOX_ENV.repoHeadSha),
      baseSha: optional(SANDBOX_ENV.repoBaseSha),
      path: join(SANDBOX_PATHS.workspace, repoName),
    },

    git: {
      username: optional(SANDBOX_ENV.scmTokenUsername, "x-access-token"),
      hasToken: Boolean(optional(SANDBOX_ENV.scmToken)),
    },

    mcpConfig: parseMcpConfig(optional(SANDBOX_ENV.mcpConfig)),
  };
}

function parseMcpConfig(raw: string): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${SANDBOX_ENV.mcpConfig} is not valid JSON`);
  }
}

function readThinkingLevel(): ThinkingLevel {
  const value = required(SANDBOX_ENV.modelThinkingLevel);
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (!level) throw new Error(`${SANDBOX_ENV.modelThinkingLevel} is invalid`);
  return level;
}

function readAuthType(): "api_key" | "oauth" {
  const value = required(SANDBOX_ENV.modelAuthType);
  if (value !== "api_key" && value !== "oauth") {
    throw new Error(`${SANDBOX_ENV.modelAuthType} must be api_key or oauth`);
  }
  return value;
}

/**
 * Every secret value visible to this process.
 *
 * The sandbox is the only place that knows all of them, which makes it the right
 * place to scrub output. Names are matched rather than listed so a credential
 * added by a future provider is redacted by default instead of by remembering to
 * update this file. See docs/secrets.md.
 */
function secretValues(): string[] {
  const pattern = /(TOKEN|API_KEY|SECRET|PASSWORD|AUTH_JSON)$/;
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (
      pattern.test(name) ||
      name === SANDBOX_ENV.callbackToken ||
      name === SANDBOX_ENV.mcpConfig
    ) {
      values.push(value);
    }
  }
  return values;
}

/** Scrub every runtime-owned output path, including stderr and HTTP payloads. */
export function createRuntimeRedactor(): (text: string) => string {
  const redact = createRedactor(secretValues());
  return (text) => redact(redactUrlCredentials(text));
}
