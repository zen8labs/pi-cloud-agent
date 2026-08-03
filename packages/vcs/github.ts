import { Secret, type VCSProvider, type VcsRepository } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson } from "./http";

const API_BASE = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/**
 * GitHub access is supplied by the connected user's GitHub App user token.
 *
 * The token is limited by both the App permissions and the repositories where
 * the user installed the App. The future secrets broker must replace this
 * direct token handoff with per-operation credentials.
 */
export function createGitHubProvider(accessToken: string): VCSProvider {
  const token = z.string().default("").parse(accessToken);

  return {
    name: "github",

    async getRepository(repoFullName): Promise<VcsRepository | null> {
      const parsed = parseGitHubName(repoFullName);
      if (!parsed) return null;
      if (!token) {
        return {
          provider: "github",
          host: "github.com",
          fullName: repoFullName,
          owner: parsed.owner,
          name: parsed.name,
          cloneUrl: `https://github.com/${repoFullName}.git`,
          defaultBranch: null,
        };
      }
      try {
        const repository = await fetchJson<{ default_branch?: string }>(
          `${API_BASE}/repos/${parsed.owner}/${parsed.name}`,
          { headers: apiHeaders(token) },
        );
        return {
          provider: "github",
          host: "github.com",
          fullName: repoFullName,
          owner: parsed.owner,
          name: parsed.name,
          cloneUrl: `https://github.com/${repoFullName}.git`,
          defaultBranch: repository.default_branch ?? null,
        };
      } catch {
        return null;
      }
    },

    async mintRepoToken(): Promise<Secret> {
      if (!token) throw new Error("GitHub is not connected");
      return new Secret(token, "github app user token");
    },

    async getDefaultBranch(repoFullName): Promise<string | null> {
      const repository = await this.getRepository(repoFullName);
      return repository?.defaultBranch ?? null;
    },

    async listBranches(repoFullName): Promise<string[]> {
      const parsed = parseGitHubName(repoFullName);
      if (!parsed) return [];
      if (!token) return [];
      try {
        const branches = await fetchJson<Array<{ name?: string }>>(
          `${API_BASE}/repos/${parsed.owner}/${parsed.name}/branches?per_page=100`,
          { headers: apiHeaders(token) },
        );
        return branches.flatMap((branch) => (branch.name ? [branch.name] : []));
      } catch {
        return [];
      }
    },

    async listRepos(): Promise<VcsRepository[]> {
      if (!token) return [];
      try {
        return await listGithubRepositories(token);
      } catch {
        return [];
      }
    },
  };
}

async function listGithubRepositories(accessToken: string): Promise<VcsRepository[]> {
  const repositories: VcsRepository[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await fetchJson<GithubRepository[]>(
      `${API_BASE}/user/repos?per_page=100&sort=updated&page=${page}`,
      { headers: apiHeaders(accessToken) },
    );
    repositories.push(...batch.flatMap(toRepository));
    if (batch.length < 100) break;
  }
  return repositories;
}

interface GithubRepository {
  full_name?: string;
  owner?: { login?: string };
  name?: string;
  default_branch?: string;
}

function toRepository(repository: GithubRepository): VcsRepository[] {
  const fullName = repository.full_name;
  const owner = repository.owner?.login;
  const name = repository.name;
  if (!fullName || !owner || !name) return [];
  return [
    {
      provider: "github",
      host: "github.com",
      fullName,
      owner,
      name,
      cloneUrl: `https://github.com/${fullName}.git`,
      defaultBranch: repository.default_branch ?? null,
    },
  ];
}

function parseGitHubName(fullName: string): { owner: string; name: string } | null {
  const parsed = fullName.split("/");
  if (parsed.length !== 2 || !parsed[0] || !parsed[1]) return null;
  return { owner: parsed[0], name: parsed[1] };
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    Accept: ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
  };
}
