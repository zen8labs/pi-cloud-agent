"""The run lifecycle — the integration centerpiece.

Ties together the seams: profile → sandbox → agent runtime. Knows nothing about
*how* a task is performed (that's the profile's skill), nor about *what* the agent does
with its result. The controller's only jobs are provisioning the sandbox,
brokering the secrets the agent needs (LLM keys + a scoped SCM token), and
driving the generic run state machine.

The agent inside the sandbox actuates its own outcomes — posting PR comments,
pushing fixes, etc. — by calling tools / running commands against the VCS API
with the baked SCM token. There is no controller-side publish step and no
enforced structured-output contract; see README → "Security model".
"""

from __future__ import annotations

from core.config import get_settings
from core.config.global_settings import get_global_setting
from core.logger import bind_correlation, get_logger
from core.orchestrator.bus import event_bus
from core.orchestrator.events import wait_for_completion
from core.orchestrator.secrets import llm_provider_env, scm_token_env
from core.profiles import get_profile
from core.sandbox import (
    CreateSandboxConfig,
    SandboxProviderError,
    StopConfig,
    get_sandbox_provider,
)
from core.state import get_session
from core.state import repo as runs
from core.state.models import Run
from core.types import CorrelationContext, ModelSpec, RunLimits, RunStatus, TaskSpec
from core.vcs import get_vcs_provider

log = get_logger("orchestrator")


async def execute_run(run: Run) -> None:
    """Drive a single claimed run to a terminal state."""
    settings = get_settings()
    corr = CorrelationContext(run_id=run.id, session_id=run.session_id, provider=run.provider)
    bind_correlation(**corr.as_dict())

    profile = get_profile(run.profile)
    task: TaskSpec = profile.build_task(run.trigger)
    task = TaskSpec(
        profile=task.profile,
        prompt=task.prompt,
        repo=task.repo,
        inputs=task.inputs,
        limits=RunLimits(
            wall_clock_seconds=settings.run_wall_clock_seconds,
            max_parallel_units=task.limits.max_parallel_units,
            max_tokens=task.limits.max_tokens,
        ),
    )
    # Model resolution: per-run override → global DB default → AGENT_MODEL env var.
    model_id = run.model
    if not model_id:
        async with get_session() as db:
            model_id = await get_global_setting(db, "default_model")
    model = _model_spec(model_id)
    sandbox_provider = get_sandbox_provider()
    vcs = get_vcs_provider(run.provider)

    sandbox_handle = None
    event_queue = event_bus.subscribe(run.id)
    try:
        # 1) Non-secret runtime config the in-sandbox supervisor needs to boot
        #    the selected profile and model.
        runtime_env = _runtime_env(task, model)

        # 2) Provision the sandbox. The runtime dials CONTROL_PLANE_URL with the
        #    per-run auth token. The SCM token is minted here (trusted side) and
        #    baked into the sandbox env: the agent uses it directly for git auth
        #    and to actuate outcomes (e.g. `gh` PR comments). It is repo-scoped
        #    and short-lived (~1h). See README → "Security model".
        await _set(run.id, RunStatus.provisioning)
        secret_env = llm_provider_env(model.model)
        secret_env.update(await scm_token_env(vcs, run))
        create_cfg = CreateSandboxConfig(
            run_id=run.id,
            session_id=run.session_id,
            repo=task.repo,
            control_plane_url=settings.control_plane_url,
            sandbox_auth_token=run.auth_token,
            template=settings.e2b_template,
            timeout_seconds=settings.sandbox_timeout_seconds,
            egress_allowlist=settings.egress_allowlist(),
            env=runtime_env,
            secret_env=secret_env,
            correlation=corr,
        )
        created = await sandbox_provider.create_sandbox(create_cfg)
        sandbox_handle = created.handle
        await _set_provider_object_id(run.id, sandbox_handle.provider_object_id)

        # 3) Wait for the runtime. Pi already persists each event to
        #    run_events via the internal /events endpoint (the single writer), so
        #    here we only consume the relayed bus stream for control flow —
        #    advancing the loop and terminating on error/done. Re-recording here
        #    would double every row in the log (and the dashboard feed).
        await _set(run.id, RunStatus.running)
        await wait_for_completion(
            event_queue,
            task.limits.wall_clock_seconds,
        )

        # 4) Done. The agent already actuated its own outcomes inside the
        #    sandbox (PR comments, pushes, …) — there is no publish step.
        await _set(run.id, RunStatus.succeeded)
        log.info("run succeeded", extra={"run_id": run.id})
    except SandboxProviderError as e:
        log.error("sandbox error", extra={"run_id": run.id, "error_type": e.error_type})
        await _set(run.id, RunStatus.failed, error=f"sandbox:{e.error_type}: {e}")
    except Exception as e:  # noqa: BLE001 — terminal boundary; record + move on
        log.exception("run failed", extra={"run_id": run.id})
        await _set(run.id, RunStatus.failed, error=str(e))
    finally:
        # 5) Always tear the sandbox down.
        event_bus.unsubscribe(run.id, event_queue)
        if sandbox_handle is not None and sandbox_provider.capabilities.supports_explicit_stop:
            try:
                await sandbox_provider.stop_sandbox(
                    StopConfig(
                        provider_object_id=sandbox_handle.provider_object_id,
                        session_id=run.session_id,
                        reason="run_complete",
                        correlation=corr,
                    )
                )
            except Exception:
                log.warning("sandbox stop failed", extra={"run_id": run.id})


def _model_spec(model_id: str | None) -> ModelSpec:
    """Build a ModelSpec for the given model id, falling back to settings."""
    s = get_settings()
    if not model_id:
        return s.model_spec()
    return ModelSpec(model=model_id, fallbacks=[], temperature=s.agent_temperature)


def _runtime_env(task: TaskSpec, model: ModelSpec) -> dict[str, str]:
    """Non-secret runtime inputs shared with the sandbox supervisor."""
    import os

    env = {
        "PROFILE": task.profile,
        "TASK_PROMPT": task.prompt,
        "AGENT_MODEL": model.model,
        "AGENT_FALLBACK_MODELS": ",".join(model.fallbacks),
    }
    if os.environ.get("LLM_MAX_TOKENS"):
        env["LLM_MAX_TOKENS"] = os.environ["LLM_MAX_TOKENS"]
    return env


# ── small DB helpers (own their own session) ─────────────────────────────────
async def _set(run_id: str, status: RunStatus, error: str | None = None) -> None:
    async with get_session() as db:
        await runs.set_status(db, run_id, status, error=error)


async def _set_provider_object_id(run_id: str, provider_object_id: str) -> None:
    async with get_session() as db:
        await runs.set_provider_object_id(db, run_id, provider_object_id)
