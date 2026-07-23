"""Internal callbacks the in-sandbox Pi runtime dials back to.

Every endpoint is authenticated by the per-run bearer token (`Run.auth_token`).
Scope is deliberately tiny — telemetry only: Pi relays agent events
and the terminal status here. Secrets (LLM keys + a scoped SCM token) are baked
into the sandbox env at creation time (see core/orchestrator/runner.py), so the
sandbox no longer brokers credentials back through the controller.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from core.logger import get_logger
from core.orchestrator.bus import event_bus
from core.state import get_session
from core.state import repo as runs
from core.state.models import Run

router = APIRouter(prefix="/internal/runs", tags=["internal"])
log = get_logger("internal")


async def _authed_run(run_id: str, authorization: str = Header(...)) -> Run:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer")
    token = authorization.split(" ", 1)[1].strip()
    async with get_session() as db:
        run = await runs.get_run_by_token(db, run_id, token)
    if run is None:
        raise HTTPException(403, "invalid run token")
    return run


class EventIn(BaseModel):
    type: str
    data: dict = {}


@router.post("/{run_id}/events")
async def post_event(run_id: str, ev: EventIn, run: Run = Depends(_authed_run)):
    async with get_session() as db:
        await runs.append_event(db, run_id, ev.type, ev.data)
    await event_bus.publish(run_id, {"type": ev.type, "data": ev.data})
    return {"ok": True}


class StatusIn(BaseModel):
    status: str  # free-form runtime status; "done" closes the stream
    detail: str | None = None


@router.post("/{run_id}/status")
async def post_status(run_id: str, s: StatusIn, run: Run = Depends(_authed_run)):
    # Persist so the status is visible in /runs/{id}/events + the DB browser.
    async with get_session() as db:
        await runs.append_event(db, run_id, "status", s.model_dump())
    await event_bus.publish(run_id, {"type": "status", "data": s.model_dump()})
    # Terminate the controller's run loop on a terminal status. Without this an
    # "error"/"failed" from the supervisor would never reach the consumer, so the
    # run would hang until its wall-clock timeout (and leak the sandbox).
    if s.status == "done":
        await event_bus.publish(run_id, {"type": "done", "data": {}})
    elif s.status in ("error", "failed", "cancelled"):
        await event_bus.publish(
            run_id, {"type": "error", "data": {"message": s.detail or s.status}}
        )
        await event_bus.publish(run_id, {"type": "done", "data": {"status": s.status}})
    return {"ok": True}
