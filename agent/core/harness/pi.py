"""Controller-side adapter for the embedded Pi harness."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

from core.bundles import Bundle
from core.harness.base import Event, EventType, HarnessAdapter, Session
from core.logger import get_logger
from core.orchestrator.bus import event_bus
from core.sandbox.provider import SandboxHandle
from core.types import ModelSpec, TaskSpec

log = get_logger("harness.pi")


class PiAdapter(HarnessAdapter):
    """Configure Pi in the sandbox and consume its outbound event stream."""

    name = "pi"

    def runtime_env(self, bundle: Bundle, task: TaskSpec, model: ModelSpec) -> dict[str, str]:
        env = {
            "HARNESS": self.name,
            "BUNDLE": task.bundle,
            "AGENT_MODEL": model.model,
            "AGENT_FALLBACK_MODELS": ",".join(model.fallbacks),
        }
        user_prompt = task.inputs.get("user_prompt")
        if user_prompt:
            env["USER_PROMPT"] = str(user_prompt)
        if os.environ.get("LLM_MAX_TOKENS"):
            env["LLM_MAX_TOKENS"] = os.environ["LLM_MAX_TOKENS"]
        return env

    async def start(self, sandbox: SandboxHandle, run_id: str, session_id: str) -> Session:
        return Session(run_id=run_id, session_id=session_id, sandbox=sandbox)

    async def run(self, session: Session, task: TaskSpec) -> AsyncIterator[Event]:
        queue = event_bus.subscribe(session.run_id)
        deadline = asyncio.get_running_loop().time() + task.limits.wall_clock_seconds
        try:
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    yield self._timeout_error(task)
                    yield Event(EventType.done, {"status": "failed", "reason": "wall_clock_timeout"})
                    return
                try:
                    raw = await asyncio.wait_for(queue.get(), timeout=remaining)
                except TimeoutError:
                    log.warning("pi run timed out", extra={"run_id": session.run_id})
                    yield self._timeout_error(task)
                    yield Event(EventType.done, {"status": "failed", "reason": "wall_clock_timeout"})
                    return

                event = self._to_event(raw)
                yield event
                if event.type is EventType.done:
                    return
        finally:
            event_bus.unsubscribe(session.run_id, queue)

    async def stop(self, session: Session) -> None:
        return None

    @staticmethod
    def _to_event(raw: dict) -> Event:
        try:
            event_type = EventType(raw.get("type", "log"))
        except ValueError:
            event_type = EventType.log
        data = raw.get("data") or {}
        if not isinstance(data, dict):
            data = {"value": data}
        return Event(event_type, data)

    @staticmethod
    def _timeout_error(task: TaskSpec) -> Event:
        return Event(
            EventType.error,
            {
                "error": "wall_clock_timeout",
                "wall_clock_seconds": task.limits.wall_clock_seconds,
            },
        )
