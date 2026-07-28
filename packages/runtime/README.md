# @pi-cloud-agent/runtime

> **This is the untrusted zone.** Everything here runs inside the sandbox,
> alongside code cloned from a repository nobody has reviewed.

One process per run: clone the repository, optionally run its setup hook, run one
agent session, report outward. Then the machine is destroyed.

**Depends on:** `@pi-cloud-agent/protocol` and the agent harness. **Nothing else,
ever.** No database client, no VCS client, no sandbox provider, no credential
broker. `pnpm boundaries` fails CI if a dependency is added, and pnpm's isolated
`node_modules` makes an undeclared import unresolvable in the first place.

It reaches exactly one thing: `CONTROL_PLANE_URL`, outbound only.

## Files

| File | Role |
|---|---|
| `run.ts` | the entry point — four steps, exactly one terminal report |
| `config.ts` | reads `SANDBOX_ENV` into a typed object; `secretValues()` for redaction |
| `workspace.ts` | git credential helper, clone and checkout, the repo's setup hook |
| `agent.ts` | one agent session, relaying its native events as telemetry |
| `reporter.ts` | the only outbound path: telemetry and the terminal status |
| `build.ts` | bundles to `dist/run.js` and pins the harness version for the image |
| `Dockerfile.sandbox` | the sandbox image: Node, `git`, `gh`, the bundle |

## Invariants

- **Exactly one terminal status per process.** It is the only thing that completes
  a run. If it cannot be delivered, exit non-zero and let the controller's
  reconciler notice the silence — never exit 0 having said nothing.
- **Telemetry is best-effort and must never fail a run.** Losing a token event
  costs a line in the feed. `reporter.ts` swallows those failures on purpose.
- **Everything outbound passes through the redactor.** This is the only side that
  knows every secret in play, so it is the side that scrubs. Do not add a second
  send path. Credentials must be named `*_TOKEN`, `*_API_KEY`, `*_SECRET`, or
  `*_PASSWORD` so `secretValues()` catches them without being told.
- **Never write a credential to disk.** The git credential helper prints from the
  environment on demand, precisely so no token lands in `.git/config` where the
  agent could later read or commit it.
- **No profile code here.** The controller composes the skill and the prompt into
  one finished `TASK_PROMPT`, so the image ships nothing about any vertical.
- **This is the one package with a build step.** Crossing into a container image
  is where "just run the TypeScript" stops being simpler.

## Working on it

```bash
pnpm --filter @pi-cloud-agent/runtime build     # bundle only
pnpm sandbox:template                           # bundle + rebuild the image
```

Changes here need a template rebuild before they take effect — a controller
restart is not enough. Then validate against a real sandbox, because nothing
offline covers the image, the harness, and the callback path together:

```bash
pnpm test:live
```

See [../../docs/operations.md](../../docs/operations.md) for what a healthy run
looks like and [../../docs/secrets.md](../../docs/secrets.md) for the threat model
this package sits inside.
