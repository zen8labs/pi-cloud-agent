import { Secret, type VCSProvider } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson } from "./http";

/**
 * GitLab, self-managed or gitlab.com.
 *
 * The token is a long-lived PAT rather than something mintable, which is a real
 * downgrade from the GitHub App path: it is neither short-lived nor
 * repo-scoped. Worth knowing when deciding what to point at a sandbox.
 */

const envSchema = z.object({
  GITLAB_URL: z.string().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().default(""),
});

export function createGitLabProvider(
  env: Readonly<Record<string, string | undefined>>,
): VCSProvider {
  const config = envSchema.parse(env);
  const baseUrl = config.GITLAB_URL.replace(/\/$/, "");
  const apiBase = `${baseUrl}/api/v4`;
  const authHeaders = { Authorization: `Bearer ${config.GITLAB_TOKEN}` };

  const projectPath = (fullName: string) => encodeURIComponent(fullName);

  return {
    name: "gitlab",

    async mintRepoToken(): Promise<Secret> {
      if (!config.GITLAB_TOKEN) throw new Error("GITLAB_TOKEN is not configured");
      return new Secret(config.GITLAB_TOKEN, "gitlab token");
    },

    async getDefaultBranch(repoFullName: string): Promise<string | null> {
      try {
        const project = await fetchJson<{ default_branch?: string }>(
          `${apiBase}/projects/${projectPath(repoFullName)}`,
          { headers: authHeaders },
        );
        return project.default_branch ?? null;
      } catch {
        return null;
      }
    },

    async listBranches(repoFullName: string): Promise<string[]> {
      try {
        const branches = await fetchJson<Array<{ name: string }>>(
          `${apiBase}/projects/${projectPath(repoFullName)}/repository/branches?per_page=100`,
          { headers: authHeaders },
        );
        return branches.map((branch) => branch.name);
      } catch {
        return [];
      }
    },

    async listRepos(): Promise<string[]> {
      try {
        const projects = await fetchJson<Array<{ path_with_namespace: string }>>(
          `${apiBase}/projects?membership=true&per_page=100&order_by=last_activity_at`,
          { headers: authHeaders },
        );
        return projects.map((project) => project.path_with_namespace).sort();
      } catch {
        return [];
      }
    },
  };
}
