# @pi-cloud-agent/vcs

One job: **resolve connected VCS identities into repository metadata, run credentials, and trusted integration actuators**. The dashboard uses the GitHub App installation inventory, while the controller mints a short-lived, repository-scoped installation token for a run.

The sandbox still has no VCS client. GitHub reviews and comment replies are narrow controller-side actuators: the untrusted runtime sends a validated structured submission to the controller, and this package posts against the pinned PR or original comment. Repository code never receives a GitHub API client or publication permission through this path. The controller requires a short-lived installation token minted from the App's private key; it never uses the connected user token for publication.

**Depends on:** `@pi-cloud-agent/protocol`, `zod`. OAuth uses the platform `fetch` and `node:crypto` for PKCE; there is no provider SDK or JWT dependency.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createVcsProvider`, `vcsProviderNames` |
| `http.ts` | `fetchJson` with a timeout and error context |
| `github.ts` | GitHub user-token identity, installation verification, App-token minting, and review/comment actuators |
| `github-repositories.ts` | paginated installation/repository/open PR reads; errors remain explicit for review diagnostics |
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
