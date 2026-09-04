import type { VCSProvider } from "@pi-cloud-agent/protocol";
import { createAzureDevOpsProvider } from "./azure-devops";
import { createGitHubProvider } from "./github";

type Factory = (accessToken: string) => VCSProvider;

const FACTORIES: Record<string, Factory> = {
  "azure-devops": createAzureDevOpsProvider,
  github: createGitHubProvider,
};

export function createVcsProvider(name: string, accessToken: string): VCSProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    const known = Object.keys(FACTORIES).sort().join(", ");
    throw new Error(`Unknown VCS provider "${name}". Available: ${known}.`);
  }
  return factory(accessToken);
}

export { createAzureDevOpsProvider } from "./azure-devops";
export type {
  GithubAppCredentials,
  GithubCommentPublisher,
  GithubInstallation,
  GithubPullRequestRevision,
  GithubReviewPublisher,
} from "./github";
export {
  createGitHubProvider,
  createGithubCommentPublisher,
  createGithubInstallationToken,
  createGithubReviewPublisher,
  fetchGithubPullRequestRevision,
  verifyGithubInstallation,
} from "./github";
export { createVcsOAuthProvider } from "./oauth";

export function vcsProviderNames(): string[] {
  return Object.keys(FACTORIES).sort();
}
