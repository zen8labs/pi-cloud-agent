<!-- One concern per PR. If this description needs the word "also", it may be two PRs. -->

## What and why

<!-- The problem you hit, the approach you took, and what you rejected. The diff already shows what changed; tell us why. -->

Closes #

## What I ran

- [ ] `pnpm verify`
- [ ] `pnpm test:live` (only if the sandbox image, runtime, or model config changed)

<!-- Paste anything surprising. -->

## Does this cross a line that needs a decision?

Tick anything that applies — none of these block the PR, they just mean a maintainer should weigh in before merge. See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).

- [ ] adds or widens a contract in `packages/protocol`
- [ ] adds a dependency to `packages/runtime`, or otherwise moves the trust boundary
- [ ] gives the controller knowledge of a specific profile or provider
- [ ] adds a dependency, a provider, or a service
- [ ] changes `db/schema.ts` (a generated migration is committed)
- [ ] changes anything in [docs/secrets.md](../blob/main/docs/secrets.md)'s scope

## Docs

- [ ] the docs for the surface I touched are updated, or no doc describes it
