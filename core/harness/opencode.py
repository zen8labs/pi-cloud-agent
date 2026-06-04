"""OpenCode harness adapter (controller side).

OpenCode is the managed agent runtime we run *inside* the sandbox. The
controller never reaches into the sandbox: the in-sandbox supervisor boots
OpenCode from the env this adapter bakes in, and the bridge dials back out,
POSTing events to the internal API which `event_bus.publish()`es them
(see ARCHITECTURE.md → "Trust boundary & secrets" and "The sandbox runtime").
This adapter therefore (1) emits the non-secret
boot env, (2) hands back a `Session`, and (3) consumes the bus stream in
`run()`, translating each relayed dict into a typed `Event`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from core.bundles import Bundle
from core.harness.base import Event, EventType, HarnessAdapter, Session
from core.logger import get_logger
from core.orchestrator.bus import event_bus
from core.sandbox.provider import SandboxHandle
from core.types import ModelSpec, TaskSpec

log = get_logger(__name__)


class OpenCodeAdapter(HarnessAdapter):
    """Drives an OpenCode session running inside a sandbox."""

    name: str = "opencode"

    def runtime_env(self, bundle: Bundle, task: TaskSpec, model: ModelSpec) -> dict[str, str]:
        """Non-secret boot env for the in-sandbox supervisor.

        Tells it which harness + bundle to load and which model (plus ordered
        fallbacks, pr-agent semantics) to drive OpenCode with. Secrets (LLM
        keys), repo coordinates, and per-run callback env are layered on by the
        orchestrator and sandbox provider — never here.
        """
        return {
            "HARNESS": "opencode",
            "BUNDLE": task.bundle,
            "AGENT_MODEL": model.model,
            "AGENT_FALLBACK_MODELS": ",".join(model.fallbacks),
        }

    async def start(self, sandbox: SandboxHandle, run_id: str, session_id: str) -> Session:
        """Bind a session handle to the live sandbox.

        No network call: the sandbox's bridge dials us, so there is nothing to
        provision here beyond the handle the orchestrator's `run()` will use to
        subscribe to the bus.
        """
        return Session(run_id=run_id, session_id=session_id, sandbox=sandbox)

    async def run(self, session: Session, task: TaskSpec) -> AsyncIterator[Event]:
        """Yield events the bridge relays until the session's `done` event.

        We subscribe to the per-run bus and translate each `{"type","data"}`
        dict into a typed `Event`. Unknown/unmapped types degrade to
        `EventType.log` so a forward-compatible bridge can't stall the stream.
        An overall wall-clock budget is enforced via a per-`get` deadline; on
        timeout we surface an `error` then a synthetic `done` so the consumer
        always terminates cleanly.
        """
        q = event_bus.subscribe(session.run_id)
        deadline = asyncio.get_running_loop().time() + task.limits.wall_clock_seconds
        try:
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    yield self._timeout_error(task)
                    yield Event(EventType.done, {"status": "failed", "reason": "wall_clock_timeout"})
                    return
                try:
                    raw = await asyncio.wait_for(q.get(), timeout=remaining)
                except TimeoutError:
                    log.warning("opencode run timed out", extra={"run_id": session.run_id})
                    yield self._timeout_error(task)
                    yield Event(EventType.done, {"status": "failed", "reason": "wall_clock_timeout"})
                    return

                event = self._to_event(raw)
                yield event
                if event.type is EventType.done:
                    return
        finally:
            event_bus.unsubscribe(session.run_id, q)

    async def stop(self, session: Session) -> None:
        """Best-effort teardown.

        A no-op today: sandbox teardown is the provider's responsibility. TODO:
        once OpenCode exposes an explicit session-abort callback, dial it here
        (or signal the bridge) so an in-flight model loop is cancelled promptly
        rather than waiting on sandbox stop.
        """
        return None

    @staticmethod
    def _to_event(raw: dict) -> Event:
        """Translate a relayed bus dict into a typed `Event`."""
        raw_type = raw.get("type", "log")
        try:
            etype = EventType(raw_type)
        except ValueError:
            etype = EventType.log
        data = raw.get("data") or {}
        if not isinstance(data, dict):
            data = {"value": data}
        return Event(etype, data)

    @staticmethod
    def _timeout_error(task: TaskSpec) -> Event:
        return Event(
            EventType.error,
            {
                "error": "wall_clock_timeout",
                "wall_clock_seconds": task.limits.wall_clock_seconds,
            },
        )
