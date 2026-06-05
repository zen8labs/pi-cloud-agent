"""LLM service tests.

Unit tests build the LiteLLM call args and exercise fallback ordering without a
network. The live test actually calls the configured MiniMax gateway; it skips
unless `OPENAI_BASE_URL` is set.
"""

from __future__ import annotations

import os
import sys
import types

import pytest

from core.llm import LLMService


def test_completion_kwargs_uses_gateway():
    # AGENT_MODEL uses the custom "aigateway/" provider prefix; when a gateway
    # api_base is set, _litellm_model rewrites it to LiteLLM's "openai/" form.
    svc = LLMService(
        model="aigateway/MiniMax/MiniMax-M2.7",
        fallbacks=[],
        api_base="https://gateway.example/v1",
        api_key="sek-test",
        timeout=99,
        max_tokens=1234,
        temperature=0.1,
    )
    kw = svc._completion_kwargs(svc.model, [{"role": "user", "content": "hi"}])
    assert kw["model"] == "openai/MiniMax/MiniMax-M2.7"  # rewritten for LiteLLM
    assert kw["api_base"] == "https://gateway.example/v1"
    assert kw["api_key"] == "sek-test"
    assert kw["timeout"] == 99
    assert kw["max_tokens"] == 1234


def _install_fake_litellm(behaviour):
    """Inject a fake `litellm` module whose acompletion runs `behaviour`."""
    mod = types.ModuleType("litellm")

    async def acompletion(**kwargs):
        return await behaviour(**kwargs)

    mod.acompletion = acompletion
    sys.modules["litellm"] = mod


async def test_complete_falls_back_to_next_model():
    calls: list[str] = []

    async def behaviour(**kwargs):
        calls.append(kwargs["model"])
        if kwargs["model"] == "openai/primary":
            raise RuntimeError("primary down")
        # minimal OpenAI-shaped response
        msg = types.SimpleNamespace(content="ok")
        choice = types.SimpleNamespace(message=msg, finish_reason="stop")
        return types.SimpleNamespace(choices=[choice])

    _install_fake_litellm(behaviour)
    svc = LLMService(model="openai/primary", fallbacks=["openai/backup"], api_base="x", api_key="y")
    result = await svc.complete(system="s", user="u")
    assert result.text == "ok"
    assert result.model == "openai/backup"
    assert calls == ["openai/primary", "openai/backup"]


@pytest.mark.live
@pytest.mark.skipif(
    not os.environ.get("OPENAI_BASE_URL"),
    reason="live LLM test — set OPENAI_BASE_URL + OPENAI_API_KEY + AGENT_MODEL to run",
)
async def test_minimax_gateway_reachable_live():
    """Proves the self-hosted MiniMax model actually answers."""
    from core.llm import get_llm_service

    result = await get_llm_service().ping()
    assert result.text.strip(), "model returned empty response"
