# @pi-cloud-agent/vcs

One job: **give me a credential scoped to this repository**, plus the read-only metadata (`getDefaultBranch`, `listBranches`, `listRepos`) the dashboard's selectors ask for.

There is no write side. The agent posts its own comments and pushes its own commits from inside the sandbox using the token minted here, so this package has no publish method, no comment API, and no diff fetching.

**Depends on:** `@pi-cloud-agent/protocol`, `zod`. Signing uses `node:crypto` rather than a JWT library; one algorithm is not worth a dependency.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createVcsProvider`, `vcsProviderNames` |
| `http.ts` | `fetchJson` with a timeout and error context |
| `github.ts` | GitHub and Enterprise; App installation tokens, cached and deduped |
| `gitlab.ts` | GitLab; PAT auth |
| `bitbucket.ts` | Bitbucket Cloud; PAT auth |
| `index.test.ts` | the provider registry |

## Invariants

- **Selector methods never throw.** `getDefaultBranch`, `listBranches`, and `listRepos` feed dashboard pickers; return `null` or `[]` so a forge outage leaves the dashboard usable.
- **Prefer short-lived, repo-scoped credentials.** A GitHub App installation token is the reference. A PAT is accepted and is strictly worse: broad and long-lived. Say so in a comment wherever one is used.
- **Providers are constructed per request, not held as singletons.** They cache tokens internally, and a stale process-wide instance is a worse problem than a few extra allocations.

## Adding a forge

One file and one line in `FACTORIES`: [../../docs/adding-a-vcs-provider.md](../../docs/adding-a-vcs-provider.md).

```bash
pnpm vitest run packages/vcs
```
