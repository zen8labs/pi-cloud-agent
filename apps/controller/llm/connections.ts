import type {
  LlmApi,
  LlmAuthType,
  LlmConnectionSummary,
  LlmModelOption,
} from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  createLlmConnection,
  getDefaultLlmConnection,
  getLlmConnection,
  getLlmConnectionForRun,
  listLlmConnections,
  updateLlmConnection,
} from "../db/llm-connections";
import type { LlmConnectionRow } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secrets/crypto";
import { assertSafeLlmEndpoint, type ResolveHostname } from "./endpoint-policy";

const MODEL_TEST_TIMEOUT_MS = 10_000;

interface StoredApiKeyCredential {
  type: "api_key";
  key: string;
}

export interface StoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

type StoredCredential = StoredApiKeyCredential | StoredOAuthCredential;

export interface ResolvedLlmModel {
  connectionId: string;
  authType: LlmAuthType;
  provider: string;
  name: string;
  api: LlmApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  apiKey: string;
  authJson: string | null;
}

export class LlmModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmModelSelectionError";
  }
}

export async function saveOAuthConnections(
  database: Database,
  config: Config,
  input: {
    userId: string;
    displayName: string;
    provider: string;
    api: LlmApi;
    baseUrl: string;
    models: ReadonlyArray<LlmModelOption>;
    credential: StoredOAuthCredential;
    isDefault: boolean;
  },
): Promise<LlmConnectionRow> {
  const models = input.models.map((model) => ({ ...model }));
  const firstModel = models[0];
  if (!firstModel) throw new Error("at least one OAuth model is required");
  const encryptedCredential = encryptSecret(
    JSON.stringify(input.credential),
    config.llm.encryptionKey,
  );
  const existing = (await listLlmConnections(database, input.userId)).find(
    (row) => row.authType === "oauth" && row.provider === input.provider,
  );
  const inputRow = {
    userId: input.userId,
    displayName: input.displayName,
    provider: input.provider,
    api: input.api,
    baseUrl: firstModel.baseUrl ?? input.baseUrl,
    model: firstModel.id,
    models,
    contextWindow: firstModel.contextWindow,
    maxTokens: firstModel.maxTokens,
    authType: "oauth" as const,
    credential: encryptedCredential,
    isDefault: input.isDefault || existing?.isDefault === true,
  };
  return existing
    ? updateLlmConnection(database, input.userId, existing.id, inputRow)
    : createLlmConnection(database, inputRow);
}

export async function saveApiKeyConnection(
  database: Database,
  config: Config,
  input: {
    userId: string;
    displayName: string;
    provider: string;
    api: LlmApi;
    baseUrl: string;
    model: string;
    apiKey: string;
    contextWindow: number;
    maxTokens: number;
    isDefault: boolean;
  },
): Promise<LlmConnectionRow> {
  return createLlmConnection(database, {
    ...input,
    models: [
      {
        id: input.model,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
      },
    ],
    authType: "api_key",
    credential: encryptSecret(
      JSON.stringify({ type: "api_key", key: input.apiKey }),
      config.llm.encryptionKey,
    ),
  });
}

export async function listLlmConnectionSummaries(
  database: Database,
  userId: string,
): Promise<LlmConnectionSummary[]> {
  return (await listLlmConnections(database, userId)).map(toSummary);
}

export async function resolveLlmModel(
  database: Database,
  config: Config,
  userId: string,
  connectionId: string,
  modelId: string,
): Promise<ResolvedLlmModel> {
  const connection = await getLlmConnection(database, userId, connectionId);
  if (!connection) {
    throw new LlmModelSelectionError(
      "connect a model provider in Settings before starting a task",
    );
  }
  return decryptModel(connection, config, modelId);
}

export async function resolveLlmModelForRun(
  database: Database,
  config: Config,
  userId: string,
  connectionId: string,
  modelId: string,
): Promise<ResolvedLlmModel> {
  const connection = await getLlmConnectionForRun(database, userId, connectionId);
  if (!connection) throw new Error("run model connection is no longer available");
  return decryptModel(connection, config, modelId);
}

export async function resolveDefaultLlmModel(
  database: Database,
  config: Config,
  userId: string,
): Promise<ResolvedLlmModel> {
  const connection = await getDefaultLlmConnection(database, userId);
  if (!connection) {
    throw new Error("connect a model provider in Settings before resuming this session");
  }
  return decryptModel(connection, config, connection.model);
}

export function modelIdFromSnapshot(snapshot: string): string {
  const separator = snapshot.indexOf("/");
  if (separator < 1 || separator === snapshot.length - 1) {
    throw new Error("run model snapshot is invalid");
  }
  return snapshot.slice(separator + 1);
}

export async function testLlmEndpoint(
  input: {
    baseUrl: string;
    apiKey: string;
    api: LlmApi;
    model: string;
  },
  options: { resolveHostname?: ResolveHostname } = {},
): Promise<void> {
  const url = await assertSafeLlmEndpoint(input.baseUrl, options.resolveHostname);

  const endpoint = endpointFor(input.api);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.api === "anthropic-messages") {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(`${url.toString().replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody(input.api, input.model)),
      signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new Error("could not reach the model endpoint");
  }
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 240);
    throw new Error(`model endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

function decryptModel(
  row: LlmConnectionRow,
  config: Config,
  modelId: string,
): ResolvedLlmModel {
  const credential = parseCredential(decryptSecret(row.credential, config.llm.encryptionKey));
  const selected = row.models.find((model) => model.id === modelId);
  if (!selected) {
    throw new LlmModelSelectionError(`model ${modelId} is not available on this connection`);
  }
  return {
    connectionId: row.id,
    authType: row.authType,
    provider: row.provider,
    name: selected.id,
    api: row.api,
    baseUrl: (selected.baseUrl ?? row.baseUrl).replace(/\/$/, ""),
    contextWindow: selected.contextWindow,
    maxTokens: selected.maxTokens,
    apiKey: credential.type === "api_key" ? credential.key : credential.access,
    authJson: credential.type === "oauth" ? JSON.stringify(credential) : null,
  };
}

function parseCredential(value: string): StoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("stored model credential is invalid");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("stored model credential is invalid");
  }
  if (
    (parsed as { type?: unknown }).type === "api_key" &&
    typeof (parsed as { key?: unknown }).key === "string" &&
    (parsed as { key: string }).key
  ) {
    return parsed as StoredApiKeyCredential;
  }
  if (
    (parsed as { type?: unknown }).type === "oauth" &&
    typeof (parsed as { access?: unknown }).access === "string" &&
    typeof (parsed as { refresh?: unknown }).refresh === "string" &&
    typeof (parsed as { expires?: unknown }).expires === "number"
  ) {
    return parsed as StoredOAuthCredential;
  }
  throw new Error("stored model credential is invalid");
}

export function toSummary(row: LlmConnectionRow): LlmConnectionSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    provider: row.provider,
    authType: row.authType,
    api: row.api,
    baseUrl: row.baseUrl,
    model: row.model,
    models: row.models,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    isDefault: row.isDefault,
    warning:
      row.authType === "oauth" && row.provider === "anthropic"
        ? "Claude subscription usage may be billed as extra usage."
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function endpointFor(api: LlmApi): string {
  if (api === "openai-completions") return "/chat/completions";
  if (api === "openai-responses" || api === "openai-codex-responses") return "/responses";
  return "/messages";
}

function requestBody(api: LlmApi, model: string): Record<string, unknown> {
  if (api === "anthropic-messages") {
    return { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
  }
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return { model, input: "ping", max_output_tokens: 1 };
  }
  return { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
}
