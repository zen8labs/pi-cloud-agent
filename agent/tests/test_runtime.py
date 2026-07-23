"""Pi runtime and controller event-loop unit tests."""

from __future__ import annotations

import pytest

from core.orchestrator.bus import event_bus
from core.orchestrator.events import wait_for_completion
from core.orchestrator.runner import _runtime_env
from core.profiles import get_profile
from core.types import ModelSpec, RepoRef, TaskSpec
from runtime.config import RuntimeConfig
from runtime.supervisor import SandboxSupervisor


def _task() -> TaskSpec:
    repo = RepoRef("github", "github.com", "o", "r", "u", "main", "b", "h", "feat", 1)
    return TaskSpec(
        profile="pr_review",
        prompt="review",
        repo=repo,
    )


def test_runtime_env_passes_profile_prompt_and_model():
    model = ModelSpec(
        model="aigateway/MiniMax/MiniMax-M2.7",
        fallbacks=["aigateway/backup"],
        temperature=0.1,
    )

    env = _runtime_env(_task(), model)

    assert env["PROFILE"] == "pr_review"
    assert env["TASK_PROMPT"] == "review"
    assert env["AGENT_MODEL"] == "aigateway/MiniMax/MiniMax-M2.7"
    assert env["AGENT_FALLBACK_MODELS"] == "aigateway/backup"


def test_supervisor_builds_profile_prompt(monkeypatch, tmp_path):
    skill = tmp_path / "pr_review" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Review carefully")

    config = RuntimeConfig(
        run_id="r",
        session_id="s",
        control_plane_url="",
        sandbox_token="",
        profile="pr_review",
        task_prompt="Inspect the changed parser.",
        repo_name="repo",
        repo_clone_url="url",
        repo_base_sha="",
        repo_head_sha="",
        repo_head_branch="main",
        repo_default_branch="main",
    )
    supervisor = SandboxSupervisor(config)
    monkeypatch.setattr(supervisor, "_profiles_dir", lambda: tmp_path)

    assert supervisor.build_prompt() == (
        "# Review carefully\n\n---\n\nInspect the changed parser."
    )


def test_profile_registry_resolves_builtins():
    assert get_profile("pr_review").name == "pr_review"
    assert get_profile("general_agent").name == "general_agent"


@pytest.mark.asyncio
async def test_wait_for_completion_times_out_without_done():
    queue = event_bus.subscribe("run-timeout")
    try:
        with pytest.raises(TimeoutError, match="wall-clock"):
            await wait_for_completion(queue, 0)
    finally:
        event_bus.unsubscribe("run-timeout", queue)


@pytest.mark.asyncio
async def test_wait_for_completion_consumes_pre_subscribed_done():
    queue = event_bus.subscribe("run-bus")
    try:
        await event_bus.publish("run-bus", {"type": "done", "data": {}})
        await wait_for_completion(queue, 5)
    finally:
        event_bus.unsubscribe("run-bus", queue)


@pytest.mark.asyncio
async def test_wait_for_completion_raises_runtime_error():
    queue = event_bus.subscribe("run-error")
    try:
        await event_bus.publish(
            "run-error",
            {"type": "error", "data": {"message": "agent failed"}},
        )
        with pytest.raises(RuntimeError, match="agent failed"):
            await wait_for_completion(queue, 5)
    finally:
        event_bus.unsubscribe("run-error", queue)
