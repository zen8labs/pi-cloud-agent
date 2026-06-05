"""E2B sandbox provider.

Provisions a sandbox from a prebuilt E2B template, injects the run's env +
secrets, then **explicitly launches** the in-sandbox supervisor
(``python -m runtime.entrypoint``, background) — which dials back to the
controller at ``CONTROL_PLANE_URL`` using ``SANDBOX_AUTH_TOKEN``.

We do NOT use the template ``start_cmd`` for this: on E2B the start command
runs at build/snapshot time, but our supervisor is a per-run task that needs
``RUN_ID``/``REPO_*`` (only known at create), so it must be exec'd per create.

E2B maps onto the *Daytona* persistent-resume shape (see
``ref/.../daytona-provider.ts``): the same sandbox is paused and later resumed
by its native id, rather than the Modal snapshot/restore shape. Hence
``supports_persistent_resume`` / ``supports_explicit_stop`` and *not* snapshots.

Secrets note: LLM provider keys arrive via ``config.secret_env`` and DO enter
the sandbox by necessity — the agent runs in there and needs them to call the
model. Git credentials deliberately do NOT travel here; they are brokered on
demand via the credential helper against the controller, so an embedded token
can't silently expire mid-run.

Egress note: E2B's hosted PaaS does not expose per-sandbox egress firewalling
through the SDK, so we pass ``SANDBOX_EGRESS_ALLOWLIST`` as env and let the
template/supervisor enforce it. Strict network-egress control is a
template/self-host concern and is deferred — we never fail a create just
because the SDK can't enforce it.
"""

from __future__ import annotations

from core.config.settings import get_settings
from core.logger import get_logger
from core.sandbox.provider import (
    CreateSandboxConfig,
    CreateSandboxResult,
    ResumeConfig,
    ResumeResult,
    SandboxHandle,
    SandboxProviderCapabilities,
    SandboxProviderError,
    StopConfig,
    StopResult,
)
from core.types import RepoRef

log = get_logger("e2b-provider")


def _build_env(config: CreateSandboxConfig) -> dict[str, str]:
    """Assemble the env contract the in-sandbox supervisor boots against.

    Order matters: user/non-secret env first, then secrets, then the
    controller-derived keys overlaid last so they can't be shadowed.
    """
    env: dict[str, str] = {}
    env.update(config.env)
    # Secrets (LLM keys) — needed by the agent inside the sandbox.
    env.update(config.secret_env)

    repo: RepoRef = config.repo
    env.update(
        {
            "PYTHONUNBUFFERED": "1",
            "CONTROL_PLANE_URL": config.control_plane_url,
            "RUN_ID": config.run_id,
            "SESSION_ID": config.session_id,
            "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
            # Repo coordinates — clone URL only; the token is injected later by
            # the credential helper, not baked in here.
            "REPO_PROVIDER": repo.provider,
            "REPO_HOST": repo.host,
            "REPO_OWNER": repo.owner,
            "REPO_NAME": repo.name,
            "REPO_CLONE_URL": repo.clone_url,
            "REPO_DEFAULT_BRANCH": repo.default_branch,
            "REPO_BASE_SHA": repo.base_sha,
            "REPO_HEAD_SHA": repo.head_sha,
            "REPO_HEAD_BRANCH": repo.head_branch,
            "PR_NUMBER": str(repo.pr_number) if repo.pr_number is not None else "",
            # Advisory allowlist; enforced at template/supervisor layer (see module docstring).
            "SANDBOX_EGRESS_ALLOWLIST": ",".join(config.egress_allowlist),
        }
    )
    return env


