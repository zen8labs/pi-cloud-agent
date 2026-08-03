import type { VCSProvider } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import { createAzureDevOpsProvider } from "./azure-devops";
import { createGitHubProvider } from "./github";
import { fetchJson } from "./http";

interface OAuthToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

interface VcsIdentity {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface VcsOAuthProvider {
  readonly name: string;
  readonly displayName: string;
  readonly redirectUri: string;
  authorizationUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<OAuthToken>;
  refreshToken(refreshToken: string): Promise<OAuthToken>;
  identify(accessToken: string): Promise<VcsIdentity>;
  create(accessToken: string): VCSProvider;
}

type Env = Readonly<Record<string, string | undefined>>;

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const AZURE_AUTHORIZE_URL = "https://login.microsoftonline.com";

export function createVcsOAuthProvider(name: string, env: Env): VcsOAuthProvider {
  if (name === "github") return createGitHubOAuthProvider(env);
  if (name === "azure-devops") return createAzureOAuthProvider(env);
  throw new Error(`Unknown VCS provider "${name}".`);
}

function createGitHubOAuthProvider(env: Env): VcsOAuthProvider {
  const config = z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      redirectUri: z.string().url(),
    })
    .parse({
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      redirectUri: env.GITHUB_APP_REDIRECT_URI,
    });

  return {
    name: "github",
    displayName: "GitHub",
    redirectUri: config.redirectUri,
    authorizationUrl({ state, codeChallenge }) {
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },
    exchangeCode(code, codeVerifier) {
      return exchangeToken(GITHUB_TOKEN_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      });
    },
    refreshToken(refreshToken) {
      return exchangeToken(GITHUB_TOKEN_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },
    async identify(accessToken) {
      const user = await fetchJson<{
        id: number;
        login?: string;
        name?: string;
        avatar_url?: string;
      }>(`${GITHUB_API_URL}/user`, { headers: githubHeaders(accessToken) });
      return {
        id: String(user.id),
        login: user.login ?? String(user.id),
        displayName: user.name ?? user.login ?? String(user.id),
        avatarUrl: user.avatar_url ?? null,
      };
    },
    create(accessToken) {
      return createGitHubProvider(accessToken);
    },
  };
}

function createAzureOAuthProvider(env: Env): VcsOAuthProvider {
  const config = z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      tenantId: z.string().default("common"),
      redirectUri: z.string().url(),
    })
    .parse({
      clientId: env.AZURE_DEVOPS_CLIENT_ID,
      clientSecret: env.AZURE_DEVOPS_CLIENT_SECRET,
      tenantId: env.AZURE_DEVOPS_TENANT_ID,
      redirectUri: env.AZURE_DEVOPS_REDIRECT_URI,
    });
  const authorizeUrl = `${AZURE_AUTHORIZE_URL}/${config.tenantId}/oauth2/v2.0/authorize`;
  const tokenUrl = `${AZURE_AUTHORIZE_URL}/${config.tenantId}/oauth2/v2.0/token`;
  const scope =
    "https://app.vssps.visualstudio.com/.default offline_access openid profile email";

  return {
    name: "azure-devops",
    displayName: "Azure DevOps",
    redirectUri: config.redirectUri,
    authorizationUrl({ state, codeChallenge }) {
      const url = new URL(authorizeUrl);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        response_mode: "query",
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },
    exchangeCode(code, codeVerifier) {
      return exchangeToken(tokenUrl, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        scope,
        code_verifier: codeVerifier,
      });
    },
    refreshToken(refreshToken) {
      return exchangeToken(tokenUrl, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope,
      });
    },
    async identify(accessToken) {
      const profile = await fetchJson<{ id?: string; displayName?: string }>(
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3",
        { headers: bearerHeaders(accessToken) },
      );
      if (!profile.id) throw new Error("Azure DevOps did not return a profile id");
      return {
        id: profile.id,
        login: profile.id,
        displayName: profile.displayName ?? profile.id,
        avatarUrl: null,
      };
    },
    create(accessToken) {
      return createAzureDevOpsProvider(accessToken);
    },
  };
}

async function exchangeToken(url: string, values: Record<string, string>): Promise<OAuthToken> {
  const result = await fetchJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(values).toString(),
  });
  if (!result.access_token) throw new Error("OAuth provider did not return an access token");
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000) : null,
  };
}

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    ...bearerHeaders(accessToken),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}
