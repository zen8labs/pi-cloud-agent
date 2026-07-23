"""Run status + live log endpoints (for the dashboard / debugging).

  * GET /runs                  — recent runs (the "sessions" list)
  * GET /runs/{id}             — one run: status + findings
  * GET /runs/{id}/events      — the full agent event log (tool calls, logs, …)
  * GET /runs/{id}/stream      — Server-Sent Events: live log as the agent works

The stream polls the append-only `run_events` table by sequence, so it works
whether or not the worker shares the API process (no in-proc bus dependency).
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.state import get_session
from core.state import repo as runs
from core.types import RunStatus

router = APIRouter(prefix="/runs", tags=["runs"])


class CreateRunIn(BaseModel):
    """Manually start an agent session from the web dashboard's chat page."""

    repo: str = Field(..., description="owner/name")
    prompt: str = Field(..., min_length=1)
    profile: str = "general_agent"
    provider: str = "github"
    host: str = "github.com"
    # Branch to clone. When omitted, the controller resolves the repo's real
    # default branch (so we don't assume `main` on a `master`-only repo).
    branch: str | None = None
    pr_number: int | None = None
    # Model override for this session (e.g. "openai/gpt-5.4-mini").
    # None → orchestrator falls back to the global default, then AGENT_MODEL env.
    model: str | None = None

_TERMINAL = {RunStatus.succeeded.value, RunStatus.failed.value, RunStatus.cancelled.value}


def _run_dict(run) -> dict:
    return {
        "id": run.id,
        "status": run.status,
        "profile": run.profile,
        "model": run.model,
        "provider": run.provider,
        "repo": run.repo_full_name,
        "pr_number": run.pr_number,
        "error": run.error,
        "created_at": run.created_at.isoformat(),
    }


@router.get("")
async def list_runs(limit: int = Query(50, le=200), status: str | None = None):
    async with get_session() as db:
        rows = await runs.list_runs(db, limit=limit, status=status)
        return {"runs": [_run_dict(r) for r in rows]}


@router.post("", status_code=201)
async def create_run(body: CreateRunIn):
    """Queue a manual agent session (the worker picks it up like a webhook run).

    Builds the same flat trigger the webhook layer produces, plus the free-form
    `user_prompt` the general_agent profile threads through to the sandbox. No
    base/head SHA is supplied — the sandbox clones the repo's default-branch tip.
    """
    if "/" not in body.repo:
        raise HTTPException(422, "repo must be in 'owner/name' form")
    owner, name = body.repo.split("/", 1)
    if not owner or not name:
        raise HTTPException(422, "repo must be in 'owner/name' form")

    # Resolve which branch to clone: an explicit selection wins; otherwise ask
    # the provider for the repo's real default branch so we never assume `main`.
    # The sandbox applies a priority fallback if even this can't be cloned.
    branch = (body.branch or "").strip()
    if not branch:
        try:
            from core.vcs import get_vcs_provider

            vcs = get_vcs_provider(body.provider)
            if hasattr(vcs, "get_default_branch"):
                branch = await vcs.get_default_branch(body.repo) or ""
        except Exception:  # noqa: BLE001 — fall through to the sandbox fallback
            branch = ""

    trigger = {
        "provider": body.provider,
        "host": body.host,
        "owner": owner,
        "name": name,
        "clone_url": f"https://{body.host}/{owner}/{name}.git",
        "default_branch": branch,
        "base_sha": "",
        "head_sha": "",
        "head_branch": branch,
        "pr_number": body.pr_number,
        "user_prompt": body.prompt,
    }
    async with get_session() as db:
        run = await runs.create_run(
            db,
            profile=body.profile,
            provider=body.provider,
            repo_full_name=body.repo,
            pr_number=body.pr_number,
            head_sha=None,
            trigger=trigger,
            model=body.model or None,
        )
        return _run_dict(run)


