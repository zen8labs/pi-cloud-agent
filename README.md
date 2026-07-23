# Minimal Cloud Agent

A small, task-agnostic cloud-agent core for CoReview. A trusted controller
creates ephemeral sandboxes; an embedded Pi session does the work; profiles
specialize the agent without adding behavior to the controller.

Read [VISION.md](VISION.md) for the product principles.

## Architecture

```text
webhook / API / chat
        │
        ▼
FastAPI controller + embedded worker ─── Postgres runs and event log
        │  mint scoped credentials
        │  create and later destroy
        ▼
E2B microVM
  └─ supervisor
      ├─ clone checkout
      ├─ optional .coreview/setup.sh
      └─ embedded Pi session + selected profile
             │
             ├─ read/edit/bash/git/gh
             └─ outbound token, tool, log, and terminal events
```

There are two trust zones:

- The controller is trusted. It verifies triggers, coordinates state, mints
  short-lived credentials, and provisions infrastructure. It never executes
  repository code or interprets/publishes agent output.
- The E2B sandbox is untrusted and ephemeral. It runs repository code and owns
  the agent loop. It only calls outward; the controller never dials into it.

Pi is embedded through `createAgentSession()`. There is no agent server, SSE
completion inference, polling bridge, or controller-side harness session.

## Repository

```text
agent/
  core/
    api/            Public and sandbox-callback HTTP routes
    orchestrator/   Generic run lifecycle, event bus, credential shaping
    profiles.py     Profile contract and registry
    sandbox/        SandboxProvider contract and E2B implementation
    state/          SQLAlchemy models and repositories
    vcs/            GitHub, GitLab, and Bitbucket providers
  profiles/
    general_agent/  Free-form repository task
    pr_review/      PR task plus SKILL.md instructions
  runtime/
    entrypoint.py   Thin sandbox process entrypoint
    supervisor.py   One-run lifecycle
    workspace.py    Git checkout and optional setup
    control.py      Outbound controller reporting
    pi-runner.mjs   Embedded Pi session and native event relay
  tests/
web/                Next.js operator dashboard
```

## Core contracts

- `VCSProvider` verifies and normalizes provider events and mints clone tokens.
- `SandboxProvider` creates and stops isolated compute.
- `Profile` converts a trigger into a `TaskSpec`.
- `TaskSpec` carries the repo, concrete prompt, inputs, and run limits.

The orchestrator knows infrastructure, not the meaning of a task. To add an
agent vertical, add a profile; do not branch the run lifecycle.

## Profiles

A profile lives at `agent/profiles/<name>/`:

```text
profile.py   implements Profile
task.py      trigger → TaskSpec
SKILL.md     optional reusable instructions loaded inside the sandbox
```

The built-ins are:

- `general_agent` — execute a free-form request against a repository.
- `pr_review` — review one PR and post high-signal feedback directly with `gh`.

Profiles start with Pi's built-in tools and normal CLIs. MCP, subagents, plans,
and custom tools are opt-in additions only when a profile proves it needs them.

## Local setup

Requirements: Python 3.12+, Node 22+, Docker, and an E2B account for live runs.

```bash
cp agent/.env.example agent/.env
make install
make up
make web-dev
```

The controller listens on `:8080`; the dashboard listens on `:3000`.

Important settings:

- `DATABASE_URL`
- `CONTROL_PLANE_URL` — externally reachable by E2B for full live runs
- `E2B_API_KEY`, `E2B_TEMPLATE`
- `AGENT_MODEL`
- `AIGATEWAY_BASE_URL`, `AIGATEWAY_API_KEY` for Netmind/Viettel MiniMax
- GitHub App, GitLab, or Bitbucket credentials
- `WEB_REPOS`, `WEB_CORS_ORIGINS`

Never bake `agent/.env` into either image.

## Sandbox template

The sandbox image pins Pi in `agent/package.json` and installs from
`agent/package-lock.json`.

```bash
make sandbox-template
```

Rebuild after changes to:

- `agent/Dockerfile.sandbox`
- `agent/runtime/`
- `agent/profiles/`
- `agent/package.json` or `agent/package-lock.json`

Controller-only changes need a restart, not a new template.

## Start a run

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repo": "owner/repo",
    "prompt": "Inspect the repository and summarize its architecture.",
    "profile": "general_agent",
    "provider": "github",
    "host": "github.com"
  }'
```

For PR review, use `"profile": "pr_review"` and provide `pr_number`.

## Observe a run

```bash
RUN_ID=<run-id>

curl -s localhost:8080/runs/$RUN_ID | jq
curl -s localhost:8080/runs/$RUN_ID/events | jq '.events[]'
curl -N localhost:8080/runs/$RUN_ID/stream
```

The internal callback routes authenticate with a per-run bearer token. Each
event is appended to Postgres before it is published to the in-process control
bus. The worker subscribes before sandbox creation, preventing a fast run from
finishing before the controller is listening.

API and worker run in one process by default. A deployment that separates them
must replace the in-memory bus with a cross-process transport such as Redis.

## Validate

```bash
make test       # offline unit and API integration suite
make lint
make compile
make test-live  # real E2B + configured model; reads agent/.env

cd web
npm run build
npm run lint
```

The live Pi tests create real E2B sandboxes and call the configured model. For a
production-shaped proof, also start the controller with an externally reachable
`CONTROL_PLANE_URL`, submit a run, and verify:

1. the run reaches `succeeded`;
2. stored events include tokens and completed tool calls;
3. the sandbox is destroyed at the end.

## Security model

- Repository code runs only in the ephemeral sandbox.
- The controller injects only credentials needed for that run.
- GitHub App installation tokens are repository-scoped and short-lived.
- The agent acts directly through `git` and provider CLIs; there is no hidden
  controller publish step.
- Egress can be restricted with `SANDBOX_EGRESS_ALLOWLIST`.

The remaining hardening priority is permission-level downscoping for external or
forked repositories. Isolation does not make an overpowered write credential
safe.
