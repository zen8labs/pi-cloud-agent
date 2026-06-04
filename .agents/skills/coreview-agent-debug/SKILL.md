---
name: coreview-agent-debug
description: Diagnose and fix failures in the CoReview agentic PR-review system (agent/) — runs stuck or failing, no review posted, webhooks not arriving, the in-sandbox supervisor/clone/OpenCode failing, or sessions showing wrong status. Use when a PR review run misbehaves and you need the debugging playbook: where to look (Sessions UI live log, controller logs, E2B dashboard, Postgres), the two-image rebuild rule, and the taxonomy of known failures with fixes. NOT for first-time setup (use coreview-agent-setup) or understanding how the system is built / rebuilding it (use build-pr-review-agent).
---

# Debugging the CoReview agent

## Where to look (in this order)

1. **Dashboard → Sessions** (`/sessions`): the primary surface. Pick the run →
   live log streams every supervisor + OpenCode event via SSE; the header shows
   final `status` + `error`. The whole sandbox log is forwarded here (the E2B
   **Logs tab only shows `sleep infinity`**, not our supervisor — it runs as a
   detached command). Backend behind it: `GET /runs`, `/runs/{id}`,
   `/runs/{id}/events`, `/runs/{id}/stream` (SSE), `POST /runs/{id}/cancel`.
   The dashboard reaches the controller via `AGENT_API_URL` (default `http://localhost:8080`).
2. **Controller logs**: `docker compose logs -f agent` (the `agent` service). JSON
   lines: `run queued → provisioning → running → publishing`. (`db-1 … checkpoint`
   lines are routine Postgres — ignore.)
3. **E2B dashboard**: shows the live sandbox (Monitoring/Filesystem). Use **Kill**
   here only as a last resort — it does NOT notify the controller (see orphans below).
4. **Postgres**: Adminer at `http://localhost:8081` (server `db`, user/pass
   `coreview`, db `coreview_agent`). Inspect `runs`, `run_events`, `findings`.

## THE rule: two images, two rebuilds

After editing code, the change only takes effect in the right image:
- **Controller** (`core/`): `docker compose up -d --build agent`.
- **Sandbox** (`runtime/`, `bundles/`, `Dockerfile.sandbox`): `make sandbox-template`
  (rebuilds the E2B template). A controller restart will NOT pick up `runtime/` changes.

When a sandbox-side fix "does nothing," you almost always forgot `make sandbox-template`.

## Failure taxonomy (symptom → cause → fix)

**Webhook never arrives** (no `parsed pull_request` log)
- Check **GitHub App → Advanced → Recent Deliveries** first (use Redeliver to retest).
  `401` = `GITHUB_WEBHOOK_SECRET` mismatch (must equal the App's secret; restart after editing `.env`).
  Connection failed = wrong URL/tunnel — URL must be `https://<tunnel>/webhooks/github`; verify `curl https://<tunnel>/healthz`.
  Delivered `2xx` but "nothing happens" = you're watching the wrong terminal (`db-1` compose logs vs the controller). Quick tunnels rotate URLs on restart.
- Don't run `make up` (agent on :8080) AND `make dev` (uvicorn on :8080) together.

**Supervisor never runs** (E2B logs stop at "Sandbox created"; controller stuck after `create_sandbox.ok`)
- Cause: relying on the E2B template `start_cmd` — it runs at *build*, not per-create.
- Fix: the provider must explicitly `sandbox.commands.run("python -m runtime.entrypoint", background=True, envs=..., cwd="/app")` after create (see `core/sandbox/e2b_provider.py`).

**Run hangs as "running" / "provisioning"**
- External E2B kill or a controller restart orphans it (completion logic is in-memory).
- Fixes already in place: startup `reconcile_orphaned_runs` marks in-flight runs `failed` on boot; `POST /runs/{id}/cancel` (the Sessions **Kill** button) stops the sandbox + marks `cancelled`. To clear stuck rows now: restart the controller, or hit Kill.

**`git clone failed: … could not create work tree dir '/workspace/…': Permission denied`**
- Non-root user can't write root-owned `/workspace`. Fix: `chmod 1777 /workspace` in `Dockerfile.sandbox` → `make sandbox-template`.

**`[coreview-git-credentials] … Permission denied: '/run/coreview'`**
- `/run` is a root-owned runtime tmpfs the user can't `mkdir` into. Fix: cache under `/tmp/coreview` (`runtime/constants.py`) → `make sandbox-template`.

**`could not read Username for 'https://github.com/…'` / `403` during clone**
- Auth. Either (a) the GitHub App private key is malformed — `.env` stores the PEM with literal `\n`; `core/vcs/github.py::_private_key_pem` restores newlines (rebuild controller), or (b) the App lacks **Contents: Read** (and **Pull requests: Read & write** to post). Verify in isolation: `TEST_REPO=<owner/repo> make test-live` runs `tests/test_vcs_live.py` (mint token + real clone).

**OpenCode "unknown model" / model errors**
- `AGENT_MODEL` prefix routing. OpenCode model keys can't contain slashes; the supervisor maps `provider/a/b` → key `b`, `name="a/b"`. For a custom gateway prefix it needs `@ai-sdk/openai-compatible`. Isolate the agent layer with `make test-live` (`tests/test_harness_live.py`).

## Isolating layers fast (opt-in live tests)

```bash
make test-live                                   # all live checks (self-skip w/o creds)
pytest -q -m live tests/test_llm.py              # LLM gateway reachable from controller
pytest -q -m live tests/test_sandbox_live.py     # E2B sandbox starts + runs a command
pytest -q -m live tests/test_harness_live.py     # template ships OpenCode + answers a prompt
TEST_REPO=<owner/repo> pytest -q -m live tests/test_vcs_live.py  # token mint + clone
```

Run the layer matching the failing stage; the assertion prints the real error
(tokens redacted). Most live tests need `.env` (conftest loads it) + an `E2B_TEMPLATE` built.
