"""One-shot lifecycle coordinator for a Pi sandbox run."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import signal
from pathlib import Path

from .config import RuntimeConfig
from .constants import PI_RUNNER, PROFILES_DIR
from .control import ControlReporter
from .log_config import attach_log_forwarder, get_logger
from .workspace import Workspace


class SandboxSupervisor:
    def __init__(self, config: RuntimeConfig | None = None) -> None:
        self.config = config or RuntimeConfig.from_env()
        self.stopped = asyncio.Event()
        self.agent_process: asyncio.subprocess.Process | None = None
        self.log = get_logger(
            "supervisor",
            service="cloud-agent-runtime",
            run_id=self.config.run_id,
            session_id=self.config.session_id,
        )
        self.workspace = Workspace(self.config, self.log)
        self.reporter = ControlReporter(self.config, self.log)

    def _profiles_dir(self) -> Path:
        spec = importlib.util.find_spec("profiles")
        if spec and spec.submodule_search_locations:
            return Path(next(iter(spec.submodule_search_locations)))
        return PROFILES_DIR

    def build_prompt(self) -> str:
        path = self._profiles_dir() / self.config.profile / "SKILL.md"
        try:
            instructions = path.read_text().strip()
        except FileNotFoundError:
            instructions = ""
        except OSError as error:
            self.log.warn("profile.read_failed", path=str(path), exc=error)
            instructions = ""
        return (
            f"{instructions}\n\n---\n\n{self.config.task_prompt}"
            if instructions
            else self.config.task_prompt
        )

    async def run_agent(self) -> None:
        env = {
            **os.environ,
            "REPO_PATH": str(self.config.repo_path),
            "AGENT_PROMPT": self.build_prompt(),
        }
        self.log.info(
            "pi.start",
            profile=self.config.profile,
            model=os.environ.get("AGENT_MODEL", ""),
            workdir=str(self.config.repo_path),
        )
        self.agent_process = await asyncio.create_subprocess_exec(
            "node",
            str(PI_RUNNER),
            cwd=str(self.config.repo_path),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert self.agent_process.stdout
        async for line in self.agent_process.stdout:
            self.log.info("pi.stdout", line=line.decode(errors="replace").rstrip())
        code = await self.agent_process.wait()
        if code:
            raise RuntimeError(f"Pi exited with status {code}")
        self.log.info("pi.complete")

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(
                sig,
                lambda current=sig: asyncio.create_task(self.handle_signal(current)),
            )
        log_task = asyncio.create_task(
            self.reporter.forward_logs(attach_log_forwarder(), self.stopped)
        )
        try:
            await self.workspace.configure_credentials()
            await self.workspace.clone()
            await self.workspace.run_setup()
            await self.run_agent()
        except Exception as error:  # noqa: BLE001
            self.log.error("supervisor.error", exc=error)
            await self.reporter.status("error", str(error))
        finally:
            await self.shutdown()
            try:
                await asyncio.wait_for(log_task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                log_task.cancel()

    async def handle_signal(self, sig: signal.Signals) -> None:
        self.log.info("supervisor.signal", signal_name=sig.name)
        await self.shutdown()

    async def shutdown(self) -> None:
        if self.stopped.is_set():
            return
        self.stopped.set()
        if self.agent_process and self.agent_process.returncode is None:
            self.agent_process.terminate()
            try:
                await asyncio.wait_for(self.agent_process.wait(), timeout=10.0)
            except TimeoutError:
                self.agent_process.kill()
                await self.agent_process.wait()
