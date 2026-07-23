---
name: coreview-agent-setup
description: Onboards a developer to the CoReview controller, dashboard, E2B template, and real Pi/MiniMax validation. Use when setting up the repository locally or verifying a fresh environment.
---

# Set Up CoReview Agent

## Prerequisites

- Python 3.12+
- Node 22+
- Docker
- E2B CLI/account for live runs
- VCS app or token authorized for the test repository
- Netmind/Viettel MiniMax gateway URL and key

## Local controller and dashboard

```bash
cp agent/.env.example agent/.env
make install
make up
make web-dev
```

Populate `agent/.env` without printing it. The controller uses `:8080`; the
dashboard uses `:3000`.

## Offline validation

```bash
make test
make lint
make compile
cd web && npm run build
```

## Publish the sandbox template

```bash
make sandbox-template
```

Republish after changes to `agent/runtime/`, `agent/profiles/`,
`agent/Dockerfile.sandbox`, or Pi package locks.

## Real validation

```bash
cd agent
pytest tests/test_harness_live.py -m live -q -s
```

For the production-shaped path, expose the controller through a temporary HTTPS
tunnel, set that URL as `CONTROL_PLANE_URL`, and create a manual run:

```bash
curl -sS -X POST http://localhost:8080/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "repo": "owner/authorized-repo",
    "prompt": "Read the checkout and report the latest commit.",
    "profile": "general_agent"
  }'
```

Success means the run reaches `succeeded`, stored events contain real token and
completed tool activity, and the E2B sandbox is deleted. A repository 404 during
clone usually means the configured VCS app is not installed on that repository,
not that Pi failed.
