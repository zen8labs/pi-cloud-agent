---
name: build-pr-review-agent
description: How to build — or rebuild from scratch — a cloud-based agentic PR-review agent like CoReview's agent/. It is a task-agnostic "cloud agent" core (webhook controller + ephemeral sandbox + server-first coding harness) plus a PR-review capability bundle. Use when a developer wants to recreate this system from nothing, understand how and why it was built, replicate the architecture for a new product/deployment, or evaluate the build sequence, component contracts, and key design decisions. NOT for operating an existing instance (use coreview-agent-setup) or diagnosing a failing run (use coreview-agent-debug).
---

# Build a cloud agentic PR-review agent (from scratch)

This is the build guide for `agent/`. The thesis: instead of stuffing a diff into
one LLM prompt (the deprecated `../pr-agent`), put a capable model **in a
tool-calling loop, on a real checkout, in a sandbox** — so it pulls context on
demand, runs linters/tests, and grounds findings before posting. Build a
**task-agnostic core** and add **capability bundles**; PR review is the first.

**Read alongside this:** `references/building-a-cloud-agent.md` (the patterns +
rationale + what's deferred). **Port from, don't reinvent:** `ref/background-agents`
(Open-Inspect) is a working sandbox-runtime/bridge to adapt; the Ramp post
(https://builders.ramp.com/post/why-we-built-our-background-agent) is the "why."
`agent/ARCHITECTURE.md` is the in-repo design record.

## Target architecture (what you're building)

```
VCS webhook → CONTROLLER (your VPC, holds secrets)
   verify+flag → queue(Postgres) → worker → runner
   → provision SANDBOX (ephemeral microVM) from a prebuilt template
       → SUPERVISOR clones repo, starts HARNESS, drives review, dials home
   ← findings → publish inline+summary comments
```

Four roles, two trust zones: **controller** (trusted), **sandbox** (untrusted,
non-root), **supervisor+bridge** (in-sandbox glue that dials the controller
*outbound*), **harness** (the agent runtime). See the reference §2 for why.

## Stack choices (and the reasoning)

- **Controller: Python + FastAPI.** Async webhooks; lets you copy-paste mature
  VCS/webhook logic from existing tools. The controller↔harness boundary is HTTP
  regardless, so language unification buys little.
- **Sandbox: E2B** (Firecracker microVMs; PaaS now, self-host later). Provider is
  swappable behind a contract (Modal/Daytona/Docker also fit).
- **Harness: OpenCode, server-first, pinned `1.14.41`.** Don't build a bespoke
  agent loop — drive a real one. Server-first = drivable from any controller; open
  source = the agent can read its own runtime. Pin the version (an SSE change
  after 1.14.41 breaks the bridge). Keep it swappable behind an adapter.
- **State: Postgres** (runs, events, findings, flags) — replaces the reference's
  Cloudflare Durable Objects with VPC-native pieces.
- **Tools: MCP** so behavioral logic is portable across harnesses; only prompt
  assets are harness-specific.

## Components to build (each is a contract)

| Component | Contract / responsibility |
|---|---|
| `core/types.py` | `TaskSpec`, `RepoRef`, `RunLimits`, `ModelSpec` — the shared vocabulary |
| `core/config` | settings (env), per-repo legacy/agentic flag, model routing |
| `core/state` | Postgres models + a run repo with `FOR UPDATE SKIP LOCKED` claim |
| `core/vcs/base.py` | `VCSProvider`: verify/parse webhook, mint clone token, get PR, publish inline+summary |
| `core/sandbox/provider.py` | `SandboxProvider`: create/resume/stop + capability flags + transient/permanent errors |
| `core/harness/base.py` | `HarnessAdapter`: `runtime_env`, `start`, `run` (stream events), `stop` |
| `core/bundles.py` | `Bundle`: portable MCP tools + a `build_task` + per-harness prompt assets |
| `core/orchestrator` | the run lifecycle (runner), the worker, an in-process event bus |
| `core/api` | FastAPI: webhook intake, internal bridge callbacks, run status/stream |
| `runtime/` (sandbox-side) | supervisor (clone, start harness, drive), bridge (outbound callbacks), git credential helper |
| `bundles/pr_review/` | the skill (split→review→critic→report), subagents, `report_finding` tool, `opencode.jsonc` |

## Build sequence (milestones — build in this order)

1. **Contracts + skeleton.** Write the Protocols above + `core/types.py`. Stub
   factories. Stand up FastAPI with `/healthz` and Postgres `init_db`.
2. **Webhook → run.** One VCS provider's `verify_and_parse_webhook` + a `runs`
   table + the worker claim loop. A PR open creates a queued run. (No sandbox yet.)
3. **Sandbox boot.** `SandboxProvider` for your backend; **explicitly launch the
   supervisor after create** (don't rely on the template start command — it runs
   at build, not per-create). Prove a trivial in-sandbox command round-trips.
4. **Harness in the sandbox.** Port `ref/background-agents` supervisor+bridge:
   clone the repo via a **brokered credential helper**, start the harness server,
   inject the prompt, stream `/event` SSE back to the controller. Get one prompt
   answered against your model.
5. **The bundle.** `pr_review` skill + subagents + a `report_finding` MCP/plugin
   tool that POSTs findings to the controller. Controller publishes grounded
   findings as inline+summary comments. **This is the first real review.**
6. **Hardening.** Orphan reconciliation on boot, cancel/killswitch, the Sessions
   live-log (forward supervisor logs as events), fast-fail on supervisor errors,
   feature flag for side-by-side rollout, the live test tiers.

## Non-obvious things to get right (hard-won)

- **Two images.** Controller code and sandbox code (`runtime/`+`bundles/`+
  `Dockerfile.sandbox`) ship in *different* images; the sandbox runs the **baked**
  template, so sandbox changes need a template rebuild, not a controller restart.
- **Outbound bridge.** The sandbox dials the controller (NAT/firewall-friendly);
  the controller never reaches in. `CONTROL_PLANE_URL` must be reachable from the
  sandbox (a public URL in dev).
- **Non-root sandbox.** Everything the agent writes must be user-writable
  (`/workspace`, `/tmp/...`); never root-owned `/run` (a runtime tmpfs).
- **Brokered git creds, no baked secrets.** Mint a short-lived App installation
  token per clone via a git credential helper. Clone/read = App (bot) token;
  human-attributed writes = the user's OAuth token (don't mix — see reference §4).
- **LLM keys do enter the sandbox** (the agent runs there); mitigate with egress
  limits + ephemerality; a controller-side LLM proxy is the planned hardening.
- **In-process event bus** ⇒ API + worker share a process; promote to Redis to split.
- **Model routing is gateway-agnostic;** the gateway URL/keys are deployment
  config, never hardcoded.

For the deeper rationale on every point above — sandbox economics (prebuilt
images, snapshots, warm pools), read-during-sync, isolation, observability,
sub-agent fan-out, and the deferred roadmap — read
`references/building-a-cloud-agent.md`.
