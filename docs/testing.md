# Testing

## The policy

Tests are grouped by **the behavior they defend**, not by the file they cover. There is no unit test for a two-line mapper, and there is no mock of Postgres.

Three questions decide whether something deserves a test:

1. **Would a bug here be silent?** Redaction, webhook verification, and guarded state transitions all fail quietly and expensively. They get thorough tests.
2. **Is the behavior in the code, or in the SQL?** Exclusive claiming and gapless sequence numbers are properties of `for update skip locked` and a row lock. A fake database would test the fake, so these run against real Postgres.
3. **Does the test describe a promise to a caller?** `getRun` returning a row is an implementation detail. "The first terminal decision wins permanently" is a promise.

A test file should read as a list of guarantees. If you cannot write the `it(...)` string as something a user or maintainer would care about, the test is probably describing implementation.

## The three projects

Separated by what they need to run, so a fresh clone can always run something.

| Project | Command | Needs | Runs in CI |
|---|---|---|---|
| `unit` | `pnpm test` | nothing | yes |
| `integration` | `pnpm test:integration` | Postgres (`pnpm up`) | yes |
| `live` | `pnpm test:live` | real E2B + model credentials | **no** |

`pnpm verify` runs unit and integration. Configuration is in `vitest.config.ts`.

Integration tests share one database and truncate between tests, so they run in a single fork, sequentially. Migrations are applied once by `apps/controller/test-global-setup.ts` — doing it per file raced.

## What is covered, and why that

| File | The guarantee it defends |
|---|---|
| `packages/protocol/secret.test.ts` | a credential cannot reach output by accident |
| `packages/vcs/webhooks.test.ts` | a forged or unverifiable delivery is refused; an understood event becomes exactly one trigger |
| `packages/profiles/profiles.test.ts` | profiles own their triggering policy and their config, and `accepts` never green-lights what `buildTask` would refuse |
| `packages/sandbox/registry.test.ts` | a misconfigured provider fails at startup, naming the variable and the alternatives |
| `packages/runtime/reporter.test.ts` | secrets do not leave the sandbox; telemetry loss cannot fail a run; the terminal status retries |
| `apps/controller/db/runs.integration.test.ts` | the SQL properties: exclusive claim, guarded transitions, gapless sequences under concurrency |
| `apps/controller/reconcile/reconciler.integration.test.ts` | the resumability claims, including that a live run survives a restart untouched |
| `apps/controller/http/api.integration.test.ts` | the HTTP contract, grouped by who is allowed to do what |

The refusal cases matter more than the happy paths. `webhooks.test.ts` has more tests for rejection than for acceptance, deliberately.

## Conventions

**Name a test after the promise, not the function.**

```ts
it("lets the first terminal decision win permanently", …)   // yes
it("completeRun returns false when already terminal", …)     // no
```

**Explain a non-obvious assertion in a comment.** Not what it does — why the case exists at all:

```ts
// This race is real: a sandbox posting `done` and the reconciler timing the
// same run out can arrive together.
```

**Use the shared helpers.** `apps/controller/test-support.ts` provides `setupTestDatabase`, `resetTables`, `testConfig`, `seedRun`, `manualTrigger`, and `silentLogger`. Do not hand-roll a config object — `testConfig` goes through the real `configFrom`, so a config change breaks the tests rather than drifting past them.

**Inject providers, do not mock modules.** The reconciler takes a `createProvider` factory, so tests substitute a recording fake. There is no module mocking anywhere in this suite.

**Drain, do not sleep.** `tick()` detaches provisioning on purpose, so `drain()` exists to make the difference observable. If you find yourself adding `setTimeout` to a test, the code under test is missing a way to be observed.

**Type response bodies.** Integration tests read JSON through a `json<T>()` helper using the protocol's own types, so a renamed field fails to compile instead of failing an assertion.

## Live tests

`*.live.test.ts` boots a real sandbox against real credentials from `.env` and costs money. They are excluded from CI and never run automatically.

They exist to validate the one thing offline tests cannot: that the sandbox image, the harness, the model gateway, and the callback path work together. Run them after changing the sandbox image, the runtime, or the model configuration.

```bash
pnpm sandbox:template
pnpm test:live
```

See [operations.md](operations.md) for what a healthy run looks like.
