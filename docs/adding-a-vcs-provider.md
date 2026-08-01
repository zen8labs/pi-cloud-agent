# Adding a VCS provider

A VCS provider **mints a credential scoped to one repository** and answers the read-only questions the dashboard's selectors ask.

There is no write side. The agent posts its own comments and pushes its own commits from inside the sandbox using the token you mint, so this contract has no publish method, no comment API, and no diff fetching.

```ts
export interface VCSProvider {
  readonly name: string;
  mintRepoToken(repoFullName: string): Promise<Secret>;
  getDefaultBranch(repoFullName: string): Promise<string | null>;
  listBranches(repoFullName: string): Promise<string[]>;
  listRepos(): Promise<string[]>;
}
```

## 1. Write it

```text
packages/vcs/
  my-forge.ts     the implementation
  index.ts        add one line to FACTORIES
  http.ts         shared helpers. Use these
```

Use `http.ts` rather than rolling your own: `fetchJson` applies a timeout.

## 2. Register it

```ts
// packages/vcs/index.ts
const FACTORIES: Record<string, Factory> = {
  github: createGitHubProvider,
  "my-forge": createMyForgeProvider,   // ← this line
};
```

The controller can now mint tokens through it, and the dashboard's repository and branch selectors can query it.

## What each method must guarantee

### `mintRepoToken`

Prefer something short-lived and scoped to the single repository. A GitHub App installation token is the reference. A long-lived personal access token is acceptable as a fallback, and is strictly worse. Say so in a comment so nobody mistakes it for equivalent. See [secrets.md](secrets.md).

Cache tokens and refresh before expiry with slack, so a long clone cannot straddle the boundary. Collapse concurrent requests for the same repository into one round-trip.

### The selector methods

`getDefaultBranch`, `listBranches`, and `listRepos` are best-effort. They feed dashboard selectors, so they must **never throw**. Return `null` or an empty array. A forge outage should leave the dashboard usable with a typed-in `owner/name`, not blank.

## Configuration

Validate your own slice of the environment inside your factory, the way `github.ts` does. Do not add fields to the controller's config schema. That is what keeps a new forge from touching `apps/controller` at all.

## Test it

Add a test file next to your implementation. Cover, at minimum:

- tokens are cached and refreshed before expiry, so a long clone cannot straddle the boundary
- concurrent mints for the same repository collapse into one round-trip
- the selector methods return `null` or an empty array on a forge outage rather than throwing

```bash
pnpm vitest run packages/vcs
```
