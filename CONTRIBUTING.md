# Contributing

Thanks for being here. This project is small on purpose, and that shapes what a good contribution looks like. Read [VISION.md](VISION.md) once before you start. It explains what this is for and, more usefully, what it will refuse to become.

## Set up the project

Follow [DEVELOPMENT.md](DEVELOPMENT.md) for the complete environment setup, including E2B, the sandbox template, model credentials, ngrok, Postgres, and a first real run. Then branch, make your change, and run `pnpm verify` before opening a pull request. A local pass means CI will almost certainly pass too.

## Where contributions land best

The extension surfaces are where this project wants to grow. Each is documented and none of them require touching the controller:

| To add | Read | Effort |
|---|---|---|
| a sandbox backend (Docker, Modal, Daytona…) | [docs/adding-a-sandbox-provider.md](docs/adding-a-sandbox-provider.md) | two methods |
| a forge (Gitea, Forgejo, GitHub Enterprise…) | [docs/adding-a-vcs-provider.md](docs/adding-a-vcs-provider.md) | one file |

Also always welcome: bug fixes with a test that fails before and passes after, documentation that corrects something misleading, and **deletions**. If you find code with no caller, a table with no writer, or a config field nothing reads, removing it is a contribution.

## Open an issue first if your change is a decision

Some changes are cheap to make and expensive to undo. For these, please open an issue or discussion before writing code, so we can agree on the shape:

- adding a new contract to `packages/protocol`, or widening an existing one
- moving the trust boundary, including adding a dependency to `packages/runtime`
- adding controller-side knowledge of a specific workflow or provider
- adding a dependency, a provider, or a service (a queue, a cache, a broker)
- introducing an agent server, a polling bridge, or controller-side parsing of agent output
- anything that trades flexibility for a one-time convenience

For reversible, local, within-contract work, just send the PR.

Please don't take a "not yet" personally. The default answer to "should we add this?" is "not yet, and probably not here"; that is the reason the codebase is still readable in an afternoon.

## Rules the tooling enforces

You don't need to memorize these; they fail the build. They're listed so the failure makes sense when you hit it.

- **`packages/runtime` may depend only on `packages/protocol`.** It executes untrusted repository code. `pnpm boundaries` fails CI on a declared dependency.
- **Only `apps/controller/config.ts` reads `process.env`.** Everything else takes typed values.
- **No `any`, no non-null assertions, no `enum`.** Use unions and `as const`.
- **Every `UPDATE` needs a `WHERE`.** Run transitions are compare-and-set. See [docs/resumability.md](docs/resumability.md).
- **A schema change needs a generated migration.** CI regenerates and fails on a diff: `pnpm --filter @pi-cloud-agent/controller db:generate`.
- **`console` is not the logger.** Use `createLogger`. The runtime is exempt because it has no controller to log through.
- **A new package needs a README, and relative links must resolve.** `pnpm docs:check` fails otherwise.
- **Names follow one convention.** Biome's `useNamingConvention` fails the lint otherwise: types and components PascalCase, functions and variables camelCase (constants may be CONSTANT_CASE).
- **Functions stay under the complexity ceiling.** Biome's `noExcessiveCognitiveComplexity` is on for every package.
- **Source files stay under 500 lines.** `pnpm files:check` fails CI otherwise.
- **No dead exports, no unused dependencies.** `pnpm deadcode` (knip) fails CI on either.
- **Copy-paste has a budget.** `pnpm dupes` (jscpd) fails CI when duplicated lines cross the threshold in `.jscpd.json`.
- **Commits are checked before they land.** The husky pre-commit hook runs Biome on staged files plus the file-size check.

[AGENTS.md](AGENTS.md) is the index coding agents read, and it's a good map for humans too. Each package also has its own README: what it owns, its invariants, and a map of its files. That's the right place to start when you arrive at a directory instead of at the root.

## Tests

Read [docs/testing.md](docs/testing.md) before adding tests. The policy in one line: tests are grouped by the behavior they defend, not the file they cover, and a test name should read as a promise to a caller.

| Project | Command | Needs |
|---|---|---|
| unit | `pnpm test` | nothing |
| integration | `pnpm test:integration` | Postgres (`pnpm up`) |
| live | `pnpm test:live` | real E2B + model credentials, costs money |

Live tests never run in CI. If you change the sandbox image, the runtime, or the model configuration, run them locally and say so in the PR.

One file at a time:

```bash
pnpm vitest run --project integration apps/controller/db/runs.integration.test.ts
```

## Pull requests

- **One concern per PR.** If the description needs the word "also", it's probably two PRs.
- **Explain why, not what.** The diff shows what changed. Tell us the problem, the approach, and what you rejected.
- **Say what you ran.** `pnpm verify`, plus live tests if they were relevant.
- Commit messages follow Conventional Commits loosely: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Not enforced, appreciated.
- Formatting is Biome's job, not yours: `pnpm fix`.
- Draft PRs are welcome for early feedback.

There's no CLA. By contributing you agree your work is licensed under the [MIT License](LICENSE).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for the reporting path, and [docs/secrets.md](docs/secrets.md) for the honest version of the current threat model.

## Getting unstuck

- [ARCHITECTURE.md](ARCHITECTURE.md): the two trust zones and the run lifecycle
- [docs/operations.md](docs/operations.md): running, debugging, and validating a live run, including what a healthy run looks like
- Open a discussion or an issue. A question that reveals a confusing document is useful information; we'd rather fix the document than answer it twice.
