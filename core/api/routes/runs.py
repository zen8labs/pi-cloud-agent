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

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from core.state import get_session
from core.state import repo as runs
from core.types import RunStatus

router = APIRouter(prefix="/runs", tags=["runs"])

_TERMINAL = {RunStatus.succeeded.value, RunStatus.failed.value, RunStatus.cancelled.value}


def _run_dict(run) -> dict:
    return {
        "id": run.id,
        "status": run.status,
        "bundle": run.bundle,
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


@router.get("/{run_id}")
async def get_run(run_id: str):
    async with get_session() as db:
        run = await runs.get_run(db, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        data = _run_dict(run)
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
async def stream_run(run_id: str):
    """Live SSE log. `curl -N localhost:8080/runs/<id>/stream` to watch."""

    async def gen():
        last_seq = -1
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
                yield _sse(e.type, e.data)
            if run is not None and run.status != last_status:
                last_status = run.status
                yield _sse("status", {"status": run.status, "error": run.error})
            if run is not None and run.status in _TERMINAL:
                yield _sse("end", {"status": run.status})
                return
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
