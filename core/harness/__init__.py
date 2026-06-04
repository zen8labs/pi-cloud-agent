from core.harness.base import Event, EventType, HarnessAdapter, Session

__all__ = ["HarnessAdapter", "Session", "Event", "EventType", "get_harness_adapter"]


def get_harness_adapter(name: str | None = None) -> HarnessAdapter:
    """Factory: returns the configured harness adapter.

    The harness is swappable (see ARCHITECTURE.md → "Core contracts"). Today only
    OpenCode is wired;
    a `pi` or `claude_agent` adapter implements the same `HarnessAdapter` protocol.
    """
    from core.config import get_settings

    name = name or get_settings().harness
    if name == "opencode":
        from core.harness.opencode import OpenCodeAdapter

        return OpenCodeAdapter()
    raise ValueError(f"Unknown harness: {name!r}")
