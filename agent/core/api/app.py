"""FastAPI application.

By default the API process also runs the background worker (single-process
deployment). Set `AGENT_RUN_WORKER=0` to run the API and worker separately.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from core.config import get_settings
from core.logger import configure_logging, get_logger
from core.orchestrator import run_worker
from core.state import init_db

log = get_logger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    await init_db()

    # Reconcile runs left in-flight by a previous process. The runner's
    # completion/timeout logic is in-memory, so a restart would otherwise leave
    # these stuck as "running" forever (their sandboxes are already gone).
    from core.state import get_session
    from core.state import repo as runs

    async with get_session() as db:
        n = await runs.reconcile_orphaned_runs(db)
    if n:
        log.info("reconciled orphaned runs", extra={"count": n})

    stop = asyncio.Event()
    worker_task: asyncio.Task | None = None
    if os.environ.get("AGENT_RUN_WORKER", "1") == "1":
        worker_task = asyncio.create_task(run_worker(stop))
        log.info("embedded worker started")
    try:
        yield
    finally:
        stop.set()
        if worker_task is not None:
            await worker_task


def create_app() -> FastAPI:
    app = FastAPI(title="CoReview Agent", version="0.1.0", lifespan=lifespan)

    # Allow the Next.js web dashboard (a separate origin) to call the API and
    # consume the SSE stream from the browser. No auth in this phase.
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().web_cors_origin_list(),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from core.api.routes import internal, meta, runs, settings, webhooks

    app.include_router(webhooks.router)
    app.include_router(runs.router)
    app.include_router(internal.router)
    app.include_router(meta.router)
    app.include_router(settings.router)

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "env": get_settings().env}

    return app


app = create_app()
