import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  loadPluginPackage,
  type PluginOauth,
  pluginOauthSchema,
} from "@pi-cloud-agent/plugins";
import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  pluginAuditLog,
  pluginOauthClients,
  pluginOauthTokens,
  plugins,
  pluginUserVariables,
  pluginVersions,
} from "../db/schema";
import { consumeOAuthState, createOAuthState } from "../db/vcs-connections";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SLACK_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export interface PluginOauthStatus {
  required: boolean;
  connected: boolean;
  connectPath: string | null;
  tokenVariable: string | null;
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Convention for oauth_states.provider when the flow is plugin MCP OAuth. */
export function pluginOAuthProvider(pluginName: string): string {
  return `plugin:${pluginName}`;
}

export function parsePluginOauth(manifest: Record<string, unknown>): PluginOauth | null {
  if (!manifest.oauth) return null;
  const parsed = pluginOauthSchema.safeParse(manifest.oauth);
  return parsed.success ? parsed.data : null;
}

export function issuerHostAllowed(issuer: string, allowlist: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowlist.some((entry) => entry.toLowerCase() === host);
}

async function discoverAuthorizationServer(
  resource: string,
  allowlist: readonly string[],
): Promise<{ resource: string; metadata: AuthorizationServerMetadata }> {
  const resourceMeta = await fetchProtectedResource(resource);
  const issuer = resourceMeta.authorization_servers[0];
  if (!issuer) throw new Error(`no authorization_servers for resource ${resource}`);
  if (!issuerHostAllowed(issuer, allowlist)) {
    throw new Error(`authorization server "${issuer}" is not on PLUGIN_OAUTH_ISSUER_ALLOWLIST`);
  }
  const metadata = await fetchAuthorizationServerMetadata(issuer);
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error(`authorization server "${issuer}" does not support PKCE S256`);
  }
  if (!metadata.registration_endpoint) {
    throw new Error(
      `authorization server "${issuer}" has no registration_endpoint (DCR required)`,
    );
  }
  return { resource: resourceMeta.resource || resource, metadata };
}

export async function beginPluginOAuth(
  database: Database,
  config: Config,
  pluginName: string,
  userId: string,
): Promise<{ url: string; state: string }> {
  assertEncryption(config);
  const { pluginId, oauth } = await loadApprovedPluginOauth(database, pluginName);
  void pluginId;
  const { resource, metadata } = await discoverAuthorizationServer(
    oauth.resource,
    config.plugins.oauthIssuerAllowlist,
  );
  const clientId = await ensureRegisteredClient(database, config, metadata);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await createOAuthState(database, {
    state,
    provider: pluginOAuthProvider(pluginName),
    userId,
    codeVerifier,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: config.plugins.oauthRedirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: oauth.scopes.join(" "),
    resource,
  }).toString();
  return { url: url.toString(), state };
}

export async function finishPluginOAuth(
  database: Database,
  config: Config,
  state: string,
  code: string,
  userId: string,
): Promise<{ pluginName: string }> {
  assertEncryption(config);
  const saved = await consumeOAuthState(database, state);
  if (!saved?.provider.startsWith("plugin:")) {
    throw new Error("invalid or expired OAuth state");
  }
  if (saved.userId !== userId) throw new Error("OAuth state belongs to another user");
  const pluginName = saved.provider.slice("plugin:".length);
  const { pluginId, oauth } = await loadApprovedPluginOauth(database, pluginName);
  const { resource, metadata } = await discoverAuthorizationServer(
    oauth.resource,
    config.plugins.oauthIssuerAllowlist,
  );
  const clientId = await ensureRegisteredClient(database, config, metadata);
  const token = await exchangeCode(metadata.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.plugins.oauthRedirectUri,
    client_id: clientId,
    code_verifier: saved.codeVerifier,
    resource,
  });
  await storePluginTokens(database, config, userId, pluginId, pluginName, oauth, token);
  return { pluginName };
}

export async function resolvePluginOAuthToken(
  database: Database,
  config: Config,
  userId: string,
  pluginId: string,
  pluginName: string,
  oauth: PluginOauth,
): Promise<string | null> {
  assertEncryption(config);
  const [row] = await database
    .select()
    .from(pluginOauthTokens)
    .where(and(eq(pluginOauthTokens.userId, userId), eq(pluginOauthTokens.pluginId, pluginId)))
    .limit(1);
  if (!row) return null;

  const access = decryptSecret(row.accessEncrypted, config.vcs.encryptionKey);
  const needsRefresh =
    row.expiresAt !== null && row.expiresAt.getTime() <= Date.now() + TOKEN_REFRESH_SLACK_MS;
  if (!needsRefresh) return access;
  if (!row.refreshEncrypted) {
    throw new Error(
      `plugin "${pluginName}" OAuth token expired; reconnect from the Plugins page`,
    );
  }

  const { metadata } = await discoverAuthorizationServer(
    oauth.resource,
    config.plugins.oauthIssuerAllowlist,
  );
  const clientId = await ensureRegisteredClient(database, config, metadata);
  const refresh = decryptSecret(row.refreshEncrypted, config.vcs.encryptionKey);
  const token = await exchangeCode(metadata.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    resource: oauth.resource,
  });
  await storePluginTokens(database, config, userId, pluginId, pluginName, oauth, token);
  return token.access_token;
}

