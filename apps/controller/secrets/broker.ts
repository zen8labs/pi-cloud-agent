import { SANDBOX_ENV, type Secret, type VCSProvider } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Logger } from "../logger";

/**
 * Shapes the credentials one run needs, and nothing more.
 *
 * There is exactly one interface here on purpose. Today it mints a repo-scoped
 * forge token and hands over the single configured model key; the version we
 * want — an egress proxy that injects auth so the sandbox never holds a token at
 * all — is a second implementation of `CredentialBroker`, not a refactor of
 * everything that calls it. See docs/secrets.md.
 */
export interface CredentialBroker {
  mintForRun(input: MintInput): Promise<RunCredentials>;
}

interface MintInput {
  provider: string;
  repoFullName: string;
  /** Forge host, so a CLI can be pointed at an Enterprise instance. */
  host: string;
  vcs: VCSProvider;
}

interface RunCredentials {
  /** Injected as environment variables, kept out of logs and events. */
  secrets: Record<string, Secret>;
  /** Non-secret companions to those credentials (usernames, hosts). */
  env: Record<string, string>;
}

/**
 * Conventional variable names each forge's CLI and git credential helper expect.
 *
 * The same token is exposed under several names because `gh`, `glab`, and git
 * each look for their own. That duplication is the forge's convention, not ours.
 */
const CLI_TOKEN_ALIASES: Record<string, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  bitbucket: ["BITBUCKET_TOKEN"],
};

/** The username half of HTTP basic auth for a token, per forge. */
const GIT_USERNAMES: Record<string, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
  bitbucket: "x-token-auth",
};

export function createCredentialBroker(config: Config, log: Logger): CredentialBroker {
  return {
    async mintForRun({ provider, repoFullName, host, vcs }): Promise<RunCredentials> {
      const secrets: Record<string, Secret> = {
        // The only model credential in the system. One configured model means
        // one key — there is no provider matrix to get wrong, and no chance of
        // handing a sandbox a credential for a model it isn't using.
        [SANDBOX_ENV.modelApiKey]: config.model.apiKey,
      };
      const env: Record<string, string> = {};

      // A run without forge auth can still be useful — a public repository, a
      // read-only task — so a minting failure degrades instead of failing the
      // run. The agent will report the real problem if it turns out to need the
      // credential, which is more informative than a provisioning error.
      try {
        const token = await vcs.mintRepoToken(repoFullName);
        secrets[SANDBOX_ENV.scmToken] = token;
        for (const alias of CLI_TOKEN_ALIASES[provider] ?? []) {
          secrets[alias] = token;
        }
        env[SANDBOX_ENV.scmTokenUsername] = GIT_USERNAMES[provider] ?? "x-access-token";
        if (provider === "github" && host !== "github.com") {
          env.GH_HOST = host;
        }
      } catch (error) {
        log.warn("no forge credential for this run; continuing unauthenticated", {
          provider,
          repo: repoFullName,
          error,
        });
      }

      return { secrets, env };
    },
  };
}
