import {
  type ParsedWebhook,
  type RepoRef,
  Secret,
  type VCSProvider,
  WebhookVerificationError,
} from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson, header, secureEquals, verifyHmacSignature } from "./http";

/**
 * Bitbucket Cloud.
 *
 * Bitbucket has no universal payload signature. Newer workspaces can send an
 * HMAC in `X-Hub-Signature`; otherwise the only option is a shared secret echoed
 * in a header configured on the hook. Both are accepted, HMAC preferred, and
 * neither present is a refusal.
 */

const envSchema = z.object({
  BITBUCKET_TOKEN: z.string().default(""),
  BITBUCKET_WEBHOOK_SECRET: z.string().default(""),
});

const API_BASE = "https://api.bitbucket.org/2.0";

export function createBitbucketProvider(
  env: Readonly<Record<string, string | undefined>>,
): VCSProvider {
  const config = envSchema.parse(env);
  const authHeaders = { Authorization: `Bearer ${config.BITBUCKET_TOKEN}` };

  return {
    name: "bitbucket",

    verifyAndParseWebhook(headers: Headers, body: string): ParsedWebhook {
      verifySecret(headers, body, config.BITBUCKET_WEBHOOK_SECRET);

      let payload: BitbucketWebhookPayload;
      try {
        payload = JSON.parse(body) as BitbucketWebhookPayload;
      } catch (cause) {
        throw new WebhookVerificationError(`webhook body is not JSON: ${String(cause)}`);
      }

      const event = header(headers, "x-event-key");
      if (!payload.repository) return null;

      if (event === "pullrequest:created" || event === "pullrequest:updated") {
        return {
          kind: event === "pullrequest:created" ? "pr_opened" : "pr_updated",
          repo: toRepoRef(payload),
        };
      }
      if (event === "pullrequest:comment_created") {
        return {
          kind: "pr_comment",
          repo: toRepoRef(payload),
          command: payload.comment?.content?.raw,
        };
      }
      return null;
    },

    async mintRepoToken(): Promise<Secret> {
      if (!config.BITBUCKET_TOKEN) throw new Error("BITBUCKET_TOKEN is not configured");
      return new Secret(config.BITBUCKET_TOKEN, "bitbucket token");
    },

    async resolvePullRequest(repo: RepoRef, prNumber: number): Promise<RepoRef> {
      const pull = await fetchJson<{
        source?: { commit?: { hash?: string }; branch?: { name?: string } };
        destination?: { commit?: { hash?: string } };
      }>(`${API_BASE}/repositories/${repo.owner}/${repo.name}/pullrequests/${prNumber}`, {
        headers: authHeaders,
      });
      return {
        ...repo,
        baseSha: pull.destination?.commit?.hash ?? repo.baseSha,
        headSha: pull.source?.commit?.hash ?? repo.headSha,
        headBranch: pull.source?.branch?.name ?? repo.headBranch,
        prNumber,
      };
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

function verifySecret(headers: Headers, body: string, secret: string): void {
  if (!secret) {
    throw new WebhookVerificationError("BITBUCKET_WEBHOOK_SECRET is not configured");
  }
  const signature = header(headers, "x-hub-signature");
  if (signature) {
    verifyHmacSignature({
      secret,
      signature,
      body,
      prefix: "sha256=",
      headerName: "X-Hub-Signature",
    });
    return;
  }
  const shared = header(headers, "x-hook-secret");
  if (!shared || !secureEquals(shared, secret)) {
    throw new WebhookVerificationError("invalid X-Hook-Secret");
  }
}

interface BitbucketWebhookPayload {
  repository?: { full_name?: string; mainbranch?: { name?: string } };
  pullrequest?: {
    id?: number;
    source?: { commit?: { hash?: string }; branch?: { name?: string } };
    destination?: { commit?: { hash?: string } };
  };
  comment?: { content?: { raw?: string } };
}

function toRepoRef(payload: BitbucketWebhookPayload): RepoRef {
  const fullName = payload.repository?.full_name ?? "";
  const separator = fullName.indexOf("/");
  const owner = separator > 0 ? fullName.slice(0, separator) : "";
  const name = separator > 0 ? fullName.slice(separator + 1) : fullName;
  const pull = payload.pullrequest;
  return {
    provider: "bitbucket",
    host: "bitbucket.org",
    owner,
    name,
    cloneUrl: `https://bitbucket.org/${fullName}.git`,
    defaultBranch: payload.repository?.mainbranch?.name ?? "main",
    baseSha: pull?.destination?.commit?.hash ?? "",
    headSha: pull?.source?.commit?.hash ?? "",
    headBranch: pull?.source?.branch?.name ?? "",
    prNumber: pull?.id ?? null,
  };
}
