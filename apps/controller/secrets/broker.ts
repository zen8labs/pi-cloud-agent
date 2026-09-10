import { SANDBOX_ENV, Secret } from "@pi-cloud-agent/protocol";
import { createGithubInstallationToken } from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  loadReviewRepositories,
  usableReviewRepository,
} from "../integrations/review-repositories";
import {
  modelIdFromSnapshot,
  type ResolvedLlmModel,
  resolveLlmModelForRun,
} from "../llm/connections";
import type { Logger } from "../logger";
import { getVcsProvider } from "../vcs/connections";

/**
 * Shapes the credentials one run needs, and nothing more.
 *
 * GitHub credentials are minted from the selected App installation and scoped
 * to one repository. Other forges retain their provider-specific behavior; see
 * docs/secrets.md for the remaining sandbox-boundary limitation.
 */
export interface CredentialBroker {
  mintForRepository(input: {
    userId: string;
    provider: string;
    repoFullName: string;
  }): Promise<RepositoryCredentials>;
  mintForRun(input: MintInput): Promise<RunCredentials>;
}

interface RepositoryCredentials {
  secrets: Record<string, Secret>;
  env: Record<string, string>;
}

interface MintInput {
  userId: string | null;
  provider: string;
  repoFullName: string;
  modelConnectionId: string | null;
  modelSnapshot: string;
}

interface RunCredentials {
  /** Injected as environment variables, kept out of logs and events. */
  secrets: Record<string, Secret>;
  /** Non-secret companions to those credentials (usernames, hosts). */
  env: Record<string, string>;
  model: ResolvedLlmModel;
}

/** Conventional variable names expected by GitHub's CLI and git. */
const CLI_TOKEN_ALIASES: Record<string, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  "azure-devops": [],
};

/** The username half of HTTP basic auth for a token, per forge. */
const GIT_USERNAMES: Record<string, string> = {
  github: "x-access-token",
  "azure-devops": "oauth2",
};

export function createCredentialBroker(
  config: Config,
  database: Database,
  log: Logger,
): CredentialBroker {
  return {
    async mintForRepository({
      userId,
      provider,
      repoFullName,
    }): Promise<RepositoryCredentials> {
      const secrets: Record<string, Secret> = {};
      const env: Record<string, string> = {};
      try {
        const token =
          provider === "github" && config.github.appId && config.github.privateKey
            ? await mintGithubRepositoryToken(config, database, userId, repoFullName)
            : await (await getVcsProvider(database, config, provider, userId)).mintRepoToken(
                repoFullName,
              );
        secrets[SANDBOX_ENV.scmToken] = token;
        for (const alias of CLI_TOKEN_ALIASES[provider] ?? []) secrets[alias] = token;
        env[SANDBOX_ENV.scmTokenUsername] = GIT_USERNAMES[provider] ?? "x-access-token";
      } catch (error) {
        log.warn("no forge credential for repository environment test", {
          provider,
          repo: repoFullName,
          error,
        });
      }
      return { secrets, env };
    },

    async mintForRun({
      userId,
      provider,
      repoFullName,
      modelConnectionId,
      modelSnapshot,
    }): Promise<RunCredentials> {
      if (!userId) throw new Error("authentication is required to run a task");
      if (!modelConnectionId) throw new Error("run has no model connection");
      const model = await resolveLlmModelForRun(
        database,
        config,
        userId,
        modelConnectionId,
        modelIdFromSnapshot(modelSnapshot),
      );
      const secrets: Record<string, Secret> = {
        [SANDBOX_ENV.modelApiKey]: new Secret(model.apiKey, "model api key"),
      };
      if (model.authJson) {
        secrets[SANDBOX_ENV.modelAuthJson] = new Secret(
          model.authJson,
          "model OAuth credential",
        );
      }
      const env: Record<string, string> = {};

      // Public repositories remain usable when no identity is connected. A
      // credential failure is reported by the agent only if the run needs it.
      const repository = await this.mintForRepository({ userId, provider, repoFullName });
      if (
        provider === "github" &&
        config.auth.requireUser &&
        !repository.secrets[SANDBOX_ENV.scmToken]
      ) {
        throw new Error("could not mint a repository-scoped GitHub App credential");
      }
      Object.assign(secrets, repository.secrets);
      Object.assign(env, repository.env);

      env[SANDBOX_ENV.modelAuthType] = model.authType;
      return { secrets, env, model };
    },
  };
}

async function mintGithubRepositoryToken(
  config: Config,
  database: Database,
  userId: string,
  repoFullName: string,
): Promise<Secret> {
  const access = await loadReviewRepositories(database, config, userId);
  const repository = usableReviewRepository(access.repositories, repoFullName);
  if (!repository) throw new Error("repository is not accessible through the GitHub App");
  const credential = await createGithubInstallationToken(
    { appId: config.github.appId, privateKey: config.github.privateKey },
    repository.installationId,
    repoFullName,
  );
  return new Secret(credential.token, "repository-scoped github installation token");
}
