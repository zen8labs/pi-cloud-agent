# Adding a VCS provider

A VCS provider does two things: it tells the controller **whether a webhook is real and what it means**, and it **mints a credential scoped to one repository**.

There is no write side. The agent posts its own comments and pushes its own commits from inside the sandbox using the token you mint, so this contract has no publish method, no comment API, and no diff fetching.

```ts
export interface VCSProvider {
  readonly name: string;
  verifyAndParseWebhook(headers: Headers, body: string): ParsedWebhook;
  mintRepoToken(repoFullName: string): Promise<Secret>;
  resolvePullRequest(repo: RepoRef, prNumber: number): Promise<RepoRef>;
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
  http.ts         shared helpers — use these
```

Use `http.ts` rather than rolling your own: `verifyHmacSignature` fails closed, `secureEquals` is constant-time, and `fetchJson` applies a timeout.

## 2. Register it

```ts
// packages/vcs/index.ts
const FACTORIES: Record<string, Factory> = {
  github: createGitHubProvider,
  "my-forge": createMyForgeProvider,   // ← this line
};
```

The webhook endpoint `POST /webhooks/my-forge` now exists.

## What each method must guarantee

### `verifyAndParseWebhook` — the one that matters

This is the only surface an unauthenticated stranger can reach. Three rules:

**Verify before you parse.** An unauthenticated body must never reach JSON handling, let alone anything that acts on it.

**Fail closed, always.** No configured secret, no signature header, a malformed body — all throw `WebhookVerificationError`, which the controller answers with
401. "We could not check" and "this is authentic" must never take the same branch.

**Return `null` for events you understand and do not care about.** That is not an error and must not look like one; the controller answers 204. A closed pull request, a star, a push to an unrelated branch — all `null`.

Then normalize into a `Trigger`. The mapping to be consistent about:

| Forge event | `kind` |
|---|---|
| pull request opened or reopened | `pr_opened` |
| new commits pushed to a pull request | `pr_updated` |
| comment created on a pull request | `pr_comment`, with `command` set to the body |

Only map to `pr_updated` when **code actually changed**. Most forges fire an update event for label and description edits too — GitLab's `update` action needs an `oldrev` to count. Getting this wrong means running the agent on every label change.

### `mintRepoToken`

Prefer something short-lived and scoped to the single repository. A GitHub App installation token is the reference. A long-lived personal access token is acceptable as a fallback, and is strictly worse — say so in a comment so nobody mistakes it for equivalent. See [secrets.md](secrets.md).

Cache tokens and refresh before expiry with slack, so a long clone cannot straddle the boundary. Collapse concurrent requests for the same repository into one round-trip.

### `resolvePullRequest`

Some webhooks carry no commit SHAs — GitHub's `issue_comment` is the common case — and the sandbox must clone an exact revision. Return **coordinates, not content**: `baseSha`, `headSha`, `headBranch`. The agent reads the diff itself with `git` in the checkout it already has.

### The selector methods

`getDefaultBranch`, `listBranches`, and `listRepos` are best-effort. They feed dashboard selectors, so they must **never throw** — return `null` or an empty array. A forge outage should leave the dashboard usable with a typed-in `owner/name`, not blank.

## Configuration

Validate your own slice of the environment inside your factory, the way `github.ts` does. Do not add fields to the controller's config schema — that is what keeps a new forge from touching `apps/controller` at all.

## Test it

Add a `describe` block to `packages/vcs/webhooks.test.ts`. Cover, at minimum:

- a valid delivery becomes exactly the right `Trigger`, asserted as a whole object
- a forged signature throws
- a missing signature throws
- an unconfigured secret throws even when the signature would be valid
- an event you ignore returns `null`

Write more rejection cases than acceptance cases. That is the ratio in the existing tests, and it is deliberate.

```bash
pnpm vitest run packages/vcs/webhooks.test.ts
```