@router.get("/{run_id}")
async def get_run(run_id: str):
    async with get_session() as db:
        run = await runs.get_run(db, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        data = _run_dict(run)
        data["prompt"] = (run.trigger or {}).get("user_prompt")
        data["findings"] = [
            {
                "file": f.file,
                "line": f.line,
                "severity": f.severity,
                "title": f.title,
                "grounded": f.grounded,
                "published": f.published,
            }
            for f in run.findings
        ]
        return data


@router.get("/{run_id}/events")
async def get_events(run_id: str, after_seq: int = -1):
    async with get_session() as db:
        if await runs.get_run(db, run_id) is None:
            raise HTTPException(404, "run not found")
        events = await runs.get_events(db, run_id, after_seq=after_seq)
        return {
            "events": [
                {"seq": e.seq, "type": e.type, "data": e.data, "at": e.created_at.isoformat()}
                for e in events
            ]
        }


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str):
    """Manually stop a run: kill its sandbox (if any) and mark it cancelled.

    Works for both actively-running runs (publishes a terminating event so the
    in-process loop exits) and orphaned ones (no live loop — we stop the sandbox
    and set the status directly)."""
    async with get_session() as db:
        run = await runs.get_run(db, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        if run.status in _TERMINAL:
            return {"ok": True, "status": run.status}
        provider_object_id = run.provider_object_id
        session_id = run.session_id

    # Best-effort: stop the sandbox if we ever recorded its native id.
    if provider_object_id:
        try:
            from core.sandbox import StopConfig, get_sandbox_provider

            sp = get_sandbox_provider()
            if sp.capabilities.supports_explicit_stop:
                await sp.stop_sandbox(
                    StopConfig(
                        provider_object_id=provider_object_id,
                        session_id=session_id,
                        reason="user_cancelled",
                    )
                )
        except Exception:  # noqa: BLE001 — cancellation must still mark the row
            pass

    async with get_session() as db:
        await runs.set_status(db, run_id, RunStatus.cancelled, error="cancelled by user")
    # Terminate any in-process run loop still waiting on this run's events.
    from core.orchestrator.bus import event_bus

    await event_bus.publish(run_id, {"type": "error", "data": {"message": "cancelled by user"}})
    return {"ok": True, "status": "cancelled"}


@router.get("/{run_id}/stream")
async def stream_run(
    run_id: str,
    after_seq: int = -1,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
):
    """Live SSE log — resumable. `curl -N localhost:8080/runs/<id>/stream` to watch.

    Each data frame carries `id: <seq>` (the append-only event log's sequence).
    A browser `EventSource` echoes the last id back as `Last-Event-ID` when it
    auto-reconnects, so a dropped connection resumes exactly where it left off
    with no gaps or duplicates. `?after_seq=` lets a client that already replayed
    history via REST skip straight to live tail. Status/`end` frames are derived
    from the run row (no id) and are safe to re-emit on reconnect.
    """
    # Last-Event-ID (set automatically by EventSource on reconnect) wins over the
    # query param so a reconnect always resumes from the true last-seen seq.
    start_seq = after_seq
    if last_event_id is not None:
        try:
            start_seq = int(last_event_id)
        except ValueError:
            pass

    async def gen():
        last_seq = start_seq
        last_status = None
        # Confirm the run exists up front so a bad id fails fast.
        async with get_session() as db:
            if await runs.get_run(db, run_id) is None:
                yield _sse("error", {"message": "run not found"})
                return
        while True:
            async with get_session() as db:
                events = await runs.get_events(db, run_id, after_seq=last_seq)
                run = await runs.get_run(db, run_id)
            for e in events:
                last_seq = e.seq
                yield _sse(e.type, e.data, seq=e.seq)
            if run is not None and run.status != last_status:
                last_status = run.status
                yield _sse("status", {"status": run.status, "error": run.error})
            if run is not None and run.status in _TERMINAL:
                yield _sse("end", {"status": run.status})
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # don't let a proxy buffer the stream
        },
    )


def _sse(event: str, data: dict, seq: int | None = None) -> str:
    """One SSE frame. When `seq` is given, emit `id:` so EventSource can resume
    from it via Last-Event-ID after a dropped connection."""
    prefix = f"id: {seq}\n" if seq is not None else ""
    return f"{prefix}event: {event}\ndata: {json.dumps(data)}\n\n"
