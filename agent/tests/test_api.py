"""API endpoint integration tests (SQLite-backed, no external services).

Exercises the real FastAPI app + DB through a full request lifecycle: health,
webhook signature handling, run creation + read-back, and the token-authenticated
internal callbacks the sandbox runtime uses.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from core.api.app import app


def _gh_sig(body: bytes, secret: str = "testsecret") -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _pr_payload() -> dict:
    return {
        "action": "opened",
        "number": 11,
        "pull_request": {
            "number": 11,
            "title": "t",
            "body": "b",
            "head": {"sha": "headsha", "ref": "feature"},
            "base": {"sha": "basesha", "ref": "main"},
            "user": {"login": "alice"},
        },
        "repository": {
            "name": "repo",
            "owner": {"login": "octo"},
            "html_url": "https://github.com/octo/repo",
            "clone_url": "https://github.com/octo/repo.git",
            "default_branch": "main",
        },
    }


@pytest.fixture(scope="module")
def client():
    # The context manager runs the lifespan → init_db() creates tables in SQLite.
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_webhook_bad_signature_rejected(client):
    r = client.post(
        "/webhooks/github",
        content=b'{"action":"opened"}',
        headers={"x-github-event": "pull_request", "x-hub-signature-256": "sha256=bad"},
    )
    assert r.status_code == 401


def test_webhook_valid_pr_creates_run_then_readable(client):
    body = json.dumps(_pr_payload()).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    assert r.status_code == 202
    assert r.headers.get("X-CoReview-Route") == "agentic"
    run_id = r.headers["X-CoReview-Run"]

    got = client.get(f"/runs/{run_id}")
    assert got.status_code == 200
    data = got.json()
    assert data["repo"] == "octo/repo"
    assert data["profile"] == "pr_review"
    assert data["status"] == "queued"


def test_runs_unknown_404(client):
    assert client.get("/runs/does-not-exist").status_code == 404


def test_repo_branch_setting_round_trips(client):
    # No override → branch is "" (means "use the repo default").
    r = client.get("/settings/repo-branches")
    assert r.status_code == 200
    by_repo = {x["repo"]: x["branch"] for x in r.json()["repos"]}
    assert by_repo.get("octo/repo", "") == ""

    # Pin a branch; it persists and comes back on the next read.
    r = client.put("/settings/repo-branches", json={"repo": "octo/repo", "branch": "develop"})
    assert r.status_code == 200
    assert r.json()["branch"] == "develop"
    by_repo = {
        x["repo"]: x["branch"] for x in client.get("/settings/repo-branches").json()["repos"]
    }
    assert by_repo.get("octo/repo") == "develop"

    # Clearing it (empty branch) reverts to the repo default.
    client.put("/settings/repo-branches", json={"repo": "octo/repo", "branch": ""})
    by_repo = {
        x["repo"]: x["branch"] for x in client.get("/settings/repo-branches").json()["repos"]
    }
    assert by_repo.get("octo/repo", "") == ""


def test_repo_triggers_round_trip(client):
    # Default: every event triggers a review.
    repos = client.get("/settings/repo-branches").json()["repos"]
    by_repo = {x["repo"]: x["triggers"] for x in repos}
    assert by_repo.get("octo/repo", {}).get("synchronize", True) is True

    # Disable synchronize; persists and reads back.
    r = client.put(
        "/settings/repo-triggers",
        json={"repo": "octo/repo", "opened": True, "synchronize": False, "comment": True},
    )
    assert r.status_code == 200
    assert r.json()["triggers"]["synchronize"] is False
    repos = client.get("/settings/repo-branches").json()["repos"]
    by_repo = {x["repo"]: x["triggers"] for x in repos}
    assert by_repo["octo/repo"]["synchronize"] is False
    assert by_repo["octo/repo"]["opened"] is True


def test_webhook_synchronize_skipped_when_trigger_disabled(client):
    # synchronize disabled for octo/repo by the round-trip test above.
    client.put(
        "/settings/repo-triggers",
        json={"repo": "octo/repo", "opened": True, "synchronize": False, "comment": True},
    )
    payload = _pr_payload()
    payload["action"] = "synchronize"
    body = json.dumps(payload).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    assert r.status_code == 204
    assert r.headers.get("X-CoReview-Route") == "trigger-disabled"

    # Re-enable → synchronize creates a run again.
    client.put(
        "/settings/repo-triggers",
        json={"repo": "octo/repo", "opened": True, "synchronize": True, "comment": True},
    )
    body = json.dumps(payload).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    assert r.status_code == 202
    assert r.headers.get("X-CoReview-Route") == "agentic"


def test_branches_endpoint_renders_without_creds(client):
    # No GitHub creds in tests → best-effort empty result, never a 500.
    r = client.get("/repos/octo/repo/branches")
    assert r.status_code == 200
    body = r.json()
    assert body["branches"] == []
    assert body["default"] is None


def test_internal_endpoint_auth(client):
    # create a run to get a valid token
    body = json.dumps(_pr_payload()).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    run_id = r.headers["X-CoReview-Run"]

    event = {"type": "log", "data": {"event": "hello"}}
    # wrong token → 403
    bad = client.post(
        f"/internal/runs/{run_id}/events",
        json=event,
        headers={"Authorization": "Bearer wrong"},
    )
    assert bad.status_code == 403

    # missing header → 422 (required header)
    assert client.post(f"/internal/runs/{run_id}/events", json=event).status_code == 422

    # correct token → accepted
    token = _run_token(client, run_id)
    ok = client.post(
        f"/internal/runs/{run_id}/events",
        json=event,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert ok.status_code == 200


def test_internal_events_publishes_to_bus(client):
    body = json.dumps(_pr_payload()).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    run_id = r.headers["X-CoReview-Run"]
    token = _run_token(client, run_id)

    import asyncio

    from core.orchestrator.bus import event_bus

    q = event_bus.subscribe(run_id)

    async def wait_for_event():
        return await asyncio.wait_for(q.get(), timeout=2.0)

    loop = asyncio.new_event_loop()
    try:
        waiter = loop.create_task(wait_for_event())
        loop.run_until_complete(asyncio.sleep(0.05))
        ok = client.post(
            f"/internal/runs/{run_id}/events",
            json={"type": "log", "data": {"message": "hello"}},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert ok.status_code == 200
        raw = loop.run_until_complete(waiter)
    finally:
        event_bus.unsubscribe(run_id, q)
        loop.close()

    assert raw == {"type": "log", "data": {"message": "hello"}}


def test_internal_status_done_publishes_done_event(client):
    body = json.dumps(_pr_payload()).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    run_id = r.headers["X-CoReview-Run"]
    token = _run_token(client, run_id)

    raw = _post_status_and_collect_bus_events(
        client,
        run_id,
        token,
        {"status": "done", "detail": "finished"},
        expected_count=2,
    )

    assert [e["type"] for e in raw] == ["status", "done"]


def test_internal_status_error_publishes_done_event(client):
    body = json.dumps(_pr_payload()).encode()
    r = client.post(
        "/webhooks/github",
        content=body,
        headers={"x-github-event": "pull_request", "x-hub-signature-256": _gh_sig(body)},
    )
    run_id = r.headers["X-CoReview-Run"]
    token = _run_token(client, run_id)

    raw = _post_status_and_collect_bus_events(
        client,
        run_id,
        token,
        {"status": "error", "detail": "runtime failed"},
        expected_count=3,
    )

    assert [e["type"] for e in raw] == ["status", "error", "done"]
    assert raw[1]["data"]["message"] == "runtime failed"
    assert raw[2]["data"]["status"] == "error"


def _post_status_and_collect_bus_events(
    client,
    run_id: str,
    token: str,
    payload: dict,
    expected_count: int,
) -> list[dict]:
    import asyncio

    from core.orchestrator.bus import event_bus

    q = event_bus.subscribe(run_id)

    async def collect():
        events = []
        for _ in range(expected_count):
            events.append(await asyncio.wait_for(q.get(), timeout=2.0))
        return events

    loop = asyncio.new_event_loop()
    try:
        waiter = loop.create_task(collect())
        loop.run_until_complete(asyncio.sleep(0.05))
        ok = client.post(
            f"/internal/runs/{run_id}/status",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert ok.status_code == 200
        return loop.run_until_complete(waiter)
    finally:
        event_bus.unsubscribe(run_id, q)
        loop.close()


def _run_token(client, run_id: str) -> str:
    """Read the run's callback token straight from the SQLite file.

    Done with stdlib sqlite3 (not the async engine) to avoid touching the
    TestClient's event loop from the test thread.
    """
    import os
    import sqlite3

    path = os.environ["DATABASE_URL"].split(":///", 1)[1]
    con = sqlite3.connect(path)
    try:
        row = con.execute("SELECT auth_token FROM runs WHERE id = ?", (run_id,)).fetchone()
    finally:
        con.close()
    assert row, "run not found in db"
    return row[0]
