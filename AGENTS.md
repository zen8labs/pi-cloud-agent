# AGENTS.md

Navigation for coding agents. This file is an index, not a manual. Read the document that matches what you are about to do, rather than everything.

## Read this first, always

| Question | Document |
|---|---|
| What is this project for, and what will it refuse to become? | [VISION.md](VISION.md) |
| How do the pieces fit, and where does each concept live? | [ARCHITECTURE.md](ARCHITECTURE.md) |
| How do I run it? | [README.md](README.md) |

## If you arrived at a directory, start with its README

Every package and app has one, and it is the local entry point: what that package owns, what it is allowed to depend on, its own invariants, and a map of its files. Read it before editing anything inside; the invariants are the part you cannot infer from the code in front of you.

| Package | Read |
|---|---|
| the contracts | [packages/protocol/README.md](packages/protocol/README.md) |
| verticals | [packages/profiles/README.md](packages/profiles/README.md) |
| compute backends | [packages/sandbox/README.md](packages/sandbox/README.md) |
| forges | [packages/vcs/README.md](packages/vcs/README.md) |
| the untrusted sandbox side | [packages/runtime/README.md](packages/runtime/README.md) |
| the trusted service | [apps/controller/README.md](apps/controller/README.md) |
| the dashboard | [apps/web/README.md](apps/web/README.md) |

`pnpm docs:check` fails if a package has no README, so this list stays complete.

## Then read what your task needs

| If you are… | Read |
|---|---|
| adding or changing a profile (a vertical) | [docs/adding-a-profile.md](docs/adding-a-profile.md) |
| adding a sandbox backend (Docker, Modal, Daytona…) | [docs/adding-a-sandbox-provider.md](docs/adding-a-sandbox-provider.md) |
| adding a forge (GitHub Enterprise, Gitea, Forgejo…) | [docs/adding-a-vcs-provider.md](docs/adding-a-vcs-provider.md) |
| touching run state, the queue, or the reconciler | [docs/resumability.md](docs/resumability.md) |
| touching credentials, tokens, or anything logged | [docs/secrets.md](docs/secrets.md) |
| writing or changing tests | [docs/testing.md](docs/testing.md) |
| running, debugging, or validating a live run | [docs/operations.md](docs/operations.md) |

Each document is self-contained for its task. If you find yourself reading three of them to make one change, the change probably crosses a boundary it should not. See *Consult first* below.

## Layout

```text
apps/
  controller/     trusted service: HTTP, reconciler, credentials, database
  web/            operator dashboard (Next.js)
packages/
  protocol/       the contracts: types, schemas, and the three provider interfaces
  profiles/       verticals: general, pr-review
  sandbox/        SandboxProvider implementations (e2b)
  vcs/            VCSProvider implementations (github, gitlab, bitbucket)
  runtime/        runs INSIDE the sandbox (untrusted)
  tsconfig/       shared compiler options
```

## Commands

Everything runs from the repository root.

```bash
pnpm install
pnpm up                  # Postgres on 5532, plus the controller image
pnpm db:migrate          # apply migrations (never automatic on boot)
pnpm controller          # controller on :8080, with reload
pnpm web                 # dashboard on :3000

pnpm verify              # what CI runs: everything below, plus typecheck and tests
pnpm lint                # biome check
pnpm fix                 # biome check --write
pnpm typecheck
pnpm boundaries          # enforce the trust boundary
pnpm docs:check          # every package has a README; every relative link resolves
pnpm files:check         # no source file over 500 lines
pnpm deadcode            # knip: no unused exports, files, or dependencies
pnpm dupes               # jscpd: duplicated lines stay under the threshold
pnpm test                # unit: no I/O, runs anywhere
pnpm test:integration    # needs Postgres (`pnpm up`)
pnpm test:live           # needs real E2B + model credentials; never in CI
pnpm sandbox:template    # rebuild the sandbox image and E2B template
```

One file:

```bash
pnpm vitest run packages/vcs/webhooks.test.ts
pnpm vitest run --project integration apps/controller/db/runs.integration.test.ts
```

## Rules that the tooling enforces

You do not need to remember these; they fail the build. They are listed so the failure makes sense when you hit it.

- **`packages/runtime` may depend only on `packages/protocol`.** It executes untrusted repository code. pnpm makes an undeclared import unresolvable, and `pnpm boundaries` makes a *declared* one a CI failure. Widening this is a decision, not a fix. See *Consult first*.
- **Only `apps/controller/config.ts` reads `process.env`.** Everything else takes typed values or is handed an environment to validate itself.
- **No `any`, no non-null assertions, no `enum`.** Use unions and `as const`.
- **Every `UPDATE` needs a `WHERE`.** Run transitions are compare-and-set; see [docs/resumability.md](docs/resumability.md).
- **A schema change needs a generated migration.** CI regenerates and fails on a diff.
- **`console` is not the logger.** Use `createLogger`; the runtime is exempt because it has no controller to log through.
- **A new package needs a README, and links must resolve.** `pnpm docs:check` fails otherwise, so a package cannot ship undocumented and a moved file cannot silently orphan the documents that pointed at it.
- **Names follow one convention.** Biome's `useNamingConvention` fails the lint otherwise: types and components PascalCase, functions and variables camelCase (constants may be CONSTANT_CASE).
- **Functions stay under the complexity ceiling.** Biome's `noExcessiveCognitiveComplexity` is on for every package, so a function that wants one more nested branch gets extracted instead.
- **Source files stay under 500 lines.** `pnpm files:check` fails CI otherwise; a file that size is two files.
- **No dead exports, no unused dependencies.** `pnpm deadcode` (knip) fails CI on either. Deleting is design work; this makes it continuous.
- **Copy-paste has a budget.** `pnpm dupes` (jscpd) fails CI when duplicated lines cross the threshold in `.jscpd.json`; extract the shared thing instead.
- **Commits are checked before they land.** The husky pre-commit hook runs Biome on staged files plus the file-size check, so these failures surface before CI does.

## Consult the maintainer first

Ask before:

- adding a new contract to `packages/protocol`, or widening an existing one
- moving the trust boundary, including adding a dependency to `packages/runtime`
- adding controller-side knowledge of a specific profile or provider
- adding a dependency, a provider, or a service (a queue, a cache, a broker)
- introducing an agent server, a polling bridge, or controller-side parsing of agent output; Pi stays an implementation detail of the sandbox image
- anything that trades flexibility for a one-time convenience

For reversible, local, within-contract work, just proceed.

## Design philosophy: think in primitives, not features

The primitive is the product; workflows outlast technologies. Pi, E2B, and MiniMax are implementation details. `TaskSpec`, `Profile`, `SandboxProvider`, and `VCSProvider` are the product.

- Start from the outcome, then find the smallest stable abstraction that enables it. Do not add a feature where a sharper primitive would do.
- Treat every new feature as a liability. The default answer to "should we add this?" is "not yet, and probably not here."
- Prefer composability over owning a workflow. Ask what others should be able to build on this, not what flow we should own.
- Draw abstraction lines deliberately. Where to be opinionated versus extensible is a decision to surface, not an implementation detail.
- Aim for boring. Complexity should be compressed into the abstraction (S3: put, get, list). If a design feels clever or sprawling, the line is wrong.
- Assume the model, sandbox, and forge will all change. Keep the workflow stable so swapping one is a small local change.
- **Deleting is design work.** This codebase is smaller than the problem it solves, deliberately. If you find code with no caller, a table with no writer, or a config field nothing reads, removing it is a contribution.
