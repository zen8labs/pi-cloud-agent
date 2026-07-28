import type {
  BranchesResponse,
  ConfigResponse,
  CreateRunRequest,
  RepoConfigResponse,
  RunDetail,
  RunEvent,
  RunEventsResponse,
  RunListResponse,
  RunSummary,
} from "@pi-cloud-agent/protocol";

/**
 * The controller's HTTP API, typed from the same definitions the controller uses.
 *
 * There are no locally-declared response shapes in this file on purpose: a field
 * the server renames stops compiling here rather than turning into `undefined` on
 * screen.
 */

export const API_BASE =
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
  listRuns: (limit = 100): Promise<RunSummary[]> =>
    request<RunListResponse>(`/runs?limit=${limit}`).then((r) => r.runs),

  getRun: (id: string): Promise<RunDetail> => request<RunDetail>(`/runs/${id}`),

  getEvents: (id: string, afterSeq = 0): Promise<RunEvent[]> =>
    request<RunEventsResponse>(`/runs/${id}/events?afterSeq=${afterSeq}`).then((r) => r.events),

  createRun: (body: CreateRunRequest): Promise<RunSummary> =>
    request<RunSummary>("/runs", { method: "POST", body: JSON.stringify(body) }),

  cancelRun: (id: string): Promise<{ status: string }> =>
    request<{ status: string }>(`/runs/${id}/cancel`, { method: "POST" }),

  getConfig: (): Promise<ConfigResponse> =>
    cached("config", () => request<ConfigResponse>("/config")),

  listRepos: (): Promise<string[]> =>
    cached("repos", () => request<{ repos: string[] }>("/repos").then((r) => r.repos)),

  listBranches: (repo: string): Promise<BranchesResponse> =>
    request<BranchesResponse>(`/repos/${repo}/branches`),

  getRepoConfig: (): Promise<RepoConfigResponse> =>
    request<RepoConfigResponse>("/settings/repo-config"),

  setRepoConfig: (body: {
    repo: string;
    profile: string;
    config: Record<string, unknown>;
  }): Promise<unknown> =>
    request("/settings/repo-config", { method: "PUT", body: JSON.stringify(body) }),
};

export function streamUrl(id: string): string {
  return `${API_BASE}/runs/${id}/stream`;
}
