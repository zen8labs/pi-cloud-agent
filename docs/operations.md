# Operations

Running it, watching it, and working out what went wrong.

## Local setup

For first-time account setup, dependencies, E2B template creation, ngrok, and the first real run, follow [DEVELOPMENT.md](../DEVELOPMENT.md). This document assumes the development environment is configured and focuses on operating it.

`.env` at the repository root configures the controller. It is gitignored and holds live credentials. **Never print its values.**

### The one setting people get wrong

`CONTROL_PLANE_URL` must be reachable **from inside the sandbox**, because the sandbox is outbound-only and reports back over it. With a hosted provider like E2B, `http://localhost:8080` is unreachable and every run goes silent until the reconciler times it out.

Use the authenticated ngrok tunnel configured during development:

```bash
ngrok http --url <your-domain>.ngrok.app 8080
```

Set `CONTROL_PLANE_URL` to that HTTPS URL and restart the controller after any change. A run that provisions, produces no events, and fails ten minutes later with "stopped reporting" is almost always this.

## When to rebuild the sandbox template

Rebuild after changing `packages/runtime/**`, `Dockerfile.sandbox`, or the pinned agent harness version:

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
psql -c "select id, status, profile, repo_full_name, attempt, created_at
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
| `failed` immediately, "could not create a sandbox" | bad `E2B_API_KEY`, or the template does not exist | `pnpm sandbox:template` |
| `running`, no events, fails with "stopped reporting" | `CONTROL_PLANE_URL` unreachable from the sandbox | the tunnel |
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
pnpm sandbox:template
LIVE_TEST_REPO=owner/repository pnpm test:live
```

Or by hand:

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","prompt":"Report the latest commit.","profile":"general"}'
```

For an interactive session, create it once and add turns to the same id:

```bash
SESSION_ID=$(curl -sS -X POST http://localhost:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","prompt":"Create an uncommitted proof file.","profile":"general"}' \
  | jq -r '.id')

# Wait until GET /sessions/$SESSION_ID reports status=idle, then:
curl -sS -X POST "http://localhost:8080/sessions/$SESSION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Read the proof file from the previous turn."}'
```

The live test performs this as two real turns and verifies the Pi session id, uncommitted file, provider workspace id, and absence of a second clone. Run it after changing the sandbox image, runtime, session checkpointing, provider lifecycle, or model configuration.
