# Development

This guide takes a new checkout from zero to a real agent run. It covers the local services, E2B sandbox template, public callback tunnel, model gateway, and the checks to run before opening a pull request.

The important network constraint is simple: the controller never connects to an E2B sandbox. The sandbox calls the controller over `CONTROL_PLANE_URL`, so that URL must be public and reachable for the entire run.

## 1. Create the required accounts

You need:

- An [E2B account](https://e2b.dev/docs) for hosted sandboxes. Create an API key in the E2B dashboard. The application uses this as `E2B_API_KEY`.
- An [ngrok account](https://dashboard.ngrok.com/signup) for a stable HTTPS callback into the local controller. Copy the authtoken from the ngrok dashboard. If your account has a development domain, use it so `CONTROL_PLANE_URL` does not change whenever ngrok restarts.
- Credentials for an OpenAI-compatible model gateway. The default configuration expects the MiniMax model through an AI gateway, but any compatible endpoint can be used if `AGENT_MODEL`, `AIGATEWAY_BASE_URL`, and `AIGATEWAY_API_KEY` agree.
- Optional forge credentials. Public GitHub repositories work read-only without a token. Set `GITHUB_TOKEN` for private repositories or agent actions such as pushing commits and posting comments. A GitHub App is preferred for scoped, short-lived credentials; see [docs/secrets.md](docs/secrets.md).

E2B sandboxes and model requests cost money. Live tests never run in CI.

## 2. Install local tools

Install:

- Node.js 22.19 or newer
- pnpm 11.1.3 (the version pinned in `package.json`)
- Docker with Docker Compose
- ngrok

On macOS with Homebrew:

```bash
brew install node ngrok/ngrok/ngrok
brew install --cask docker
npm install --global pnpm@11.1.3
```

Start Docker Desktop, then verify the tools:

```bash
node --version
pnpm --version
docker compose version
ngrok version
```

## 3. Install the workspace

From the repository root:

```bash
pnpm install
cp .env.example .env
pnpm exec playwright install chromium
```

`.env` contains credentials and is gitignored. Never commit it or paste its contents into logs or issues.

## 4. Configure ngrok

Authenticate the ngrok agent once:

```bash
ngrok config add-authtoken <your-ngrok-authtoken>
```

Start the controller tunnel in its own terminal. Prefer the development domain assigned in the ngrok dashboard:

```bash
ngrok http --url <your-domain>.ngrok.app 8080
```

If you do not have a development domain, let ngrok assign a URL:

```bash
ngrok http 8080
```

Copy the HTTPS forwarding URL into `.env`:

```dotenv
CONTROL_PLANE_URL=https://<your-domain>.ngrok.app
```

Keep ngrok running while developing. If an assigned URL changes, update `CONTROL_PLANE_URL` and restart the controller before creating another run. Otherwise the sandbox will produce no events and fail after the silence timeout.

The controller is not running yet, so an ngrok `502 Bad Gateway` at this point is expected. After starting the controller, this must return `{"ok":true}`:

```bash
curl https://<your-domain>.ngrok.app/healthz
```

## 5. Configure E2B and the model

Fill the following values in `.env`:

```dotenv
E2B_API_KEY=<your-e2b-api-key>
E2B_TEMPLATE=pi-cloud-agent

AGENT_MODEL=aigateway/MiniMax/MiniMax-M2.7
AIGATEWAY_BASE_URL=https://<your-openai-compatible-gateway>/v1
AIGATEWAY_API_KEY=<your-model-api-key>
```

`AGENT_MODEL` has the form `provider/model`. The provider prefix is local configuration; everything after the first slash is sent to the gateway as the model name.

The repository includes the E2B CLI as a pinned development dependency. Sign in through the browser so the CLI is allowed to build templates:

```bash
pnpm --filter @pi-cloud-agent/runtime exec e2b auth login
```

The E2B SDK uses `E2B_API_KEY` from `.env` when the controller creates a sandbox. The CLI login is separately used by `pnpm sandbox:template` while building the template.

Build and publish the template:

```bash
pnpm sandbox:template
```

This builds `packages/runtime`, creates the `pi-cloud-agent` E2B template with 4 CPUs and 4096 MiB of memory, and snapshots an inert `sleep infinity` process. The controller starts the real runtime after sandbox creation because per-run prompts and credentials do not exist at template-build time.

The E2B CLI writes account-specific template metadata to `packages/runtime/e2b.toml`. That generated file is gitignored: keep it local and do not commit its team or template IDs.

Rebuild the template after changing:

- `packages/runtime/**`
- `packages/runtime/Dockerfile.sandbox`
- the pinned Pi agent dependency used by the runtime

Controller and dashboard changes do not require a template rebuild.

## 6. Configure repository access

For a first read-only run against a public GitHub repository, forge credentials may remain empty. To list private repositories or let the agent actuate changes, configure one of:

```dotenv
# Simple development option
GITHUB_TOKEN=<fine-grained-personal-access-token>

# Preferred long-term option
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<private-key>
GITHUB_WEBHOOK_SECRET=<webhook-secret>
```

To populate the dashboard repository selector explicitly:

```dotenv
WEB_REPOS=owner/repository,owner/another-repository
```

An empty `WEB_REPOS` asks the configured VCS provider what it can access. The dashboard also has a `Custom…` option for entering any `owner/repository`.

## 7. Start the development stack

Use separate terminals so logs remain readable.

Terminal 1 — ngrok, if it is not already running:

```bash
ngrok http --url <your-domain>.ngrok.app 8080
```

Terminal 2 — Postgres. Start only the database for host-based development; `pnpm up` starts the containerized controller too and would occupy port 8080:

```bash
docker compose up -d db
pnpm db:migrate
```

Terminal 3 — controller:

```bash
pnpm controller
```

Confirm both the local and public health endpoints:

```bash
curl http://localhost:8080/healthz
curl https://<your-domain>.ngrok.app/healthz
```

Terminal 4 — dashboard:

```bash
pnpm web
```

Open [http://localhost:3000](http://localhost:3000). Create a session using a public repository and a small prompt such as `What does this repository do?`. A healthy run progresses through `queued`, `running`, and `succeeded`, and its event stream begins with `git.cloned`.

You can also create a run without the dashboard:

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repository","prompt":"Report the latest commit.","profile":"general"}'
```

## 8. Validate changes

The normal CI-equivalent check is:

```bash
pnpm verify
```

Useful narrower checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm docs:check
```

After changing the runtime, template, sandbox provider, callback handling, or model configuration, rebuild the template and run the paid live suite:

```bash
pnpm sandbox:template
LIVE_TEST_REPO=owner/repository pnpm test:live
```

`LIVE_TEST_REPO` must name a repository the configured forge credential can clone, or a public repository when running without forge credentials. Without it, the live test is intentionally skipped and does not validate a sandbox or model request.

See [docs/testing.md](docs/testing.md) for test boundaries and [docs/operations.md](docs/operations.md) for run inspection, cancellation, database queries, and symptom-based diagnosis.

## Troubleshooting first startup

| Symptom | Check |
|---|---|
| Controller rejects configuration | Compare `.env` with `.env.example`; do not leave the database URL missing. |
| Template build returns 401 | Run `pnpm --filter @pi-cloud-agent/runtime exec e2b auth login` again and confirm the E2B account/team. |
| Sandbox cannot be created | Confirm `E2B_API_KEY`, `E2B_TEMPLATE=pi-cloud-agent`, and that `pnpm sandbox:template` completed. |
| Run has no events and later reports `sandbox went silent` | Verify ngrok is running, the public `/healthz` endpoint works, and the controller was restarted after changing `CONTROL_PLANE_URL`. |
| Clone fails | Try a public repository first, then verify forge token scope for private repositories. |
| Agent starts but inference fails | Verify the gateway URL, API key, model identifier, account balance, and gateway logs. |
| Port 5532, 8080, or 3000 is busy | Stop the conflicting service or update the matching local configuration. |

Stop the local containers when finished:

```bash
pnpm down
```

Stopping the controller or ngrok does not stop Postgres. E2B sandboxes are reclaimed by the reconciler after terminal runs, cancellation, or timeout.
