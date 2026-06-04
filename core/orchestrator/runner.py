"""The run lifecycle — the integration centerpiece.

Ties together the seams: bundle → sandbox → harness → findings → publish.
Knows nothing about *how* a review is performed (that's the bundle's skill); it
only drives the generic state machine and the trust-boundary operations
(provisioning, secret brokering, publishing).
"""

from __future__ import annotations

from core.bundles import get_bundle
from core.config import get_settings
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
from core.types import CorrelationContext, RunStatus, TaskSpec
from core.vcs import get_vcs_provider

log = get_logger("orchestrator")


async def execute_run(run: Run) -> None:
    """Drive a single claimed run to a terminal state."""
    settings = get_settings()
    corr = CorrelationContext(run_id=run.id, session_id=run.session_id, provider=run.provider)
    bind_correlation(**corr.as_dict())

    bundle = get_bundle(run.bundle)
    task: TaskSpec = bundle.build_task(run.trigger)
    model = settings.model_spec()
    adapter = get_harness_adapter()
    sandbox_provider = get_sandbox_provider()
    vcs = get_vcs_provider(run.provider)

    sandbox_handle = None
    session: Session | None = None
    try:
        # 1) Non-secret runtime config the in-sandbox supervisor needs to boot
        #    the right harness/bundle/model.
        runtime_env = adapter.runtime_env(bundle, task, model)

        # 2) Provision the sandbox. The bridge will dial CONTROL_PLANE_URL using
        #    the per-run auth token; git creds are brokered on demand (never baked).
        await _set(run.id, RunStatus.provisioning)
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
            secret_env=_llm_provider_keys(),
            correlation=corr,
        )
        created = await sandbox_provider.create_sandbox(create_cfg)
        sandbox_handle = created.handle
        await _set_provider_object_id(run.id, sandbox_handle.provider_object_id)

        # 3) Run the harness session, streaming events into Postgres + the bus.
        await _set(run.id, RunStatus.running)
        session = await adapter.start(sandbox_handle, run.id, run.session_id)
        async for event in adapter.run(session, task):
            await _record_event(run.id, event.type.value, event.data)
            if event.type is EventType.error:
                raise RuntimeError(event.data.get("message", "harness error"))

        # 4) Publish grounded findings back to the PR.
        await _set(run.id, RunStatus.publishing)
        await _publish(vcs, task, run.id)

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


def _llm_provider_keys() -> dict[str, str]:
    """LLM provider config the in-sandbox harness needs to call the model.

    Includes the OpenAI-compatible gateway (self-hosted MiniMax) base_url + key,
    plus any provider keys present in the environment. These genuinely enter the
    sandbox (the agent runs there). Mitigations: egress allowlist; per-run
    ephemeral sandbox. Planned hardening: a controller-side LLM proxy so keys
    never leave the trust boundary.
    """
    import os

    s = get_settings()
    out: dict[str, str] = {}
    if s.openai_base_url:
        out["OPENAI_BASE_URL"] = s.openai_base_url
    if s.openai_api_key:
        out["OPENAI_API_KEY"] = s.openai_api_key
    if s.anthropic_api_key:
        out["ANTHROPIC_API_KEY"] = s.anthropic_api_key
    # Pass through anything else already in the environment.
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"):
        if var not in out and os.environ.get(var):
            out[var] = os.environ[var]
    return out


async def _publish(vcs, task: TaskSpec, run_id: str) -> None:
    """Read grounded findings and post them. Only grounded findings are sent."""
    from core.vcs.types import InlineComment

    async with get_session() as db:
        run = await runs.get_run(db, run_id)
        if run is None or run.pr_number is None:
            return
        grounded = [f for f in run.findings if f.grounded and f.line]
        comments = [
            InlineComment(file=f.file, line=f.line, body=_format_comment(f)) for f in grounded
        ]
        if comments:
            await vcs.publish_inline_comments(task.repo, run.pr_number, comments)
        summary = _format_summary(run.findings)
        if summary:
            await vcs.publish_summary(task.repo, run.pr_number, summary)
        for f in grounded:
            f.published = True
        await db.commit()


def _format_comment(f) -> str:
    sev = {"blocker": "🛑", "warning": "⚠️", "nit": "💡"}.get(f.severity, "•")
    out = f"{sev} **{f.title}**\n\n{f.body}"
    if f.evidence:
        out += f"\n\n<sub>evidence: {f.evidence}</sub>"
    return out


def _format_summary(findings) -> str:
    grounded = [f for f in findings if f.grounded]
    if not grounded:
        return "✅ CoReview agent found no blocking issues."
    counts: dict[str, int] = {}
    for f in grounded:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    parts = ", ".join(f"{n} {sev}" for sev, n in sorted(counts.items()))
    return f"### CoReview agent\n\nPosted {len(grounded)} grounded finding(s): {parts}."


# ── small DB helpers (own their own session) ─────────────────────────────────
async def _set(run_id: str, status: RunStatus, error: str | None = None) -> None:
    async with get_session() as db:
        await runs.set_status(db, run_id, status, error=error)


async def _set_provider_object_id(run_id: str, provider_object_id: str) -> None:
    async with get_session() as db:
        await runs.set_provider_object_id(db, run_id, provider_object_id)


async def _record_event(run_id: str, type_: str, data: dict) -> None:
    async with get_session() as db:
        await runs.append_event(db, run_id, type_, data)
