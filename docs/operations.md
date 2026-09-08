# Operations

Running it, watching it, and working out what went wrong.

## Local setup

For first-time account setup, dependencies, local microSandbox image creation, and the first real run, follow [DEVELOPMENT.md](../DEVELOPMENT.md). This document assumes the development environment is configured and focuses on operating it.

`.env` at the repository root configures the controller. It is gitignored and holds live credentials. **Never print its values.**

The Settings page manages the GitHub App and Azure DevOps connections. GitHub App sign-in is required and dashboard resources are scoped to the signed-in user. A connected VCS token is still exposed to the untrusted sandbox for the duration of a run; see [secrets.md](secrets.md).

## GitHub event-triggered sessions

The webhook endpoint is `POST /webhooks/github`. It verifies the raw request body with `X-Hub-Signature-256`, requires `X-GitHub-Delivery` and `X-GitHub-Event`, records the payload in `integration_deliveries`, and returns `202` without waiting for a model or sandbox. The reconciler claims those rows, retries transient projection failures with a bounded backoff, and projects supported events into the shared `SessionCommand` path.

For a local smoke test, use the configured secret without printing it in shell history where possible:

```bash
payload='{"action":"ping"}'
signature="sha256=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"
curl -i -X POST http://localhost:8080/webhooks/github \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Delivery: local-smoke-001' \
  -H 'X-GitHub-Event: ping' \
  -H "X-Hub-Signature-256: $signature" \
  --data "$payload"
```

Expected response: `202` with `{ "accepted": true, "duplicate": false }`; repeating the exact delivery id returns `duplicate: true` and does not create another inbox row. A real PR event must be sent through GitHub or a fixture with a bound `github_installations` row and a configured model connection.

The first review run for a PR is keyed by `github:pr:<owner>/<repo>:<number>`. Later `@pi-cloud-agent` issue or inline review comments append turns to that same session. Review runs always use a fresh sandbox workspace, clone the head repository, reset to the exact head SHA from the event, fetch the base SHA, and publish through the controller's structured review callback. This avoids reviewing a newer main branch or posting comments from an untrusted `gh` process.

The GitHub App Setup URL is intentionally public. It redirects to dashboard Settings with the installation id. Settings then calls the authenticated setup endpoint to verify the installation through the connected GitHub user token and persist the binding.

### The one setting people get wrong

`CONTROL_PLANE_URL` must be reachable **from inside the sandbox**, because the sandbox is outbound-only and reports back over it. With the default local microSandbox provider, use its host gateway:

```dotenv
CONTROL_PLANE_URL=http://host.microsandbox.internal:8080
MICROSANDBOX_ALLOW_HOST=true
# Store provider-owned session snapshots on durable local storage.
MICROSANDBOX_SNAPSHOT_DIR=.pi-cloud-agent-snapshots
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

The default image runs as the unprivileged `node` user and includes Node/npm/pnpm, Python/pip/venv/uv, Git/GitHub CLIs, `jq`, `ripgrep`, archive utilities, and native build tools. Inspect a built image without starting an agent:

```bash
docker run --rm --entrypoint bash pi-cloud-agent:local -lc \
  'id -un; node --version; pnpm --version; python --version; uv --version; rg --version'
```

## Repository images and checkpoints

Configure a public project image per connected repository in Settings > Repositories. It supplies project toolchains on a supported Debian/Ubuntu base; the provider installs the app runtime, its Node, git/gh prerequisites, and unprivileged user inside the VM. No private runtime paths need to be packaged in the image. **Test** checks installation and library loading without running a model task. Leaving the mapping empty uses the default project environment. Build and deploy the app archives with `pnpm sandbox:runtime`; see [compatibility and deployment](../packages/runtime/README.md#image-contract).

After each completed session turn, microSandbox stores an integrity-checked local snapshot, commits its path and source-finalization marker, and then releases the stopped source VM; E2B pauses the filesystem. If source release fails, the marker remains and the reconciler retries it on a later pass. The previous checkpoint is deleted after its replacement is durable, so a session keeps one warm artifact. Warm follow-ups resume that checkpoint without cloning. Checkpoints expire after `SESSION_WORKSPACE_RETENTION_SECONDS` (seven days by default); the reconciler deletes them and marks the session inactive while retaining the provider identity, so the next turn cold-clones from the correct provider's pinned image while restoring Pi history. See [resumability.md](resumability.md).

The first provisioning also pins the resolved repository image and provider on the session. Changing the Settings mapping therefore affects new sessions; an existing session keeps its original provider/image pair if it ever needs a cold resume.

Delete and retention expiry claim the session before provider cleanup. A follow-up submitted during cleanup receives `409`; cleanup renews its heartbeat while the provider call runs, and only a claim stale for ten minutes can be reclaimed after a crash. Pending stopped-source finalizations are retained on their terminal run and retried by the reconciler. The guarded delete or clear then verifies the immutable operation token before changing the session.

E2B materializes each public OCI image resolution under a unique template alias and fails a build instead of reusing an older alias. A session stores the resolved provider/alias pair once, so a republished registry tag affects only later sessions.

Session artifacts are filesystem checkpoints rather than full Docker image commits. Keep `MICROSANDBOX_SNAPSHOT_DIR` on durable storage, monitor that storage directly, and use delete or retention expiry as the normal reclamation paths. The controller keeps one checkpoint per session and deletes the old one only after the replacement is durable. If a provider delete temporarily fails during replacement, the new checkpoint remains usable and the old reference stays on the terminal run for reconciler retry.

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

## Sending agent traces to Langfuse

The controller exports completed runs over OTLP/HTTP. Configure the Langfuse public OTLP endpoint and Basic Auth header in the controller environment, then restart it:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic $(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64),x-langfuse-ingestion-version=4"
export OTEL_SERVICE_NAME=pi-cloud-agent
export OTEL_EXPORT_DEBUG_EVENTS=false
pnpm controller
```

