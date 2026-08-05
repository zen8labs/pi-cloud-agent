import { SANDBOX_ENV, Secret } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
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
 * The forge token comes from the user's connected identity. A future secrets
 * broker can replace this implementation without changing the reconciler
 * contract; see docs/secrets.md.
 */
export interface CredentialBroker {
  mintForRun(input: MintInput): Promise<RunCredentials>;
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
      try {
        const vcs = await getVcsProvider(database, config, provider, userId);
        const token = await vcs.mintRepoToken(repoFullName);
        secrets[SANDBOX_ENV.scmToken] = token;
        for (const alias of CLI_TOKEN_ALIASES[provider] ?? []) {
          secrets[alias] = token;
        }
        env[SANDBOX_ENV.scmTokenUsername] = GIT_USERNAMES[provider] ?? "x-access-token";
      } catch (error) {
        log.warn("no forge credential for this run; continuing unauthenticated", {
          provider,
          repo: repoFullName,
          error,
        });
      }

      env[SANDBOX_ENV.modelAuthType] = model.authType;
      return { secrets, env, model };
    },
  };
}
