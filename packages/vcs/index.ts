import type { VCSProvider } from "@pi-cloud-agent/protocol";
import { createBitbucketProvider } from "./bitbucket";
import { createGitHubProvider } from "./github";
import { createGitLabProvider } from "./gitlab";

/**
 * @pi-cloud-agent/vcs — which forge a run came from, and how to get a
 * credential for it.
 *
 * Providers are constructed per request rather than held as singletons: they
 * cache tokens internally, and a stale process-wide instance is a worse problem
 * than a few extra object allocations. Adding a forge is one file and one line
 * in `FACTORIES`.
 *
 * See docs/adding-a-vcs-provider.md.
 */

type Env = Readonly<Record<string, string | undefined>>;
type Factory = (env: Env) => VCSProvider;

const FACTORIES: Record<string, Factory> = {
  github: createGitHubProvider,
  gitlab: createGitLabProvider,
  bitbucket: createBitbucketProvider,
};

export function createVcsProvider(name: string, env: Env): VCSProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    const known = Object.keys(FACTORIES).sort().join(", ");
    throw new Error(`Unknown VCS provider "${name}". Available: ${known}.`);
  }
  return factory(env);
}

export function vcsProviderNames(): string[] {
  return Object.keys(FACTORIES).sort();
}

export { createBitbucketProvider, createGitHubProvider, createGitLabProvider };
