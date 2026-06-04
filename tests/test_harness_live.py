"""Live harness/OpenCode tests (opt-in).

Skips unless `E2B_API_KEY` and `E2B_TEMPLATE` are set (the custom template must be
built — see README "E2B setup"). Proves our sandbox image actually ships a
working OpenCode `1.14.41` and that the runtime package is importable, and
optionally that OpenCode can answer a one-line prompt against the configured
MiniMax gateway.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv

# Load .env so the tests can run without manually exporting variables.
load_dotenv(Path(__file__).parent.parent / ".env")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not (os.environ.get("E2B_API_KEY") and os.environ.get("E2B_TEMPLATE")),
        reason="live harness test — set E2B_API_KEY + E2B_TEMPLATE (build the template first)",
    ),
]


async def _make_sandbox(envs: dict | None = None):
    from e2b import AsyncSandbox

    return await AsyncSandbox.create(
        template=os.environ["E2B_TEMPLATE"],
        api_key=os.environ["E2B_API_KEY"],
        envs=envs or {},
    )


async def test_template_ships_opencode_and_runtime():
    sandbox = await _make_sandbox()
    try:
        ver = await sandbox.commands.run("opencode --version")
        assert "1.14.41" in (ver.stdout + ver.stderr), f"unexpected opencode version: {ver.stdout!r}"
        imp = await sandbox.commands.run("cd /app && python -c 'import runtime, bundles; print(\"import-ok\")'")
        assert "import-ok" in imp.stdout
    finally:
        await sandbox.kill()


@pytest.mark.live
@pytest.mark.skipif(
    not os.environ.get("OPENAI_BASE_URL"),
    reason="needs OPENAI_BASE_URL + OPENAI_API_KEY to drive OpenCode against MiniMax",
)
async def test_opencode_answers_prompt_live():
    """Start OpenCode in the sandbox, send a trivial prompt, expect a reply.

    This is a focused harness check (not a full review): it boots `opencode serve`
    with the MiniMax gateway configured via @ai-sdk/openai-compatible and asks for
    a one-word answer.
    """
    import json

    agent_model = os.environ.get("AGENT_MODEL", "aigateway/MiniMax/MiniMax-M2.7")
    base_url = os.environ["OPENAI_BASE_URL"]
    api_key = os.environ.get("OPENAI_API_KEY", "")

    provider_id, _, model_path = agent_model.partition("/")
    # Mirror the working local opencode.json shape exactly: custom provider with
    # @ai-sdk/openai-compatible, full slash-containing model path as the dict key
    # (that is what OpenCode sends to the API as the model name).
    config = {
        "model": agent_model,
        "provider": {
            provider_id: {
                "npm": "@ai-sdk/openai-compatible",
                "name": provider_id,
                "options": {"baseURL": base_url, "apiKey": api_key},
                "models": {model_path: {"name": model_path}},
            }
        },
    }
    envs = {
        "OPENAI_BASE_URL": base_url,
        "OPENAI_API_KEY": api_key,
        "AGENT_MODEL": agent_model,
    }
    sandbox = await _make_sandbox(envs)
    try:
        # `opencode run` executes a single prompt headlessly and prints the reply.
        # --print-logs is for `opencode serve`; omit it here so the LLM response
        # goes to stdout instead of being swallowed by the log formatter.
        config_json = json.dumps(config).replace("'", "'\\''")
        cmd = (
            f"cd /app && OPENCODE_CONFIG_CONTENT='{config_json}' "
            "opencode run 'Reply with exactly: pong' 2>&1 | tail -40"
        )
        out = await sandbox.commands.run(cmd, timeout=120)
        assert "pong" in (out.stdout + out.stderr).lower()
    finally:
        await sandbox.kill()
