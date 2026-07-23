"""E2B sandbox provider unit tests (mocked SDK — no network)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.sandbox.e2b_provider import E2BSandboxProvider, _build_env
from core.sandbox.provider import CreateSandboxConfig, SandboxProviderError, StopConfig
from core.types import RepoRef


def _repo() -> RepoRef:
    return RepoRef(
        provider="github",
        host="github.com",
        owner="octo",
        name="repo",
        clone_url="https://github.com/octo/repo.git",
        default_branch="main",
        base_sha="base",
        head_sha="head",
        head_branch="feat",
        pr_number=42,
    )


def test_build_env_layers_secrets_and_controller_keys():
    cfg = CreateSandboxConfig(
        run_id="run-1",
        session_id="sess-1",
        repo=_repo(),
        control_plane_url="https://agent.example.com",
        sandbox_auth_token="tok-abc",
        template="coreview-agent",
        timeout_seconds=600,
        egress_allowlist=["github.com", "pypi.org"],
        env={"PROFILE": "pr_review", "TASK_PROMPT": "Review the PR."},
        secret_env={"OPENAI_API_KEY": "sek"},
    )
    env = _build_env(cfg)
    assert env["PROFILE"] == "pr_review"
    assert env["OPENAI_API_KEY"] == "sek"
    assert env["CONTROL_PLANE_URL"] == "https://agent.example.com"
    assert env["RUN_ID"] == "run-1"
    assert env["SANDBOX_AUTH_TOKEN"] == "tok-abc"
    assert env["REPO_OWNER"] == "octo"
    assert env["PR_NUMBER"] == "42"
    assert "github.com" in env["SANDBOX_EGRESS_ALLOWLIST"]


@pytest.mark.asyncio
async def test_create_sandbox_calls_e2b_with_built_env():
    provider = E2BSandboxProvider(api_key="test-key", template="tpl")

    mock_sandbox = MagicMock()
    mock_sandbox.sandbox_id = "e2b-native-id"
    # The provider explicitly launches the supervisor after create.
    mock_sandbox.commands.run = AsyncMock()

    with patch("e2b.AsyncSandbox.create", new_callable=AsyncMock, return_value=mock_sandbox) as create:
        cfg = CreateSandboxConfig(
            run_id="run-1",
            session_id="sess-1",
            repo=_repo(),
            control_plane_url="https://agent.example.com",
            sandbox_auth_token="tok",
            template="tpl",
            timeout_seconds=120,
        )
        result = await provider.create_sandbox(cfg)

    create.assert_awaited_once()
    kwargs = create.call_args.kwargs
    assert kwargs["template"] == "tpl"
    assert kwargs["api_key"] == "test-key"
    assert kwargs["envs"]["RUN_ID"] == "run-1"
    assert result.handle.provider_object_id == "e2b-native-id"
    assert result.handle.sandbox_id == "sess-1"
    # Supervisor launched explicitly (not via template start_cmd), in /app.
    mock_sandbox.commands.run.assert_awaited_once()
    run_args, run_kwargs = mock_sandbox.commands.run.call_args
    assert "runtime.entrypoint" in run_args[0]
    assert run_kwargs["background"] is True
    assert run_kwargs["cwd"] == "/app"


@pytest.mark.asyncio
async def test_create_sandbox_wraps_provider_errors():
    provider = E2BSandboxProvider(api_key="test-key", template="tpl")

    with patch(
        "e2b.AsyncSandbox.create",
        new_callable=AsyncMock,
        side_effect=RuntimeError("quota exceeded"),
    ):
        with pytest.raises(SandboxProviderError, match="Failed to create"):
            await provider.create_sandbox(
                CreateSandboxConfig(
                    run_id="r",
                    session_id="s",
                    repo=_repo(),
                    control_plane_url="https://x",
                    sandbox_auth_token="t",
                    template="tpl",
                    timeout_seconds=60,
                )
            )


@pytest.mark.asyncio
async def test_stop_sandbox_kills_connected_sandbox():
    provider = E2BSandboxProvider(api_key="test-key", template="tpl")
    mock_sandbox = MagicMock()
    mock_sandbox.kill = AsyncMock()

    with patch("e2b.AsyncSandbox.connect", new_callable=AsyncMock, return_value=mock_sandbox):
        result = await provider.stop_sandbox(
            StopConfig(provider_object_id="e2b-id", session_id="s", reason="done")
        )

    mock_sandbox.kill.assert_awaited_once()
    assert result.success is True