Run an agent normally. Its completed trace comprehensively contains the run, prompts, each model turn, thinking, generated text, tool calls, tool arguments, tool results, usage, timing, and status. Set `OTEL_EXPORT_DEBUG_EVENTS=true` temporarily to emit, retain, and export the detailed Pi lifecycle event stream while diagnosing a runtime issue; it is false by default, so the sandbox does not send those low-value events. Old OTLP observations are immutable, so create a new run after changing the mapping or configuration. For self-hosted or regional Langfuse, replace the hostname while keeping `/api/public/otel/v1/traces`. The exporter uses protobuf over HTTP; no Langfuse SDK is required in this repository.

The controller always exports trace content so production runs can be used as evaluation data. `OTEL_EXPORT_DEBUG_EVENTS` only controls low-value lifecycle noise; leave it false for normal traces and enable it temporarily when diagnosing the runtime event stream. Content can include repository source, prompts, personal data, or credentials accidentally printed by a tool, so configure access and retention controls on the selected OTLP destination.

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
psql -c "select id, active_run_id, latest_run_id, turn_count, sandbox_image_ref, retention_status, sandbox_id, workspace_expires_at
         from sessions order by updated_at desc limit 10;"
```

## What a healthy run looks like

```text
status: queued → provisioning → running → succeeded
events: git.cloned → git.checkout_ready
        → agent.session_start → agent.turn_start → message… → token…
        → tool_call… → agent.turn_end → agent.session_complete → status{done}
```

The terminal evidence is a `status` event followed by the run row reaching `succeeded` or `failed`. **Token and tool-call events are telemetry and never control completion**. A run that streamed a thousand tokens and never reported a status is a timeout, not a success.

## Diagnosing by symptom

| Symptom | Cause | Where to look |
|---|---|---|
| stuck in `queued` | reconciler not running, or `SANDBOX_PROVIDER` misconfigured | controller logs at startup |
| `failed` immediately, "could not create a sandbox" | bad provider configuration, missing local image, or missing E2B template | `pnpm sandbox:image` or `pnpm sandbox:template` |
| `running`, no events, fails with "stopped reporting" | `CONTROL_PLANE_URL` is unreachable from the sandbox, or the detached runtime failed before it could report | the controller log, `msb logs <sandbox-id>`, `msb exec <sandbox-id> -- cat /tmp/pi-cloud-agent-runtime.log` while the microSandbox is running, and the selected provider's network path |
| image compatibility failure before the agent starts | image lacks the runtime contract or cannot boot | Settings **Test** output and provider logs |
| events stop mid-run, then "wall-clock budget" | the agent genuinely ran long | `RUN_WALL_CLOCK_SECONDS` |
| `git.clone_branch_failed` then a successful clone | the named branch is gone; fell back to the default | benign |
| `attempt` climbing | retryable provisioning failures | the provider's error in the logs |
| session stays `parking` | reconciler has not suspended or released the terminal turn | controller logs and `runs.sandbox_stopped_at` |
| stopped source remains after a checkpoint commit | provider finalization failed and is waiting for reconciliation | controller logs and `runs.sandbox_finalization_workspace_id` |
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

Set `PLUGIN_OAUTH_REDIRECT_URI` to a browser-reachable controller URL (for local dev usually `http://localhost:8080/plugins/oauth/callback` — not the sandbox gateway host). Keep `PLUGIN_OAUTH_ISSUER_ALLOWLIST` tight (default `auth.exa.ai`).

Demo with Context7: Install → Configure with a key from https://context7.com/dashboard → start a `general` run that asks about a library API.

Demo with Exa: Install → **Connect** (OAuth) → start a `general` run that needs live web search. Paste an API key under Configure only as a fallback.

Plugin skills are composed into the task prompt; MCP arrives as resolved `MCP_CONFIG` in the sandbox (never from the cloned repo).

Yanked versions cannot newly attach; in-flight runs keep the plugin set pinned on `runs.plugins`.

Create the session from the dashboard after signing in with GitHub, then use its conversation UI for the follow-up turn.

The live test performs this as two real turns and verifies the Pi session id, uncommitted file, provider workspace id, and absence of a second clone. Run it after changing the sandbox image, runtime, session checkpointing, provider lifecycle, or model configuration.

### Missing personal repositories or webhook deliveries

Settings discovers every accessible installation of the configured GitHub App, even if its setup callback was missed. Enabling auto-review binds an unowned installation to the current user; discovery never transfers an installation from another user. GitHub permissions are checked again when enabling.

For local development, the App webhook URL must point to the **current** public controller tunnel at `/webhooks/github`. An expired ngrok hostname can return 404 before the controller receives anything. Check `/healthz` through the public hostname, then inspect GitHub App delivery responses. A successful delivery returns 202; opening, reopening, or updating a non-draft PR in an enabled repository should create a review session. An already-open PR is visible in Reviews before any webhook is received.
