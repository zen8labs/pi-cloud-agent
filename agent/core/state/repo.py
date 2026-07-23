"""Run repository: create/claim/update runs and append events.

Worker coordination uses `SELECT ... FOR UPDATE SKIP LOCKED` so multiple worker
processes can pull from the same `runs` table without double-processing
(see ARCHITECTURE.md → "State & persistence" — the Durable-Object single-writer
replacement).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.state.models import Finding, Run, RunEvent
from core.types import RunStatus


async def create_run(
    db: AsyncSession,
    *,
    profile: str,
    provider: str,
    repo_full_name: str,
    pr_number: int | None,
    head_sha: str | None,
    trigger: dict,
    model: str | None = None,
) -> Run:
    run = Run(
        profile=profile,
        provider=provider,
        repo_full_name=repo_full_name,
        pr_number=pr_number,
        head_sha=head_sha,
        trigger=trigger,
        model=model,
        status=RunStatus.queued.value,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run


async def claim_next_run(db: AsyncSession) -> Run | None:
    """Atomically claim the oldest queued run for this worker."""
    stmt = (
        select(Run)
        .where(Run.status == RunStatus.queued.value)
        .order_by(Run.created_at.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    run = (await db.execute(stmt)).scalar_one_or_none()
    if run is None:
        return None
    run.status = RunStatus.provisioning.value
    run.claimed_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(run)
    return run


async def reconcile_orphaned_runs(db: AsyncSession) -> int:
    """Fail runs left mid-flight by a previous process (called on startup).

    The runner's completion + wall-clock-timeout logic lives in-memory, so after
    a restart any run still in a non-terminal in-flight state is orphaned (its
    sandbox is gone and nothing will ever complete it). Mark them failed.
    Queued runs are left alone — the worker can still claim those.
    """
    stale = (
        RunStatus.provisioning.value,
        RunStatus.running.value,
        RunStatus.publishing.value,
    )
    result = await db.execute(
        update(Run)
        .where(Run.status.in_(stale))
        .values(status=RunStatus.failed.value, error="orphaned: controller restarted")
    )
    await db.commit()
    return result.rowcount or 0


async def set_status(
    db: AsyncSession, run_id: str, status: RunStatus, *, error: str | None = None
) -> None:
    await db.execute(
        update(Run)
        .where(Run.id == run_id)
        .values(status=status.value, error=error)
    )
    await db.commit()


async def set_provider_object_id(db: AsyncSession, run_id: str, provider_object_id: str) -> None:
    await db.execute(
        update(Run).where(Run.id == run_id).values(provider_object_id=provider_object_id)
    )
    await db.commit()


async def append_event(db: AsyncSession, run_id: str, type_: str, data: dict) -> None:
    seq = (
        await db.execute(
            select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.desc()).limit(1)
        )
    ).scalar_one_or_none()
    next_seq = (seq.seq + 1) if seq else 0
    db.add(RunEvent(run_id=run_id, seq=next_seq, type=type_, data=data))
    await db.commit()


async def add_finding(
    db: AsyncSession,
    run_id: str,
    *,
    file: str,
    line: int | None,
    severity: str,
    title: str,
    body: str,
    evidence: str | None,
    grounded: bool = False,
) -> Finding:
    f = Finding(
        run_id=run_id,
        file=file,
        line=line,
        severity=severity,
        title=title,
        body=body,
        evidence=evidence,
        grounded=grounded,
    )
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def get_run(db: AsyncSession, run_id: str) -> Run | None:
    # Eager-load findings: callers (the /runs endpoint, the publish step) read
    # `run.findings`, and async SQLAlchemy cannot lazy-load a relationship.
    stmt = select(Run).where(Run.id == run_id).options(selectinload(Run.findings))
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_runs(db: AsyncSession, *, limit: int = 50, status: str | None = None) -> list[Run]:
    """Most-recent runs first (for the dashboard sessions list)."""
    stmt = select(Run).order_by(Run.created_at.desc()).limit(limit)
    if status:
        stmt = stmt.where(Run.status == status)
    return list((await db.execute(stmt)).scalars().all())


async def get_events(db: AsyncSession, run_id: str, *, after_seq: int = -1) -> list[RunEvent]:
    """Append-only event log for a run, ordered, optionally after a seq cursor."""
    stmt = (
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.seq > after_seq)
        .order_by(RunEvent.seq.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_run_by_token(db: AsyncSession, run_id: str, token: str) -> Run | None:
    run = await get_run(db, run_id)
    if run is None or run.auth_token != token:
        return None
    return run
