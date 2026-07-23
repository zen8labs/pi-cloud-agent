"""Controller-side LLM service.

A thin LiteLLM wrapper, mirroring ../pr-agent's `LiteLLMAIHandler`, configured for
the self-hosted **MiniMax** model served over an OpenAI-compatible gateway
(`AGENT_MODEL=aigateway/MiniMax/MiniMax-M2.7` + `OPENAI_BASE_URL`/`OPENAI_API_KEY`).
The custom `aigateway/` prefix is rewritten to LiteLLM's `openai/` form by
`_litellm_model` when this service calls the gateway directly.

In the agentic design the *review* LLM work happens inside the Pi sandbox,
so the controller doesn't call this on the hot path. It exists as:
  * the single source of truth for model/gateway config (also injected into the
    sandbox so the harness uses the same model), and
  * a directly testable unit — `ping()` proves the model is reachable without
    booting a sandbox (see tests/test_llm.py), and it's the substrate for future
    controller-side tasks (triage, summarization) or an LLM proxy.

LiteLLM is imported lazily so importing the package doesn't require the dep.
"""

from __future__ import annotations

from dataclasses import dataclass

from core.config import get_settings
from core.logger import get_logger

log = get_logger("llm")


@dataclass(slots=True)
class LLMResult:
    text: str
    model: str
    finish_reason: str | None = None


class LLMService:
    """Calls a chat model via LiteLLM, with ordered fallbacks like pr-agent."""

    def __init__(
        self,
        model: str | None = None,
        fallbacks: list[str] | None = None,
        api_base: str | None = None,
        api_key: str | None = None,
        timeout: int | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> None:
        s = get_settings()
        spec = s.model_spec()
        self.model = model or spec.model
        self.fallbacks = fallbacks if fallbacks is not None else spec.fallbacks
        self.timeout = timeout if timeout is not None else s.ai_timeout
        self.max_tokens = max_tokens if max_tokens is not None else s.llm_max_tokens
        self.temperature = temperature if temperature is not None else spec.temperature

        # Pick gateway vs. native OpenAI vars based on the model's provider prefix.
        provider = self.model.partition("/")[0]
        if api_base is not None:
            self.api_base = api_base
        elif provider == "aigateway":
            self.api_base = s.aigateway_base_url or None
        else:
            # openai/* (official or compatible) — base_url is optional.
            self.api_base = s.openai_base_url or None

        if api_key is not None:
            self.api_key = api_key
        elif provider == "aigateway":
            self.api_key = s.aigateway_api_key or None
        else:
            self.api_key = s.openai_api_key or None

    # LiteLLM's own provider prefixes — don't rewrite these.
    _LITELLM_PROVIDERS = frozenset(
        {"openai", "anthropic", "azure", "vertex_ai", "bedrock", "groq",
         "mistral", "together", "fireworks", "deepseek", "cerebras", "cohere"}
    )

    def _litellm_model(self, model: str) -> str:
        """Normalize AGENT_MODEL for litellm.

        AGENT_MODEL uses a custom prefix (e.g. 'aigateway/') for the sandbox
        provider wiring. LiteLLM only understands 'openai/' for OpenAI-compatible
        gateways. When api_base is set, rewrite any non-litellm prefix to 'openai/'.
        """
        if not self.api_base:
            return model
        provider, sep, rest = model.partition("/")
        if not sep or provider in self._LITELLM_PROVIDERS:
            return model
        return f"openai/{rest}"

    def _completion_kwargs(self, model: str, messages: list[dict]) -> dict:
        """Build the LiteLLM acompletion kwargs (mirrors pr-agent's handler).

        For OpenAI-compatible models (``openai/...``) the gateway base_url + key
        are passed through; other providers read their keys from the environment.
        """
        kwargs: dict = {
            "model": self._litellm_model(model),
            "messages": messages,
            "timeout": self.timeout,
            "temperature": self.temperature,
        }
        if self.max_tokens:
            kwargs["max_tokens"] = self.max_tokens
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.api_key:
            kwargs["api_key"] = self.api_key
        return kwargs

    async def complete(self, system: str, user: str) -> LLMResult:
        """Run a chat completion against the primary model, falling back in order."""
        import litellm

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        last_exc: Exception | None = None
        for model in [self.model, *self.fallbacks]:
            if not model:
                continue
            try:
                resp = await litellm.acompletion(**self._completion_kwargs(model, messages))
                choice = resp.choices[0]
                return LLMResult(
                    text=choice.message.content or "",
                    model=model,
                    finish_reason=getattr(choice, "finish_reason", None),
                )
            except Exception as e:  # noqa: BLE001 — try the next fallback
                last_exc = e
                log.warning("llm completion failed", extra={"model": model, "error": str(e)})
        raise RuntimeError(f"All models failed (last error: {last_exc})") from last_exc

    async def ping(self) -> LLMResult:
        """Cheapest possible reachability check — proves the gateway answers."""
        return await self.complete(
            system="You are a health check. Reply with exactly: ok",
            user="ping",
        )


def get_llm_service() -> LLMService:
    return LLMService()
