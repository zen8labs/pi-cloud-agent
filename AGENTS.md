# AGENT.md

This file provides guidance to coding agents when working with this repository.

## Repository layout

```
agent/         Python controller + sandbox runtime (FastAPI + worker + E2B)
  core/        Task-agnostic kernel: api, vcs, sandbox, harness, llm, config, state, orchestrator
  bundles/     Capability bundles: pr_review, general_agent
  runtime/     In-sandbox supervisor (entrypoint.py), bridge, git-cred-helper
  tests/       Unit + API integration tests; opt-in live tier
  Dockerfile           Controller image
  Dockerfile.sandbox   Sandbox image → E2B template
  e2b.toml             E2B template config (4 GB RAM, 4 CPU)
web/           Next.js 16 + React 19 + Tailwind 4 dashboard (sessions, chat, settings)
```

## Commands

All Python work runs from `agent/`; all web work runs from `web/`.

```bash
# Agent
make install          # pip install -e ".[dev]"
make dev              # uvicorn on :8080 (API + embedded worker)
make up               # docker compose up (Postgres + controller)
make test             # pytest -m "not live"  — no external services
make test-live        # pytest -m live        — E2B, MiniMax gateway (reads agent/.env)
make lint             # ruff check core bundles runtime
make compile          # fast syntax check (no deps needed)
make sandbox-template # build/publish E2B template from Dockerfile.sandbox

# Web
make web-dev          # cd web && npm run dev  (:3000)
cd web && npm run build
cd web && npm run lint
```

**Run a single test:**
```bash
cd agent && pytest tests/test_api.py -q
cd agent && pytest tests/test_llm.py::test_minimax_gateway_reachable_live -m live
```

## Architecture: two-process, two-trust-zone

The system has **four roles across two trust zones**:

1. **Controller** (`agent/core/`, trusted VPC): FastAPI + embedded worker in one process (`AGENT_RUN_WORKER=1`). Verifies webhooks, queues runs in Postgres, brokers secrets, publishes results to VCS. Holds all secrets; never executes untrusted code.

2. **Sandbox** (E2B Firecracker microVM, untrusted): boots `Dockerfile.sandbox` — the baked template. Runs the PR author's code.

3. **Supervisor** (`runtime/entrypoint.py`, PID-1 in sandbox): clones the repo, starts OpenCode, drives the review via the bridge, forwards logs to the controller as events.

4. **Bridge** (`runtime/bridge.py`, in-sandbox): runs the task with one **synchronous** `POST /session/{id}/message` (blocks until the whole run incl. subagents completes — its return is the authoritative `done`/`error`), while a **separate best-effort task** streams `/event` SSE progress (tokens, tool calls, subagents) to the controller as telemetry. **Outbound-only** — the controller never dials into the sandbox.

**Request lifecycle:** webhook → verify → create `Run` (Postgres) → 202 → worker claims run (`FOR UPDATE SKIP LOCKED`) → create E2B sandbox → supervisor boots → bridge drives OpenCode → `report_finding` tool POSTs findings to `/internal/runs/{id}/findings` → controller publishes to VCS → sandbox stopped.

**Event relay seam:** The bridge POSTs to `core/api/routes/internal.py`, which `publish()`es onto an in-process per-run bus (`core/orchestrator/bus.py`). The harness adapter's `run()` subscribes and yields `Event`s back to `execute_run`. This is why the API and worker must share a process by default — to split them, promote the bus to Redis.

## Core contracts (extension points)

All extension points are `typing.Protocol`s with factory functions. **Do not add capability-specific logic to the orchestrator** — push it into a bundle or provider instead.

| Contract | File | Factory |
|---|---|---|
| `VCSProvider` | `core/vcs/base.py` | `get_vcs_provider(name)` |
| `SandboxProvider` | `core/sandbox/provider.py` | `get_sandbox_provider()` |
| `HarnessAdapter` | `core/harness/base.py` | `get_harness_adapter(name)` |
| `Bundle` | `core/bundles.py` | `get_bundle(name)` |

`TaskSpec` (in `core/types.py`) is the pivot: bundles turn raw webhook triggers into `TaskSpec`; the orchestrator drives that — it never sees provider-specific shapes.

## Bundles

A bundle under `bundles/<name>/` contributes:
- `tools/` — OpenCode plugin tools (behavioral logic; portable across harnesses)
- `task.py` — `build_task(trigger) → TaskSpec`
- `schema.py` — structured output contract
- `opencode/` — per-harness prompt assets: `skills/`, `subagents/`, `opencode.jsonc`

