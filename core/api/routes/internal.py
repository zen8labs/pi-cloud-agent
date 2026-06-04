"""Internal callbacks the in-sandbox bridge + agent tools dial back to.

Every endpoint is authenticated by the per-run bearer token (`Run.auth_token`),
which is the *only* credential the sandbox holds. Real secrets (git tokens) are
minted here, on the trusted side, and handed out narrowly (see ARCHITECTURE.md →
"Trust boundary & secrets").
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from core.logger import get_logger
from core.orchestrator.bus import event_bus
from core.state import get_session
from core.state import repo as runs
from core.state.models import Run
from core.vcs import get_vcs_provider

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


class FindingIn(BaseModel):
    file: str
    line: int | None = None
    severity: str = "warning"  # blocker | warning | nit
    title: str
    body: str
    evidence: str | None = None


@router.post("/{run_id}/findings")
async def post_finding(run_id: str, f: FindingIn, run: Run = Depends(_authed_run)):
    # Our contract requires evidence; a finding with evidence is treated as
    # grounded (the skill instructs the agent to only report verified findings).
    grounded = bool(f.evidence and f.evidence.strip())
    async with get_session() as db:
        await runs.add_finding(
            db,
            run_id,
            file=f.file,
            line=f.line,
            severity=f.severity,
            title=f.title,
            body=f.body,
            evidence=f.evidence,
            grounded=grounded,
        )
    await event_bus.publish(run_id, {"type": "finding", "data": f.model_dump()})
    return {"ok": True, "grounded": grounded}


class GitCredentialIn(BaseModel):
    # git's credential protocol fields the helper forwards.
    protocol: str | None = None
    host: str | None = None
    path: str | None = None


class GitCredentialOut(BaseModel):
    username: str
    password: str


@router.post("/{run_id}/git-credentials", response_model=GitCredentialOut)
async def git_credentials(
    run_id: str, _req: GitCredentialIn, run: Run = Depends(_authed_run)
) -> GitCredentialOut:
    """Mint a fresh short-lived clone credential on demand.

    Called by the sandbox's git credential helper for every git op, so no
    long-lived token is ever stored in the sandbox.
    """
    vcs = get_vcs_provider(run.provider)
    token = await vcs.mint_clone_token(run.repo_full_name)
    username = "x-access-token" if run.provider == "github" else "oauth2"
    log.info("brokered git credential", extra={"run_id": run_id})
    return GitCredentialOut(username=username, password=token)


class StatusIn(BaseModel):
    status: str  # free-form bridge status; "done" closes the stream
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
    return {"ok": True}