export function oauthStatusForManifest(
  manifest: Record<string, unknown>,
  connected: boolean,
  pluginName: string,
): PluginOauthStatus {
  const oauth = parsePluginOauth(manifest);
  if (!oauth) {
    return { required: false, connected: false, connectPath: null, tokenVariable: null };
  }
  return {
    required: true,
    connected,
    connectPath: `/plugins/${encodeURIComponent(pluginName)}/oauth/connect`,
    tokenVariable: oauth.tokenVariable,
  };
}

async function loadApprovedPluginOauth(
  database: Database,
  pluginName: string,
): Promise<{ pluginId: string; oauth: PluginOauth; artifactPath: string }> {
  const [row] = await database
    .select({
      pluginId: plugins.id,
      artifactPath: pluginVersions.artifactPath,
      manifest: pluginVersions.manifest,
    })
    .from(pluginVersions)
    .innerJoin(plugins, eq(pluginVersions.pluginId, plugins.id))
    .where(and(eq(plugins.name, pluginName), eq(pluginVersions.reviewStatus, "approved")))
    .limit(1);
  if (!row) throw new Error(`no approved version for plugin: ${pluginName}`);
  const oauth = parsePluginOauth(row.manifest);
  if (!oauth) throw new Error(`plugin "${pluginName}" does not declare oauth`);
  if (!existsSync(row.artifactPath)) {
    // Prefer live package when present so oauth stays in sync after seed.
    loadPluginPackage(row.artifactPath);
  }
  return { pluginId: row.pluginId, oauth, artifactPath: row.artifactPath };
}

async function ensureRegisteredClient(
  database: Database,
  config: Config,
  metadata: AuthorizationServerMetadata,
): Promise<string> {
  const redirectUri = config.plugins.oauthRedirectUri;
  const [existing] = await database
    .select()
    .from(pluginOauthClients)
    .where(
      and(
        eq(pluginOauthClients.issuer, metadata.issuer),
        eq(pluginOauthClients.redirectUri, redirectUri),
      ),
    )
    .limit(1);
  if (existing) return existing.clientId;

  if (!metadata.registration_endpoint) {
    throw new Error(`authorization server "${metadata.issuer}" has no registration_endpoint`);
  }
  const registered = await fetchJson<{ client_id: string }>(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "pi-cloud-agent",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!registered.client_id) throw new Error("DCR response missing client_id");
  await database
    .insert(pluginOauthClients)
    .values({
      issuer: metadata.issuer,
      redirectUri,
      clientId: registered.client_id,
    })
    .onConflictDoNothing();
  const [row] = await database
    .select()
    .from(pluginOauthClients)
    .where(
      and(
        eq(pluginOauthClients.issuer, metadata.issuer),
        eq(pluginOauthClients.redirectUri, redirectUri),
      ),
    )
    .limit(1);
  if (!row) throw new Error("failed to persist OAuth client registration");
  return row.clientId;
}

async function storePluginTokens(
  database: Database,
  config: Config,
  userId: string,
  pluginId: string,
  pluginName: string,
  oauth: PluginOauth,
  token: TokenResponse,
): Promise<void> {
  const accessEncrypted = encryptSecret(token.access_token, config.vcs.encryptionKey);
  const refreshEncrypted = token.refresh_token
    ? encryptSecret(token.refresh_token, config.vcs.encryptionKey)
    : null;
  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;

  await database
    .insert(pluginOauthTokens)
    .values({
      userId,
      pluginId,
      accessEncrypted,
      refreshEncrypted,
      expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pluginOauthTokens.userId, pluginOauthTokens.pluginId],
      set: {
        accessEncrypted,
        refreshEncrypted,
        expiresAt,
        updatedAt: new Date(),
      },
    });

  await database
    .insert(pluginUserVariables)
    .values({
      userId,
      pluginId,
      name: oauth.tokenVariable,
      valueEncrypted: accessEncrypted,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        pluginUserVariables.userId,
        pluginUserVariables.pluginId,
        pluginUserVariables.name,
      ],
      set: { valueEncrypted: accessEncrypted, updatedAt: new Date() },
    });

  await database.insert(pluginAuditLog).values({
    actorUserId: userId,
    pluginName,
    action: "oauth_connect",
    detail: { tokenVariable: oauth.tokenVariable },
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
}

async function fetchProtectedResource(resource: string): Promise<ProtectedResourceMetadata> {
  const url = new URL(resource);
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const meta = await fetchJson<ProtectedResourceMetadata>(candidate);
      if (Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0) {
        return meta;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`failed to discover protected resource metadata for ${resource}`);
}

async function fetchAuthorizationServerMetadata(
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  const base = issuer.replace(/\/$/, "");
  return fetchJson<AuthorizationServerMetadata>(
    `${base}/.well-known/oauth-authorization-server`,
  );
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${init.method ?? "GET"} ${url} failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

function assertEncryption(config: Config): void {
  if (!/^[0-9a-fA-F]{64}$/.test(config.vcs.encryptionKey)) {
    throw new Error("VCS_ENCRYPTION_KEY must be 64 hexadecimal characters");
  }
}
