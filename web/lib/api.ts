import type { AgentEvent, AppConfig, RepoBranch, RunDetail, RunSummary } from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8080";

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
    bundle?: string;
    branch?: string | null;
    pr_number?: number | null;
  }) => req<RunSummary>(`/runs`, { method: "POST", body: JSON.stringify(body) }),

  listRepos: () => req<{ repos: string[] }>(`/repos`).then((r) => r.repos),

  listBranches: (repo: string) =>
    req<{ branches: string[]; default: string | null }>(
      `/repos/${repo}/branches`,
    ),

  getConfig: () => req<AppConfig>(`/config`),

  listRepoBranches: () =>
    req<{ source: string; repos: RepoBranch[] }>(`/settings/repo-branches`).then(
      (r) => r.repos,
    ),

  setRepoBranch: (repo: string, branch: string) =>
    req<{ repo: string; branch: string }>(`/settings/repo-branches`, {
      method: "PUT",
      body: JSON.stringify({ repo, branch }),
    }),
};

export function streamUrl(id: string): string {
  return `${API_BASE}/runs/${id}/stream`;
}
