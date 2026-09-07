# Development

## Quick start

### Prerequisites

Install Node.js 22.19 or newer, pnpm 11.1.3, and Docker Desktop. The default sandbox provider is local microSandbox, so Docker and Apple Silicon or Linux KVM are required. You also need a [GitHub App](#github-app-setup). Model connections are added from **Settings** after signing in.

### 1. Configure credentials

Create the environment file:

```bash
cp .env.example .env
```

Fill these values in `.env`:

```dotenv
APP_SESSION_SECRET=<at-least-32-random-characters>
VCS_ENCRYPTION_KEY=<64-hex-characters>
LLM_ENCRYPTION_KEY=<different-64-hex-characters>

GITHUB_APP_CLIENT_ID=<github-app-client-id>
GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
```

After signing in, add an API-key or subscription connection in **Settings**. The endpoint type selection derives the provider and API format; users do not enter a provider ID.

Keep the default local sandbox values unless you are intentionally using E2B.

Configure the GitHub App callback as `http://localhost:8080/auth/github/callback`. The dashboard requires GitHub App sign-in by default, so `APP_SESSION_SECRET`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET` must be valid before the controller starts.

### 2. Run setup

From the repository root:

```bash
make setup
```

This installs the locked dependencies, starts local Postgres, applies migrations, builds the app runtime archives for amd64/arm64, and loads the default project image into microSandbox. It is safe to run again after pulling changes.

### 3. Start development

```bash
make dev
```

This starts Postgres if needed, applies pending migrations, and launches the controller on port 8080 and the dashboard on port 3000 through one Turbo process. Open [http://localhost:3000](http://localhost:3000), sign in with GitHub, select a repository, and start a session with a small prompt such as `What does this repository do?`.

The first run should move through `queued`, `running`, and `succeeded`. The sandbox calls the local controller through `host.microsandbox.internal`.

Stop the development process with `Ctrl-C`. Postgres remains running and can be stopped with `docker compose down` when you are finished.

## GitHub App setup

Create a GitHub App from **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**. Set the local homepage to `http://localhost:3000` and the user authorization callback to `http://localhost:8080/auth/github/callback`. Enable user authorization during installation, keep user-to-server token expiration enabled, and grant the following repository permissions:

- **Contents: Read and write** — clone private repositories and push agent branches and commits.
- **Metadata: Read-only** — resolve repository and branch metadata.
- **Pull requests: Read and write** — read pull requests and create, update, and review them.

Do not grant **Workflows** unless the agent is explicitly allowed to edit `.github/workflows/**`. Install the App only on repositories that the agent should access. Organization owners may need to approve the installation or later permission increases. After changing permissions, reapprove the installation and reconnect the GitHub identity.

Copy the App Client ID and Client Secret into `.env` using the names already present in `.env.example`:

```dotenv
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_APP_REDIRECT_URI=http://localhost:8080/auth/github/callback
```

## Optional: Azure DevOps

Register an application in [Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), then add the exact callback `http://localhost:8080/vcs/connections/azure-devops/callback` and the `vso.code` and `vso.profile` permissions. Set these values in `.env`:

```dotenv
AZURE_DEVOPS_CLIENT_ID=<client-id>
AZURE_DEVOPS_CLIENT_SECRET=<client-secret>
AZURE_DEVOPS_TENANT_ID=common
AZURE_DEVOPS_REDIRECT_URI=http://localhost:8080/vcs/connections/azure-devops/callback
```

Restart `make dev`, sign in with GitHub, open **Settings**, and use the Azure DevOps **Connect** action.

## Optional: E2B

E2B is useful when the controller is not running on a machine that can create local microVMs. It requires an E2B account and a public callback URL.

Start a tunnel in a separate terminal:

```bash
ngrok http --url <your-domain>.ngrok.app 8080
```

Update `.env`:

```dotenv
SANDBOX_PROVIDER=e2b
CONTROL_PLANE_URL=https://<your-domain>.ngrok.app
E2B_API_KEY=<your-e2b-api-key>
E2B_TEMPLATE=pi-cloud-agent
```

Build the hosted template and restart the app:

```bash
pnpm sandbox:template
pnpm sandbox:runtime
make dev
```

For E2B, keep the tunnel running for the entire run. GitHub webhooks also require a public URL when you want GitHub to initiate runs, regardless of which sandbox provider is selected.

## Optional: validation and live runs

Run the normal checks with:

```bash
make verify
```

Useful narrower checks are `pnpm lint`, `pnpm test`, `pnpm test:integration`, and `pnpm docs:check`. A real sandbox/model run uses credentials and may incur cost:

```bash
LIVE_TEST_REPO=owner/repository pnpm test:live
```

Rebuild the app runtime after changing runtime code or dependencies:

```bash
pnpm sandbox:runtime
```

This artifact is used by both providers. Rebuild the default project image with `pnpm sandbox:image` (or `pnpm sandbox:template` for E2B) only when changing its toolchains. Build runtime archives before building the controller Docker image: its build context includes `packages/runtime/dist`. For other packaging layouts, set `SANDBOX_RUNTIME_DIR` to the archive directory.

The image provides Node/npm/pnpm, Python/pip/venv/uv, Git/GitHub CLIs, common shell utilities, and native build tools. Repository-specific dependencies belong in a per-repository custom image; see [packages/runtime/README.md](packages/runtime/README.md#image-contract).

Build a project image from a supported distribution; there is no required app parent image or agent runtime to copy:

```dockerfile
FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends <toolchain> \
    && rm -rf /var/lib/apt/lists/*
```

Enter the public OCI reference in Settings > Environments. **Test environment** optionally checks app installation and library loading; it does not run a model task. Supported bases are Debian 12/13 and Ubuntu 22.04/24.04. The app adds its runtime inside the sandbox and launches it as an unprivileged user. Language toolchains remain the image author's choice.

To verify installation and warm resume with plain Debian, without model or forge credentials:

```bash
pnpm vitest run --project live packages/sandbox/project-image.live.test.ts
```

## Troubleshooting

| Symptom | Check |
|---|---|
| microSandbox cannot boot | Confirm Docker is running, `make setup` completed, and the host supports Apple Silicon or Linux KVM. |
| Local sandbox produces no events | Confirm the controller log uses `http://host.microsandbox.internal:8080`, keep `MICROSANDBOX_ALLOW_HOST=true`, and restart after changing `.env`. |
| E2B produces no events | Confirm ngrok is running, the public `/healthz` endpoint works, and `CONTROL_PLANE_URL` is the current tunnel URL. |
| Port 5532, 8080, or 3000 is busy | Stop the conflicting service or update the matching local configuration. |

For run inspection, cancellation, database queries, and provider-specific operations, see [docs/operations.md](docs/operations.md). For the trust boundary and lifecycle, see [ARCHITECTURE.md](ARCHITECTURE.md).
