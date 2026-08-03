# Adding a VCS provider

The MVP has two providers: GitHub and Azure DevOps. Users connect one identity per provider in **Settings**; the controller then uses that identity for repository listing, branch lookup, cloning, and git actions.

The provider package owns API details. The controller owns OAuth state, encrypted token storage, refresh, and the trust boundary around sandbox credentials.

```ts
export interface VCSProvider {
  readonly name: string;
  getRepository(repoFullName: string): Promise<VcsRepository | null>;
  mintRepoToken(repoFullName: string): Promise<Secret>;
  getDefaultBranch(repoFullName: string): Promise<string | null>;
  listBranches(repoFullName: string): Promise<string[]>;
  listRepos(): Promise<VcsRepository[]>;
}
```

## Provider implementation

Add one adapter under `packages/vcs/` and register it in `packages/vcs/index.ts`. An adapter receives an already decrypted access token; it must not read process environment variables or persist credentials.

`getRepository`, `getDefaultBranch`, `listBranches`, and `listRepos` are dashboard lookups. They should return `null` or an empty array on provider outages. `mintRepoToken` may throw when the identity is disconnected or cannot access the repository.

Repository names are provider-specific but stable inside the shared `VcsRepository` shape. GitHub uses `owner/name`; Azure DevOps uses `organization/project/repository`.

## OAuth integration

Add the provider's OAuth implementation to `packages/vcs/oauth.ts`, then add its configuration keys to `apps/controller/config.ts`. The controller flow is:

1. Generate a random state and PKCE verifier and store them in `oauth_states` for ten minutes.
2. Set an HttpOnly, SameSite=Lax state cookie and redirect to the provider.
3. Verify the callback state, consume it once, exchange the code, and identify the account.
4. Encrypt access and refresh tokens with `VCS_ENCRYPTION_KEY` before upserting `vcs_connections`.
5. Refresh an expiring token before constructing a provider for a run.

Do not add provider-specific credential handling to the reconciler. `getVcsProvider` is the one controller resolver for connected identities.

## Test it

Cover repository normalization, provider outage behavior, and token minting. Run:

```bash
pnpm vitest run packages/vcs
pnpm typecheck
```

Adding a provider is a product and security decision. It needs an OAuth registration, a documented scope, and a review of how its token is exposed to the sandbox. Do not reintroduce PAT-only or process-wide provider credentials for convenience.
