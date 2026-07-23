"""Wait for terminal events emitted by the sandbox runtime."""

from __future__ import annotations

import asyncio


async def wait_for_completion(
    queue: asyncio.Queue,
    timeout_seconds: int,
) -> None:
    """Consume a pre-subscribed run queue until ``done`` or ``error``."""
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"agent exceeded {timeout_seconds}s wall-clock limit")
        try:
            event = await asyncio.wait_for(queue.get(), timeout=remaining)
        except TimeoutError as error:
            raise TimeoutError(
                f"agent exceeded {timeout_seconds}s wall-clock limit"
            ) from error

        event_type = event.get("type", "log")
        data = event.get("data") or {}
        if event_type == "error":
            raise RuntimeError(data.get("message") or data.get("detail") or "agent error")
        if event_type == "done":
            return
