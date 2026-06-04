---
name: coreview-agent-setup
description: Onboard a developer to the CoReview agentic PR-review system (agent/) and get it running end-to-end. Use when setting up the project for the first time, getting a local/dev instance running, building the E2B sandbox template, wiring the GitHub App + webhook + tunnel, or doing a first real PR-review run. The agent should DO as much as possible itself (install deps, docker build/up, health checks, run tests, observe/diagnose) and only INSTRUCT the human for account-level steps it cannot do (creating E2B/GitHub-App accounts, pasting secrets, exposing a public tunnel). NOT for understanding how the system is built or rebuilding it (use build-pr-review-agent) or deep failure diagnosis (use coreview-agent-debug).
---

# Getting CoReview running (onboarding)

Goal: a working end-to-end PR review with minimal human effort. **Do every
machine step yourself**; for account/secret steps, give the human exact,
copy-pasteable instructions and wait. Verify each layer before the full run.

Work from `agent/`. Confirm the toolchain first: `docker`, `python3.12+`, `node`+`npm` (for the E2B CLI). If something's missing, offer to install it.

## Split of work

| You (the agent) DO | Human does (you INSTRUCT + wait) |
|---|---|
| `make install`, `docker compose up`, health checks, `make test`, build the E2B template, tail logs, run `make test-live`, diagnose | Create an **E2B account** + API key; create the **GitHub App**; provide the **LLM gateway** URL/key (client dependency); start a **public tunnel**; paste secrets into `.env` |

## Steps

### 1. [AGENT] Scaffold env + bring up the stack
```bash
cp .env.example .env
make install                       # pip install -e ".[dev]"
docker compose up -d --build       # Postgres + Adminer(:8081) + controller(:8080)
curl -s localhost:8080/healthz     # expect {"ok":true,...}
make test                          # default tier must pass (no external services)
```
If the controller can't start, read `docker compose logs agent` and fix before continuing.

### 2. [HUMAN → instruct] E2B account
Tell them: sign up at **https://e2b.dev**, copy the API key from the dashboard,
and give it to you. Then you set `E2B_API_KEY` in `.env`. Install + auth the CLI
yourself: `npm i -g @e2b/cli && e2b auth login` (this opens their browser — ask
them to complete the login).

### 3. [AGENT] Build the sandbox template
```bash
make sandbox-template              # builds Dockerfile.sandbox → E2B template "coreview-agent"
```
Set `E2B_TEMPLATE=coreview-agent` in `.env`. (Rebuild this whenever `runtime/`,
`bundles/`, or `Dockerfile.sandbox` change — see coreview-agent-debug.)

### 4. [HUMAN → instruct] LLM gateway (client dependency)
The model is gateway-agnostic. Ask the human for their OpenAI-compatible gateway
**base URL** + **API key** and the **model id**. You set `OPENAI_BASE_URL`,
`OPENAI_API_KEY`, and `AGENT_MODEL` (e.g. `openai/<model>`; a non-`openai`/custom
prefix uses `@ai-sdk/openai-compatible`). Verify it yourself:
`pytest -q -m live tests/test_llm.py` (proves the controller reaches the model).

### 5. [HUMAN → instruct] GitHub App
Walk them through **GitHub → Settings → Developer settings → GitHub Apps → New**:
- **Permissions:** Repository → **Contents: Read** + **Pull requests: Read & write** (required to clone + post the review).
- **Subscribe to events:** **Pull request** and **Issue comment**.
- **Webhook URL:** `https://<tunnel-host>/webhooks/github` (from step 6) · **Secret:** a random string · keep **Active** + SSL on.
- **Install** the App on the org/repo to review.
They give you: **App ID**, the **private key** (downloaded `.pem`), and the **webhook secret**. You set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.
(Note: pasting a multi-line PEM into `.env` — the loader tolerates literal `\n`. For quick local testing a `GITHUB_TOKEN` PAT with repo scope also works.)

### 6. [HUMAN → instruct] Public tunnel + CONTROL_PLANE_URL
The sandbox **and** GitHub must reach the controller over the internet. Ask them
to run `cloudflared tunnel --url http://localhost:8080` (or `ngrok http 8080`)
and give you the public URL. You set `CONTROL_PLANE_URL=https://<tunnel-host>`
in `.env` and use the same host in the App's webhook URL. Restart the controller
after `.env` edits: `docker compose up -d agent`. (Quick tunnels change URL on
restart — keep it running.)

### 7. [AGENT] Verify each layer, then do a real run
```bash
make test-live                                   # LLM + sandbox + harness + (with TEST_REPO) clone
```
Then ask the human to **open a PR** (or comment `/review`) on the installed repo.
Watch it: open the dashboard **Sessions** page, or
`curl -N localhost:8080/runs/<id>/stream`. A healthy run shows
`provisioning → running → git.clone_complete → opencode boot → findings → publishing`,
then inline + summary comments on the PR.

## If a run fails
Switch to **coreview-agent-debug** — it has the symptom→fix taxonomy (clone perms,
cred-cache path, App auth, orphaned runs, model routing) and the isolation tests.
Most first-run issues are: template not rebuilt, `CONTROL_PLANE_URL` still
localhost, webhook-secret mismatch, or the GitHub App missing Contents: Read.
