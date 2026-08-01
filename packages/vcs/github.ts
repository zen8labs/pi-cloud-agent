import { createSign } from "node:crypto";
import { Secret, type VCSProvider } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { fetchJson } from "./http";

/**
 * GitHub, including Enterprise via GITHUB_API_BASE.
 *
 * Authentication prefers a GitHub App installation token, because it is the only
 * option that is both short-lived and scoped to a single repository — the two
 * properties that make handing a write credential to a sandbox defensible. A PAT
 * is accepted as a fallback so a local setup works without registering an App,
 * and it is strictly worse: broad and long-lived.
 */

const envSchema = z.object({
  GITHUB_API_BASE: z.string().default("https://api.github.com"),
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_TOKEN: z.string().default(""),
});

const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
/** Refresh a little before expiry so a long clone can't straddle the boundary. */
const TOKEN_REFRESH_SLACK_MS = 300_000;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export function createGitHubProvider(
  env: Readonly<Record<string, string | undefined>>,
): VCSProvider {
  const config = envSchema.parse(env);
  const apiBase = config.GITHUB_API_BASE.replace(/\/$/, "");
  const tokenCache = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<CachedToken>>();

  const hasApp = config.GITHUB_APP_ID !== "" && config.GITHUB_APP_PRIVATE_KEY !== "";

  function appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    // iat is backdated for clock skew; GitHub rejects an exp more than 10
    // minutes out, so 9 leaves room.
    return signRs256(
      { iat: now - 60, exp: now + 540, iss: config.GITHUB_APP_ID },
      normalizePem(config.GITHUB_APP_PRIVATE_KEY),
    );
  }

  function jwtHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${appJwt()}`,
      Accept: ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  async function mintInstallationToken(repoFullName: string): Promise<CachedToken> {
    const [owner, name] = repoFullName.split("/");
    const installation = await fetchJson<{ id: number }>(
      `${apiBase}/repos/${owner}/${name}/installation`,
      { headers: jwtHeaders() },
    ).catch((cause) => {
      throw new Error(
        `GitHub App is not installed on ${repoFullName}, or cannot see it: ${String(cause)}`,
      );
    });

    const minted = await fetchJson<{ token: string; expires_at?: string }>(
      `${apiBase}/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        headers: { ...jwtHeaders(), "Content-Type": "application/json" },
        // Scope the token to this one repository, not the whole installation.
        body: JSON.stringify({ repositories: [name] }),
      },
    );

    const expiresAtMs = minted.expires_at
      ? new Date(minted.expires_at).getTime()
      : Date.now() + 3_600_000;
    return { value: minted.token, expiresAtMs };
  }

  async function repoToken(repoFullName: string): Promise<string> {
    if (!hasApp) {
      if (config.GITHUB_TOKEN) return config.GITHUB_TOKEN;
      throw new Error(
        "no GitHub credentials: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN",
      );
    }

    const cached = tokenCache.get(repoFullName);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SLACK_MS > Date.now()) return cached.value;

    // Collapse concurrent requests for the same repo into one round-trip.
    const existing = inFlight.get(repoFullName);
    if (existing) return (await existing).value;

    const pending = mintInstallationToken(repoFullName);
    inFlight.set(repoFullName, pending);
    try {
      const fresh = await pending;
      tokenCache.set(repoFullName, fresh);
      return fresh.value;
    } finally {
      inFlight.delete(repoFullName);
    }
  }

  async function apiHeaders(repoFullName: string): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await repoToken(repoFullName)}`,
      Accept: ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  return {
    name: "github",

    async mintRepoToken(repoFullName: string): Promise<Secret> {
      return new Secret(await repoToken(repoFullName), `github token for ${repoFullName}`);
    },

    async getDefaultBranch(repoFullName: string): Promise<string | null> {
      const [owner, name] = repoFullName.split("/");
      if (!owner || !name) return null;
      try {
        const repo = await fetchJson<{ default_branch?: string }>(
          `${apiBase}/repos/${owner}/${name}`,
          { headers: await apiHeaders(repoFullName) },
        );
        return repo.default_branch ?? null;
      } catch {
        return null;
      }
    },

    async listBranches(repoFullName: string): Promise<string[]> {
      const [owner, name] = repoFullName.split("/");
      if (!owner || !name) return [];
      try {
        const headers = await apiHeaders(repoFullName);
        const branches: string[] = [];
        for (let page = 1; page <= 3; page += 1) {
          const batch = await fetchJson<Array<{ name: string }>>(
            `${apiBase}/repos/${owner}/${name}/branches?per_page=100&page=${page}`,
            { headers },
          );
          branches.push(...batch.map((branch) => branch.name));
          if (batch.length < 100) break;
        }
        return branches;
      } catch {
        return [];
      }
    },

    async listRepos(): Promise<string[]> {
      try {
        if (hasApp) return await listAppRepos(apiBase, jwtHeaders);
        if (!config.GITHUB_TOKEN) return [];
        const repos = await fetchJson<Array<{ full_name: string }>>(
          `${apiBase}/user/repos?per_page=100&sort=updated`,
          {
            headers: {
              Authorization: `Bearer ${config.GITHUB_TOKEN}`,
              Accept: ACCEPT,
              "X-GitHub-Api-Version": API_VERSION,
            },
          },
        );
        return repos.map((repo) => repo.full_name).sort();
      } catch {
        return [];
      }
    },
  };
}

async function listAppRepos(
  apiBase: string,
  jwtHeaders: () => Record<string, string>,
): Promise<string[]> {
  const installations = await fetchJson<Array<{ id: number }>>(
    `${apiBase}/app/installations?per_page=100`,
    { headers: jwtHeaders() },
  );
  const repos = new Set<string>();
  for (const installation of installations) {
    const minted = await fetchJson<{ token: string }>(
      `${apiBase}/app/installations/${installation.id}/access_tokens`,
      { method: "POST", headers: jwtHeaders() },
    ).catch(() => null);
    if (!minted) continue;
    const listed = await fetchJson<{ repositories?: Array<{ full_name: string }> }>(
      `${apiBase}/installation/repositories?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${minted.token}`,
          Accept: ACCEPT,
          "X-GitHub-Api-Version": API_VERSION,
        },
      },
    ).catch(() => null);
    for (const repo of listed?.repositories ?? []) repos.add(repo.full_name);
  }
  return [...repos].sort();
}

// ── App JWT ──────────────────────────────────────────────────────────────────

/**
 * Sign an RS256 JWT with node:crypto.
 *
 * A JWT is three base64url segments, and we need exactly one algorithm — so a
 * dedicated JWT library would be more surface than value here.
 */
function signRs256(claims: Record<string, string | number>, privateKey: string): string {
  const encode = (value: object) => base64Url(Buffer.from(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256").update(signingInput);
  try {
    return `${signingInput}.${base64Url(signer.sign(privateKey))}`;
  } catch (cause) {
    throw new Error(
      `could not sign the GitHub App JWT — check the private key: ${String(cause)}`,
    );
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Restore a PEM that has been flattened into a single line.
 *
 * `.env` files routinely store the key with literal `\n` sequences and
 * surrounding quotes, which is not a parseable PEM. Normalizing here turns a
 * confusing signing failure into a working key.
 */
function normalizePem(key: string): string {
  const trimmed = key.trim().replace(/^["']|["']$/g, "");
  return trimmed.includes("\\n") ? trimmed.replaceAll("\\n", "\n") : trimmed;
}
