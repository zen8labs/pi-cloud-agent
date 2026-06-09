# Cloud Agent

Agentic cloud-agent runtime for CoReview. A **minimal, task-agnostic core** (sandbox + VCS + harness + API) plus **capability bundles** that specialize it. The first bundle is **PR code review**; the same core is meant to later run other agents (complete-a-PR, Excel, deep-research, …) by adding bundles, not by changing the core.

---

## Mental model

```
webhook ─▶ core (FastAPI)
             ├─ verify + flag (legacy → pr-agent | agentic → here)
             ├─ mint a repo-scoped SCM token + bake it into the sandbox env
             └─ E2B sandbox ─▶ OpenCode harness ─▶ pr-review bundle
                                  (split → reviewers → critic)
                                     └─ posts its own PR review via `gh`
           ◀─ telemetry only (events + terminal status); no publish step
```

- **Core is task-agnostic.** It knows about sandboxes, VCS, a harness, and runs — not about "PR review." It launches the agent with context and gets out of the way.
- **The agent actuates its own outcomes.** It posts PR comments, pushes fixes, etc. by calling tools / running commands (`gh`, `git`, the VCS API) with the baked SCM token. There is **no structured-output contract** and no controller-side publish step — if a call fails, the agent observes the error and retries.
- **Bundles are the specialization.** A bundle = a task builder + per-harness **skill/subagent** prompt files (+ optional plugin tools). Adding a new agent vertical is a new bundle, no core changes.
- **Harness is swappable.** OpenCode today, behind a `HarnessAdapter` so pi-agent / Claude Agent SDK can drop in later. Behavioral logic lives in skill prompts; only prompt assets are harness-specific.
- **Security model:** the SCM token is baked into the sandbox env. See [Security model](#security-model) for the trade-off and when to revisit it.

## Layout

```
agent/
  core/
    api/         FastAPI app + routes: webhooks, internal bridge callbacks, runs
    vcs/         github · gitlab · bitbucket  [+ azure_devops later]
    sandbox/     SandboxProvider contract + E2B provider
    harness/     HarnessAdapter contract + opencode adapter  [+ pi/claude later]
    llm/         controller-side LLM service (LiteLLM → MiniMax gateway)
    config/      settings, model routing (pr-agent style), repo flags
    state/       Postgres: runs, run_events, repo_flags (+ claim logic)
    orchestrator/ run lifecycle (runner) · worker · in-proc event bus
    bundles.py   bundle registry/loader
  bundles/
    pr_review/   bundle.py · task.py
                 opencode/{opencode.jsonc, skills/, subagents/}
  runtime/       in-sandbox supervisor (entrypoint) · bridge · constants · log-config
  tests/         unit + API integration tests; opt-in live tier (E2B, MiniMax)
  Dockerfile           controller image (FastAPI + worker)
  Dockerfile.sandbox   sandbox image (OpenCode + runtime) → E2B template
  docker-compose.yml   Postgres + controller
  e2b.toml             E2B template config
  Makefile · pyproject.toml · README.md
```

## Key decisions

- **Language:** Python core (copy-paste pr-agent's VCS/webhook/config/model routing; controller↔harness is an HTTP boundary regardless).
- **Sandbox:** **E2B** — PaaS now, self-host in our VPC later via the open-source `e2b-dev/infra` (no code change, same SDK).
- **Harness:** **OpenCode** server, headless, inside the sandbox, behind an adapter.
- **State:** **Postgres** for runs/events/results. **No Cloudflare Durable Objects** 
- **VCS:** GitHub primary; GitLab + Bitbucket day 0; Azure DevOps later.
- **Model routing:** follow pr-agent (LiteLLM, config/DB-driven); the controller picks the model and injects it into the harness's provider config.
- **Tools:** the agent uses the harness's built-in tools + CLIs (`gh`, `git`); bundles add plugin tools only when needed.

## Security model

> ⚠️ **Deliberate trade-off — read before pointing this at untrusted PRs.**

The controller mints a **repo-scoped, short-lived (~1h) SCM token** and **bakes it
into the sandbox env** (`SCM_TOKEN`, plus `GH_TOKEN`/`GITHUB_TOKEN` for `gh`). The
agent uses it to clone, push, and post its own PR comments. This is what makes the
agent versatile and the wrapper thin — but it means a write-capable token lives in
the sandbox for the whole run.

The sandbox also runs the PR author's code. So the exfiltration risk is real **only
when both** of these hold:

1. the PR author is **untrusted** (a fork / external contributor), **and**
2. the agent **executes** that PR's code (build / `npm install` / tests) — a
   malicious `postinstall` or test hook could read `SCM_TOKEN` and ship it out.

It is **safe** when either is false:

- **Internal repos only** — authors already have write access; a leaked
  repo-scoped token gains them nothing. ✅
- **Pure static review** — the agent only reads files and never runs PR code, so
  no attacker code executes. ✅

**Current posture:** the token carries the GitHub App's full grant (repo-scoped but
not permission-scoped), and the token lives in env for the run. This is accepted for
now. **Tripwire — revisit before accepting external/fork PRs whose code we execute.**
Planned hardening when that day comes: per-call token brokering with permission
downscoping (`contents:read` for clone, `pull_requests:write` only for the comment
step) and/or mint→use→revoke. See `core/orchestrator/runner.py::_scm_token_env`.

## Prerequisites (target)

- Python 3.12+
- Postgres (shared with the existing stack)
- An **E2B** account / `E2B_API_KEY` (PaaS), or self-hosted E2B later
- VCS app credentials (GitHub primary; GitLab + Bitbucket day 0) for webhook verification + short-lived clone tokens + comment posting
- LLM provider keys, configured the pr-agent way

Expected env:

```
E2B_API_KEY=...
DATABASE_URL=postgres://...
# VCS app creds (per provider)
GITHUB_APP_ID=... / GITHUB_PRIVATE_KEY=...
GITLAB_TOKEN=... / BITBUCKET_...=...
# LLM provider keys + model routing (per pr-agent config)
```

## Quick start

```bash
cp .env.example .env      # fill E2B_API_KEY, a GitHub token/app, an LLM key
make install              # pip install -e ".[dev]"
docker compose up db -d   # starts Postgres db in detached mode
make dev                  # starts dev with uvicorn (port 8080)
# or, against your own Postgres:  make dev
# in another terminal:
ngrok http 8080
# check connection
curl <your-ngrok-url>/healthz
```

The controller runs the API **and** an embedded worker in one process (`AGENT_RUN_WORKER=1`, the default). See [How to test](#how-to-test) for driving it with a real PR, and [How to deploy](#how-to-deploy) for remote deployment.

Below instructions are for running the agent with docker.

## E2B setup

The agent runs each review inside an [E2B](https://e2b.dev) sandbox — a Firecracker microVM built from `Dockerfile.sandbox` (OpenCode `1.16.2` + our `runtime/` + `bundles/`). Set this up once.

### 1. Account + API key

1. Create an account at **https://e2b.dev** and open the **Dashboard**.
2. Copy your **API key** (Dashboard → *Keys*) into `.env` as `E2B_API_KEY=...`.
   - Free PaaS tier is enough to start; billing/usage is in the dashboard.

### 2. Install + authenticate the CLI

```bash
npm i -g @e2b/cli         # requires Node 18+
e2b --version
e2b auth login           # opens a browser; or: export E2B_API_KEY=... before commands
```

### 3. Build & publish the sandbox template

The template is the prebuilt image E2B boots per run. Build it from `Dockerfile.sandbox` and name it `coreview-agent`:

```bash
make sandbox-template
# == e2b template build -c "python -m runtime.entrypoint" -d Dockerfile.sandbox --name coreview-agent
```

This pushes the image to your E2B account and prints a **template id**. Set it in `.env`:

```
E2B_TEMPLATE=coreview-agent     # the --name you built (or the template id)
```

Rebuild the template whenever `runtime/`, `bundles/`, or `Dockerfile.sandbox` change. (The first build takes a few minutes — it installs Node 22 + OpenCode + plugins.)

### 4. (Later) self-hosting in your VPC

E2B's infrastructure is open source (`e2b-dev/infra`, Terraform). To move off PaaS, deploy it in your VPC and point the SDK at it — **no code change**, same `E2B_API_KEY`/`E2B_TEMPLATE` flow. This is the planned path once the flow is validated on PaaS.

> **Model note:** the default model is the self-hosted **MiniMax** served
> OpenAI-compatibly (`AGENT_MODEL=aigateway/MiniMax/MiniMax-M2.7`), matching
> `../pr-agent`. Set `OPENAI_BASE_URL` to your gateway and `OPENAI_API_KEY` to its
> key — these are used by both the controller LLM service and the in-sandbox
> OpenCode harness (the runtime injects them as an OpenCode `openai` provider
> with the gateway `baseURL`). OpenCode is pinned to `1.16.2` (1.14.42–1.15.x broke the SSE endpoint;
> 1.16.2 restores it and fixes the subagent hang); keep the pin.

## How to test

End-to-end local testing means: run the controller on your machine, expose it to the internet so a real Git host can reach the webhook **and** the sandbox bridge can dial back, build the E2B sandbox template, then open a PR.

### 1. Build the E2B sandbox template

See [E2B setup](#e2b-setup) above — you need `E2B_API_KEY`, the `coreview-agent` template built, and `E2B_TEMPLATE` set in `.env`.

### 2. Create a GitHub App

The controller uses a GitHub App for webhook delivery, cloning, and posting comments. Create one if you don't already have one:

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in the basics:
   - **GitHub App name:** any name (e.g. `coreview-dev`)
   - **Homepage URL:** any URL (e.g. your tunnel URL or `https://example.com`)
   - **Webhook URL:** `https://<your-tunnel-host>/webhooks/github` *(you'll start the tunnel in step 3 — come back and fill this in, or update it after the tunnel is running)*
   - **Webhook secret:** generate a random string (e.g. `openssl rand -hex 32`) and paste it here; you'll put the same value in `.env`.
3. Set **Repository permissions**:
   - **Contents:** Read-only (for cloning)
   - **Pull requests:** Read & write (for reading diffs and posting review comments)
   - **Issues:** Read-only (required to subscribe to `Issue comment` events, which is how PR comments are delivered to the webhook)
4. Subscribe to **events**:
   - **Pull request** — triggers an automatic review when a PR is opened or synced
   - **Issues** — triggers a review when someone comments `/review` on a PR *(only available after enabling Issues read permission above)*
5. Click **Create GitHub App**.
6. On the app's settings page, note the **App ID**.
7. Scroll to **Private keys** → **Generate a private key** → download the `.pem` file. Keep it safe.
8. Click **Install App** (left sidebar) → install it on your test repo (or org).

### 3. Configure credentials in `.env`

```
GITHUB_APP_ID=<App ID from step 2>
GITHUB_APP_PRIVATE_KEY=<contents of the downloaded .pem file, or path to it>
GITHUB_WEBHOOK_SECRET=<the webhook secret you set in step 2>
```

- **LLM:** set `AGENT_MODEL=aigateway/MiniMax/MiniMax-M2.7`, `OPENAI_BASE_URL` to your self-hosted gateway, and `OPENAI_API_KEY` to its key (same as `../pr-agent`).

### 4. Start the controller + expose it publicly

The sandbox bridge dials `CONTROL_PLANE_URL`, so it must be a **public** URL (not `localhost`). Use a tunnel:

```bash
make up                                  # controller on :8080 (+ Postgres)
# in another terminal:
ngrok http 8080
```

Copy the public URL it prints and set it in `.env`, then restart:

```
CONTROL_PLANE_URL=https://<your-tunnel-host>
```

Go back to your GitHub App settings and update the **Webhook URL** to `https://<your-tunnel-host>/webhooks/github` if you used a placeholder earlier.

### 5. Install the GitHub App on your test repo

If you chose **Only select repositories** during installation in step 2.8, make sure your test repo is in the list. GitHub → **Settings → Developer settings → GitHub Apps → [your app] → Install App** to add or change repositories.

(GitLab → register the webhook at `…/webhooks/gitlab` with `X-Gitlab-Token` = `GITLAB_WEBHOOK_SECRET`; Bitbucket → `…/webhooks/bitbucket`.)

### 6. Trigger a review

Open a PR on the test repo (or comment `/review` on an existing one). Then watch:

```bash
# the controller logs show: run queued → provisioning → running → succeeded
# poll run status (the X-CoReview-Run header on the webhook 202 gives the id):
curl localhost:8080/runs/<run_id> | jq
```

A successful run has the **agent itself** post inline + summary comments back on the PR (via `gh`, using the baked SCM token — the controller no longer publishes). To keep a repo on the **legacy** `../pr-agent` reviewer during rollout, insert a `repo_flags` row (`provider, full_name, review_mode='legacy'`); default is `agentic`.

### 7. Access the web app

There is a simple web app to view the sessions and chat with the agent. Start it with:

```bash
make web-dev
```

### DB tables

After `make up` (or `docker compose up adminer`), open http://localhost:8081 to view the db tables. Config:
  - System: PostgreSQL
  - Server: db
  - Username: coreview
  - Password: coreview
  - Database: coreview_agent

### Automated tests (two tiers)

```bash
make test        # default tier — no external services (pytest -m "not live")
make test-live   # opt-in live tier (E2B, MiniMax gateway)
make lint        # ruff
make compile     # fast syntax check across core/ bundles/ runtime/
```

**Default tier** (runs anywhere; the API tier uses a throwaway SQLite DB):
- `tests/test_smoke.py` — webhook signature verify, bundle→task mapping, harness bus→event translation.
- `tests/test_config.py` — model routing, fallbacks, egress allowlist parsing.
- `tests/test_llm.py` — the LLM service builds correct LiteLLM/gateway args and honours fallback ordering (mocked).
- `tests/test_sandbox.py` — E2B env assembly + provider create/stop (mocked SDK).
- `tests/test_harness.py` — OpenCode adapter runtime env, bus translation, timeout.
- `tests/test_vcs.py` — GitLab + Bitbucket webhook verify/parse.
- `tests/test_api.py` — real FastAPI app over SQLite: `/healthz`, webhook signature rejection, webhook→run creation→`/runs/{id}` read-back, internal bridge callbacks (events, findings, status), and token auth.

**Live tier** (opt-in — reads secrets from ``agent/.env`` via ``tests/conftest.py``; each test still self-skips if its required keys are missing):

```bash
make test-live   # all @pytest.mark.live tests (LLM + E2B + harness)

# Or run one service at a time:
pytest tests/test_llm.py::test_minimax_gateway_reachable_live -m live
pytest tests/test_sandbox_live.py -m live
pytest tests/test_harness_live.py -m live
```

Required keys in ``agent/.env`` (see ``.env.example``):

| Live test file | Required env vars |
|----------------|-------------------|
| ``test_llm.py`` | ``OPENAI_BASE_URL``, ``OPENAI_API_KEY`` (and optionally ``AGENT_MODEL``) |
| ``test_sandbox_live.py`` | ``E2B_API_KEY`` |
| ``test_harness_live.py`` | ``E2B_API_KEY``, ``E2B_TEMPLATE``; OpenCode prompt test also needs ``OPENAI_BASE_URL`` |
| ``test_vcs_live.py`` | ``TEST_REPO`` (e.g. `org/repo`) + ``GITHUB_TOKEN`` or ``GITHUB_APP_ID``/``GITHUB_APP_PRIVATE_KEY`` |

Shell exports still win over ``.env``; test fixtures (SQLite ``DATABASE_URL``, etc.) are never overridden by ``.env``.

`make test` runs the default tier and skips the live tier automatically.

## How to deploy

The controller is a standard container; the sandbox runs on E2B (PaaS now, self-hosted later — no code change). Two images:

| Image | Built from | Runs where |
|---|---|---|
| controller | `Dockerfile` | your server / VPC (FastAPI + worker) |
| sandbox | `Dockerfile.sandbox` → `e2b.toml` | E2B (one per review run) |

### 1. Publish the sandbox template

Same as testing step 1 (`make sandbox-template`), from CI or a release step whenever `runtime/` or `bundles/` change. Pin `opencode-ai` in `Dockerfile.sandbox` for reproducibility.

### 2. Deploy the controller

Any container host (a VM with Docker, ECS/Fargate, Cloud Run, or k8s). It needs:

- a reachable **Postgres** (`DATABASE_URL`),
- a **public HTTPS** ingress for `/webhooks/*` and the sandbox callbacks (`CONTROL_PLANE_URL` must be this public URL),
- the `.env` secrets (`E2B_API_KEY`, VCS creds, LLM key).

```bash
# build & push
docker build -t <registry>/coreview-agent:<tag> .
docker push <registry>/coreview-agent:<tag>

# run (example: plain Docker on a VM)
docker run -d --name coreview-agent --env-file .env -p 8080:8080 \
  -e CONTROL_PLANE_URL=https://agent.yourco.com \
  -e DATABASE_URL=postgresql+asyncpg://USER:PASS@db-host:5432/coreview_agent \
  <registry>/coreview-agent:<tag>
```

Put TLS/ingress (Caddy, Nginx, an ALB, or the platform's built-in) in front so `https://agent.yourco.com` terminates to the container's `:8080`.

### 3. Scaling notes

- **Workers:** the embedded worker uses `FOR UPDATE SKIP LOCKED`, so you can run multiple controller replicas and they won't double-process runs. For a dedicated worker tier, run replicas with `AGENT_RUN_WORKER=1` and the API tier with `AGENT_RUN_WORKER=0`. (Note: the in-process event bus is per-process — for a split API/worker tier, promote `core/orchestrator/bus.py` to Redis pub/sub.) ⚠️ Before running **more than one replica**, fix the single-replica orphan-reconciliation bug — see [Known issues](#known-issues).
- **E2B self-host:** point the SDK at your `e2b-dev/infra` deployment; no app change.
- **Migrations:** `init_db()` auto-creates tables on boot for convenience; for production use Alembic (dependency already included) and disable auto-create.

## Known issues

Tracked bugs to fix before the relevant scale-out. Unchecked = open; this list is the canonical record (the code and `ARCHITECTURE.md` point here).

- [ ] **Orphan reconciliation is single-replica only.** On boot, `reconcile_orphaned_runs` (`core/state/repo.py`) marks *every* in-flight run (`provisioning` / `running` / `publishing`) as `failed` to clear runs stranded by a crash. With more than one controller replica, booting/restarting one replica also fails runs the *other* replicas are still actively processing. The `runs.claimed_at` lease column exists but isn't consulted yet. **Fix:** only reconcile runs whose `claimed_at` lease has expired (or gate reconciliation behind leader election / a heartbeat reaper) before running multiple replicas. Safe as-is for the default single-process deployment.

## Implementation status & known TODOs

This is a working MVP, ported faithfully from the proven `ref/background-agents` OpenCode integration. The seams compile, import, and pass smoke tests. Remaining items need validation on a first live run:

- **OpenCode `1.16.2`** (`runtime/bridge.py`, `runtime/entrypoint.py`, `bundles/pr_review/opencode/opencode.jsonc`): the session/`/event`-SSE/prompt driving and config are validated against this pin. Keep the pin; if you upgrade OpenCode, re-validate the full bridge SSE path (parent idle, subagent idle, parent idle after subagent). Subagent agent-file frontmatter (`mode: subagent`) should be confirmed on first run (bodies still load as agent prompts regardless).
- **`report_finding` tool** (`bundles/pr_review/tools/report_finding.js`): now an `@opencode-ai/plugin` `tool()` (the reference's proven pattern), posting to `/internal/runs/{id}/findings` — not an MCP server.
- **E2B SDK specifics** (`core/sandbox/e2b_provider.py`): confirm `connect`/resume parameter names and pause semantics against the installed `e2b` version.
- **Bitbucket inline comments** (`core/vcs/bitbucket.py`): anchor `to`/`from` placement is best-effort; verify against a real repo. GitLab/Bitbucket post per-comment (no bundled review like GitHub).
- **Sandbox egress allowlist**: passed as env to the sandbox; strict network egress firewalling is enforced at the template/self-host layer (deferred).
- **LLM keys in the sandbox**: the in-sandbox agent needs them to call the model (unlike git creds, which are brokered). Mitigated by egress allowlist + ephemeral sandboxes; planned hardening is a controller-side LLM proxy.

## Bundles

A capability bundle lives under `bundles/<name>/` and provides:

- `tools/` — **MCP tool servers** (portable substrate; behavioral logic here)
- `task.py` — turns a trigger (e.g. a PR webhook) into a `TaskSpec`
- `schema.py` — the bundle's structured output contract
- `<harness>/` — per-harness assets (e.g. `opencode/skills`, `opencode/subagents`)

Adding a bundle does **not** touch the core. Adding a harness means one adapter porting prompt assets; tools and core are untouched.

### Deferred (tracked, not built yet)

- Triage gate (gate cheap PRs before booting a sandbox)
- Snapshot / warm-pool latency optimization (E2B `pause`/`resume` + prebuilt templates)
- Knowledge base (old mem0 layer **dropped**; redesigned later as MCP tools)
- Live streaming / multiplayer UI (SSE + Redis if/when needed)
- Azure DevOps provider

## Implementation blueprint: `../ref/background-agents/`

The Ramp-inspired Open-Inspect reference is cloned at `../ref/background-agents/`. Its control-plane is TS/Cloudflare (we don't use that), but its **`packages/sandbox-runtime` is Python and ports almost directly** into our core: the supervisor (`entrypoint.py`), the outbound `bridge.py`, the `git_credential_helper.py`, GitHub-App auth, OpenCode plugins/tools, and a capability-flagged `SandboxProvider` interface (E2B ≈ their Daytona persistent provider). 

## Relationship to `../pr-agent/`

`../pr-agent/` is the legacy one-shot reviewer, kept as a fallback behind a feature flag. `agent/` does not import from it — reusable pieces are **copy-pasted/ported** in. Once `agent/` is proven, `../pr-agent/` will be deleted.
