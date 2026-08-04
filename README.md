# pi-cloud-agent

[![CI](https://github.com/zen8labs/pi-cloud-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/zen8labs/pi-cloud-agent/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.19-3c873a.svg)](package.json) [![Wiki](https://img.shields.io/badge/wiki-DeepWiki-blue.svg)](https://deepwiki.com/zen8labs/pi-cloud-agent)

**Background agents, without the backend.**

Every agentic product (code review, issue triage, research bots) rebuilds the same 80%: a durable queue, an isolated machine, credentials that survive sitting next to untrusted code, a log someone can replay. This is that 80%, in under 8,000 lines, MIT, on your own server.

You write the other 20%.

## Principles

- **Small enough to read.** Under 8,000 lines of TypeScript. You can audit every line that touches your credentials in an evening, which is the only honest reason to trust it with one.
- **Composable, not configurable.** Three contracts: a vertical, a compute backend, a forge. Plugins are installable skill/MCP bundles beside those contracts — not a second controller.
- **Boring on purpose.** Postgres and one reconciliation loop. No workflow engine, no message broker, no cache.
- **Deleting is design work.** Every feature is a liability. The default answer to "should we add this?" is "not yet, and probably not here."

Complexity belongs compressed inside the abstraction, not spread across the surface.

## How a run works

1. Something triggers it: the dashboard or an API call.
2. The operator connects a GitHub or Azure DevOps identity in Settings; the controller resolves the repository and boots a sandbox with the run credential.
3. Inside, an agent clones the repo, does the work, and posts its own result with ordinary tools like `git` and `gh`.
4. Every step lands in an append-only log you can stream live or replay later.
5. A standalone run's machine is reclaimed. A chat session's filesystem is parked for the next turn, then expires automatically.

Runs are fully headless. The dashboard can also continue a deliberate multi-turn session without pretending each follow-up is a new conversation.

## What it is not

A remote dev environment. There is nothing to attach to; the controller cannot even dial into a sandbox, by design. A parked session preserves agent history and a filesystem, not a machine you can SSH into.

The execution unit is a **run**: an event starts it, it ends, and its log is immutable. A **session** is the durable parent for ordered chat turns, the Pi checkpoint, and an optional parked workspace. See [docs/sessions.md](docs/sessions.md).

## Development

Copy `.env.example` to `.env`, add the GitHub App and model credentials, run `make setup`, then `make dev`. [DEVELOPMENT.md](DEVELOPMENT.md) has the short quick start and optional provider configuration.

## Why it is this small

The interesting decisions are subtractions:

- **No workflow engine.** Run state lives in Postgres and one reconciliation loop repairs it, so a restart is indistinguishable from a slow tick. No Temporal, no trigger.dev, no run lifecycle held in memory to lose. → [docs/resumability.md](docs/resumability.md)
- **No event bus, no Redis.** Postgres already stores every event; `LISTEN/NOTIFY` is a wake-up hint and polling is the correctness baseline.
- **No publishing step.** The agent posts its own review. No output parser, no findings table, and therefore no way for the controller to disagree with what the agent actually did.
- **A lifecycle-shaped sandbox contract.** `create`, `resume`, `suspend`, `deleteWorkspace`, and `stop`. The sandbox remains outbound-only; persistence is a provider concern, not an agent server. → [docs/adding-a-sandbox-provider.md](docs/adding-a-sandbox-provider.md)
- **One model.** One configured model means one credential, so there is no provider matrix to leak the wrong key into a sandbox.

## Layout

```text
apps/
  controller/     trusted service: HTTP, reconciler, credentials, database
  web/            operator dashboard
packages/
  protocol/       the contracts: types, schemas, provider interfaces
  profiles/       verticals: general (pr-review dormant on disk as a rebuild seed)
  sandbox/        SandboxProvider implementations
  vcs/            GitHub and Azure DevOps provider implementations
  runtime/        runs inside the sandbox (untrusted)
```

The split is by **substitutability and trust**, not by feature. `packages/runtime` executes untrusted repository code and may depend only on `packages/protocol`; `pnpm boundaries` enforces that in CI.

## Documentation

- [DeepWiki](https://deepwiki.com/zen8labs/pi-cloud-agent): a deep dive into the project's architecture and design
- [VISION.md](VISION.md): what this is for, and what it will refuse to become
- [ARCHITECTURE.md](ARCHITECTURE.md): the two trust zones and the run lifecycle
- [DEVELOPMENT.md](DEVELOPMENT.md): complete local setup, microSandbox image, optional E2B template, and first run
- [AGENTS.md](AGENTS.md): index for coding agents, plus the enforced rules
- [docs/](docs/): durable sessions, resumability, secrets, testing, operations, extension guides

## Contributing

Profiles, sandbox backends, and forges are the surfaces this project wants to grow, and none of them require touching the controller. Bug fixes, corrected docs, and deletions are equally welcome.

[DEVELOPMENT.md](DEVELOPMENT.md) covers environment setup and validation. [CONTRIBUTING.md](CONTRIBUTING.md) covers the rules CI enforces and the short list of changes worth discussing before you write code. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © zen8labs
