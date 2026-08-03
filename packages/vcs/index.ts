import type { VCSProvider } from "@pi-cloud-agent/protocol";
import { createAzureDevOpsProvider } from "./azure-devops";
import { createGitHubProvider } from "./github";
import { createVcsOAuthProvider } from "./oauth";

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

export { createAzureDevOpsProvider, createGitHubProvider, createVcsOAuthProvider };

export function vcsProviderNames(): string[] {
  return Object.keys(FACTORIES).sort();
}
