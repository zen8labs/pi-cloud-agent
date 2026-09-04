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
GITHUB_WEBHOOK_SECRET=<high-entropy-webhook-secret>
GITHUB_MENTION=@pi-cloud-agent
# Optional: App-authored reviews/replies (Advanced settings -> Generate private key)
GITHUB_APP_ID=<numeric-github-app-id>
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

After signing in, add an API-key or subscription connection in **Settings**. The endpoint type selection derives the provider and API format; users do not enter a provider ID.

Keep the default local sandbox values unless you are intentionally using E2B.

Configure the GitHub App callback as `http://localhost:8080/auth/github/callback`. The dashboard requires GitHub App sign-in by default, so `APP_SESSION_SECRET`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET` must be valid before the controller starts. Webhook delivery also needs a public HTTPS URL; use the tunnel described below when GitHub cannot reach your laptop.

### 2. Run setup

From the repository root:

```bash
make setup
```

This installs the locked dependencies, starts the local Postgres container, applies migrations, builds the runtime image, and loads it into the microSandbox image cache. It is safe to run again after pulling changes.

### 3. Start development

```bash
make dev
```

This starts Postgres if needed, applies pending migrations, and launches the controller on port 8080 and the dashboard on port 3000 through one Turbo process. Open [http://localhost:3000](http://localhost:3000), sign in with GitHub, select a repository, and start a session with a small prompt such as `What does this repository do?`.

The first run should move through `queued`, `running`, and `succeeded`. The sandbox calls the local controller through `host.microsandbox.internal`.

Stop the development process with `Ctrl-C`. Postgres remains running and can be stopped with `docker compose down` when you are finished.

## GitHub App setup

Create a GitHub App from **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**. Set the homepage to `http://localhost:3000`, the user authorization callback (Redirect URI) to `http://localhost:8080/auth/github/callback`, and the Setup URL to `https://<public-controller-host>/integrations/github/setup`. Keep user-to-server token expiration enabled. Disable **Request user authorization (OAuth) during installation** so GitHub shows the Setup URL. The setup callback redirects to the dashboard, which completes the authenticated installation binding; this works even when the dashboard is on localhost and the webhook controller is on ngrok. The OAuth client id/secret, numeric App id, private key, webhook secret, and installation must all belong to this same GitHub App; do not mix a production App with a `-dev` App.

Configure the App webhook as:

- **Active:** on
- **Payload URL:** `https://<public-controller-host>/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same high-entropy value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Pull requests, Issue comments, and Pull request review comments

The controller filters actions to pull-request `opened`, `reopened`, `ready_for_review`, and `synchronize`, plus newly created comments that mention `GITHUB_MENTION`. It acknowledges a verified delivery quickly, stores it durably by `X-GitHub-Delivery`, and processes it asynchronously.

Grant the following repository permissions:

- **Contents: Read and write** — clone private repositories and push agent branches and commits.
- **Metadata: Read-only** — resolve repository and branch metadata.
- **Pull requests: Read and write** — read pull requests and create, update, and review them.
- **Issues: Read-only** — receive PR conversation events. The existing **Pull requests: Read and write** permission also authorizes comments on pull requests; add Issues: write only if non-PR issue replies become a supported trigger.

Do not grant **Workflows** unless the agent is explicitly allowed to edit `.github/workflows/**`. Install the App only on repositories that the agent should access. Organization owners may need to approve the installation or later permission increases. After changing permissions, reapprove the installation and reconnect the GitHub identity.

Copy the App Client ID and Client Secret into `.env` using the names already present in `.env.example`:

```dotenv
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_APP_REDIRECT_URI=http://localhost:8080/auth/github/callback
GITHUB_WEBHOOK_SECRET=<same-secret-configured-on-the-App>
GITHUB_MENTION=@pi-cloud-agent
GITHUB_APP_ID=<numeric-app-id>
GITHUB_APP_PRIVATE_KEY="<PEM private key; escaped newlines are accepted>"
```

Then validate the binding in this order:

1. Start the controller and dashboard, open the GitHub sign-in flow, and connect the GitHub identity.
2. From the App's **Install App** link, install it on a test repository. GitHub redirects to the Setup URL with `installation_id`; the callback returns to dashboard Settings, where the signed-in browser verifies the installation through the connected user token and stores the binding.
3. Open a test PR. The webhook should return `202`, create one `integration_deliveries` row, and enqueue one review session. Duplicate deliveries remain one row.
4. The review sandbox clones the PR head repository at the exact head SHA, fetches the base SHA for diff context, and calls the structured controller tool once. The controller posts one GitHub review with a Markdown summary plus inline diff comments.
5. A comment containing `GITHUB_MENTION` creates a task session pinned to the PR head. The agent must call `reply_github_comment` once; the controller publishes a reply to the original comment and records the result durably.

When `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are configured, controller-owned reviews and replies use a one-hour installation token and appear as the App (for example `zen8agent[bot]`). The connected user token remains the OAuth/login and checkout credential; it is used for publication only when App credentials are intentionally not configured. A configured App that cannot mint a token fails publication instead of silently changing attribution. Keep the private key only in the controller environment; it is never passed to a sandbox.

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

Rebuild the local image after changing `packages/runtime/**`, `packages/runtime/Dockerfile.sandbox`, or the runtime dependency:

```bash
pnpm sandbox:image
```

For E2B, use `pnpm sandbox:template` instead.

The image provides Node/npm/pnpm, Python/pip/venv/uv, Git/GitHub CLIs, common shell utilities, and native build tools. Repository-specific dependencies belong in the per-repository setup script in Settings > Environments; see [packages/runtime/README.md](packages/runtime/README.md#sandbox-tools-and-repository-setup).

## Troubleshooting

| Symptom | Check |
|---|---|
| microSandbox cannot boot | Confirm Docker is running, `make setup` completed, and the host supports Apple Silicon or Linux KVM. |
| Local sandbox produces no events | Confirm the controller log uses `http://host.microsandbox.internal:8080`, keep `MICROSANDBOX_ALLOW_HOST=true`, and restart after changing `.env`. |
| E2B produces no events | Confirm ngrok is running, the public `/healthz` endpoint works, and `CONTROL_PLANE_URL` is the current tunnel URL. |
| Port 5532, 8080, or 3000 is busy | Stop the conflicting service or update the matching local configuration. |

For run inspection, cancellation, database queries, and provider-specific operations, see [docs/operations.md](docs/operations.md). For the trust boundary and lifecycle, see [ARCHITECTURE.md](ARCHITECTURE.md).
