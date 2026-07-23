# AGENTS.md

Guidance for coding agents working in this repository.

## Layout

```text
agent/
  core/       Trusted controller: API, queue, state, VCS, sandbox, orchestration
  profiles/   Agent specializations: general_agent and pr_review
  runtime/    Untrusted-sandbox supervisor and embedded Pi runner
  tests/      Offline tests plus opt-in live E2B/MiniMax tests
web/          Next.js operator dashboard
```

All Python commands run from `agent/`; web commands run from `web/`.

```bash
make install
make dev
make up
make test
make test-live
make lint
make compile
make sandbox-template

cd web && npm run build
cd web && npm run lint
```

For one test:

```bash
cd agent && pytest tests/test_api.py -q
cd agent && pytest tests/test_harness_live.py -m live -q -s
```

## Architecture

The system has two trust zones:

1. The trusted controller (`agent/core/`) verifies triggers, persists and claims
   runs, mints short-lived credentials, creates an E2B sandbox, and records
   outbound events. It never executes repository code or publishes agent output.
2. The untrusted sandbox (`agent/runtime/`) clones the repository, optionally
   runs `.coreview/setup.sh`, and starts one embedded Pi session. Pi reads the
   selected profile's instructions and actuates outcomes itself with ordinary
   tools such as `git` and `gh`.

Request lifecycle:

```text
trigger → Run row → worker claim → pre-subscribe event queue
        → E2B sandbox → supervisor → embedded Pi session
        → outbound events/status → controller → terminal Run status
        → sandbox teardown
```

The sandbox is outbound-only. `runtime/pi-runner.mjs` posts native Pi token and
tool events to `core/api/routes/internal.py`. That route first appends to
`run_events`, then publishes to the per-run in-process bus used for controller
flow control. API and worker share a process by default; a split deployment must
replace that bus with a cross-process transport.

## Extension points

Keep the orchestrator free of profile- and provider-specific behavior.

| Contract | Location | Resolver |
|---|---|---|
| `VCSProvider` | `core/vcs/base.py` | `get_vcs_provider(name)` |
| `SandboxProvider` | `core/sandbox/provider.py` | `get_sandbox_provider()` |
| `Profile` | `core/profiles.py` | `get_profile(name)` |

`TaskSpec` is the pivot. A profile converts a normalized trigger into the repo,
task prompt, and limits that the controller passes to the sandbox.

A profile under `profiles/<name>/` contains:

- `profile.py` — implements the `Profile` protocol.
- `task.py` — normalizes its trigger into `TaskSpec`.
- optional `SKILL.md` — reusable instructions prepended to the concrete prompt.

Pi is intentionally an implementation detail of the sandbox image, not a
controller-side session abstraction. Do not add an agent server, polling bridge,
or controller-side output parser.

## Live debugging

```bash
RUN_ID=<run_id>

curl -N localhost:8080/runs/$RUN_ID/stream
curl -s localhost:8080/runs/$RUN_ID/events | jq '.events[]'

docker compose exec db psql -U coreview -d coreview_agent -c \
  "SELECT id, status, profile, created_at FROM runs ORDER BY created_at DESC LIMIT 10;"

docker compose exec db psql -U coreview -d coreview_agent -c \
  "SELECT seq, type, data->>'event', created_at FROM run_events WHERE run_id='$RUN_ID' ORDER BY seq;"
```

Expected terminal evidence is a `status` event followed by controller state
`succeeded` or `failed`. Token and tool-call events are telemetry; they do not
control completion.

## End-to-end validation

`agent/.env` contains the live E2B, VCS, and Netmind/Viettel MiniMax settings.
Never print its values.

```bash
make sandbox-template
cd agent && pytest tests/test_harness_live.py -m live -q -s

curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repo": "owner/repo",
    "prompt": "Inspect the repository and report its latest commit.",
    "profile": "general_agent",
    "provider": "github",
    "host": "github.com"
  }'
```

Rebuild the E2B template whenever `Dockerfile.sandbox`, `runtime/`,
`profiles/`, or the Pi package lock changes. Controller-only changes need a
controller restart, not a template rebuild.
