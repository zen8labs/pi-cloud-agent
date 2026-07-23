"""Opt-in E2B and real Netmind/Minimax harness checks."""

from __future__ import annotations

import os
import shlex
from pathlib import Path

import pytest
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not (os.environ.get("E2B_API_KEY") and os.environ.get("E2B_TEMPLATE")),
        reason="set E2B_API_KEY and E2B_TEMPLATE, then build the sandbox template",
    ),
]


async def _make_sandbox(envs: dict | None = None):
    from e2b import AsyncSandbox

    return await AsyncSandbox.create(
        template=os.environ["E2B_TEMPLATE"],
        api_key=os.environ["E2B_API_KEY"],
        envs=envs or {},
    )


async def test_template_ships_pi_and_runtime():
    sandbox = await _make_sandbox()
    try:
        command = (
            "cd /app && node --input-type=module -e "
            + shlex.quote(
                "import { createAgentSession } from "
                "'@earendil-works/pi-coding-agent'; "
                "console.log(typeof createAgentSession)"
            )
        )
        pi = await sandbox.commands.run(command)
        assert "function" in pi.stdout

        imports = await sandbox.commands.run(
            "cd /app && python -c 'import runtime, bundles; print(\"import-ok\")'"
        )
        assert "import-ok" in imports.stdout
    finally:
        await sandbox.kill()


@pytest.mark.skipif(
    not (os.environ.get("AIGATEWAY_BASE_URL") and os.environ.get("AIGATEWAY_API_KEY")),
    reason="needs AIGATEWAY_BASE_URL and AIGATEWAY_API_KEY",
)
async def test_pi_answers_with_netmind_minimax():
    model_reference = os.environ.get(
        "AGENT_MODEL", "aigateway/MiniMax/MiniMax-M2.7"
    )
    provider, model_id = model_reference.split("/", 1)
    envs = {
        "OPENAI_BASE_URL": os.environ["AIGATEWAY_BASE_URL"],
        "OPENAI_API_KEY": os.environ["AIGATEWAY_API_KEY"],
    }
    script = f"""
import {{
  createAgentSession, ModelRuntime, SessionManager, SettingsManager
}} from "@earendil-works/pi-coding-agent";
const modelRuntime = await ModelRuntime.create({{
  modelsPath: null,
  allowModelNetwork: false
}});
modelRuntime.registerProvider({provider!r}, {{
  name: {provider!r},
  baseUrl: process.env.OPENAI_BASE_URL,
  apiKey: "$OPENAI_API_KEY",
  api: "openai-completions",
  models: [{{
    id: {model_id!r},
    name: {model_id!r},
    reasoning: true,
    input: ["text"],
    cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }},
    contextWindow: 196608,
    maxTokens: 1024,
    compat: {{
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens"
    }}
  }}]
}});
const model = modelRuntime.getModel({provider!r}, {model_id!r});
if (!model) throw new Error("model registration failed");
const {{ session }} = await createAgentSession({{
  cwd: "/tmp",
  model,
  thinkingLevel: "medium",
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({{
    compaction: {{ enabled: false }},
    retry: {{ enabled: false }}
  }})
}});
session.subscribe((event) => {{
  if (event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta") {{
    process.stdout.write(event.assistantMessageEvent.delta);
  }}
}});
await session.prompt("Reply with exactly: pong");
session.dispose();
"""

    sandbox = await _make_sandbox(envs)
    try:
        command = (
            "cd /app && node --input-type=module -e " + shlex.quote(script)
        )
        result = await sandbox.commands.run(command, timeout=180)
        assert result.exit_code == 0, result.stderr
        assert "pong" in result.stdout.lower()
    finally:
        await sandbox.kill()
