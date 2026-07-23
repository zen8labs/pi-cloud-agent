"""Prepare the repository checkout Pi will work in."""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

from .config import RuntimeConfig
from .constants import (
    CLONE_DEPTH_COMMITS,
    SETUP_SCRIPT_REL_PATH,
    SETUP_SCRIPT_TIMEOUT_SECONDS,
)


class Workspace:
    def __init__(self, config: RuntimeConfig, log) -> None:
        self.config = config
        self.log = log

    @staticmethod
    def _redact(stderr: str) -> str:
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr)

    async def _git(self, *args: str, cwd: Path | None = None) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        return process.returncode or 0, self._redact(stderr.decode(errors="replace"))

    async def configure_credentials(self) -> None:
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

    async def clone(self) -> None:
        if not self.config.repo_clone_url:
            raise RuntimeError("REPO_CLONE_URL is required")

        branches = list(
            dict.fromkeys(
                branch
                for branch in (
                    self.config.repo_head_branch,
                    self.config.repo_default_branch,
                )
                if branch
            )
        )
        last_error = ""
        for branch in branches:
            code, last_error = await self._git(
                "clone",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "--branch",
                branch,
                self.config.repo_clone_url,
                str(self.config.repo_path),
            )
            if not code:
                self.log.info("git.clone_complete", branch=branch)
                break
            self.log.warn("git.clone_branch_failed", branch=branch, stderr=last_error)
        else:
            code, last_error = await self._git(
                "clone",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                self.config.repo_clone_url,
                str(self.config.repo_path),
            )
            if code:
                raise RuntimeError(last_error.strip() or f"git exited {code}")

        await self._checkout_requested_revision()
        self.log.info("git.checkout_ready", repo_path=str(self.config.repo_path))

    async def _checkout_requested_revision(self) -> None:
        if self.config.repo_head_sha:
            await self._git(
                "fetch",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "origin",
                self.config.repo_head_sha,
                cwd=self.config.repo_path,
            )
            code, stderr = await self._git(
                "reset",
                "--hard",
                self.config.repo_head_sha,
                cwd=self.config.repo_path,
            )
            if code:
                raise RuntimeError(
                    f"cannot check out {self.config.repo_head_sha}: {stderr}"
                )
        if self.config.repo_base_sha:
            await self._git(
                "fetch",
                "--depth",
                str(CLONE_DEPTH_COMMITS),
                "origin",
                self.config.repo_base_sha,
                cwd=self.config.repo_path,
            )

    async def run_setup(self) -> None:
        script = self.config.repo_path / SETUP_SCRIPT_REL_PATH
        if not script.exists():
            self.log.info("setup.skip", reason="no_script")
            return
        process = await asyncio.create_subprocess_exec(
            "bash",
            str(script),
            cwd=str(self.config.repo_path),
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
            self.log.warn("setup.timeout")
            return
        if process.returncode:
            output = stdout.decode(errors="replace")
            self.log.warn(
                "setup.failed",
                exit_code=process.returncode,
                output_tail="\n".join(output.splitlines()[-50:]),
            )
            return
        self.log.info("setup.complete")
