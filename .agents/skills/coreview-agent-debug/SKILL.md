---
name: coreview-agent-debug
description: Diagnoses failures in the CoReview controller, E2B sandbox, embedded Pi runtime, profile prompts, and outbound event path. Use when runs stall, fail, or produce incorrect behavior.
---

# Debug CoReview Agent Runs

Follow the run across boundaries. Do not patch the symptom before locating the
failing layer.

## 1. Classify the failure

- Trigger/API: no Run row or wrong profile/input.
- Queue/worker: remains queued or is reconciled as orphaned.
- Provisioning: credential mint or E2B creation failure.
- Workspace: clone, revision checkout, or setup failure.
- Pi/model: provider registration, inference, or tool-loop failure.
- Callback: events/status cannot reach the controller.
- Behavior: session succeeds but the profile instructions are wrong.

## 2. Read durable evidence

```bash
RUN_ID=<run-id>
curl -s localhost:8080/runs/$RUN_ID | jq
curl -s localhost:8080/runs/$RUN_ID/events | jq '.events[]'

docker compose exec db psql -U coreview -d coreview_agent -c \
  "SELECT id,status,profile,error,provider_object_id FROM runs WHERE id='$RUN_ID';"
```

Useful runtime log events include:

- `git.credentials_configured`
- `git.clone_complete`
- `git.checkout_ready`
- `setup.skip`, `setup.complete`, or `setup.failed`
- `pi.start`, `pi.stdout`, `pi.complete`
- `supervisor.error`

Token and `tool_call` events prove real Pi activity. Terminal `status` controls
the run result.

## 3. Test the narrowest layer

```bash
cd agent
pytest -m "not live" -q
pytest tests/test_harness_live.py -m live -q -s
```

The live suite distinguishes template/model problems from controller callback
problems. A full callback run additionally requires a public
`CONTROL_PLANE_URL`.

## 4. Common causes

- No clone: VCS app is not installed on the target repo or token scope is wrong.
- No callbacks: `CONTROL_PLANE_URL` is local/private or tunnel has expired.
- Model error: `AGENT_MODEL`, gateway URL, and key do not form one valid provider.
- Missing instructions: profile not copied into the E2B template; rebuild it.
- Fast hang after provisioning: confirm event subscription occurs before E2B
  creation and API/worker share a process.
- Old behavior after code change: sandbox template is baked; republish after
  runtime/profile/package changes.

Never print secrets. Use presence, host, status code, and scoped identity as
evidence.
