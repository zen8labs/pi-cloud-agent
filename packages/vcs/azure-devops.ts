import { Secret, type VCSProvider, type VcsRepository } from "@pi-cloud-agent/protocol";
import { fetchJson } from "./http";

const PROFILE_API = "https://app.vssps.visualstudio.com";

/**
 * Azure DevOps Services through a Microsoft Entra delegated token.
 *
 * Repository names use organization/project/repository so the controller never
 * has to guess which Azure project owns a repository.
 */
export function createAzureDevOpsProvider(accessToken: string): VCSProvider {
  return {
    name: "azure-devops",

    async getRepository(repoFullName): Promise<VcsRepository | null> {
      const parsed = parseAzureName(repoFullName);
      if (!parsed) return null;
      if (!accessToken) {
        return toRepository(parsed.organization, {
          name: parsed.name,
          project: { name: parsed.project },
        });
      }
      const url =
        apiBase(parsed.organization) +
        "/" +
        encodeURIComponent(parsed.project) +
        "/_apis/git/repositories/" +
        encodeURIComponent(parsed.name) +
        "?api-version=7.1";
      try {
        const repository = await fetchJson<AzureRepository>(url, {
          headers: bearerHeaders(accessToken),
        });
        return toRepository(parsed.organization, repository);
      } catch {
        return null;
      }
    },

    async mintRepoToken(): Promise<Secret> {
      if (!accessToken) throw new Error("Azure DevOps is not connected");
      return new Secret(accessToken, "azure devops oauth token");
    },

    async getDefaultBranch(repoFullName): Promise<string | null> {
      const repository = await this.getRepository(repoFullName);
      return repository?.defaultBranch ?? null;
    },

    async listBranches(repoFullName): Promise<string[]> {
      const parsed = parseAzureName(repoFullName);
      if (!parsed) return [];
      const url =
        apiBase(parsed.organization) +
        "/" +
        encodeURIComponent(parsed.project) +
        "/_apis/git/repositories/" +
        encodeURIComponent(parsed.name) +
        "/refs?filter=heads/&api-version=7.1";
      try {
        const response = await fetchJson<{ value?: Array<{ name?: string }> }>(url, {
          headers: bearerHeaders(accessToken),
        });
        return (response.value ?? []).flatMap((branch) => {
          const name = branch.name?.replace(/^refs\/heads\//, "");
          return name ? [name] : [];
        });
      } catch {
        return [];
      }
    },

    async listRepos(): Promise<VcsRepository[]> {
      if (!accessToken) return [];
      try {
        const profile = await fetchJson<{ id?: string }>(
          `${PROFILE_API}/_apis/profile/profiles/me?api-version=7.1-preview.3`,
          { headers: bearerHeaders(accessToken) },
        );
        if (!profile.id) return [];
        const accounts = await fetchJson<{ value?: Array<{ accountName?: string }> }>(
          `${PROFILE_API}/_apis/accounts?memberId=${encodeURIComponent(profile.id)}&api-version=7.1`,
          { headers: bearerHeaders(accessToken) },
        );
        return listAccountRepositories(accounts.value ?? [], accessToken);
      } catch {
        return [];
      }
    },
  };
}

async function listAccountRepositories(
  accounts: Array<{ accountName?: string }>,
  accessToken: string,
): Promise<VcsRepository[]> {
  const repositories: VcsRepository[] = [];
  for (const account of accounts) {
    const organization = account.accountName;
    if (!organization) continue;
    const response = await fetchJson<{ value?: AzureRepository[] }>(
      `${apiBase(organization)}/_apis/git/repositories?api-version=7.1`,
      { headers: bearerHeaders(accessToken) },
    );
    repositories.push(
      ...(response.value ?? []).map((repository) => toRepository(organization, repository)),
    );
  }
  return repositories.filter((repository) => repository.fullName !== "");
}

interface AzureRepository {
  name?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  project?: { name?: string };
}

function toRepository(organization: string, repository: AzureRepository): VcsRepository {
  const project = repository.project?.name ?? "";
  const name = repository.name ?? "";
  const fullName = [organization, project, name].filter(Boolean).join("/");
  return {
    provider: "azure-devops",
    host: `dev.azure.com/${organization}`,
    fullName,
    owner: `${organization}/${project}`,
    name,
    cloneUrl:
      repository.remoteUrl ??
      "https://dev.azure.com/" +
        organization +
        "/" +
        encodeURIComponent(project) +
        "/_git/" +
        encodeURIComponent(name),
    defaultBranch: repository.defaultBranch?.replace(/^refs\/heads\//, "") ?? null,
  };
}

function parseAzureName(
  fullName: string,
): { organization: string; project: string; name: string } | null {
  const parts = fullName.split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { organization: parts[0], project: parts[1], name: parts[2] };
}

function apiBase(organization: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}`;
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}