def _status_from_exc(exc: Exception) -> int | None:
    """Best-effort HTTP status extraction so error classification can be precise.

    E2B SDK errors don't expose a stable status attribute across versions, so we
    probe a few common shapes and fall back to text-based classification.
    """
    for attr in ("status", "status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    return None


class E2BSandboxProvider:
    """SandboxProvider over the E2B ``AsyncSandbox`` SDK."""

    name = "e2b"

    capabilities = SandboxProviderCapabilities(
        supports_snapshots=False,
        supports_restore=False,
        supports_warm=False,
        supports_persistent_resume=True,
        supports_explicit_stop=True,
    )

    def __init__(self, api_key: str | None = None, template: str | None = None) -> None:
        settings = get_settings()
        # Resolve at construction so a misconfigured key surfaces early, but
        # allow explicit overrides for tests.
        self._api_key = api_key if api_key is not None else settings.e2b_api_key
        self._default_template = template if template is not None else settings.e2b_template

    # ------------------------------------------------------------------
    # SandboxProvider interface
    # ------------------------------------------------------------------

    async def create_sandbox(self, config: CreateSandboxConfig) -> CreateSandboxResult:
        # Lazy import keeps the module importable (and py_compile-able) without
        # the `e2b` dependency installed.
        from e2b import AsyncSandbox

        env = _build_env(config)
        template = config.template or self._default_template

        try:
            sandbox = await AsyncSandbox.create(
                template=template,
                api_key=self._api_key,
                timeout=config.timeout_seconds,
                envs=env,
            )
        except Exception as exc:  # noqa: BLE001 — classify, then re-raise as provider error
            raise SandboxProviderError.from_exc(
                "Failed to create E2B sandbox", exc, status=_status_from_exc(exc)
            ) from exc

        # IMPORTANT: on E2B the template `start_cmd` runs at *build/snapshot*
        # time, not per-create — and our supervisor is a per-run task that needs
        # RUN_ID/CONTROL_PLANE_URL/REPO_* (only known at create). So we launch it
        # explicitly here, in the background, with the run's env. cwd=/app so the
        # `runtime`/`bundles` packages resolve.
        try:
            await sandbox.commands.run(
                "python -m runtime.entrypoint",
                background=True,
                envs=env,
                cwd="/app",
            )
        except Exception as exc:  # noqa: BLE001
            raise SandboxProviderError.from_exc(
                "Failed to launch sandbox supervisor", exc, status=_status_from_exc(exc)
            ) from exc

        log.info(
            "e2b.create_sandbox.ok",
            extra={"provider_object_id": sandbox.sandbox_id, "template": template},
        )

        return CreateSandboxResult(
            handle=SandboxHandle(
                sandbox_id=config.session_id,
                provider_object_id=sandbox.sandbox_id,
                status="running",
            )
        )

    async def resume_sandbox(self, config: ResumeConfig) -> ResumeResult:
        # Resume == reconnect to a paused/persisted sandbox by its native id.
        from e2b import AsyncSandbox

        try:
            sandbox = await AsyncSandbox.connect(
                config.provider_object_id,
                api_key=self._api_key,
                timeout=config.timeout_seconds,
            )
        except Exception as exc:  # noqa: BLE001
            # A resume failure is recoverable at the orchestration layer by
            # spawning a fresh sandbox, so we report rather than raise.
            log.warning(
                "e2b.resume_sandbox.failed",
                extra={"provider_object_id": config.provider_object_id, "error": str(exc)},
            )
            return ResumeResult(
                success=False,
                error=f"Failed to resume E2B sandbox: {exc}",
                should_spawn_fresh=True,
            )

        return ResumeResult(
            success=True,
            handle=SandboxHandle(
                sandbox_id=config.sandbox_id,
                provider_object_id=sandbox.sandbox_id,
                status="running",
            ),
        )

    async def stop_sandbox(self, config: StopConfig) -> StopResult:
        from e2b import AsyncSandbox

        try:
            sandbox = await AsyncSandbox.connect(
                config.provider_object_id,
                api_key=self._api_key,
            )
            await sandbox.kill()
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "e2b.stop_sandbox.failed",
                extra={"provider_object_id": config.provider_object_id, "error": str(exc)},
            )
            return StopResult(success=False, error=f"Failed to stop E2B sandbox: {exc}")

        log.info(
            "e2b.stop_sandbox.ok",
            extra={"provider_object_id": config.provider_object_id, "reason": config.reason},
        )
        return StopResult(success=True)