The `pr_review` bundle runs a **split → fan-out reviewer → critic → report_finding** flow declared in the skill prompt, not in controller code.

## Live debugging

All bridge logs, subagent steps, and findings land in `run_events`. Query them:

```bash
RUN_ID=<run_id>

# Live tail
curl -N localhost:8080/runs/$RUN_ID/stream

# All events
curl -s localhost:8080/runs/$RUN_ID/events | jq '.events[]'

# Bridge diagnostics (progress heartbeats, idle signals, timeouts)
curl -s localhost:8080/runs/$RUN_ID/events \
  | jq '.events[] | select(.type == "log") | {seq, event: .data.event, data: .data}'

# Subagent step counts (logged every 5 steps — high count + reason=tool-calls = spinning)
curl -s localhost:8080/runs/$RUN_ID/events \
  | jq '.events[] | select(.data.event == "bridge.subagent_step_count")'

# Recent runs
docker compose exec db psql -U coreview -d coreview_agent -c \
  "SELECT id, status, bundle, created_at FROM runs ORDER BY created_at DESC LIMIT 10;"

# All events for a run (direct Postgres)
docker compose exec db psql -U coreview -d coreview_agent -c \
  "SELECT seq, type, data->>'event', created_at FROM run_events WHERE run_id='$RUN_ID' ORDER BY seq;"
```

Key `bridge.*` events: `run_start` (bridge up), `review_complete` (sync `/message` returned ⇒ run done), `subagent_start`/`subagent_idle` (subagent telemetry labels), `subagent_step_count` (spinning check), `inactivity_timeout` (no SSE telemetry for 120 s ⇒ session aborted), `prompt_timeout` (sync call exceeded the wall-clock read timeout), `progress` (60 s heartbeat with elapsed + per-subagent step counts), `telemetry_error` (SSE pump hiccup — non-fatal).

## Web app (`web/`)

Next.js 16 App Router, React 19, Tailwind 4. Pages: `/` (redirect), `/sessions/[id]` (run detail + live event log), `/chat` (agent chat), `/settings`. API client in `web/lib/api.ts` talks to the controller at `localhost:8080`. Types in `web/lib/types.ts` mirror the controller's Pydantic models.

## End-to-end testing workflow

For testing controller-sandbox integration without external dependencies:

```bash
# 1. Ensure controller is running (with any env overrides for testing)
make up
# Or with a short watchdog for faster failure detection:
BRIDGE_SSE_INACTIVITY_TIMEOUT=30 make up

# 2. Create a test run via the API (example: subagent-heavy workload)
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repo":"oadtq/warp",
    "prompt":"Spawn multiple subagents to explore this repo in parallel. Ask one subagent to inspect Rust project structure, one to inspect package/build/test configuration, one to inspect UI/frontend structure, and one to summarize agent/automation conventions. Then merge their observations into a concise report. Do not modify files.",
    "bundle":"general_agent",
    "provider":"github",
    "host":"github.com"
  }'
# Returns: {"id":"...","status":"queued",...}

# 3. Poll for completion (run_id from previous step)
RUN_ID=<run_id>
# Watch live events:
curl -N localhost:8080/runs/$RUN_ID/stream
# Or poll status via database:
docker compose exec -T db psql -U coreview -d coreview_agent \
  -c "SELECT id, status, updated_at FROM runs WHERE id='$RUN_ID';"
```

**Key events to monitor:**
- `bridge.run_start` — bridge initialized, telemetry pump + inactivity watchdog armed
- `bridge.subagent_start` / `bridge.subagent_idle` — subagent spawned / finished (telemetry labels)
- `bridge.review_complete` — synchronous `/message` returned ⇒ run finished
- `bridge.inactivity_timeout` — watchdog fired (no telemetry for the window ⇒ session aborted)
- `status` + `done` — terminal state reached

**Timeout overrides for testing:**
- `BRIDGE_SSE_INACTIVITY_TIMEOUT` — seconds of SSE silence before watchdog aborts (default: 120)
- `BRIDGE_SSE_INACTIVITY_TIMEOUT_MIN` — clamp minimum (5)
- `BRIDGE_SSE_INACTIVITY_TIMEOUT_MAX` — clamp maximum (3600)

## Notices

- **`Dockerfile.sandbox` changes require `make sandbox-template`** — the E2B template is a baked image. Controller-only changes just need a restart.