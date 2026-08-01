import { Secret, type VCSProvider } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson } from "./http";

/**
 * Bitbucket Cloud.
 *
 * The token is a long-lived PAT rather than something mintable: neither
 * short-lived nor repo-scoped, the same downgrade from the GitHub App path as
 * GitLab. Worth knowing when deciding what to point at a sandbox.
 */

const envSchema = z.object({
  BITBUCKET_TOKEN: z.string().default(""),
});

const API_BASE = "https://api.bitbucket.org/2.0";

export function createBitbucketProvider(
  env: Readonly<Record<string, string | undefined>>,
): VCSProvider {
  const config = envSchema.parse(env);
  const authHeaders = { Authorization: `Bearer ${config.BITBUCKET_TOKEN}` };

  return {
    name: "bitbucket",

    async mintRepoToken(): Promise<Secret> {
      if (!config.BITBUCKET_TOKEN) throw new Error("BITBUCKET_TOKEN is not configured");
      return new Secret(config.BITBUCKET_TOKEN, "bitbucket token");
    },

    async getDefaultBranch(repoFullName: string): Promise<string | null> {
      try {
        const repo = await fetchJson<{ mainbranch?: { name?: string } }>(
          `${API_BASE}/repositories/${repoFullName}`,
          { headers: authHeaders },
        );
        return repo.mainbranch?.name ?? null;
      } catch {
        return null;
      }
    },

    async listBranches(repoFullName: string): Promise<string[]> {
      try {
        const page = await fetchJson<{ values?: Array<{ name: string }> }>(
          `${API_BASE}/repositories/${repoFullName}/refs/branches?pagelen=100`,
          { headers: authHeaders },
        );
        return (page.values ?? []).map((branch) => branch.name);
      } catch {
        return [];
      }
    },

    async listRepos(): Promise<string[]> {
      try {
        const page = await fetchJson<{ values?: Array<{ full_name: string }> }>(
          `${API_BASE}/repositories?role=member&pagelen=100`,
          { headers: authHeaders },
        );
        return (page.values ?? []).map((repo) => repo.full_name).sort();
      } catch {
        return [];
      }
    },
  };
}
