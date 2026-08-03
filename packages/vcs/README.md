# @pi-cloud-agent/vcs

One job: **resolve connected VCS identities into repository metadata and run credentials**. The dashboard uses read-only metadata, while the controller mints a token for a run.

There is no write side. The agent posts its own comments and pushes its own commits from inside the sandbox using the token minted here, so this package has no publish method, no comment API, and no diff fetching.

**Depends on:** `@pi-cloud-agent/protocol`, `zod`. OAuth uses the platform `fetch` and `node:crypto` for PKCE; there is no provider SDK or JWT dependency.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createVcsProvider`, `vcsProviderNames` |
| `http.ts` | `fetchJson` with a timeout and error context |
| `github.ts` | GitHub App user-token identity and repository adapter |
| `azure-devops.ts` | Azure DevOps through Microsoft Entra delegated OAuth |
| `oauth.ts` | OAuth authorization, exchange, refresh, and identity lookup |
| `index.test.ts` | the provider registry |

## Invariants

- **Selector methods never throw.** `getDefaultBranch`, `listBranches`, and `listRepos` feed dashboard pickers; return `null` or `[]` so a forge outage leaves the dashboard usable.
- **Provider adapters never read environment variables.** The trusted controller passes a connected access token explicitly.
- **Providers are constructed per request, not held as singletons.** This keeps token refresh and connection changes visible immediately.

## Adding a provider

Follow the provider and OAuth connection checklist in [../../docs/adding-a-vcs-provider.md](../../docs/adding-a-vcs-provider.md).

```bash
pnpm vitest run packages/vcs
```
