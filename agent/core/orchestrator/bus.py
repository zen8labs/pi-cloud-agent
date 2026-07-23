"""In-process per-run event bus.

The in-sandbox Pi runner dials the controller and POSTs events to the internal API
(see ARCHITECTURE.md → "The request lifecycle"). Those handlers `publish()` onto
this bus; the orchestrator subscribes before provisioning and waits for `done`.

This is intentionally in-memory: it works when the API and the worker share a
process (the default deployment). To scale the worker out to its own process,
swap this for Redis pub/sub — the call sites don't change.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict


class _EventBus:
    def __init__(self) -> None:
        self._queues: dict[str, list[asyncio.Queue]] = defaultdict(list)

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._queues[run_id].append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        subs = self._queues.get(run_id)
        if subs and q in subs:
            subs.remove(q)
        if subs is not None and not subs:
            self._queues.pop(run_id, None)

    async def publish(self, run_id: str, event: dict) -> None:
        for q in list(self._queues.get(run_id, [])):
            await q.put(event)


event_bus = _EventBus()
