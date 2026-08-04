import { join } from "node:path";
import {
  createRedactor,
  redactUrlCredentials,
  SANDBOX_ENV,
  SANDBOX_PATHS,
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
  workspaceResumed: boolean;

  prompt: string;
  profile: string;

  model: {
    provider: string;
    name: string;
    baseUrl: string;
    contextWindow: number;
    maxTokens: number;
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

function numeric(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(): RuntimeConfig {
  const modelRef = required(SANDBOX_ENV.model);
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error(`${SANDBOX_ENV.model} must be "provider/model", got "${modelRef}"`);
  }

  const repoName = optional(SANDBOX_ENV.repoName, "repo");

  return {
    runId: required(SANDBOX_ENV.runId),
    controlPlaneUrl: required(SANDBOX_ENV.controlPlaneUrl).replace(/\/$/, ""),
    callbackToken: required(SANDBOX_ENV.callbackToken),
    sessionId: optional(SANDBOX_ENV.sessionId),
    workspaceResumed: optional(SANDBOX_ENV.workspaceResumed) === "true",

    prompt: required(SANDBOX_ENV.taskPrompt),
    profile: optional(SANDBOX_ENV.profile, "general"),

    model: {
      provider: modelRef.slice(0, separator),
      name: modelRef.slice(separator + 1),
      baseUrl: required(SANDBOX_ENV.modelBaseUrl),
      contextWindow: numeric(SANDBOX_ENV.modelContextWindow, 196_608),
      maxTokens: numeric(SANDBOX_ENV.modelMaxTokens, 32_000),
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

/**
 * Every secret value visible to this process.
 *
 * The sandbox is the only place that knows all of them, which makes it the right
 * place to scrub output. Names are matched rather than listed so a credential
 * added by a future provider is redacted by default instead of by remembering to
 * update this file. See docs/secrets.md.
 */
function secretValues(): string[] {
  const pattern = /(TOKEN|API_KEY|SECRET|PASSWORD)$/;
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
