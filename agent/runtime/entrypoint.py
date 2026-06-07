#!/usr/bin/env python3
"""Sandbox supervisor — PID 1 inside the E2B sandbox.

A faithful, headless-review port of the reference ``sandbox_runtime.entrypoint``
(originally written against OpenCode 1.14.41, upgraded to 1.16.2), retargeted to our run-oriented HTTP
controller and stripped of everything irrelevant to a one-shot PR review
(code-server, ttyd, tunnels, agent-browser, slack, multiplayer, spawn/cancel
tools). Responsibilities, in order:

  1. Install the git credential-helper shim + configure git so every git op
     authenticates via the controller's /git-credentials endpoint (no long-lived
     token baked into the sandbox). Ported from the reference shim approach.
  2. Clone the PR repo (``REPO_CLONE_URL``) and check out ``REPO_HEAD_SHA``.
  3. Run the repo's ``.coreview/setup.sh`` hook if present (non-fatal).
  4. Build the OpenCode config from the bundle's ``opencode.jsonc``: inject the
     resolved provider/model, stage the ``report_finding`` plugin tool into
     ``.opencode/tool/``, stage the skill + reviewer/critic subagents, and
     pre-stage ``@opencode-ai/plugin`` deps into ``.opencode/`` (matching the
     reference's ``_install_tools``). Pass the config inline via
     ``OPENCODE_CONFIG_CONTENT`` — the same env the reference uses.
  5. Start ``opencode serve --port 4096``, health-check ``/global/health``.
  6. Run the bridge in-process: it injects the initial prompt (the bundle's
     ``skills/pr-review/SKILL.md`` body + a one-line "review PR #N"), forwards
     OpenCode's SSE events to the controller, and posts ``{"status": "done"}``
     when the session completes.
  7. Monitor OpenCode with backoff/restart; handle SIGTERM/SIGINT gracefully.

Run as ``python -m runtime.entrypoint``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import queue
import re
import shutil
import signal
import time
from pathlib import Path

import httpx

from .bridge import AgentBridge
from .constants import (
    BACKOFF_BASE_SECONDS,
    BACKOFF_MAX_SECONDS,
    BUNDLES_DIR,
    CLONE_DEPTH_COMMITS,
    DEFAULT_AGENT_MODEL,
    MAX_RESTARTS,
    OPENCODE_DEPS_DIR,
    OPENCODE_HEALTH_TIMEOUT_SECONDS,
    OPENCODE_HOSTNAME,
    OPENCODE_PORT,
    SETUP_SCRIPT_REL_PATH,
    SETUP_SCRIPT_TIMEOUT_SECONDS,
    WORKSPACE_DIR,
)
from .log_config import attach_log_forwarder, configure_logging, get_logger

configure_logging()

# Git invokes this shim for every credential request; it delegates to our
# Python helper module, which brokers a fresh per-request token from the
# controller. Installed system-wide at boot (ported from the reference shim
# approach in entrypoint._ensure_credential_helper_configured / the image build)
# so it applies even before the first git op.
GIT_CREDENTIAL_SHIM_PATH = Path("/usr/local/bin/coreview-git-credentials")
GIT_CREDENTIAL_SHIM_BODY = (
    "#!/bin/sh\nexec python3 -m runtime.git_credential_helper \"$@\"\n"
)


class SandboxSupervisor:
    """Supervises the in-sandbox review: git setup, OpenCode, the bridge."""

    def __init__(self) -> None:
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.opencode_ready = asyncio.Event()
        self.clone_error: str | None = None  # git stderr, surfaced on clone failure

        # Env contract injected by the controller (see e2b_provider._build_env
        # and the harness runtime_env).
        self.run_id = os.environ.get("RUN_ID", "")
        self.session_id = os.environ.get("SESSION_ID", "")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.bundle = os.environ.get("BUNDLE", "pr_review")
        self.agent_model = os.environ.get("AGENT_MODEL", "") or DEFAULT_AGENT_MODEL
        self.agent_fallback_models = os.environ.get("AGENT_FALLBACK_MODELS", "")

        self.repo_host = os.environ.get("REPO_HOST", "github.com")
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
            service="coreview-runtime",
            run_id=self.run_id,
            session_id=self.session_id,
        )

    # ------------------------------------------------------------------
    # Git
    # ------------------------------------------------------------------

    @staticmethod
    def _redact_git_stderr(stderr_text: str) -> str:
        """Redact any credential-bearing URL git may surface (e.g. redirects)."""
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr_text)

    async def _git(self, *args: str, cwd: Path | None = None) -> tuple[int, str]:
        """Run a git command, returning (returncode, redacted stderr)."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await proc.communicate()
        return proc.returncode or 0, self._redact_git_stderr(stderr.decode(errors="replace"))

    def _install_credential_helper_shim(self) -> bool:
        """Write the credential-helper shim to /usr/local/bin and make it exec.

        Idempotent — re-applied every boot so a snapshot/old image gets patched.
        Returns True if the shim is available for git to call. Ported from the
        reference ``_ensure_credential_helper_configured``.
        """
        try:
            if (
                GIT_CREDENTIAL_SHIM_PATH.exists()
                and GIT_CREDENTIAL_SHIM_PATH.read_text() == GIT_CREDENTIAL_SHIM_BODY
            ):
                return True
            GIT_CREDENTIAL_SHIM_PATH.write_text(GIT_CREDENTIAL_SHIM_BODY)
            GIT_CREDENTIAL_SHIM_PATH.chmod(0o755)
            return True
        except OSError as e:
            self.log.warn("credential_helper.shim_write_failed", error=str(e))
            return False

    async def configure_git_credentials(self) -> None:
        """Point git at our credential helper for all https ops.

        ``credential.useHttpPath=true`` includes the repo path in helper requests
        so the controller can scope the minted token if it chooses. The remote
        URL itself stays token-free — the helper supplies creds per request,
        brokered from the controller's /git-credentials endpoint. Ported from the
        reference: install the shim, then configure git globally to call it.
        """
        shim_available = self._install_credential_helper_shim()

        configs: list[tuple[str, str]] = [("credential.useHttpPath", "true")]
        if shim_available:
            configs.insert(0, ("credential.helper", str(GIT_CREDENTIAL_SHIM_PATH)))

        for key, value in configs:
            rc, stderr = await self._git("config", "--global", "--replace-all", key, value)
            if rc != 0:
                self.log.warn("git.config_failed", config_key=key, stderr=stderr)
        self.log.info("git.credentials_configured", shim_available=shim_available)

    async def _clone_with_fallback(self) -> bool:
        """Clone the repo at the requested branch, else the remote's default HEAD.

        The controller resolves each repo's real default branch from the VCS API
        before launching, so the requested branch (head, then default) normally
        clones first try. If none is set — or a stale one can't be found — we
        clone with no ``--branch`` so git uses whatever the remote's default
        HEAD is. No hardcoded branch-name guessing. Sets ``self.clone_error`` if
        even the default-HEAD clone fails.
        """
        # Requested branches in order, de-duplicated. For a PR review head is the
        # PR branch; for a chat session head == the resolved default branch.
        requested: list[str] = []
        for b in (self.repo_head_branch, self.repo_default_branch):
            if b and b not in requested:
                requested.append(b)

        last_stderr = ""
        for branch in requested:
            rc, stderr = await self._git(
                "clone", "--depth", str(CLONE_DEPTH_COMMITS), "--branch", branch,
                self.repo_clone_url, str(self.repo_path),
            )
            if rc == 0:
                self.log.info("git.clone_branch_ok", branch=branch)
                return True
            last_stderr = stderr
            self.log.warn("git.clone_branch_failed", branch=branch, stderr=stderr)

        # No branch specified, or it no longer exists: clone the remote's default.
        rc, stderr = await self._git(
            "clone", "--depth", str(CLONE_DEPTH_COMMITS),
            self.repo_clone_url, str(self.repo_path),
        )
        if rc == 0:
            self.log.info("git.clone_default_head_ok")
            return True
        self.clone_error = (stderr or last_stderr).strip() or f"git exited {rc}"
        self.log.error("git.clone_error", stderr=self.clone_error, exit_code=rc)
        return False

    async def clone_repo(self) -> bool:
        """Shallow-clone the PR repo and check out the head SHA.

        Clones the head branch (token-free URL — the credential helper supplies
        auth), then resets to the exact ``REPO_HEAD_SHA`` so the review runs
        against the precise commit the controller recorded, not a moving tip.
        Falls back to the remote's default HEAD when the requested branch is
        missing (see ``_clone_with_fallback``).
        """
        if not self.repo_clone_url:
            self.log.error("git.clone_skip", reason="no_clone_url")
            return False

        self.log.info("git.clone_start", repo_name=self.repo_name, head_sha=self.repo_head_sha)
        if not await self._clone_with_fallback():
            return False

        # Pin to the exact head SHA. The shallow clone may not contain it if the
        # branch advanced; fetch it explicitly, then hard-reset.
        if self.repo_head_sha:
            await self._git(
                "fetch", "--depth", str(CLONE_DEPTH_COMMITS), "origin", self.repo_head_sha,
                cwd=self.repo_path,
            )
            rc, stderr = await self._git("reset", "--hard", self.repo_head_sha, cwd=self.repo_path)
            if rc != 0:
                self.log.warn("git.checkout_head_sha_failed", stderr=stderr, sha=self.repo_head_sha)

        # Make the base SHA available locally for `git diff base...head`.
        if self.repo_base_sha:
            await self._git(
                "fetch", "--depth", str(CLONE_DEPTH_COMMITS), "origin", self.repo_base_sha,
                cwd=self.repo_path,
            )

        self.log.info("git.clone_complete", repo_path=str(self.repo_path))
        return True

    # ------------------------------------------------------------------
    # Repo setup hook
    # ------------------------------------------------------------------

    async def run_setup_script(self) -> bool:
        """Run ``.coreview/setup.sh`` if present (non-fatal on failure)."""
        script_path = self.repo_path / SETUP_SCRIPT_REL_PATH
        if not script_path.exists():
            self.log.info("setup.skip", reason="no_script", path=str(script_path))
            return True

        self.log.info("setup.start", script=str(script_path))
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash",
                str(script_path),
                cwd=str(self.repo_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=os.environ.copy(),
            )
            try:
                stdout, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=SETUP_SCRIPT_TIMEOUT_SECONDS
                )
            except TimeoutError:
                proc.kill()
                await proc.wait()
                self.log.error("setup.timeout", timeout_seconds=SETUP_SCRIPT_TIMEOUT_SECONDS)
                return False

            tail = "\n".join((stdout.decode(errors="replace") if stdout else "").splitlines()[-50:])
            if proc.returncode == 0:
                self.log.info("setup.complete")
                return True
            self.log.error("setup.failed", exit_code=proc.returncode, output_tail=tail)
            return False
        except Exception as e:  # noqa: BLE001
            self.log.error("setup.error", exc=e)
            return False

    # ------------------------------------------------------------------
    # OpenCode config + asset staging
    # ------------------------------------------------------------------

    def _resolve_bundles_dir(self) -> Path:
        """Locate the installed ``bundles/`` package directory.

        Prefer the import location of the installed ``bundles`` package so the
        path is correct regardless of where the image put it; fall back to the
        known ``/app/bundles`` install location.
        """
        spec = importlib.util.find_spec("bundles")
        if spec and spec.submodule_search_locations:
            return Path(next(iter(spec.submodule_search_locations)))
        return BUNDLES_DIR

    def _bundle_opencode_dir(self) -> Path:
        """The bundle's baked ``opencode/`` asset directory."""
        return self._resolve_bundles_dir() / self.bundle / "opencode"

    def _bundle_tools_dir(self) -> Path:
        """The bundle's baked ``tools/`` directory (holds report_finding.js)."""
        return self._resolve_bundles_dir() / self.bundle / "tools"

    @staticmethod
    def _strip_jsonc(text: str) -> str:
        """Strip ``//`` line comments and ``/* */`` block comments from JSONC.

        OpenCode reads JSONC, but we parse the bundle config in Python to inject
        the resolved model before handing it to OpenCode as ``OPENCODE_CONFIG_CONTENT``,
        so a tiny tolerant stripper is enough (no strings contain ``//`` here).
        """
        # Remove block comments first, then line comments.
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
        text = re.sub(r"(?m)^\s*//.*$", "", text)
        text = re.sub(r"\s+//.*$", "", text, flags=re.MULTILINE)
        return text

    def _build_opencode_config(self) -> dict:
        """Load the bundle's opencode.jsonc and inject the resolved model.

        AGENT_MODEL is LiteLLM-style ``provider/model`` which is exactly the
        ``provider/model`` form OpenCode's top-level ``model`` field expects, so
        we set it verbatim. The bundle file declares tools, the report_finding
        plugin enablement, and the reviewer/critic subagents; we only override
        the concrete model values here so the file stays env-agnostic.
        """
        config: dict = {"permission": {"*": {"*": "allow"}}}
        config_path = self._bundle_opencode_dir() / "opencode.jsonc"
        if config_path.exists():
            try:
                config = json.loads(self._strip_jsonc(config_path.read_text()))
            except (OSError, json.JSONDecodeError) as e:
                self.log.warn("opencode.config_parse_failed", path=str(config_path), exc=e)

        # Inject the resolved model/provider (the file uses {env:AGENT_MODEL}
        # placeholders which OpenCode may not interpolate in this position).
        config["model"] = self.agent_model
        config.setdefault("small_model", self.agent_model)
        # Headless review never edits/commits — keep everything allowed so the
        # agent isn't blocked on a permission prompt it can't answer.
        config.setdefault("permission", {"*": {"*": "allow"}})

        # Point the harness at the self-hosted gateway. Routing depends on the
        # provider prefix in AGENT_MODEL (see _inject_gateway_provider).
        self._inject_gateway_provider(config)

        # Diagnostic: log the final config (redact the API key).
        import copy
        debug_config = copy.deepcopy(config)
        for prov in debug_config.get("provider", {}).values():
            if isinstance(prov.get("options"), dict):
                prov["options"].pop("apiKey", None)
        self.log.info("opencode.config_built", config=debug_config)

        return config

    def _inject_gateway_provider(self, config: dict) -> None:
        """Wire the configured gateway URL into the OpenCode provider block.

        Custom gateway providers use ``@ai-sdk/openai-compatible``. Preserve the
        full model path from AGENT_MODEL so the gateway receives model names like
        ``MiniMax/MiniMax-M2.7`` rather than the shortened leaf name.
        """
        base_url = os.environ.get("OPENAI_BASE_URL", "").strip()
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not base_url:
            return
        provider_id, _, model_path = self.agent_model.partition("/")
        if not model_path:
            return
        model_key = model_path
        config["model"] = f"{provider_id}/{model_key}"
        config["small_model"] = f"{provider_id}/{model_key}"
        providers = config.setdefault("provider", {})
        provider_cfg = providers.setdefault(provider_id, {})
        if provider_id not in {"anthropic", "openai", "google"}:
            provider_cfg["npm"] = "@ai-sdk/openai-compatible"
        provider_cfg.setdefault("name", provider_id)
        options = provider_cfg.setdefault("options", {})
        options["baseURL"] = base_url
        if api_key:
            options["apiKey"] = api_key
        models = provider_cfg.setdefault("models", {})
        models.setdefault(model_key, {"name": model_path})

    def _stage_opencode_assets(self, workdir: Path) -> None:
        """Stage tools, skills, subagents, and plugin deps into ``.opencode/``.

        Mirrors the reference ``_install_tools`` / ``_install_skills``:
          * report_finding.js  -> ``.opencode/tool/report_finding.js``
          * skills/*           -> ``.opencode/skills/*``
          * subagents/*.md     -> ``.opencode/agent/*.md``  (OpenCode reads agent
            prompt bodies from ``.opencode/agent/``)
          * @opencode-ai/plugin deps (package.json/lock/node_modules) copied from
            the image's staging dir so OpenCode's Npm.install() is a no-op.
        """
        opencode_dir = workdir / ".opencode"

        # --- Tools (the report_finding plugin tool) --------------------------
        tools_src = self._bundle_tools_dir()
        if tools_src.is_dir():
            tool_dest = opencode_dir / "tool"
            tool_dest.mkdir(parents=True, exist_ok=True)
            for tool_file in tools_src.iterdir():
                if tool_file.is_file() and tool_file.suffix == ".js":
                    shutil.copy(tool_file, tool_dest / tool_file.name)
                    self.log.info("opencode.tool_staged", tool=tool_file.name)

        bundle_opencode = self._bundle_opencode_dir()

        # --- Skills ----------------------------------------------------------
        skills_src = bundle_opencode / "skills"
        if skills_src.is_dir():
            skills_dest = opencode_dir / "skills"
            shutil.copytree(
                skills_src,
                skills_dest,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
            )
            self.log.info("opencode.skills_staged", path=str(skills_dest))

        # --- Subagents -> .opencode/agent ------------------------------------
        subagents_src = bundle_opencode / "subagents"
        if subagents_src.is_dir():
            agent_dest = opencode_dir / "agent"
            agent_dest.mkdir(parents=True, exist_ok=True)
            staged = []
            for md in subagents_src.glob("*.md"):
                shutil.copy(md, agent_dest / md.name)
                staged.append(md.name)
            self.log.info("opencode.subagents_staged", path=str(agent_dest), files=staged)
        else:
            self.log.info("opencode.subagents_none", bundle=self.bundle)

        # --- Pre-staged @opencode-ai/plugin deps -----------------------------
        # Gives OpenCode a lockfile in sync with the declared deps so its
        # Npm.install() finds everything and skips arborist reify() entirely.
        deps_cache = OPENCODE_DEPS_DIR
        opencode_dir.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "package-lock.json"):
            src = deps_cache / name
            dest = opencode_dir / name
            if src.exists() and not dest.exists():
                shutil.copy2(src, dest)
        cached_modules = deps_cache / "node_modules"
        local_modules = opencode_dir / "node_modules"
        if cached_modules.is_dir() and not local_modules.exists():
            shutil.copytree(cached_modules, local_modules, symlinks=True)

    # ------------------------------------------------------------------
    # OpenCode
    # ------------------------------------------------------------------

    def _workdir(self) -> Path:
        """OpenCode's cwd: the repo if cloned, else the workspace root."""
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            return self.repo_path
        return WORKSPACE_DIR

    async def start_opencode(self) -> None:
        """Start the OpenCode server pointed at the staged config + model."""
        self.opencode_ready.clear()
        workdir = self._workdir()
        self._stage_opencode_assets(workdir)
        opencode_config = self._build_opencode_config()

        self.log.info(
            "opencode.start",
            bundle=self.bundle,
            model=self.agent_model,
            workdir=str(workdir),
        )

        env = {
            **os.environ,
            # The proven config-injection path the reference uses: inline JSON
            # in OPENCODE_CONFIG_CONTENT. Staged .opencode/ (tools, skills,
            # agents) is auto-discovered relative to the cwd.
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            # Headless: there is no channel to answer OpenCode's interactive
            # question tool, so make sure it runs in serve mode (reference note).
            "OPENCODE_CLIENT": "serve",
        }

        self.opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(OPENCODE_PORT),
            "--hostname",
            OPENCODE_HOSTNAME,
            "--print-logs",
            cwd=str(workdir),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        asyncio.create_task(self._forward_opencode_logs())

        await self._wait_for_health()
        self.opencode_ready.set()
        self.log.info("opencode.ready")

    async def _forward_opencode_logs(self) -> None:
        """Forward OpenCode stdout to our (stderr-based) log stream."""
        if not self.opencode_process or not self.opencode_process.stdout:
            return
        try:
            async for line in self.opencode_process.stdout:
                self.log.info("opencode.stdout", line=line.decode(errors="replace").rstrip())
        except Exception as e:  # noqa: BLE001
            self.log.warn("opencode.log_forward_error", exc=e)

    async def _wait_for_health(self) -> None:
        """Poll OpenCode's health endpoint until ready, or raise on timeout.

        Uses ``/global/health`` — the route confirmed working for OpenCode 1.16.2.
        """
        health_url = f"http://localhost:{OPENCODE_PORT}/global/health"
        start = time.time()
        async with httpx.AsyncClient() as client:
            while time.time() - start < OPENCODE_HEALTH_TIMEOUT_SECONDS:
                if self.shutdown_event.is_set():
                    raise RuntimeError("Shutdown requested during OpenCode startup")
                try:
                    resp = await client.get(health_url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        raise RuntimeError("OpenCode server failed to become healthy")

    # ------------------------------------------------------------------
    # Bridge + review
    # ------------------------------------------------------------------

    def _find_skill_body(self) -> str:
        """Read the bundle's skill body (the real driver of the agent).

        Bundle-agnostic: each bundle stages exactly one skill under
        ``opencode/skills/<name>/SKILL.md`` (pr-review for pr_review, general for
        general_agent). We load the first SKILL.md we find and feed it verbatim.
        """
        skills_dir = self._bundle_opencode_dir() / "skills"
        if not skills_dir.is_dir():
            return ""
        for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
            try:
                return skill_md.read_text()
            except OSError as e:
                self.log.warn("prompt.skill_read_failed", path=str(skill_md), exc=e)
        return ""

    def _build_initial_prompt(self) -> str:
        """Build the initial prompt for the agent session.

        Bundles with a skill (e.g. pr_review) get: skill body + a one-line task
        pointer. Bundles without a skill (e.g. general_agent) pass the user's
        prompt directly — OpenCode's own system prompt covers the how-to-work
        instructions, so no wrapper is needed.
        """
        skill_body = self._find_skill_body()
        user_prompt = os.environ.get("USER_PROMPT", "").strip()

        if not skill_body:
            return user_prompt

        if user_prompt:
            task_line = f"Carry out the following request, following the skill above:\n\n{user_prompt}"
        elif self.pr_number:
            task_line = f"Review PR #{self.pr_number} now, following the skill above."
        else:
            task_line = "Review this pull request now, following the skill above."

        return f"{skill_body.strip()}\n\n---\n\n{task_line}"

    async def run_review(self) -> None:
        """Run the review once OpenCode is healthy.

        The bridge injects the skill prompt, forwards events, and posts the
        terminal status. When it returns, the review is over and we shut down.
        """
        await self.opencode_ready.wait()
        bridge = AgentBridge(
            run_id=self.run_id,
            session_id=self.session_id,
            control_plane_url=self.control_plane_url,
            auth_token=self.sandbox_token,
            opencode_port=OPENCODE_PORT,
        )
        await bridge.run_review(self._build_initial_prompt())
        # Review finished (done or error already posted) — begin shutdown.
        self.shutdown_event.set()

    async def monitor_opencode(self) -> None:
        """Restart OpenCode with exponential backoff if it crashes mid-review."""
        restart_count = 0
        while not self.shutdown_event.is_set():
            if self.opencode_process and self.opencode_process.returncode is not None:
                exit_code = self.opencode_process.returncode
                restart_count += 1
                self.log.error("opencode.crash", exit_code=exit_code, restart_count=restart_count)
                if restart_count > MAX_RESTARTS:
                    self.log.error("opencode.max_restarts", restart_count=restart_count)
                    await self._report_status("error", "OpenCode crashed repeatedly")
                    self.shutdown_event.set()
                    break
                delay = min(BACKOFF_BASE_SECONDS**restart_count, BACKOFF_MAX_SECONDS)
                self.log.info("opencode.restart", delay_s=round(delay, 1))
                await asyncio.sleep(delay)
                try:
                    await self.start_opencode()
                except Exception as e:  # noqa: BLE001
                    self.log.error("opencode.restart_failed", exc=e)
            await asyncio.sleep(1.0)

    async def _report_status(self, status: str, detail: str | None) -> None:
        """Post a status to the controller (used for fatal supervisor errors)."""
        if not self.control_plane_url or not self.run_id:
            return
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.control_plane_url.rstrip('/')}/internal/runs/{self.run_id}/status",
                    json={"status": status, "detail": detail},
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                    timeout=5.0,
                )
        except Exception as e:  # noqa: BLE001
            self.log.error("supervisor.report_status_failed", exc=e)

    async def _forward_logs(self, log_queue: queue.Queue) -> None:
        """Drain queued log records and POST them to the controller as events.

        Runs until shutdown is signalled AND the queue is empty, so the last
        lines before a failure still reach the dashboard. Best-effort: a failed
        POST drops that line rather than crashing the supervisor.
        """
        if not (self.control_plane_url and self.run_id and self.sandbox_token):
            return
        url = f"{self.control_plane_url.rstrip('/')}/internal/runs/{self.run_id}/events"
        headers = {"Authorization": f"Bearer {self.sandbox_token}"}
        async with httpx.AsyncClient(timeout=5.0, headers=headers) as client:
            while not self.shutdown_event.is_set() or not log_queue.empty():
                batch: list[dict] = []
                while len(batch) < 50:
                    try:
                        batch.append(log_queue.get_nowait())
                    except queue.Empty:
                        break
                for item in batch:
                    try:
                        await client.post(url, json={"type": "log", "data": item})
                    except Exception:  # noqa: BLE001 — never let logging break the run
                        pass
                if not batch:
                    await asyncio.sleep(0.4)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main supervisor flow."""
        startup_start = time.time()
        self.log.info("supervisor.start", repo_name=self.repo_name, bundle=self.bundle)

        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        # Stream every supervisor log line to the controller's /events so the
        # full sandbox log shows up in the dashboard's live log.
        log_queue = attach_log_forwarder()
        log_task = asyncio.create_task(self._forward_logs(log_queue))

        try:
            await self.configure_git_credentials()

            if not await self.clone_repo():
                raise RuntimeError(f"git clone failed: {self.clone_error or 'unknown error'}")

            if not await self.run_setup_script():
                # Non-fatal: a failed setup hook shouldn't block the review, but
                # we surface it so the controller's event log shows it.
                self.log.warn("setup.nonfatal_failure")

            await self.start_opencode()

            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info("sandbox.startup", duration_ms=duration_ms, outcome="success")

            # Run the review and monitor OpenCode concurrently; either the
            # review finishing or a fatal crash sets shutdown_event.
            await asyncio.gather(
                self.run_review(),
                self.monitor_opencode(),
            )
        except Exception as e:  # noqa: BLE001
            self.log.error("supervisor.error", exc=e)
            await self._report_status("error", str(e))
        finally:
            await self.shutdown()
            # Let the forwarder flush remaining log lines, then stop it.
            self.shutdown_event.set()
            try:
                await asyncio.wait_for(log_task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                log_task.cancel()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Terminate OpenCode gracefully, escalating to kill on timeout."""
        self.log.info("supervisor.shutdown_start")
        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()
        self.log.info("supervisor.shutdown_complete")


async def main() -> None:
    """Entry point for the sandbox supervisor."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())
