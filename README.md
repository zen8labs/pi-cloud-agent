# pi-cloud-agent

A minimal, extensible core for coding agents that run in the cloud.

Something triggers a run — a webhook, the dashboard, an API call. The controller
verifies it, mints a short-lived credential scoped to one repository, and starts
an isolated sandbox. Inside, an agent clones the repository and does the work,
posting its own results back to the forge with ordinary tools like `git` and
`gh`. The controller records what happened and reclaims the machine.

That is the whole product. Everything specific to a task — reviewing a pull
request, answering a question about a codebase — is a **profile**, and profiles
are the extension surface.

## Why it is this small

The interesting decisions here are subtractions:

- **No workflow engine.** Run state lives in Postgres and a single reconciliation
  loop repairs it. A controller restart is indistinguishable from a slow tick, so
  there is no Temporal, no trigger.dev, and no in-memory run lifecycle to lose.
  → [docs/resumability.md](docs/resumability.md)
- **No event bus and no Redis.** Postgres already holds every event durably;
  `LISTEN/NOTIFY` is a wake-up hint, and polling is the correctness baseline.
- **No publishing step.** The agent posts its own review. There is no
  controller-side reporting tool, no output parser, and no findings table — which
  means there is no way for the controller to disagree with what the agent
  actually did.
- **Two methods of sandbox contract.** `create` and `stop`. The sandbox is
  outbound-only, so no provider needs to expose tunnels or reachability.
  → [docs/adding-a-sandbox-provider.md](docs/adding-a-sandbox-provider.md)
- **One model.** One configured model means one credential, so there is no
  provider matrix to leak the wrong key into a sandbox.

## Quickstart

Requires Node 22.19+, pnpm, and Docker.

```bash
pnpm install
cp .env.example .env      # then fill in E2B and model credentials
pnpm up                   # Postgres on 5532
pnpm db:migrate
pnpm sandbox:template     # build the sandbox image and E2B template
pnpm controller           # :8080
pnpm web                  # :3000
```

Start a run:

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repo": "owner/repo",
    "prompt": "Inspect the repository and report its latest commit.",
    "profile": "general"
  }'
```

Then watch it, resumably:

```bash
curl -N http://localhost:8080/runs/<run-id>/stream
```

`CONTROL_PLANE_URL` must be reachable **from inside the sandbox**. With a hosted
sandbox provider that means a public tunnel, not `localhost`. See
[docs/operations.md](docs/operations.md).

## Layout

```text
apps/
  controller/     trusted service: HTTP, reconciler, credentials, database
  web/            operator dashboard
packages/
  protocol/       the contracts: types, schemas, provider interfaces
  profiles/       verticals: general, pr-review
  sandbox/        SandboxProvider implementations
  vcs/            VCSProvider implementations
  runtime/        runs inside the sandbox — untrusted
```

The split is by **substitutability and trust**, not by feature. `packages/runtime`
executes untrusted repository code and may depend only on `packages/protocol`;
`pnpm boundaries` enforces that in CI.

## Extending it

| To add | Read | Effort |
|---|---|---|
| a vertical | [docs/adding-a-profile.md](docs/adding-a-profile.md) | one directory, one registry line |
| a sandbox backend | [docs/adding-a-sandbox-provider.md](docs/adding-a-sandbox-provider.md) | two methods |
| a forge | [docs/adding-a-vcs-provider.md](docs/adding-a-vcs-provider.md) | one file |

None of these require touching the controller.

## Documentation

- [VISION.md](VISION.md) — what this is for, and what it will refuse to become
- [ARCHITECTURE.md](ARCHITECTURE.md) — the two trust zones and the run lifecycle
- [AGENTS.md](AGENTS.md) — index for coding agents, plus the enforced rules
- [docs/](docs/) — resumability, secrets, testing, operations, extension guides

## Security posture

Honest about what it is: the sandbox receives a repo-scoped, short-lived forge
token and one model key in its environment. Once repository code runs alongside a
token, that token is compromised in principle — the controls are scope, TTL, and
isolation, not obfuscation. The operator API has no authentication in this phase
and is meant for localhost or a private network. Details and the intended next
step in [docs/secrets.md](docs/secrets.md).
