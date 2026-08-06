import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_ENV, SANDBOX_PATHS } from "@pi-cloud-agent/protocol";
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
  if (config.model.authType === "oauth") {
    await configureOAuthCredential(config);
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(SANDBOX_PATHS.state, "auth.json"),
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

  let turnNumber = 0;
  let turnStartedAt: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        reporter.log("agent.start");
        break;
      case "agent_end":
        reporter.log("agent.end", {
          willRetry: event.willRetry,
          messageCount: event.messages.length,
        });
        break;
      case "agent_settled":
        reporter.log("agent.settled");
        break;
      case "turn_start":
        turnNumber += 1;
        turnStartedAt = new Date().toISOString();
        reporter.log("agent.turn_start", { turnNumber, turnStartedAt });
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          reporter.event({ type: "token", data: { content: update.delta } });
        }
        break;
      }
      case "message_start":
        reporter.log("agent.message_start", summarizeMessage(event.message));
        break;
      case "message_end":
        reporter.log("agent.message_end", summarizeMessage(event.message));
        break;
      case "tool_execution_start":
        reporter.event({
          type: "tool_call",
          data: {
            callId: event.toolCallId,
            tool: event.toolName,
            status: "running",
            turnNumber,
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
            turnNumber,
            output: textOf(event.result),
          },
        });
        break;
      }
      case "tool_execution_update":
        reporter.log("agent.tool_update", {
          callId: event.toolCallId,
          tool: event.toolName,
          turnNumber,
          args: event.args,
          partialResult: event.partialResult,
        });
        break;
      case "turn_end": {
        const assistant = asAssistant(event.message);
        reporter.log("agent.turn_end", {
          turnNumber,
          turnStartAt: turnStartedAt,
          stopReason: assistant?.stopReason ?? null,
          usage: assistant?.usage ?? null,
          output: assistant?.content ?? null,
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
      case "auto_retry_end":
        reporter.log("agent.retry_end", {
          attempt: event.attempt,
          success: event.success,
          finalError: event.finalError,
        });
        break;
      case "compaction_start":
        reporter.log("agent.compaction_start", { reason: event.reason });
        break;
      case "compaction_end":
        reporter.log("agent.compaction_end", {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          errorMessage: event.errorMessage,
        });
        break;
      case "queue_update":
        reporter.log("agent.queue_update", {
          steeringCount: event.steering.length,
          followUpCount: event.followUp.length,
        });
        break;
      case "thinking_level_changed":
        reporter.log("agent.thinking_level_changed", { level: event.level });
        break;
      case "bash_execution_update":
        reporter.log("agent.bash_update", {
          id: event.id,
          delta: event.delta,
        });
        break;
      default:
        reporter.log("agent.event", { type: event.type, payload: event });
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
}

async function configureOAuthCredential(config: RuntimeConfig): Promise<void> {
  if (!config.model.authJson) throw new Error("LLM_AUTH_JSON is required for OAuth models");
  JSON.parse(config.model.authJson);
  await mkdir(SANDBOX_PATHS.state, { recursive: true });
  await writeFile(
    join(SANDBOX_PATHS.state, "auth.json"),
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
  content?: unknown;
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

function summarizeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const value = message as Record<string, unknown>;
  return {
    role: value.role,
    stopReason: value.stopReason,
    usage: value.usage,
  };
}
