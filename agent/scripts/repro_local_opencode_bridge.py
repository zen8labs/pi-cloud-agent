#!/usr/bin/env python3
"""Run the OpenCode bridge locally while streaming into the normal Sessions UI."""

from __future__ import annotations

import argparse
import asyncio
import os
import signal
import subprocess
from pathlib import Path

from dotenv import load_dotenv

from core.config import get_settings
from core.state import Run, get_session, init_db
from core.state import repo as runs
from core.types import RunStatus
from runtime.bridge import AgentBridge
from runtime.constants import OPENCODE_PORT
from runtime.entrypoint import SandboxSupervisor
from runtime.log_config import configure_logging, get_logger


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reproduce OpenCode bridge/subagent behavior locally and stream it to the web UI."
    )
    parser.add_argument(
        "--workdir",
        default=os.getcwd(),
        help="Local repo directory for OpenCode to run in. The script stages .opencode/ here.",
    )
    parser.add_argument("--repo", default="", help="Display repo name in the UI, e.g. oadtq/warp.")
    parser.add_argument("--bundle", default="general_agent")
    parser.add_argument("--provider", default="github")
    parser.add_argument("--host", default="github.com")
    parser.add_argument("--control-plane-url", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--prompt", default="")
    return parser.parse_args()


def _require_opencode() -> None:
    try:
        subprocess.run(["opencode", "--version"], check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("opencode is not installed or not on PATH") from exc


async def _create_local_run(args: argparse.Namespace, prompt: str) -> Run:
    workdir = Path(args.workdir).resolve()
    repo_name = args.repo.strip() or f"local/{workdir.name}"
    owner, _, name = repo_name.partition("/")
    trigger = {
        "provider": args.provider,
        "host": args.host,
        "owner": owner or "local",
        "name": name or workdir.name,
        "clone_url": str(workdir),
        "default_branch": "",
        "base_sha": "",
        "head_sha": "",
        "head_branch": "",
        "pr_number": None,
        "user_prompt": prompt,
        "local_repro": True,
    }
    async with get_session() as db:
        run = Run(
            bundle=args.bundle,
            provider=args.provider,
            repo_full_name=repo_name,
            pr_number=None,
            head_sha=None,
            trigger=trigger,
            status=RunStatus.running.value,
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        await runs.append_event(
            db,
            run.id,
            "log",
            {
                "event": "local_repro.created",
                "workdir": str(workdir),
                "opencode_port": OPENCODE_PORT,
            },
        )
        return run


def _build_supervisor(args: argparse.Namespace, run: Run) -> SandboxSupervisor:
    settings = get_settings()
    sup = SandboxSupervisor.__new__(SandboxSupervisor)
    sup.run_id = run.id
    sup.session_id = run.session_id
    sup.bundle = args.bundle
    sup.agent_model = args.model.strip() or settings.agent_model
    sup.repo_path = Path(args.workdir).resolve()
    sup.opencode_ready = asyncio.Event()
    sup.opencode_process = None
    sup.shutdown_event = asyncio.Event()
    sup.log = get_logger(
        "local-repro",
        service="coreview-runtime",
        run_id=run.id,
        session_id=run.session_id,
    )
    return sup


async def _set_final_status(run_id: str, ok: bool, error: str | None = None) -> None:
    status = RunStatus.succeeded if ok else RunStatus.failed
    async with get_session() as db:
        await runs.set_status(db, run_id, status, error=error)


async def _main() -> int:
    load_dotenv()
    configure_logging()
    _require_opencode()

    args = _parse_args()
    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        raise SystemExit(f"workdir does not exist: {workdir}")

    prompt = args.prompt.strip() or input("Prompt for OpenCode: ").strip()
    if not prompt:
        raise SystemExit("prompt is required")

    await init_db()
    run = await _create_local_run(args, prompt)
    settings = get_settings()
    control_plane_url = args.control_plane_url.strip() or settings.control_plane_url
    print(f"Run ID: {run.id}")
    print(f"UI: http://localhost:3000/sessions/{run.id}")
    print("Starting local OpenCode server and bridge...")

    sup = _build_supervisor(args, run)
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_requested.set)

    try:
        await sup.start_opencode()
        bridge = AgentBridge(
            run_id=run.id,
            session_id=run.session_id,
            control_plane_url=control_plane_url,
            auth_token=run.auth_token,
            opencode_port=OPENCODE_PORT,
        )
        bridge_task = asyncio.create_task(bridge.run_review(prompt))
        stop_task = asyncio.create_task(stop_requested.wait())
        done, pending = await asyncio.wait(
            {bridge_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if stop_task in done:
            await _set_final_status(run.id, False, "local repro interrupted")
            return 130
        ok = await bridge_task
        await _set_final_status(run.id, ok, None if ok else "local bridge returned error")
        return 0 if ok else 1
    finally:
        sup.shutdown_event.set()
        if sup.opencode_process and sup.opencode_process.returncode is None:
            sup.opencode_process.terminate()
            try:
                await asyncio.wait_for(sup.opencode_process.wait(), timeout=5)
            except TimeoutError:
                sup.opencode_process.kill()
                await sup.opencode_process.wait()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
