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

4. **Bridge** (`runtime/bridge.py`, in-sandbox): creates an OpenCode session, opens `/event` SSE stream *before* injecting the prompt, translates parts into controller events, POSTs terminal `{status: done}`. **Outbound-only** — the controller never dials into the sandbox.

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

## Critical pins and invariants

- **OpenCode is pinned to `1.14.41`** everywhere (`Dockerfile.sandbox`, bridge, `opencode.jsonc`). A later release changed the `/event` SSE behavior — bumping breaks the bridge silently (connects but receives zero events). Re-validate the entire SSE path before upgrading.
- **`Dockerfile.sandbox` changes require `make sandbox-template`** — the E2B template is a baked image. Controller-only changes just need a restart.
- **Secrets never enter the sandbox** (except LLM keys — acknowledged exposure). Git credentials are brokered per-request via `runtime/git_credential_helper.py` → `/internal/runs/{id}/git-credentials`. The sandbox holds only a per-run bearer token scoped to that one run.
- **Single-replica reconciliation bug**: `reconcile_orphaned_runs` on boot fails *all* in-flight runs unconditionally — safe only with one controller replica. Do not run multiple replicas until this is fixed.

## State

Postgres, four tables: `runs`, `run_events`, `findings`, `repo_flags`. Schema is auto-created via `init_db()` on boot (no Alembic migrations scaffolded yet). Adminer runs at `localhost:8081` after `make up` (server: `db`, user/pass: `coreview`, db: `coreview_agent`).

## Environment variables

```
E2B_API_KEY, E2B_TEMPLATE=coreview-agent
DATABASE_URL=postgresql+asyncpg://...
GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
AGENT_MODEL=aigateway/MiniMax/MiniMax-M2.7
OPENAI_BASE_URL=<self-hosted gateway>
OPENAI_API_KEY=<gateway key>
CONTROL_PLANE_URL=<public HTTPS URL for sandbox callbacks>
AGENT_RUN_WORKER=1   # default — API + worker in one process
DEFAULT_REVIEW_MODE=agentic  # or legacy per-repo via repo_flags table
```

## Testing tiers

- **Default** (`make test`): no external services; API tests use throwaway SQLite. Covers webhook verification, bundle→task mapping, harness bus translation, config/model routing, VCS webhook parsing, and full FastAPI round-trips.
- **Live** (`make test-live`): reads `agent/.env`; each test self-skips if its required keys are absent. Tests LLM reachability, E2B sandbox create/stop, and OpenCode harness boot.

## Web app (`web/`)

Next.js 16 App Router, React 19, Tailwind 4. Pages: `/` (redirect), `/sessions/[id]` (run detail + live event log), `/chat` (agent chat), `/settings`. API client in `web/lib/api.ts` talks to the controller at `localhost:8080`. Types in `web/lib/types.ts` mirror the controller's Pydantic models.
