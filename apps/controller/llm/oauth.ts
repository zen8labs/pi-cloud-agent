import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LlmApi, LlmConnectionSummary } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { listLlmConnections } from "../db/llm-connections";
import { saveOAuthConnections, toSummary } from "./connections";

export type OAuthProvider = "chatgpt" | "claude";

const PROVIDERS: Record<
  OAuthProvider,
  { piId: string; displayName: string; api: LlmApi; baseUrl: string }
> = {
  chatgpt: {
    piId: "openai-codex",
    displayName: "ChatGPT plan (Codex)",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  },
  claude: {
    piId: "anthropic",
    displayName: "Claude plan",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
};

export type OAuthFlowEvent =
  | { type: "auth"; event: AuthEvent }
  | { type: "prompt"; prompt: OauthPrompt }
  | { type: "complete"; connection: LlmConnectionSummary }
  | { type: "error"; message: string };

type OauthPrompt = Omit<AuthPrompt, "signal">;

interface OAuthFlow {
  id: string;
  userId: string;
  provider: OAuthProvider;
  events: OAuthFlowEvent[];
  subscribers: Set<(event: OAuthFlowEvent) => void>;
  pendingPrompt: ((value: string) => void) | null;
  terminal: boolean;
}

export class OAuthFlowManager {
  private readonly flows = new Map<string, OAuthFlow>();

  constructor(
    private readonly database: Database,
    private readonly config: Config,
  ) {}

  start(userId: string, provider: OAuthProvider): string {
    const flow: OAuthFlow = {
      id: randomUUID(),
      userId,
      provider,
      events: [],
      subscribers: new Set(),
      pendingPrompt: null,
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

  submit(flowId: string, userId: string, value: string): boolean {
    const flow = this.get(flowId, userId);
    if (!flow?.pendingPrompt) return false;
    const resolve = flow.pendingPrompt;
    flow.pendingPrompt = null;
    resolve(value);
    return true;
  }

  private async run(flow: OAuthFlow): Promise<void> {
    try {
      const provider = PROVIDERS[flow.provider];
      const runtime = await ModelRuntime.create({
        modelsPath: null,
        credentials: new MemoryCredentialStore(),
        allowModelNetwork: false,
      });
      const interaction: AuthInteraction = {
        prompt: (prompt) => this.prompt(flow, prompt),
        notify: (event) => this.emit(flow, { type: "auth", event }),
      };
      const credential = await runtime.login(provider.piId, "oauth", interaction);
      const models = runtime.getModels(provider.piId);
      if (models.length === 0)
        throw new Error(`Pi did not provide models for ${provider.piId}`);
      const connections = await listLlmConnections(this.database, flow.userId);
      const row = await saveOAuthConnections(this.database, this.config, {
        userId: flow.userId,
        displayName: provider.displayName,
        provider: provider.piId,
        api: provider.api,
        baseUrl: provider.baseUrl,
        models,
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
      flow.terminal = true;
      flow.pendingPrompt = null;
      setTimeout(() => this.flows.delete(flow.id), 5 * 60_000);
    }
  }

  private prompt(flow: OAuthFlow, prompt: AuthPrompt): Promise<string> {
    if (
      flow.provider === "chatgpt" &&
      prompt.type === "select" &&
      prompt.options.some((option) => option.id === "browser")
    ) {
      // Pi exposes browser/device-code selection for its CLI. The web button
      // already means browser login, so do not make the user answer a second
      // prompt while the pre-opened tab is still blank.
      return Promise.resolve("browser");
    }
    return new Promise((resolve, reject) => {
      if (flow.pendingPrompt) {
        reject(new Error("OAuth provider requested overlapping prompts"));
        return;
      }
      flow.pendingPrompt = resolve;
      const { signal, ...publicPrompt } = prompt;
      this.emit(flow, { type: "prompt", prompt: publicPrompt });
      signal?.addEventListener("abort", () => reject(new Error("OAuth prompt cancelled")), {
        once: true,
      });
    });
  }

  private emit(flow: OAuthFlow, event: OAuthFlowEvent): void {
    flow.events.push(event);
    if (flow.events.length > 50) flow.events.shift();
    for (const subscriber of flow.subscribers) subscriber(event);
  }
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

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value in PROVIDERS;
}

export function oauthProviderNames(): OAuthProvider[] {
  return Object.keys(PROVIDERS) as OAuthProvider[];
}
