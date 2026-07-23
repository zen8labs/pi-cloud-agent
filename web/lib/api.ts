import type { AgentEvent, AppConfig, ModelOption, RepoBranch, RepoTriggers, RunDetail, RunSummary } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8080";

// Module-level TTL cache for slow/rarely-changing endpoints (repo list, config).
// Survives component remounts; clears automatically after TTL_MS.
// Permission/repo changes are reflected within TTL_MS without a page reload.
const _cache = new Map<string, { data: unknown; ts: number }>();
const TTL_MS = 2 * 60 * 1000; // 2 minutes

function withCache<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < TTL_MS) return Promise.resolve(entry.data as T);
  return fetch().then((data) => {
    _cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listRuns: (limit = 100) =>
    req<{ runs: RunSummary[] }>(`/runs?limit=${limit}`).then((r) => r.runs),

  getRun: (id: string) => req<RunDetail>(`/runs/${id}`),

  getEvents: (id: string, afterSeq = -1) =>
    req<{ events: AgentEvent[] }>(`/runs/${id}/events?after_seq=${afterSeq}`).then(
      (r) => r.events,
    ),

  cancelRun: (id: string) =>
    req<{ ok: boolean; status: string }>(`/runs/${id}/cancel`, { method: "POST" }),

  createRun: (body: {
    repo: string;
    prompt: string;
    profile?: string;
    branch?: string | null;
    pr_number?: number | null;
    model?: string | null;
  }) => req<RunSummary>(`/runs`, { method: "POST", body: JSON.stringify(body) }),

  listRepos: () =>
    withCache("repos", () => req<{ repos: string[] }>(`/repos`).then((r) => r.repos)),

  listBranches: (repo: string) =>
    req<{ branches: string[]; default: string | null }>(
      `/repos/${repo}/branches`,
    ),

  getConfig: () => withCache("config", () => req<AppConfig>(`/config`)),

  getDefaultModel: () =>
    req<{ model: string; available_models: ModelOption[] }>(`/settings/default-model`),

  setDefaultModel: (model: string) =>
    req<{ model: string }>(`/settings/default-model`, {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),

  listRepoBranches: () =>
    req<{ source: string; repos: RepoBranch[] }>(`/settings/repo-branches`).then(
      (r) => r.repos,
    ),

  setRepoBranch: (repo: string, branch: string) =>
    req<{ repo: string; branch: string }>(`/settings/repo-branches`, {
      method: "PUT",
      body: JSON.stringify({ repo, branch }),
    }),

  setRepoTriggers: (repo: string, triggers: RepoTriggers) =>
    req<{ repo: string; triggers: RepoTriggers }>(`/settings/repo-triggers`, {
      method: "PUT",
      body: JSON.stringify({ repo, ...triggers }),
    }),
};

export function streamUrl(id: string): string {
  return `${API_BASE}/runs/${id}/stream`;
}
