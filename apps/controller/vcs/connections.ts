import { createHash, randomBytes } from "node:crypto";
import type { VcsConnectionSummary, VcsConnectionsResponse } from "@pi-cloud-agent/protocol";
import {
  createVcsOAuthProvider,
  createVcsProvider,
  vcsProviderNames,
} from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import { upsertAppUser } from "../db/auth";
import type { Database } from "../db/client";
import {
  consumeOAuthState,
  createOAuthState,
  deleteVcsConnection,
  getVcsConnection,
  listVcsConnections,
  updateVcsConnectionToken,
  upsertVcsConnection,
} from "../db/vcs-connections";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SLACK_MS = 60 * 1000;

export async function beginVcsConnection(
  database: Database,
  config: Config,
  provider: string,
  userId: string | null,
  returnTo: string | null = null,
): Promise<{ url: string; state: string }> {
  if (!hasEncryptionKey(config)) {
    throw new Error("VCS_ENCRYPTION_KEY must be 64 hexadecimal characters");
  }
  const oauth = createVcsOAuthProvider(provider, config.env);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await createOAuthState(database, {
    state,
    provider,
    userId,
    returnTo,
    codeVerifier,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return {
    state,
    url: oauth.authorizationUrl({
      state,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    }),
  };
}

export async function finishVcsConnection(
  database: Database,
  config: Config,
  provider: string,
  state: string,
  code: string,
  userId: string,
): Promise<void> {
  const result = await exchangeVcsConnection(database, config, provider, state, code);
  if (result.userId !== userId) throw new Error("OAuth state belongs to another user");
  await saveConnection(database, config, provider, userId, result);
}

export async function finishGithubLogin(
  database: Database,
  config: Config,
  state: string,
  code: string,
): Promise<{
  githubUserId: string;
  login: string;
  displayName: string;
  userId: string;
  returnTo: string | null;
}> {
  const result = await exchangeVcsConnection(database, config, "github", state, code);
  if (result.userId !== null) throw new Error("GitHub login state is already linked");
  const user = await upsertAppUser(database, {
    githubUserId: result.identity.id,
    login: result.identity.login,
    displayName: result.identity.displayName || result.identity.login,
    avatarUrl: result.identity.avatarUrl,
  });
  await saveConnection(database, config, "github", user.id, result);
  return {
    githubUserId: result.identity.id,
    login: result.identity.login,
    displayName: result.identity.displayName || result.identity.login,
    userId: user.id,
    returnTo: result.returnTo,
  };
}

export async function listConnectionSummaries(
  database: Database,
  config: Config,
  userId: string,
): Promise<VcsConnectionsResponse> {
  const rows = await listVcsConnections(database, userId);
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const connections: VcsConnectionSummary[] = vcsProviderNames().map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      displayName: provider === "github" ? "GitHub" : "Azure DevOps",
      configured: isOAuthConfigured(provider, config) && hasEncryptionKey(config),
      connected: Boolean(row),
      accountName: row?.accountName ?? null,
    };
  });
  return { connections };
}

export async function disconnectVcsConnection(
  database: Database,
  userId: string,
  provider: string,
): Promise<void> {
  await deleteVcsConnection(database, userId, provider);
}

export async function getVcsProvider(
  database: Database,
  config: Config,
  provider: string,
  userId: string | null,
) {
  if (!userId) return createVcsProvider(provider, "");
  const row = await getVcsConnection(database, userId, provider);
  if (!row) return createVcsProvider(provider, "");

  const accessToken = decryptSecret(row.accessToken, config.vcs.encryptionKey);
  const refreshToken = row.refreshToken
    ? decryptSecret(row.refreshToken, config.vcs.encryptionKey)
    : null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now() + TOKEN_REFRESH_SLACK_MS) {
    if (!refreshToken) throw new Error(`${provider} connection needs to be reconnected`);
    const oauth = createVcsOAuthProvider(provider, config.env);
    const token = await oauth.refreshToken(refreshToken);
    await updateVcsConnectionToken(database, row.id, {
      accessToken: encryptSecret(token.accessToken, config.vcs.encryptionKey),
      refreshToken: token.refreshToken
        ? encryptSecret(token.refreshToken, config.vcs.encryptionKey)
        : row.refreshToken,
      expiresAt: token.expiresAt,
    });
    return oauth.create(token.accessToken);
  }
  return createVcsProvider(provider, accessToken);
}

function isOAuthConfigured(provider: string, config: Config): boolean {
  try {
    createVcsOAuthProvider(provider, config.env);
    return true;
  } catch {
    return false;
  }
}

function hasEncryptionKey(config: Config): boolean {
  return /^[0-9a-f]{64}$/i.test(config.vcs.encryptionKey);
}

async function exchangeVcsConnection(
  database: Database,
  config: Config,
  provider: string,
  state: string,
  code: string,
) {
  const saved = await consumeOAuthState(database, state);
  if (!saved || saved.provider !== provider) throw new Error("invalid or expired OAuth state");
  const oauth = createVcsOAuthProvider(provider, config.env);
  const token = await oauth.exchangeCode(code, saved.codeVerifier);
  const identity = await oauth.identify(token.accessToken);
  return { userId: saved.userId, returnTo: saved.returnTo, token, identity };
}

async function saveConnection(
  database: Database,
  config: Config,
  provider: string,
  userId: string,
  result: Awaited<ReturnType<typeof exchangeVcsConnection>>,
): Promise<void> {
  await upsertVcsConnection(database, {
    userId,
    provider,
    accountId: result.identity.id,
    accountName: result.identity.displayName || result.identity.login,
    accessToken: encryptSecret(result.token.accessToken, config.vcs.encryptionKey),
    refreshToken: result.token.refreshToken
      ? encryptSecret(result.token.refreshToken, config.vcs.encryptionKey)
      : null,
    expiresAt: result.token.expiresAt,
  });
}
