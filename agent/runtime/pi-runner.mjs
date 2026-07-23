import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const log = (event, data = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
};

const controlPlaneUrl = required("CONTROL_PLANE_URL").replace(/\/$/, "");
const runId = required("RUN_ID");
const authToken = required("SANDBOX_AUTH_TOKEN");
const modelReference =
  process.env.AGENT_MODEL?.trim() || "aigateway/MiniMax/MiniMax-M2.7";
const [provider, ...modelParts] = modelReference.split("/");
const modelId = modelParts.join("/");

if (!modelId) throw new Error(`AGENT_MODEL must be provider/model, got ${modelReference}`);

required("OPENAI_API_KEY");
const modelDefinition = {
  id: modelId,
  name: modelId,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 196608),
  maxTokens: Number(process.env.LLM_MAX_TOKENS || 32000),
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
  },
};

const headers = {
  Authorization: `Bearer ${authToken}`,
  "Content-Type": "application/json",
};

async function post(path, body, requiredDelivery = false) {
  let lastError;
  const attempts = requiredDelivery ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${controlPlaneUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }
  if (requiredDelivery) throw lastError;
  log("pi.telemetry_error", { error: String(lastError) });
}

const postEvent = (type, data) =>
  post(`/internal/runs/${runId}/events`, { type, data });
const postStatus = (status, detail = null) =>
  post(`/internal/runs/${runId}/status`, { status, detail }, true);

let telemetry = Promise.resolve();
const emit = (type, data) => {
  telemetry = telemetry.then(() => postEvent(type, data));
};

function textFromResult(result) {
  return (result?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function main() {
  const cwd = required("REPO_PATH");
  const prompt = required("AGENT_PROMPT");
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(provider, {
    name: provider,
    baseUrl: required("OPENAI_BASE_URL"),
    apiKey: "$OPENAI_API_KEY",
    api: "openai-completions",
    models: [modelDefinition],
  });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi did not register model ${modelReference}`);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "medium",
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  if (extensionsResult.errors.length) {
    throw new Error(
      `Pi extension loading failed: ${extensionsResult.errors
        .map(({ path, error }) => `${path}: ${error}`)
        .join("; ")}`,
    );
  }

  log("pi.session_start", {
    session_id: session.sessionId,
    model: modelReference,
    cwd,
  });

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          emit("token", { content: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start":
        emit("tool_call", {
          tool: event.toolName,
          args: event.args,
          callId: event.toolCallId,
          status: "running",
        });
        break;
      case "tool_execution_end":
        emit("tool_call", {
          tool: event.toolName,
          args: event.args,
          callId: event.toolCallId,
          status: event.isError ? "error" : "completed",
          output: textFromResult(event.result),
        });
        break;
      case "turn_end":
        emit("log", {
          event: "pi.turn_end",
          turn: event.turnIndex,
          stop_reason: event.message?.stopReason,
          tokens: event.message?.usage,
        });
        break;
      case "auto_retry_start":
        emit("log", {
          event: "pi.retry",
          attempt: event.attempt,
          max_attempts: event.maxAttempts,
          error: event.errorMessage,
        });
        break;
    }
  });

  try {
    await session.prompt(prompt);
    await telemetry;

    const assistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
      throw new Error(assistant.errorMessage || `Pi stopped: ${assistant.stopReason}`);
    }

    log("pi.session_complete", { session_id: session.sessionId });
    await postStatus("done");
  } finally {
    unsubscribe();
    session.dispose();
  }
}

main().catch(async (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  log("pi.session_error", { error: detail });
  try {
    await telemetry;
    await postStatus("error", detail);
  } catch (statusError) {
    log("pi.status_error", { error: String(statusError) });
  }
  process.exitCode = 1;
});
