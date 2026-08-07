# Operations

Running it, watching it, and working out what went wrong.

## Local setup

For first-time account setup, dependencies, local microSandbox image creation, and the first real run, follow [DEVELOPMENT.md](../DEVELOPMENT.md). This document assumes the development environment is configured and focuses on operating it.

`.env` at the repository root configures the controller. It is gitignored and holds live credentials. **Never print its values.**

The Settings page manages the GitHub App and Azure DevOps connections. GitHub App sign-in is required and dashboard resources are scoped to the signed-in user. A connected VCS token is still exposed to the untrusted sandbox for the duration of a run; see [secrets.md](secrets.md).

### The one setting people get wrong

`CONTROL_PLANE_URL` must be reachable **from inside the sandbox**, because the sandbox is outbound-only and reports back over it. With the default local microSandbox provider, use its host gateway:

```dotenv
CONTROL_PLANE_URL=http://host.microsandbox.internal:8080
MICROSANDBOX_ALLOW_HOST=true
```

With a hosted provider like E2B, `http://localhost:8080` is unreachable and every run goes silent until the reconciler times it out.

For E2B, use the authenticated ngrok tunnel configured during development:

```bash
ngrok http --url <your-domain>.ngrok.app 8080
```

Set `CONTROL_PLANE_URL` to that HTTPS URL and restart the controller after any change. A run that provisions, produces no events, and fails ten minutes later with "stopped reporting" is almost always this.

If a run has a sandbox id but no events, check the machine before changing model settings:

```bash
msb status
msb inspect <sandbox-id>
msb ping <sandbox-id>
msb exec <sandbox-id> -- cat /tmp/pi-cloud-agent-runtime.log
```

After changing `packages/runtime/**`, an existing machine still contains the old bundled runtime. Rebuild and reload the image with `pnpm sandbox:image`, then retry the run. A stale image can report removed variables such as `AGENT_MODEL` even though the current controller injects only the `LLM_*` contract.

## When to rebuild the sandbox image or template

Rebuild the local image after changing `packages/runtime/**`, `Dockerfile.sandbox`, or the pinned agent harness version:

```bash
pnpm sandbox:image
```

For E2B, rebuild the hosted template instead:

```bash
pnpm sandbox:template
```

Controller-only changes need a restart, not a rebuild. The build bundles the runtime to a single file and writes `dist/package.json` pinning the harness to the version the bundle was typechecked against, so the image cannot drift from the workspace.

## Watching a run

```bash
RUN_ID=<run-id>

# live, resumable. Every frame carries its sequence number
curl -N localhost:8080/runs/$RUN_ID/stream

# history
curl -s localhost:8080/runs/$RUN_ID/events | jq '.events[]'

# resume from a cursor
curl -s "localhost:8080/runs/$RUN_ID/events?afterSeq=42" | jq '.events[]'
```

## Reading the state directly

```bash
psql() { docker compose exec -T db psql -U pi_cloud_agent -d pi_cloud_agent "$@"; }

# recent runs
psql -c "select id, status, repo_full_name, attempt, created_at
         from runs order by created_at desc limit 10;"

# one run's event log
psql -c "select seq, type, data->>'event', created_at
         from run_events where run_id='$RUN_ID' order by seq;"

# what the reconciler is looking at: in-flight work
psql -c "select id, status, sandbox_id, last_event_at, deadline_at, claim_expires_at
         from runs where status in ('queued','provisioning','running');"

# machines that should have been reclaimed
psql -c "select id, status, sandbox_provider, sandbox_id
         from runs where sandbox_id is not null and sandbox_stopped_at is null;"

# durable sessions and their parked workspaces
psql -c "select id, active_run_id, latest_run_id, turn_count, sandbox_id, workspace_expires_at
         from sessions order by updated_at desc limit 10;"
```

## What a healthy run looks like

```text
status: queued → provisioning → running → succeeded
events: git.cloned → git.checkout_ready → setup.skipped
        → agent.session_start → token… → tool_call… → agent.turn_end
        → agent.session_complete → status{done}
```

