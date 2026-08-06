import type {
  AppUserSummary,
  BranchesResponse,
  ConfigResponse,
  CreateLlmConnectionRequest,
  CreateRunRequest,
  CreateSessionTurnRequest,
  LlmConnectionSummary,
  LlmConnectionsResponse,
  RunDetail,
  RunEvent,
  RunEventsResponse,
  RunListResponse,
  RunSummary,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  VcsConnectionSummary,
  VcsConnectionsResponse,
  VcsRepository,
} from "@pi-cloud-agent/protocol";

export type LlmOAuthEvent =
  | {
      type: "auth";
      event: {
        type: "auth_url" | "device_code";
        url?: string;
        verificationUri?: string;
        userCode?: string;
        instructions?: string;
      };
    }
  | {
      type: "prompt";
      prompt: {
        type: string;
        message: string;
        placeholder?: string;
        options?: Array<{ id: string; label: string }>;
      };
    }
  | { type: "complete"; connection: LlmConnectionSummary }
  | { type: "error"; message: string };

/**
 * The controller's HTTP API, typed from the same definitions the controller uses.
 *
 * There are no locally-declared response shapes in this file on purpose: a field
 * the server renames stops compiling here rather than turning into `undefined` on
 * screen.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8080";

/**
 * Short-lived cache for the slow, rarely-changing lookups (the repo list has to
 * ask the forge). Two minutes is long enough to keep navigation snappy and short
 * enough that a permissions change shows up without a reload.
 */
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { data: unknown; at: number }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data as T);
  return load().then((data) => {
    cache.set(key, { data, at: Date.now() });
    return data;
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    let detail: string = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ?? JSON.stringify(body);
    } catch {
      // Keep the status text; a non-JSON error body is not worth surfacing raw.
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

export const api = {
  getCurrentUser: (): Promise<AppUserSummary> => request<AppUserSummary>("/auth/me"),

  loginUrl: (): string => `${API_BASE}/auth/github/connect`,

  logout: (): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  listRuns: (limit = 100): Promise<RunSummary[]> =>
    request<RunListResponse>(`/runs?limit=${limit}`).then((r) => r.runs),

  getRun: (id: string): Promise<RunDetail> => request<RunDetail>(`/runs/${id}`),

  getEvents: (id: string, afterSeq = 0): Promise<RunEvent[]> =>
    request<RunEventsResponse>(`/runs/${id}/events?afterSeq=${afterSeq}`).then((r) => r.events),

  createRun: (body: CreateRunRequest): Promise<RunSummary> =>
    request<RunSummary>("/runs", { method: "POST", body: JSON.stringify(body) }),

  listSessions: (limit = 100): Promise<SessionSummary[]> =>
    request<SessionListResponse>(`/sessions?limit=${limit}`).then((r) => r.sessions),

  getSession: (id: string): Promise<SessionDetail> => request<SessionDetail>(`/sessions/${id}`),

  createSession: (body: CreateRunRequest): Promise<SessionSummary> =>
    request<SessionSummary>("/sessions", { method: "POST", body: JSON.stringify(body) }),

  createSessionTurn: (id: string, body: CreateSessionTurnRequest): Promise<RunDetail> =>
    request<RunDetail>(`/sessions/${id}/turns`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  cancelRun: (id: string): Promise<{ status: string }> =>
    request<{ status: string }>(`/runs/${id}/cancel`, { method: "POST" }),

  getConfig: (): Promise<ConfigResponse> =>
    cached("config", () => request<ConfigResponse>("/config")),

  listRepos: (): Promise<VcsRepository[]> =>
    cached("repos", () => request<{ repos: VcsRepository[] }>("/repos").then((r) => r.repos)),

  listBranches: (provider: string, repo: string): Promise<BranchesResponse> =>
    request<BranchesResponse>(
      `/repos/branches?provider=${encodeURIComponent(provider)}&repo=${encodeURIComponent(repo)}`,
    ),

  listConnections: (): Promise<VcsConnectionSummary[]> =>
    request<VcsConnectionsResponse>("/vcs/connections").then((r) => r.connections),

  deleteConnection: (provider: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/vcs/connections/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    }),

  connectUrl: (provider: string): string =>
    provider === "github"
      ? `${API_BASE}/auth/github/connect?returnTo=settings`
      : `${API_BASE}/vcs/connections/${encodeURIComponent(provider)}/connect`,

  listLlmConnections: (): Promise<LlmConnectionSummary[]> =>
    request<LlmConnectionsResponse>("/llm/connections").then((r) => r.connections),

  createLlmConnection: (body: CreateLlmConnectionRequest): Promise<LlmConnectionSummary> =>
    request<LlmConnectionSummary>("/llm/connections", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  testLlmConnection: (body: CreateLlmConnectionRequest): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>("/llm/connections/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setDefaultLlmConnection: (id: string, modelId: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(
      `/llm/connections/${encodeURIComponent(id)}/default?modelId=${encodeURIComponent(modelId)}`,
      { method: "POST" },
    ),

  deleteLlmConnection: (id: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/llm/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  startLlmOAuth: (
    provider: "chatgpt" | "claude",
  ): Promise<{ flowId: string; eventsUrl: string }> =>
    request<{ flowId: string; eventsUrl: string }>(`/llm/connections/oauth/${provider}/start`, {
      method: "POST",
    }),

  submitLlmOAuthInput: (flowId: string, value: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/llm/oauth/${encodeURIComponent(flowId)}/input`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),

  streamLlmOAuth: async (
    eventsUrl: string,
    onEvent: (event: LlmOAuthEvent) => void,
  ): Promise<void> => {
    const response = await fetch(`${API_BASE}${eventsUrl}`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok || !response.body)
      throw new Error(`OAuth stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() ?? "";
      for (const message of messages) {
        const line = message.split("\n").find((entry) => entry.startsWith("data: "));
        if (line) onEvent(JSON.parse(line.slice(6)) as LlmOAuthEvent);
      }
      if (done) return;
    }
  },
};

export function streamUrl(id: string): string {
  return `${API_BASE}/runs/${id}/stream`;
}
