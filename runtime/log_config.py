"""Structured JSON logging for the in-sandbox runtime.

Ported from the reference ``sandbox_runtime.log_config`` with one deliberate
change: logs go to **stderr**, not stdout. The git credential helper speaks
git's line-based protocol on stdout, so any stray log line there would corrupt
it. Routing all diagnostics to stderr keeps stdout reserved for protocol output
while still surfacing structured logs to the controller's log pipeline.
"""

from __future__ import annotations

import json
import logging
import queue
import sys
from typing import Any

# Standard LogRecord attributes to exclude from extra fields, plus our own
# underscore-prefixed envelope attributes.
_STANDARD_ATTRS = {
    "args",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "message",
    "module",
    "msecs",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "taskName",
    "thread",
    "threadName",
    "_component",
    "_service",
}


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON with envelope fields."""

    def format(self, record: logging.LogRecord) -> str:
        output: dict[str, Any] = {
            "level": record.levelname.lower(),
            "service": getattr(record, "_service", "coreview-runtime"),
            "component": getattr(record, "_component", record.name),
            "event": record.getMessage(),
            "ts": int(record.created * 1000),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and key not in output and not key.startswith("_"):
                output[key] = value
        if record.exc_info and record.exc_info[1]:
            exc = record.exc_info[1]
            output["error_type"] = type(exc).__qualname__
            output["error_message"] = str(exc)
            output["error_stack"] = self.formatException(record.exc_info)[-2000:]
        return json.dumps(output, default=str)


def configure_logging() -> None:
    """Configure the root logger with JSON output to stderr.

    Call once at process startup. Replaces any existing root handlers so
    third-party logs (httpx) flow through the same JSON pipeline.
    """
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JSONFormatter())
    logging.root.handlers = [handler]
    logging.root.setLevel(logging.INFO)


class StructuredLogger:
    """Thin wrapper over ``logging.Logger`` with a structured call-site API."""

    def __init__(
        self,
        component: str,
        service: str = "coreview-runtime",
        context: dict[str, Any] | None = None,
    ) -> None:
        self._component = component
        self._service = service
        self._context: dict[str, Any] = dict(context) if context else {}
        self._logger = logging.getLogger(component)

    def bind(self, **ctx: Any) -> None:
        """Mutate context in-place (e.g. late-bound correlation ids)."""
        self._context.update(ctx)

    def child(self, **ctx: Any) -> StructuredLogger:
        """Return a new logger with merged context."""
        return StructuredLogger(self._component, self._service, {**self._context, **ctx})

    def debug(self, event: str, **kw: Any) -> None:
        self._log(logging.DEBUG, event, **kw)

    def info(self, event: str, **kw: Any) -> None:
        self._log(logging.INFO, event, **kw)

    def warn(self, event: str, **kw: Any) -> None:
        self._log(logging.WARNING, event, **kw)

    def error(self, event: str, exc: BaseException | None = None, **kw: Any) -> None:
        self._log(logging.ERROR, event, exc=exc, **kw)

    def _log(
        self,
        level: int,
        event: str,
        exc: BaseException | None = None,
        **kw: Any,
    ) -> None:
        extra = {
            **self._context,
            **kw,
            "_component": self._component,
            "_service": self._service,
        }
        self._logger.log(
            level,
            event,
            extra=extra,
            exc_info=(type(exc), exc, exc.__traceback__) if exc else None,
        )


def get_logger(component: str, **context: Any) -> StructuredLogger:
    """Factory for a structured logger bound to initial context fields."""
    return StructuredLogger(component, context=context or None)


# Loggers we never forward to the controller: forwarding posts over httpx, whose
# own request logs would otherwise feed back into the queue endlessly.
_FORWARD_EXCLUDE = ("httpx", "httpcore", "hpack", "urllib3")

_ENVELOPE_KEYS = {"level", "service", "component", "event", "ts"}


def _readable_message(payload: dict[str, Any]) -> str:
    """Flatten a structured log payload into one readable line for the UI."""
    msg = str(payload.get("event", ""))
    if payload.get("error_message"):
        msg += f": {payload['error_message']}"
    extras = {
        k: v
        for k, v in payload.items()
        if k not in _ENVELOPE_KEYS and k not in ("error_message", "error_type", "error_stack")
    }
    if extras:
        msg += " " + " ".join(f"{k}={v}" for k, v in extras.items())
    return msg


class QueueLogForwarder(logging.Handler):
    """Pushes each (non-noisy) log record onto a queue as a controller event.

    The supervisor drains this queue and POSTs each item to the controller's
    /events endpoint, so the full in-sandbox log streams into the dashboard's
    live log — the only window into a detached background supervisor.
    """

    def __init__(self, q: queue.Queue) -> None:
        super().__init__()
        self._formatter = JSONFormatter()
        self._q = q

    def emit(self, record: logging.LogRecord) -> None:
        if record.name.split(".")[0] in _FORWARD_EXCLUDE:
            return
        try:
            payload = json.loads(self._formatter.format(record))
            self._q.put_nowait(
                {
                    "level": payload.get("level"),
                    "message": _readable_message(payload),
                    "logger": payload.get("component"),
                }
            )
        except Exception:  # noqa: BLE001 — logging must never raise (incl. queue.Full)
            pass


def attach_log_forwarder(maxsize: int = 2000) -> queue.Queue:
    """Add a forwarding handler to the root logger; return its queue."""
    q: queue.Queue = queue.Queue(maxsize=maxsize)
    handler = QueueLogForwarder(q)
    handler.setLevel(logging.INFO)
    logging.root.addHandler(handler)
    return q
