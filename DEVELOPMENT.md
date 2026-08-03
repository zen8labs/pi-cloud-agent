# Development

This guide takes a new checkout from zero to a real agent run. The default path uses a local microSandbox VM and a local controller callback. E2B remains an optional hosted backend when you need it.

The important network constraint is simple: the controller never connects to a sandbox. The sandbox calls the controller over `CONTROL_PLANE_URL`, so that URL must be reachable from the selected provider for the entire run.

## 1. Create the required accounts

You need:

- Docker Desktop, because the local runtime image is built from `packages/runtime/Dockerfile.sandbox`.
- Credentials for an OpenAI-compatible model gateway. The default configuration expects the MiniMax model through an AI gateway, but any compatible endpoint can be used if `AGENT_MODEL`, `AIGATEWAY_BASE_URL`, and `AIGATEWAY_API_KEY` agree.
- A GitHub App and, optionally, an Azure DevOps Microsoft Entra app. GitHub App authorization creates the application session and GitHub connection; Azure DevOps is connected later from Settings. See the GitHub App setup instructions below.
- An [E2B account](https://e2b.dev/docs) and an [ngrok account](https://dashboard.ngrok.com/signup) only if you select `SANDBOX_PROVIDER=e2b`.

E2B sandboxes and model requests cost money. Live tests never run in CI.

## 2. Install local tools

Install:

- Node.js 22.19 or newer
- pnpm 11.1.3 (the version pinned in `package.json`)
- Docker with Docker Compose
- ngrok, only when using E2B

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

## 4. Configure the local sandbox

The default provider is microSandbox. It runs a hardware-isolated local VM and reaches the host controller at `host.microsandbox.internal`. The provider allows only the configured controller port on the host when `MICROSANDBOX_ALLOW_HOST=true`; it does not grant unrestricted host access.

Build the OCI image after installing dependencies:

```bash
pnpm sandbox:image
```

The command builds `pi-cloud-agent:local` and loads the Docker archive into the microSandbox image cache. It is the default `MICROSANDBOX_IMAGE`. Keep these values in `.env`:

```dotenv
SANDBOX_PROVIDER=microsandbox
CONTROL_PLANE_URL=http://host.microsandbox.internal:8080
MICROSANDBOX_IMAGE=pi-cloud-agent:local
MICROSANDBOX_ALLOW_HOST=true
```

The image's normal command is overridden by the provider. The controller injects the run environment and starts `/app/run.js` only after the VM is ready.

`pi-cloud-agent:local` is only a local image tag. For deployment, publish the same image to an OCI registry with an immutable tag, for example `ghcr.io/your-org/pi-cloud-agent:<git-sha>`, and set `MICROSANDBOX_IMAGE` to that reference on the controller host. The machine running the controller must also run microSandbox with Apple Silicon or Linux KVM; this provider does not turn microVM creation into a remote SaaS API.

## 5. Configure ngrok for E2B (optional)

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
SANDBOX_PROVIDER=e2b
CONTROL_PLANE_URL=https://<your-domain>.ngrok.app
```

Keep ngrok running while developing. If an assigned URL changes, update `CONTROL_PLANE_URL` and restart the controller before creating another run. Otherwise the sandbox will produce no events and fail after the silence timeout.

The controller is not running yet, so an ngrok `502 Bad Gateway` at this point is expected. After starting the controller, this must return `{"ok":true}`:

```bash
curl https://<your-domain>.ngrok.app/healthz
```

## 6. Configure E2B and the model

When using E2B, fill the following values in `.env`:

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

The model settings are used by both providers.

## 7. Configure repository access

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

## 8. Start the development stack

Use separate terminals so logs remain readable.

Terminal 1 — ngrok, only when using E2B:

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

Confirm the local health endpoint:

```bash
curl http://localhost:8080/healthz
```

When using E2B, also confirm the public endpoint:

```bash
curl https://<your-domain>.ngrok.app/healthz
```

Terminal 4 — dashboard:

```bash
pnpm web
```

Open [http://localhost:3000](http://localhost:3000). Create a session using a public repository and a small prompt such as `What does this repository do?`. A healthy run progresses through `queued`, `running`, and `succeeded`, and its event stream begins with `git.cloned`.

Use the dashboard after signing in with GitHub App. The operator API requires the browser's authenticated session cookie, so unauthenticated curl requests intentionally return `401`.

## 9. Validate changes

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

After changing the runtime, image, sandbox provider, callback handling, or model configuration, rebuild the local image or E2B template and run the live suite:

```bash
pnpm sandbox:image
LIVE_TEST_REPO=owner/repository pnpm test:live
```

For E2B, use `pnpm sandbox:template` instead of `pnpm sandbox:image`.

`LIVE_TEST_REPO` must name a repository the configured forge credential can clone, or a public repository when running without forge credentials. Without it, the live test is intentionally skipped and does not validate a sandbox or model request.

See [docs/testing.md](docs/testing.md) for test boundaries and [docs/operations.md](docs/operations.md) for run inspection, cancellation, database queries, and symptom-based diagnosis.

## Troubleshooting first startup

| Symptom | Check |
|---|---|
| Controller rejects configuration | Compare `.env` with `.env.example`; do not leave the database URL missing. |
| microSandbox cannot boot | Confirm Docker is running, `pnpm sandbox:image` completed, and the host supports Apple Silicon or Linux KVM. |
| Local sandbox cannot report events | Confirm the controller log shows `controlPlaneUrl=http://host.microsandbox.internal:8080`, keep `MICROSANDBOX_ALLOW_HOST=true`, and restart the controller after changing `.env`. A stale ngrok/cloudflared URL is not repaired by changing the provider. |
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

Stopping the controller or ngrok does not stop Postgres. Sandboxes are reclaimed by the reconciler after terminal runs, cancellation, or timeout.
