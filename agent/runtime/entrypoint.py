#!/usr/bin/env python3
"""One-shot sandbox supervisor for the embedded Pi agent."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import queue
import re
import signal
from pathlib import Path

import httpx

from .constants import (
    BUNDLES_DIR,
    CLONE_DEPTH_COMMITS,
    PI_RUNNER,
    SETUP_SCRIPT_REL_PATH,
    SETUP_SCRIPT_TIMEOUT_SECONDS,
    WORKSPACE_DIR,
)
from .log_config import attach_log_forwarder, configure_logging, get_logger

configure_logging()


class SandboxSupervisor:
    """Prepare a checkout, run Pi once, and forward runtime logs."""

    def __init__(self) -> None:
        self.shutdown_event = asyncio.Event()
        self.agent_process: asyncio.subprocess.Process | None = None
        self.clone_error: str | None = None

        self.run_id = os.environ.get("RUN_ID", "")
        self.session_id = os.environ.get("SESSION_ID", "")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.bundle = os.environ.get("BUNDLE", "pr_review")

        self.repo_name = os.environ.get("REPO_NAME", "")
        self.repo_clone_url = os.environ.get("REPO_CLONE_URL", "")
        self.repo_base_sha = os.environ.get("REPO_BASE_SHA", "")
        self.repo_head_sha = os.environ.get("REPO_HEAD_SHA", "")
        self.repo_head_branch = os.environ.get("REPO_HEAD_BRANCH", "")
        self.repo_default_branch = os.environ.get("REPO_DEFAULT_BRANCH", "main")
        self.pr_number = os.environ.get("PR_NUMBER", "")
        self.repo_path = WORKSPACE_DIR / (self.repo_name or "repo")

        self.log = get_logger(
            "supervisor",
            service="cloud-agent-runtime",
            run_id=self.run_id,
            session_id=self.session_id,
        )

    @staticmethod
    def _redact_git_stderr(stderr_text: str) -> str:
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr_text)

    async def _git(self, *args: str, cwd: Path | None = None) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        return process.returncode or 0, self._redact_git_stderr(
            stderr.decode(errors="replace")
        )

    async def configure_git_credentials(self) -> None:
        token = os.environ.get("SCM_TOKEN", "")
        if not token:
            self.log.warn("git.no_scm_token")
            return

        username = os.environ.get("SCM_TOKEN_USERNAME", "x-access-token")
        helper = (
            "!f() { printf 'username=%s\\npassword=%s\\n' "
            f'"${{SCM_TOKEN_USERNAME:-{username}}}" "$SCM_TOKEN"; }}; f'
        )
        for key, value in (
            ("credential.helper", helper),
            ("credential.useHttpPath", "false"),
        ):
            code, stderr = await self._git(
                "config", "--global", "--replace-all", key, value
            )
            if code:
                self.log.warn("git.config_failed", config_key=key, stderr=stderr)
        self.log.info("git.credentials_configured", username=username)

    async def clone_repo(self) -> bool:
        if not self.repo_clone_url:
            self.clone_error = "REPO_CLONE_URL is required"
            return False

        branches = list(
            dict.fromkeys(
                branch
                for branch in (self.repo_head_branch, self.repo_default_branch)
                if branch
            )
        )
        last_stderr = ""
        for branch in branches:
            code, last_stderr = await self._git(
                "clone",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "--branch",
                branch,
                self.repo_clone_url,
                str(self.repo_path),
            )
            if not code:
                self.log.info("git.clone_complete", branch=branch)
                break
            self.log.warn(
                "git.clone_branch_failed", branch=branch, stderr=last_stderr
            )
        else:
            code, last_stderr = await self._git(
                "clone",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                self.repo_clone_url,
                str(self.repo_path),
            )
            if code:
                self.clone_error = last_stderr.strip() or f"git exited {code}"
                return False

        if self.repo_head_sha:
            await self._git(
                "fetch",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "origin",
                self.repo_head_sha,
                cwd=self.repo_path,
            )
            code, stderr = await self._git(
                "reset", "--hard", self.repo_head_sha, cwd=self.repo_path
            )
            if code:
                self.clone_error = f"cannot check out {self.repo_head_sha}: {stderr}"
                return False

        if self.repo_base_sha:
            await self._git(
                "fetch",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "origin",
                self.repo_base_sha,
                cwd=self.repo_path,
            )

        self.log.info("git.checkout_ready", repo_path=str(self.repo_path))
        return True

    async def run_setup_script(self) -> bool:
        script = self.repo_path / SETUP_SCRIPT_REL_PATH
        if not script.exists():
            self.log.info("setup.skip", reason="no_script")
            return True

        process = await asyncio.create_subprocess_exec(
            "bash",
            str(script),
            cwd=str(self.repo_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(), timeout=SETUP_SCRIPT_TIMEOUT_SECONDS
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            self.log.error("setup.timeout")
            return False

        output = stdout.decode(errors="replace")
        if process.returncode:
            self.log.error(
                "setup.failed",
                exit_code=process.returncode,
                output_tail="\n".join(output.splitlines()[-50:]),
            )
            return False
        self.log.info("setup.complete")
        return True

    def _resolve_bundles_dir(self) -> Path:
        spec = importlib.util.find_spec("bundles")
        if spec and spec.submodule_search_locations:
            return Path(next(iter(spec.submodule_search_locations)))
        return BUNDLES_DIR

    def _skill_body(self) -> str:
        skills = self._resolve_bundles_dir() / self.bundle / "pi" / "skills"
        for skill in sorted(skills.glob("*/SKILL.md")):
            try:
                return skill.read_text()
            except OSError as error:
                self.log.warn("prompt.skill_read_failed", path=str(skill), exc=error)
        return ""

    def build_prompt(self) -> str:
        skill = self._skill_body().strip()
        user_prompt = os.environ.get("USER_PROMPT", "").strip()
        if user_prompt:
            task = user_prompt
        elif self.pr_number:
            task = f"Review PR #{self.pr_number} in the current checkout."
        else:
            task = "Complete the requested task in the current checkout."
        return f"{skill}\n\n---\n\n{task}" if skill else task

    async def run_agent(self) -> None:
        env = {
            **os.environ,
            "REPO_PATH": str(self.repo_path),
            "AGENT_PROMPT": self.build_prompt(),
        }
        self.log.info(
            "pi.start",
            bundle=self.bundle,
            model=os.environ.get("AGENT_MODEL", ""),
            workdir=str(self.repo_path),
        )
        self.agent_process = await asyncio.create_subprocess_exec(
            "node",
            str(PI_RUNNER),
            cwd=str(self.repo_path),
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

    async def _report_status(self, status: str, detail: str | None) -> None:
        if not (self.control_plane_url and self.run_id and self.sandbox_token):
            return
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{self.control_plane_url.rstrip('/')}/internal/runs/{self.run_id}/status",
                    json={"status": status, "detail": detail},
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                )
        except Exception as error:  # noqa: BLE001
            self.log.error("supervisor.report_status_failed", exc=error)

    async def _forward_logs(self, log_queue: queue.Queue) -> None:
        if not (self.control_plane_url and self.run_id and self.sandbox_token):
            return
        url = f"{self.control_plane_url.rstrip('/')}/internal/runs/{self.run_id}/events"
        headers = {"Authorization": f"Bearer {self.sandbox_token}"}
        async with httpx.AsyncClient(timeout=5.0, headers=headers) as client:
            while not self.shutdown_event.is_set() or not log_queue.empty():
                try:
                    item = log_queue.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.4)
                    continue
                try:
                    await client.post(url, json={"type": "log", "data": item})
                except Exception:  # noqa: BLE001
                    pass

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(
                sig, lambda current=sig: asyncio.create_task(self._handle_signal(current))
            )

        log_task = asyncio.create_task(self._forward_logs(attach_log_forwarder()))
        try:
            await self.configure_git_credentials()
            if not await self.clone_repo():
                raise RuntimeError(f"git clone failed: {self.clone_error}")
            if not await self.run_setup_script():
                self.log.warn("setup.nonfatal_failure")
            await self.run_agent()
        except Exception as error:  # noqa: BLE001
            self.log.error("supervisor.error", exc=error)
            await self._report_status("error", str(error))
        finally:
            await self.shutdown()
            try:
                await asyncio.wait_for(log_task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                log_task.cancel()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        self.log.info("supervisor.signal", signal_name=sig.name)
        await self.shutdown()

    async def shutdown(self) -> None:
        if self.shutdown_event.is_set():
            return
        self.shutdown_event.set()
        if self.agent_process and self.agent_process.returncode is None:
            self.agent_process.terminate()
            try:
                await asyncio.wait_for(self.agent_process.wait(), timeout=10.0)
            except TimeoutError:
                self.agent_process.kill()
                await self.agent_process.wait()


def main() -> None:
    asyncio.run(SandboxSupervisor().run())


if __name__ == "__main__":
    main()
