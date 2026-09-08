import { createPrivateKey, createSign } from "node:crypto";
import {
  type GithubReviewComment,
  Secret,
  type VCSProvider,
  type VcsRepository,
} from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson } from "./http";

const API_BASE = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

export interface GithubInstallation {
  id: string;
  appId: string;
  accountId: string;
  accountLogin: string;
}

export interface GithubReviewPublisher {
  submitReview(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    body: string;
    comments: GithubReviewComment[];
  }): Promise<{ id: string }>;
}

export interface GithubCommentPublisher {
  submitComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    commentId: string;
    replyKind: "issue_comment" | "review_comment";
    body: string;
  }): Promise<{ id: string }>;
}

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
}

export interface GithubPullRequestRevision {
  baseSha: string;
  headSha: string;
  headBranch: string;
  defaultBranch: string;
  cloneUrl: string;
  baseCloneUrl: string;
}

/** GitHub metadata and checkout access supplied by the connected user's token. */
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

/** Verify an App installation belongs to the connected GitHub identity. */
export async function verifyGithubInstallation(
  accessToken: string,
  installationId: string,
  expectedAppId?: string,
): Promise<GithubInstallation | null> {
  const parsed = await fetchJson<{
    installations?: Array<{
      id?: number;
      app_id?: number;
      account?: { id?: number; login?: string };
    }>;
  }>(`${API_BASE}/user/installations?per_page=100`, {
    headers: apiHeaders(accessToken),
  });
  const installation = parsed.installations?.find(
    (candidate) => String(candidate.id) === installationId,
  );
  if (
    !installation?.id ||
    !installation.app_id ||
    !installation.account?.id ||
    !installation.account.login ||
    (expectedAppId !== undefined && String(installation.app_id) !== expectedAppId)
  )
    return null;
  return {
    id: String(installation.id),
    appId: String(installation.app_id),
    accountId: String(installation.account.id),
    accountLogin: installation.account.login,
  };
}

/** Trusted controller actuator for one structured pull-request review. */
export function createGithubReviewPublisher(accessToken: string): GithubReviewPublisher {
  const token = z.string().min(1).parse(accessToken);
  return {
    async submitReview(input) {
      const response = await fetchJson<{ id?: number }>(
        `${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/reviews`,
        {
          method: "POST",
          headers: { ...apiHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify({
            body: input.body,
            event: "COMMENT",
            commit_id: input.commitId,
            comments: input.comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side,
              start_line: comment.startLine,
              start_side: comment.startSide,
              body: comment.body,
            })),
          }),
        },
      );
      if (!response.id) throw new Error("GitHub review response is missing its id");
      return { id: String(response.id) };
    },
  };
}

/** Trusted controller actuator for a reply to the triggering GitHub comment. */
export function createGithubCommentPublisher(accessToken: string): GithubCommentPublisher {
  const token = z.string().min(1).parse(accessToken);
  return {
    async submitComment(input) {
      const path =
        input.replyKind === "review_comment"
          ? `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.issueNumber}/comments/${encodeURIComponent(input.commentId)}/replies`
          : `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
      const response = await fetchJson<{ id?: number }>(`${API_BASE}${path}`, {
        method: "POST",
        headers: { ...apiHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: input.body }),
      });
      if (!response.id) throw new Error("GitHub comment response is missing its id");
      return { id: String(response.id) };
    },
  };
}

/** Mint a short-lived installation token without exposing App credentials to a sandbox. */
export async function createGithubInstallationToken(
  credentials: GithubAppCredentials,
  installationId: string,
): Promise<{ token: string; expiresAt: string | null }> {
  const appId = z.string().min(1).parse(credentials.appId);
  const privateKey = z.string().min(1).parse(credentials.privateKey);
  const jwt = signGithubAppJwt(appId, privateKey);
  const response = await fetchJson<{ token?: string; expires_at?: string }>(
    `${API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: { ...apiHeaders(jwt), Authorization: `Bearer ${jwt}` },
    },
  );
  if (!response.token)
    throw new Error("GitHub installation token response is missing its token");
  return { token: response.token, expiresAt: response.expires_at ?? null };
}

/** Fetch the immutable checkout coordinates for a PR event that omits them. */
export async function fetchGithubPullRequestRevision(
  accessToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<GithubPullRequestRevision> {
  const response = await fetchJson<{
    base?: { ref?: string; sha?: string; repo?: { clone_url?: string } };
    head?: { ref?: string; sha?: string; repo?: { clone_url?: string } };
  }>(
    `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    { headers: apiHeaders(accessToken) },
  );
  const baseSha = response.base?.sha;
  const headSha = response.head?.sha;
  const headBranch = response.head?.ref;
  const cloneUrl = response.head?.repo?.clone_url;
  if (!baseSha || !headSha || !headBranch) {
    throw new Error("GitHub pull request response is missing revision information");
  }
  return {
    baseSha,
    headSha,
    headBranch,
    defaultBranch: response.base?.ref ?? "main",
    cloneUrl: cloneUrl ?? `https://github.com/${owner}/${repo}.git`,
    baseCloneUrl: response.base?.repo?.clone_url ?? `https://github.com/${owner}/${repo}.git`,
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

export function signGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
