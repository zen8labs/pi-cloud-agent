import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LlmConnectionSummary } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { listLlmConnections } from "../db/llm-connections";
import { saveOAuthConnections, toSummary } from "./connections";

// Pi's Codex device code remains valid for 15 minutes. Leave a small margin so
// the provider, rather than this wrapper, owns the terminal expiry message.
const FLOW_TIMEOUT_MS = 16 * 60_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;

const PROVIDER = {
  piId: "openai-codex",
  displayName: "Codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
} as const;

export type OAuthFlowEvent =
  | { type: "auth"; event: AuthEvent }
  | { type: "complete"; connection: LlmConnectionSummary }
  | { type: "error"; message: string };

interface OAuthFlow {
  id: string;
  userId: string;
  events: OAuthFlowEvent[];
  subscribers: Set<(event: OAuthFlowEvent) => void>;
  abortController: AbortController;
  terminal: boolean;
}

interface OAuthRuntime {
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<Credential>;
  getModels(providerId: string): ReturnType<ModelRuntime["getModels"]>;
}

interface OAuthFlowManagerOptions {
  createRuntime?: () => Promise<OAuthRuntime>;
  flowTimeoutMs?: number;
  terminalRetentionMs?: number;
}

export class OAuthFlowManager {
  private readonly flows = new Map<string, OAuthFlow>();

  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly options: OAuthFlowManagerOptions = {},
  ) {}

  start(userId: string): string {
    for (const existing of this.flows.values()) {
      if (existing.userId === userId && !existing.terminal) {
        existing.abortController.abort(new Error("OAuth sign-in superseded by a new attempt"));
      }
    }
    const flow: OAuthFlow = {
      id: randomUUID(),
      userId,
      events: [],
      subscribers: new Set(),
      abortController: new AbortController(),
      terminal: false,
    };
    this.flows.set(flow.id, flow);
    void this.run(flow);
    return flow.id;
  }

  get(flowId: string, userId: string): OAuthFlow | null {
    const flow = this.flows.get(flowId);
    return flow?.userId === userId ? flow : null;
  }

  subscribe(
    flowId: string,
    userId: string,
    listener: (event: OAuthFlowEvent) => void,
  ): { events: OAuthFlowEvent[]; unsubscribe: () => void } | null {
    const flow = this.get(flowId, userId);
    if (!flow) return null;
    flow.subscribers.add(listener);
    return {
      events: [...flow.events],
      unsubscribe: () => flow.subscribers.delete(listener),
    };
  }

  cancel(flowId: string, userId: string): boolean {
    const flow = this.get(flowId, userId);
    if (!flow || flow.terminal) return false;
    flow.abortController.abort(new Error("OAuth sign-in cancelled"));
    return true;
  }

  private async run(flow: OAuthFlow): Promise<void> {
    const timeout = setTimeout(
      () => flow.abortController.abort(new Error("OAuth sign-in expired")),
      this.options.flowTimeoutMs ?? FLOW_TIMEOUT_MS,
    );
    try {
      const runtime = await this.createRuntime();
      if (flow.abortController.signal.aborted) {
        throw abortError(flow.abortController.signal);
      }
      const interaction: AuthInteraction = {
        signal: flow.abortController.signal,
        prompt: (prompt) => this.prompt(flow, prompt),
        notify: (event) => this.emit(flow, { type: "auth", event }),
      };
      const credential = await runtime.login(PROVIDER.piId, "oauth", interaction);
      const models = runtime.getModels(PROVIDER.piId);
      if (models.length === 0)
        throw new Error(`Pi did not provide models for ${PROVIDER.piId}`);
      const connections = await listLlmConnections(this.database, flow.userId);
      const row = await saveOAuthConnections(this.database, this.config, {
        userId: flow.userId,
        displayName: PROVIDER.displayName,
        provider: PROVIDER.piId,
        api: PROVIDER.api,
        baseUrl: PROVIDER.baseUrl,
        models: models.map((model) => ({
          id: model.id,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          thinkingLevels: getSupportedThinkingLevels(model),
        })),
        credential: asOAuthCredential(credential),
        isDefault: connections.length === 0,
      });
      this.emit(flow, { type: "complete", connection: toSummary(row) });
    } catch (error) {
      this.emit(flow, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
      flow.terminal = true;
      setTimeout(
        () => this.flows.delete(flow.id),
        this.options.terminalRetentionMs ?? TERMINAL_RETENTION_MS,
      );
    }
  }

  private createRuntime(): Promise<OAuthRuntime> {
    if (this.options.createRuntime) return this.options.createRuntime();
    return ModelRuntime.create({
      modelsPath: null,
      credentials: new MemoryCredentialStore(),
      allowModelNetwork: false,
    });
  }

  private prompt(_flow: OAuthFlow, prompt: AuthPrompt): Promise<string> {
    if (
      prompt.type === "select" &&
      prompt.options.some((option) => option.id === "device_code")
    ) {
      return Promise.resolve("device_code");
    }
    return Promise.reject(new Error("Codex device authorization requested unsupported input"));
  }

  private emit(flow: OAuthFlow, event: OAuthFlowEvent): void {
    flow.events.push(event);
    if (flow.events.length > 50) flow.events.shift();
    for (const subscriber of flow.subscribers) subscriber(event);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("OAuth prompt cancelled");
}

class MemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.credentials.get(providerId));
    if (next) this.credentials.set(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

function asOAuthCredential(credential: Credential): {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
} {
  if (
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    typeof credential.refresh !== "string" ||
    typeof credential.expires !== "number"
  ) {
    throw new Error("Pi returned a non-OAuth credential");
  }
  return credential;
}
