"""Structured JSON logging with a per-run correlation context.

Kept intentionally small. Every log line carries whatever correlation fields are
bound for the current async task (run_id, session_id, provider), so logs across
the controller and the sandbox runtime can be stitched together.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar

from pythonjsonlogger import jsonlogger

# No mutable default: an unset ContextVar raises LookupError, handled in
# get_correlation(). A shared mutable {} default would be a cross-context footgun.
_correlation: ContextVar[dict[str, str]] = ContextVar("correlation")

_CONFIGURED = False


def configure_logging(level: str = "INFO") -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(
        jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    _CONFIGURED = True


def bind_correlation(**fields: str) -> None:
    """Merge fields into the current task's correlation context."""
    current = get_correlation()
    current.update({k: v for k, v in fields.items() if v is not None})
    _correlation.set(current)


def get_correlation() -> dict[str, str]:
    try:
        return dict(_correlation.get())
    except LookupError:
        return {}


class _CorrelationAdapter(logging.LoggerAdapter):
    def process(self, msg, kwargs):
        extra = kwargs.setdefault("extra", {})
        extra.update(get_correlation())
        return msg, kwargs


def get_logger(name: str = "coreview-agent") -> logging.LoggerAdapter:
    configure_logging()
    return _CorrelationAdapter(logging.getLogger(name), {})
