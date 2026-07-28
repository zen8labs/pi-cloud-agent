import {
  type ParsedWebhook,
  type RepoRef,
  Secret,
  type VCSProvider,
  WebhookVerificationError,
} from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson, header, secureEquals } from "./http";

/**
 * GitLab, self-managed or gitlab.com.
 *
 * GitLab does not sign webhook payloads; it echoes a shared secret in
 * `X-Gitlab-Token`. That is weaker than an HMAC — it cannot detect a modified
 * body — so it is compared in constant time and refused when unset.
 *
 * The token is a long-lived PAT rather than something mintable, which is a real
 * downgrade from the GitHub App path: it is neither short-lived nor
 * repo-scoped. Worth knowing when deciding what to point at a sandbox.
 */

const envSchema = z.object({
  GITLAB_URL: z.string().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().default(""),
  GITLAB_WEBHOOK_SECRET: z.string().default(""),
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

    verifyAndParseWebhook(headers: Headers, body: string): ParsedWebhook {
      const token = header(headers, "x-gitlab-token");
      if (!config.GITLAB_WEBHOOK_SECRET) {
        throw new WebhookVerificationError("GITLAB_WEBHOOK_SECRET is not configured");
      }
      if (!token || !secureEquals(token, config.GITLAB_WEBHOOK_SECRET)) {
        throw new WebhookVerificationError("invalid X-Gitlab-Token");
      }

      let payload: GitLabWebhookPayload;
      try {
        payload = JSON.parse(body) as GitLabWebhookPayload;
      } catch (cause) {
        throw new WebhookVerificationError(`webhook body is not JSON: ${String(cause)}`);
      }

      if (payload.object_kind === "merge_request") return parseMergeRequest(payload, baseUrl);
      if (payload.object_kind === "note") return parseNote(payload, baseUrl);
      return null;
    },

    async mintRepoToken(): Promise<Secret> {
      if (!config.GITLAB_TOKEN) throw new Error("GITLAB_TOKEN is not configured");
      return new Secret(config.GITLAB_TOKEN, "gitlab token");
    },

    async resolvePullRequest(repo: RepoRef, prNumber: number): Promise<RepoRef> {
      const merge = await fetchJson<{
        diff_refs?: { base_sha?: string; head_sha?: string };
        sha?: string;
        source_branch?: string;
      }>(
        `${apiBase}/projects/${projectPath(`${repo.owner}/${repo.name}`)}/merge_requests/${prNumber}`,
        {
          headers: authHeaders,
        },
      );
      return {
        ...repo,
        baseSha: merge.diff_refs?.base_sha ?? repo.baseSha,
        headSha: merge.diff_refs?.head_sha ?? merge.sha ?? repo.headSha,
        headBranch: merge.source_branch ?? repo.headBranch,
        prNumber,
      };
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

interface GitLabProject {
  path_with_namespace?: string;
  web_url?: string;
  git_http_url?: string;
  default_branch?: string;
}

interface GitLabMergeRequest {
  action?: string;
  oldrev?: string;
  iid?: number;
  source_branch?: string;
  last_commit?: { id?: string };
  base_commit_sha?: string;
}

interface GitLabWebhookPayload {
  object_kind?: string;
  project?: GitLabProject;
  object_attributes?: GitLabMergeRequest & { note?: string };
  merge_request?: GitLabMergeRequest;
}

function parseMergeRequest(payload: GitLabWebhookPayload, baseUrl: string): ParsedWebhook {
  const attributes = payload.object_attributes;
  if (!attributes || !payload.project) return null;
  // `update` fires for label and description edits too; only a changed `oldrev`
  // means new commits landed.
  const kind =
    attributes.action === "open" || attributes.action === "reopen"
      ? "pr_opened"
      : attributes.action === "update" && attributes.oldrev
        ? "pr_updated"
        : null;
  if (!kind) return null;
  return { kind, repo: toRepoRef(payload.project, attributes, baseUrl) };
}

function parseNote(payload: GitLabWebhookPayload, baseUrl: string): ParsedWebhook {
  if (!payload.merge_request || !payload.project) return null;
  return {
    kind: "pr_comment",
    repo: toRepoRef(payload.project, payload.merge_request, baseUrl),
    command: payload.object_attributes?.note,
  };
}

function toRepoRef(
  project: GitLabProject,
  merge: GitLabMergeRequest,
  baseUrl: string,
): RepoRef {
  const pathWithNamespace = project.path_with_namespace ?? "";
  const separator = pathWithNamespace.lastIndexOf("/");
  const owner = separator > 0 ? pathWithNamespace.slice(0, separator) : "";
  const name = separator > 0 ? pathWithNamespace.slice(separator + 1) : pathWithNamespace;
  let host = "gitlab.com";
  try {
    host = new URL(project.web_url ?? baseUrl).host;
  } catch {
    // Keep the default; a malformed web_url should not drop the event.
  }
  return {
    provider: "gitlab",
    host,
    owner,
    name,
    cloneUrl: project.git_http_url ?? `https://${host}/${pathWithNamespace}.git`,
    defaultBranch: project.default_branch ?? "main",
    baseSha: merge.base_commit_sha ?? "",
    headSha: merge.last_commit?.id ?? "",
    headBranch: merge.source_branch ?? "",
    prNumber: merge.iid ?? null,
  };
}