The terminal evidence is a `status` event followed by the run row reaching `succeeded` or `failed`. **Token and tool-call events are telemetry and never control completion**. A run that streamed a thousand tokens and never reported a status is a timeout, not a success.

## Diagnosing by symptom

| Symptom | Cause | Where to look |
|---|---|---|
| stuck in `queued` | reconciler not running, or `SANDBOX_PROVIDER` misconfigured | controller logs at startup |
| `failed` immediately, "could not create a sandbox" | bad provider configuration, missing local image, or missing E2B template | `pnpm sandbox:image` or `pnpm sandbox:template` |
| `running`, no events, fails with "stopped reporting" | `CONTROL_PLANE_URL` is unreachable from the sandbox, or the detached runtime failed before it could report | the controller log, `msb logs <sandbox-id>`, `msb exec <sandbox-id> -- cat /tmp/pi-cloud-agent-runtime.log` while the microSandbox is running, and the selected provider's network path |
| events stop mid-run, then "wall-clock budget" | the agent genuinely ran long | `RUN_WALL_CLOCK_SECONDS` |
| `git.clone_branch_failed` then a successful clone | the named branch is gone; fell back to the default | benign |
| `attempt` climbing | retryable provisioning failures | the provider's error in the logs |
| session stays `parking` | reconciler has not suspended or released the terminal turn | controller logs and `runs.sandbox_stopped_at` |
| follow-up clones again | parked workspace expired or disappeared | `sessions.workspace_expires_at`, `git.cloned`; Pi history still resumes |

## Cancelling and cleanup

```bash
curl -X POST localhost:8080/runs/$RUN_ID/cancel
```

Cancelling only writes state. The reconciler reclaims the machine on its next tick, using the same path as a crash or a timeout. There is no separate teardown code to go wrong.

## Restarts and deploys

Restarting the controller is safe at any moment. In-flight runs keep working: their sandboxes are still running and still reporting, and whichever process comes up next finishes the bookkeeping. Nothing is force-failed.

On `SIGINT`/`SIGTERM` the reconciler stops claiming and drains in-flight provisioning before exiting, so a sandbox whose id has not yet been stored is not leaked.

→ [resumability.md](resumability.md) for why this works.

## Live validation

Costs money; needs real credentials in `.env`.

```bash
pnpm sandbox:image
LIVE_TEST_REPO=owner/repository pnpm test:live
```

For E2B, select `SANDBOX_PROVIDER=e2b` and use `pnpm sandbox:template`.

Create runs from the dashboard after signing in with GitHub. Direct operator API calls must include the authenticated browser session cookie; unauthenticated requests intentionally return `401`.

## Plugins marketplace

Operators listed in `OPERATOR_GITHUB_LOGINS` can seed `marketplace/plugins` and manage review/install modes. Any signed-in user can install plugins and configure variables from the **Plugins** page.

```bash
pnpm db:migrate
pnpm plugins:seed   # publishes every package under marketplace/plugins as approved / default_off
```

Set `PLUGIN_OAUTH_REDIRECT_URI` to a browser-reachable controller URL (for local
dev usually `http://localhost:8080/plugins/oauth/callback` — not the sandbox
gateway host). Keep `PLUGIN_OAUTH_ISSUER_ALLOWLIST` tight (default `auth.exa.ai`).

Demo with Context7: Install → Configure with a key from https://context7.com/dashboard → start a `general` run that asks about a library API.

Demo with Exa: Install → **Connect** (OAuth) → start a `general` run that needs live web search. Paste an API key under Configure only as a fallback.

Plugin skills are composed into the task prompt; MCP arrives as resolved `MCP_CONFIG` in the sandbox (never from the cloned repo).

Yanked versions cannot newly attach; in-flight runs keep the plugin set pinned on `runs.plugins`.

Create the session from the dashboard after signing in with GitHub, then use its conversation UI for the follow-up turn.

The live test performs this as two real turns and verifies the Pi session id, uncommitted file, provider workspace id, and absence of a second clone. Run it after changing the sandbox image, runtime, session checkpointing, provider lifecycle, or model configuration.
