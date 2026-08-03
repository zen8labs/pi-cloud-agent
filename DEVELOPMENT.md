# Development

This guide takes a new checkout from zero to a real agent run. It covers the local services, E2B sandbox template, public callback tunnel, model gateway, and the checks to run before opening a pull request.

The important network constraint is simple: the controller never connects to an E2B sandbox. The sandbox calls the controller over `CONTROL_PLANE_URL`, so that URL must be public and reachable for the entire run.

## 1. Create the required accounts

You need:

- An [E2B account](https://e2b.dev/docs) for hosted sandboxes. Create an API key in the E2B dashboard. The application uses this as `E2B_API_KEY`.
- An [ngrok account](https://dashboard.ngrok.com/signup) for a stable HTTPS callback into the local controller. Copy the authtoken from the ngrok dashboard. If your account has a development domain, use it so `CONTROL_PLANE_URL` does not change whenever ngrok restarts.
- Credentials for an OpenAI-compatible model gateway. The default configuration expects the MiniMax model through an AI gateway, but any compatible endpoint can be used if `AGENT_MODEL`, `AIGATEWAY_BASE_URL`, and `AIGATEWAY_API_KEY` agree.
- A GitHub App and, optionally, an Azure DevOps Microsoft Entra app. GitHub App authorization creates the application session and GitHub connection; Azure DevOps is connected later from Settings. See the GitHub App setup instructions below.

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

# Optional: how long an idle session's filesystem remains resumable (default 7 days)
SESSION_WORKSPACE_RETENTION_SECONDS=604800
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

This builds `packages/runtime`, creates the `pi-cloud-agent` E2B template with 4 CPUs and 4096 MiB of memory, and snapshots an inert `sleep infinity` process. The controller starts the real runtime after sandbox creation or workspace resume because per-run prompts and credentials do not exist at template-build time.

The E2B CLI writes account-specific template metadata to `packages/runtime/e2b.toml`. That generated file is gitignored: keep it local and do not commit its team or template IDs.

Rebuild the template after changing:

- `packages/runtime/**`
- `packages/runtime/Dockerfile.sandbox`
- the pinned Pi agent dependency used by the runtime

Controller and dashboard changes do not require a template rebuild.

## 6. Configure repository access

### GitHub App setup

Create a GitHub App from **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**. Follow GitHub's [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) guide and [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) reference.

Set the homepage URL to the dashboard URL and the callback URL to `http://localhost:8080/auth/github/callback` for local development, or `https://<controller-host>/auth/github/callback` for a deployed controller.

Leave **Expire user authorization tokens** enabled and enable **Request user authorization (OAuth) during installation**. Install the App on the personal or organization account that owns the repositories and select only the repositories Pi should access.

Enable **Repository → Contents: Read and write** and **Repository → Metadata: Read-only**.

Copy the GitHub App Client ID and generate a Client Secret. Users authorize through GitHub; they do not enter a PAT.

### Azure DevOps setup

Register an application in [Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), add the exact callback URL `http://localhost:8080/vcs/connections/azure-devops/callback` under Web redirect URIs, and add **Azure DevOps → API permissions → `vso.code` and `vso.profile`**. Grant admin consent if the tenant requires administrator approval. Use `AZURE_DEVOPS_TENANT_ID=common` for a multitenant Entra app, or the directory ID for a single-tenant app.

See Microsoft's [Azure DevOps Microsoft Entra OAuth guide](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops) for the registration and consent model.

### Controller configuration

Configure the GitHub App before opening the dashboard; GitHub App sign-in is required to create the application session. Azure DevOps is optional and is connected after sign-in from Settings:

```dotenv
# GitHub App user authorization.
APP_AUTH_REQUIRED=true
APP_SESSION_SECRET=<at-least-32-random-characters>
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_APP_REDIRECT_URI=http://localhost:8080/auth/github/callback
VCS_ENCRYPTION_KEY=<64-hex-characters>

# Azure DevOps / Microsoft Entra ID, if needed
AZURE_DEVOPS_CLIENT_ID=<client-id>
AZURE_DEVOPS_CLIENT_SECRET=<client-secret>
AZURE_DEVOPS_TENANT_ID=common
AZURE_DEVOPS_REDIRECT_URI=http://localhost:8080/vcs/connections/azure-devops/callback
```

Set a 64-character hex `VCS_ENCRYPTION_KEY`, restart the controller, open **Settings**, and use the provider's **Connect** button. The repository selector then loads repositories from the connected identities.

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

Use the dashboard after signing in with GitHub App. The operator API requires the browser's authenticated session cookie, so unauthenticated curl requests intentionally return `401`.

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
