"""The run lifecycle — the integration centerpiece.

Ties together the seams: bundle → sandbox → harness. Knows nothing about *how* a
task is performed (that's the bundle's skill), nor about *what* the agent does
with its result. The controller's only jobs are provisioning the sandbox,
brokering the secrets the agent needs (LLM keys + a scoped SCM token), and
driving the generic run state machine.

The agent inside the sandbox actuates its own outcomes — posting PR comments,
pushing fixes, etc. — by calling tools / running commands against the VCS API
with the baked SCM token. There is no controller-side publish step and no
enforced structured-output contract; see README → "Security model".
"""

from __future__ import annotations

from core.bundles import get_bundle
from core.config import get_settings
from core.config.global_settings import get_global_setting
from core.harness import EventType, get_harness_adapter
from core.harness.base import Session
from core.logger import bind_correlation, get_logger
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

    bundle = get_bundle(run.bundle)
    task: TaskSpec = bundle.build_task(run.trigger)
    task = TaskSpec(
        bundle=task.bundle,
        instructions=task.instructions,
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
    adapter = get_harness_adapter()
    sandbox_provider = get_sandbox_provider()
    vcs = get_vcs_provider(run.provider)

    sandbox_handle = None
    session: Session | None = None
    try:
        # 1) Non-secret runtime config the in-sandbox supervisor needs to boot
        #    the right harness/bundle/model.
        runtime_env = adapter.runtime_env(bundle, task, model)

        # 2) Provision the sandbox. The bridge dials CONTROL_PLANE_URL with the
        #    per-run auth token. The SCM token is minted here (trusted side) and
        #    baked into the sandbox env: the agent uses it directly for git auth
        #    and to actuate outcomes (e.g. `gh` PR comments). It is repo-scoped
        #    and short-lived (~1h). See README → "Security model".
        await _set(run.id, RunStatus.provisioning)
        secret_env = _llm_provider_keys(model.model)
        secret_env.update(await _scm_token_env(vcs, run))
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

        # 3) Run the harness session. The bridge already persists each event to
        #    run_events via the internal /events endpoint (the single writer), so
        #    here we only consume the relayed bus stream for control flow —
        #    advancing the loop and terminating on error/done. Re-recording here
        #    would double every row in the log (and the dashboard feed).
        await _set(run.id, RunStatus.running)
        session = await adapter.start(sandbox_handle, run.id, run.session_id)
        async for event in adapter.run(session, task):
            if event.type is EventType.error:
                raise RuntimeError(event.data.get("message", "harness error"))

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
        if session is not None:
            try:
                await adapter.stop(session)
            except Exception:
                log.warning("harness stop failed", extra={"run_id": run.id})
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


def _llm_provider_keys(model_id: str) -> dict[str, str]:
    """LLM provider env vars the in-sandbox harness needs to call the model.

    The key set is model-aware so that native openai/* models don't receive
    OPENAI_BASE_URL (which would redirect them to the internal gateway):
      - aigateway/*  → gateway base_url + gateway api_key (OPENAI_*)
      - openai/*     → official OPENAI_OFFICIAL_API_KEY injected as OPENAI_API_KEY,
                       no OPENAI_BASE_URL so @ai-sdk/openai hits api.openai.com
      - anthropic/*  → ANTHROPIC_API_KEY
      - everything   → any other provider keys present in the environment

    These keys genuinely enter the sandbox. Mitigations: egress allowlist;
    per-run ephemeral sandbox. Planned hardening: controller-side LLM proxy.
    """
    import os

    s = get_settings()
    provider = model_id.partition("/")[0]
    out: dict[str, str] = {}

    if provider == "aigateway":
        # Internal gateway (e.g. self-hosted MiniMax). Injected as OPENAI_* so
        # OpenCode's _inject_gateway_provider wires the aigateway provider block.
        if s.aigateway_base_url:
            out["OPENAI_BASE_URL"] = s.aigateway_base_url
        if s.aigateway_api_key:
            out["OPENAI_API_KEY"] = s.aigateway_api_key
    elif provider == "openai":
        # Official OpenAI or any OpenAI-compatible endpoint (Cerebras etc.).
        # OPENAI_BASE_URL is optional — omitting it hits api.openai.com.
        if s.openai_api_key:
            out["OPENAI_API_KEY"] = s.openai_api_key
        if s.openai_base_url:
            out["OPENAI_BASE_URL"] = s.openai_base_url
    else:
        # Unknown provider prefix — fall back to gateway vars if configured.
        if s.aigateway_base_url:
            out["OPENAI_BASE_URL"] = s.aigateway_base_url
        if s.aigateway_api_key:
            out["OPENAI_API_KEY"] = s.aigateway_api_key

    if s.anthropic_api_key:
        out["ANTHROPIC_API_KEY"] = s.anthropic_api_key

    # Pass through any other provider keys present in the process environment.
    for var in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"):
        if var not in out and os.environ.get(var):
            out[var] = os.environ[var]

    return out


async def _scm_token_env(vcs, run: Run) -> dict[str, str]:
    """Mint a scoped SCM token and shape it into the sandbox's secret env.

    Baked (not brokered) so the agent can authenticate git ops *and* drive the
    VCS API directly (e.g. `gh` to post PR comments). The token is repo-scoped
    and short-lived (~1h, GitHub App installation token). We expose it under
    several names so both git and the provider CLIs pick it up without the
    bundle having to know which is in play:

      * ``SCM_TOKEN`` / ``SCM_TOKEN_USERNAME`` — the runtime's git credential
        helper reads these (see runtime/entrypoint.py).
      * provider-native names — ``GITHUB_TOKEN`` + ``GH_TOKEN`` for GitHub so
        ``gh`` works with zero config; ``GITLAB_TOKEN`` / ``BITBUCKET_TOKEN``
        otherwise.

    TODO(security): downscope the token's *permissions* (not just repo) once we
    accept external/fork PRs. Today it carries the App's full grant — fine for
    internal repos, see README → "Security model".
    """
    try:
        token = await vcs.mint_clone_token(run.repo_full_name)
    except Exception as e:  # noqa: BLE001 — a missing token shouldn't kill provisioning
        log.warning(
            "scm token mint failed; sandbox will have no git auth",
            extra={"run_id": run.id, "error": str(e)},
        )
        return {}

    env: dict[str, str] = {"SCM_TOKEN": token}
    if run.provider == "github":
        env["SCM_TOKEN_USERNAME"] = "x-access-token"
        env["GITHUB_TOKEN"] = token
        env["GH_TOKEN"] = token
        host = getattr(run, "repo_host", "") or "github.com"
        if host and host != "github.com":
            env["GH_HOST"] = host
    elif run.provider == "gitlab":
        env["SCM_TOKEN_USERNAME"] = "oauth2"
        env["GITLAB_TOKEN"] = token
    elif run.provider == "bitbucket":
        env["SCM_TOKEN_USERNAME"] = "x-token-auth"
        env["BITBUCKET_TOKEN"] = token
    else:
        env["SCM_TOKEN_USERNAME"] = "x-access-token"
    return env


# ── small DB helpers (own their own session) ─────────────────────────────────
async def _set(run_id: str, status: RunStatus, error: str | None = None) -> None:
    async with get_session() as db:
        await runs.set_status(db, run_id, status, error=error)


async def _set_provider_object_id(run_id: str, provider_object_id: str) -> None:
    async with get_session() as db:
        await runs.set_provider_object_id(db, run_id, provider_object_id)
