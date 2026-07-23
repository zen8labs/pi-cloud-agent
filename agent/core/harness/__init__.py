from core.harness.base import Event, EventType, HarnessAdapter, Session

__all__ = ["HarnessAdapter", "Session", "Event", "EventType", "get_harness_adapter"]


def get_harness_adapter(name: str | None = None) -> HarnessAdapter:
    """Factory: return the configured harness adapter."""
    from core.config import get_settings

    name = name or get_settings().harness
    if name == "pi":
        from core.harness.pi import PiAdapter

        return PiAdapter()
    raise ValueError(f"Unknown harness: {name!r}")
