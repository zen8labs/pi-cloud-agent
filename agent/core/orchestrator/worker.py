"""Background worker: claim queued runs and execute them.

Runs in the same process as the API by default (see api/app.py lifespan). Claims
use `FOR UPDATE SKIP LOCKED`, so you can also run this as N separate processes.
"""

from __future__ import annotations

import asyncio

from core.logger import get_logger
from core.orchestrator.runner import execute_run
from core.state import get_session
from core.state import repo as runs

log = get_logger("worker")

POLL_INTERVAL_SECONDS = 2.0


async def run_worker(stop: asyncio.Event, concurrency: int = 2) -> None:
    """Poll for queued runs and execute up to `concurrency` at once."""
    sem = asyncio.Semaphore(concurrency)
    inflight: set[asyncio.Task] = set()
    log.info("worker started", extra={"concurrency": concurrency})

    while not stop.is_set():
        await sem.acquire()
        async with get_session() as db:
            run = await runs.claim_next_run(db)
        if run is None:
            sem.release()
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_SECONDS)
            except TimeoutError:
                pass
            continue

        async def _run(r=run):
            try:
                await execute_run(r)
            finally:
                sem.release()

        task = asyncio.create_task(_run())
        inflight.add(task)
        task.add_done_callback(inflight.discard)

    if inflight:
        await asyncio.gather(*inflight, return_exceptions=True)
    log.info("worker stopped")
