import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_ENV } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { loadSessionManager, saveSessionCheckpoint } from "./session-state";

/**
 * One Pi session, start to finish.
 *
 * Pi is embedded as a library rather than run as a server: there is no session to
 * coordinate, no port to expose, and no output to parse. Its native events are
 * relayed as telemetry, and its completion is the run's completion — nothing here
 * infers success from what the model said.
 */
export async function runAgentSession(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<void> {
  const authDirectory = oauthCredentialDirectory(config.runId);
  const authPath = join(authDirectory, "auth.json");
  await rm(authDirectory, { recursive: true, force: true });
  try {
    if (config.model.authType === "oauth") {
      await configureOAuthCredential(config, authPath);
    }
    const modelRuntime = await ModelRuntime.create({
      authPath,
      // No catalog on disk, no catalog over the network: the one model this run
      // uses is registered explicitly below. A sandbox should not be discovering
      // models at boot.
      modelsPath: null,
      allowModelNetwork: false,
    });

    if (config.model.authType !== "oauth") {
      modelRuntime.registerProvider(config.model.provider, {
        name: config.model.provider,
        baseUrl: config.model.baseUrl,
        // Pi resolves this from the environment, so the key is not passed as a value
        // through another layer.
        apiKey: `$${SANDBOX_ENV.modelApiKey}`,
        api: config.model.api,
        models: [
          {
            id: config.model.name,
            name: config.model.name,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: config.model.contextWindow,
            maxTokens: config.model.maxTokens,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      });
    }

    const model = modelRuntime.getModel(config.model.provider, config.model.name);
    if (!model) {
      throw new Error(`Pi did not register ${config.model.provider}/${config.model.name}`);
    }

    const sessionManager = await loadSessionManager(config, reporter);
    const { session, extensionsResult } = await createAgentSession({
      cwd: config.repo.path,
      model,
      thinkingLevel: "medium",
      modelRuntime,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 3 },
      }),
    });

    if (extensionsResult.errors.length > 0) {
      const detail = extensionsResult.errors
        .map(({ path, error }) => `${path}: ${error}`)
        .join("; ");
      throw new Error(`Pi could not load its extensions: ${detail}`);
    }

    reporter.log("agent.session_start", {
      sessionId: session.sessionId,
      model: `${config.model.provider}/${config.model.name}`,
      cwd: config.repo.path,
    });

    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            reporter.event({
              type: "token",
              data: { content: event.assistantMessageEvent.delta },
            });
          }
          break;
        case "tool_execution_start":
          reporter.event({
            type: "tool_call",
            data: {
              callId: event.toolCallId,
              tool: event.toolName,
              status: "running",
              args: event.args,
            },
          });
          break;
        case "tool_execution_end": {
          // Arguments were already reported on the matching "running" event; the
          // client pairs the two by callId rather than carrying them twice.
          reporter.event({
            type: "tool_call",
            data: {
              callId: event.toolCallId,
              tool: event.toolName,
              status: event.isError ? "error" : "completed",
              output: textOf(event.result),
            },
          });
          break;
        }
        case "turn_end": {
          const assistant = asAssistant(event.message);
          reporter.log("agent.turn_end", {
            stopReason: assistant?.stopReason ?? null,
            usage: assistant?.usage ?? null,
          });
          break;
        }
        case "auto_retry_start":
          reporter.log("agent.retry", {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            detail: event.errorMessage,
          });
          break;
        default:
          break;
      }
    });

    try {
      await session.prompt(config.prompt);

      // A session can end in an error state without throwing, so the last
      // assistant message is what actually says whether the work completed.
      const last = [...session.messages]
        .reverse()
        .map(asAssistant)
        .find((m) => m !== null);
      if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
        throw new Error(last.errorMessage || `the agent stopped: ${last.stopReason}`);
      }

      await saveSessionCheckpoint(config, session.sessionFile, reporter);
      reporter.log("agent.session_complete", { sessionId: session.sessionId });
    } finally {
      unsubscribe();
      session.dispose();
    }
  } finally {
    await rm(authDirectory, { recursive: true, force: true });
  }
}

function oauthCredentialDirectory(runId: string): string {
  return join(tmpdir(), "pi-cloud-agent", runId);
}

async function configureOAuthCredential(
  config: RuntimeConfig,
  authPath: string,
): Promise<void> {
  if (!config.model.authJson) throw new Error("LLM_AUTH_JSON is required for OAuth models");
  JSON.parse(config.model.authJson);
  await mkdir(join(authPath, ".."), { recursive: true });
  await writeFile(
    authPath,
    JSON.stringify({ [config.model.provider]: JSON.parse(config.model.authJson) }),
    { mode: 0o600 },
  );
}

function textOf(
  result: { content?: Array<{ type: string; text?: string }> } | undefined,
): string {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * Narrow one of Pi's messages to the assistant shape.
 *
 * `AgentMessage` is an open union that extensions can widen, so this reads the
 * two fields we care about structurally rather than importing a type from a
 * transitive dependency and pinning ourselves to its internals.
 */
interface AssistantLike {
  role: "assistant";
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

function asAssistant(message: unknown): AssistantLike | null {
  if (typeof message !== "object" || message === null) return null;
  return (message as { role?: string }).role === "assistant"
    ? (message as AssistantLike)
    : null;
}
