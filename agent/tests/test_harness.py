"""OpenCode harness adapter unit tests (no sandbox network)."""

from __future__ import annotations

import asyncio

import pytest

from core.bundles import get_bundle
from core.harness.base import EventType
from core.harness.opencode import OpenCodeAdapter
from core.orchestrator.bus import event_bus
from core.sandbox.provider import SandboxHandle
from core.types import ModelSpec, RepoRef, RunLimits, TaskSpec
from runtime.log_config import StructuredLogger


def _task(wall_clock_seconds: int = 30) -> TaskSpec:
    repo = RepoRef("github", "github.com", "o", "r", "u", "main", "b", "h", "feat", 1)
    return TaskSpec(
        bundle="pr_review",
        instructions="review",
        repo=repo,
        limits=RunLimits(wall_clock_seconds=wall_clock_seconds),
    )


def test_runtime_env_passes_harness_bundle_and_model():
    adapter = OpenCodeAdapter()
    bundle = get_bundle("pr_review")
    model = ModelSpec(model="aigateway/MiniMax/MiniMax-M2.7", fallbacks=["aigateway/backup"], temperature=0.1)
    env = adapter.runtime_env(bundle, _task(), model)
    assert env["HARNESS"] == "opencode"
    assert env["BUNDLE"] == "pr_review"
    assert env["AGENT_MODEL"] == "aigateway/MiniMax/MiniMax-M2.7"
    assert env["AGENT_FALLBACK_MODELS"] == "aigateway/backup"


def test_build_opencode_config_injects_custom_provider(monkeypatch, tmp_path):
    """Generated OpenCode config must match the @ai-sdk/openai-compatible shape.

    This is the no-E2B config-validation test: instantiate SandboxSupervisor with
    the gateway env vars, call _build_opencode_config(), and assert the result
    matches the structure that is known to work locally.
    """
    from runtime.entrypoint import SandboxSupervisor

    monkeypatch.setenv("AGENT_MODEL", "aigateway/MiniMax/MiniMax-M2.7")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://netmind.viettel.vn/gateway/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # Avoid needing a real bundle dir for the jsonc — supervisor falls back to
    # the default config dict when the file is absent.
    monkeypatch.setenv("BUNDLE", "pr_review")

    sup = SandboxSupervisor.__new__(SandboxSupervisor)
    sup.agent_model = "aigateway/MiniMax/MiniMax-M2.7"
    sup.bundle = "pr_review"
    sup.log = StructuredLogger("test")

    cfg = sup._build_opencode_config()

    # Preserve the full gateway model path; shortening this to MiniMax-M2.7
    # makes the gateway reject the request as an unauthorized model.
    assert cfg["model"] == "aigateway/MiniMax/MiniMax-M2.7"

    provider_block = cfg.get("provider", {}).get("aigateway", {})
    assert provider_block.get("npm") == "@ai-sdk/openai-compatible", (
        "provider must use @ai-sdk/openai-compatible, not the built-in openai provider"
    )
    options = provider_block.get("options", {})
    assert options.get("baseURL") == "https://netmind.viettel.vn/gateway/v1"
    assert options.get("apiKey") == "test-key"

    models = provider_block.get("models", {})
    assert "MiniMax/MiniMax-M2.7" in models, "the full gateway model key must be declared"
    assert models["MiniMax/MiniMax-M2.7"].get("name") == "MiniMax/MiniMax-M2.7", (
        "the model `name` must be the full path the gateway expects"
    )


def test_build_opencode_config_no_npm_for_builtin_providers(monkeypatch):
    """Built-in providers may get the gateway baseURL overridden, but must NOT be
    given a custom ``@ai-sdk/openai-compatible`` npm package — OpenCode ships
    their first-party SDK. Only non-builtin gateway ids get the npm field."""
    from runtime.entrypoint import SandboxSupervisor

    monkeypatch.setenv("OPENAI_BASE_URL", "https://netmind.viettel.vn/gateway/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    for builtin in ("anthropic", "openai", "google"):
        sup = SandboxSupervisor.__new__(SandboxSupervisor)
        sup.agent_model = f"{builtin}/some-model"
        sup.bundle = "pr_review"
        sup.log = StructuredLogger("test")

        cfg = sup._build_opencode_config()
        block = cfg.get("provider", {}).get(builtin, {})
        assert "npm" not in block, (
            f"built-in provider '{builtin}' must not get a custom npm provider"
        )


def test_to_event_maps_unknown_types_to_log():
    ev = OpenCodeAdapter._to_event({"type": "not-a-real-type", "data": {"k": 1}})
    assert ev.type is EventType.log
    assert ev.data == {"k": 1}


@pytest.mark.asyncio
async def test_run_times_out_when_no_done_event():
    adapter = OpenCodeAdapter()
    handle = SandboxHandle(sandbox_id="s", provider_object_id="p", status="running")
    session = await adapter.start(handle, "run-timeout", "sess-timeout")
    task = _task(wall_clock_seconds=0)

    events = []
    async for ev in adapter.run(session, task):
        events.append(ev)

    assert events[0].type is EventType.error
    assert events[-1].type is EventType.done
    assert events[-1].data.get("reason") == "wall_clock_timeout"


@pytest.mark.asyncio
async def test_run_translates_bridge_events():
    adapter = OpenCodeAdapter()
    handle = SandboxHandle(sandbox_id="s", provider_object_id="p", status="running")
    session = await adapter.start(handle, "run-bus", "sess-bus")
    task = _task(wall_clock_seconds=5)

    async def drive():
        collected = []
        gen = adapter.run(session, task)

        async def feed():
            await asyncio.sleep(0.05)
            await event_bus.publish("run-bus", {"type": "status", "data": {"status": "running"}})
            await event_bus.publish("run-bus", {"type": "finding", "data": {"file": "x.py"}})
            await event_bus.publish("run-bus", {"type": "done", "data": {}})

        feeder = asyncio.create_task(feed())
        async for ev in gen:
            collected.append(ev)
        await feeder
        return collected

    events = await drive()
    assert [e.type for e in events] == [EventType.status, EventType.finding, EventType.done]
