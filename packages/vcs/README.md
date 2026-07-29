# @pi-cloud-agent/vcs

Which forge a run came from, and how to get a credential for it.

Two jobs: **is this webhook real and what does it mean**, and **give me a credential scoped to this repository**.

There is no write side. The agent posts its own comments and pushes its own commits from inside the sandbox using the token minted here, so this package has no publish method, no comment API, and no diff fetching — the controller only ever needs coordinates.

**Depends on:** `@pi-cloud-agent/protocol`, `zod`. Signing uses `node:crypto` rather than a JWT library; one algorithm is not worth a dependency.

## Files

| File | Role |
|---|---|
| `index.ts` | the `FACTORIES` registry, `createVcsProvider`, `vcsProviderNames` |
| `http.ts` | `verifyHmacSignature` (fails closed), `secureEquals`, `fetchJson` |
| `github.ts` | GitHub and Enterprise; App installation tokens, cached and deduped |
| `gitlab.ts` | GitLab; shared-token webhooks, PAT auth |
| `bitbucket.ts` | Bitbucket Cloud; HMAC or shared-secret header |
| `webhooks.test.ts` | verification and normalization, per provider |

## Invariants

- **Verify before parsing.** An unauthenticated body must never reach JSON handling, let alone anything that acts on it.
- **Fail closed, always.** No configured secret, no signature header, wrong length — all throw `WebhookVerificationError` (401). "We could not check" and "this is authentic" must never take the same branch.
- **`null` means understood and deliberately ignored** (204). Not an error, and it must not look like one.
- **Only map to `pr_updated` when code actually changed.** Most forges fire an update event for label and description edits too. Getting this wrong runs the agent on every label change.
- **Selector methods never throw.** `getDefaultBranch`, `listBranches`, and `listRepos` feed dashboard pickers; return `null` or `[]` so a forge outage leaves the dashboard usable.
- **Prefer short-lived, repo-scoped credentials.** A GitHub App installation token is the reference. A PAT is accepted and is strictly worse — broad and long-lived. Say so in a comment wherever one is used.
- **Providers are constructed per request, not held as singletons.** They cache tokens internally, and a stale process-wide instance is a worse problem than a few extra allocations.

## Adding a forge

One file and one line in `FACTORIES`: [../../docs/adding-a-vcs-provider.md](../../docs/adding-a-vcs-provider.md).

```bash
pnpm vitest run packages/vcs/webhooks.test.ts
```
