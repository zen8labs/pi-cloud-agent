"""Pi harness adapter unit tests (no sandbox network)."""

from __future__ import annotations

import asyncio

import pytest

from core.bundles import get_bundle
from core.harness.base import EventType
from core.harness.pi import PiAdapter
from core.orchestrator.bus import event_bus
from core.sandbox.provider import SandboxHandle
from core.types import ModelSpec, RepoRef, RunLimits, TaskSpec
from runtime.entrypoint import SandboxSupervisor


def _task(wall_clock_seconds: int = 30) -> TaskSpec:
    repo = RepoRef("github", "github.com", "o", "r", "u", "main", "b", "h", "feat", 1)
    return TaskSpec(
        bundle="pr_review",
        instructions="review",
        repo=repo,
        limits=RunLimits(wall_clock_seconds=wall_clock_seconds),
    )


def test_runtime_env_passes_harness_bundle_and_model():
    adapter = PiAdapter()
    bundle = get_bundle("pr_review")
    model = ModelSpec(
        model="aigateway/MiniMax/MiniMax-M2.7",
        fallbacks=["aigateway/backup"],
        temperature=0.1,
    )

    env = adapter.runtime_env(bundle, _task(), model)

    assert env["HARNESS"] == "pi"
    assert env["BUNDLE"] == "pr_review"
    assert env["AGENT_MODEL"] == "aigateway/MiniMax/MiniMax-M2.7"
    assert env["AGENT_FALLBACK_MODELS"] == "aigateway/backup"


def test_supervisor_builds_profile_prompt(monkeypatch, tmp_path):
    skill = tmp_path / "pr_review" / "pi" / "skills" / "review" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Review carefully")

    supervisor = SandboxSupervisor()
    monkeypatch.setattr(supervisor, "_resolve_bundles_dir", lambda: tmp_path)
    monkeypatch.setenv("USER_PROMPT", "Inspect the changed parser.")

    assert supervisor.build_prompt() == (
        "# Review carefully\n\n---\n\nInspect the changed parser."
    )


def test_to_event_maps_unknown_types_to_log():
    event = PiAdapter._to_event({"type": "future-event", "data": {"k": 1}})
    assert event.type is EventType.log
    assert event.data == {"k": 1}


@pytest.mark.asyncio
async def test_run_times_out_when_no_done_event():
    adapter = PiAdapter()
    handle = SandboxHandle(sandbox_id="s", provider_object_id="p", status="running")
    session = await adapter.start(handle, "run-timeout", "sess-timeout")

    events = [event async for event in adapter.run(session, _task(wall_clock_seconds=0))]

    assert events[0].type is EventType.error
    assert events[-1].type is EventType.done
    assert events[-1].data["reason"] == "wall_clock_timeout"


@pytest.mark.asyncio
async def test_run_translates_runtime_events():
    adapter = PiAdapter()
    handle = SandboxHandle(sandbox_id="s", provider_object_id="p", status="running")
    session = await adapter.start(handle, "run-bus", "sess-bus")

    async def feed():
        await asyncio.sleep(0.05)
        await event_bus.publish("run-bus", {"type": "status", "data": {"status": "running"}})
        await event_bus.publish("run-bus", {"type": "tool_call", "data": {"tool": "read"}})
        await event_bus.publish("run-bus", {"type": "done", "data": {}})

    feeder = asyncio.create_task(feed())
    events = [event async for event in adapter.run(session, _task(wall_clock_seconds=5))]
    await feeder

    assert [event.type for event in events] == [
        EventType.status,
        EventType.tool_call,
        EventType.done,
    ]
