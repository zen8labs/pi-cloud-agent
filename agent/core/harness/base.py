"""Harness adapter contract.

A harness is the managed agent runtime that runs *inside* the
sandbox and drives the actual tool-calling loop. The controller never reaches
into the sandbox; instead the in-sandbox supervisor/bridge dials the controller
outbound (see ARCHITECTURE.md → "Trust boundary & secrets" and "The sandbox
runtime"). An adapter therefore mostly:

  1. tells the sandbox runtime which bundle + model to load (via env/config it
     bakes into `CreateSandboxConfig.env`), and
  2. interprets the event/result stream the bridge posts back.

Keeping this a Protocol lets us later add `PiAdapter` / `ClaudeAgentAdapter`
without touching the orchestrator.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from core.bundles import Bundle
from core.sandbox.provider import SandboxHandle
from core.types import ModelSpec, TaskSpec


class EventType(str, Enum):
    status = "status"  # lifecycle: provisioning/running/...
    log = "log"  # free-form progress line
    tool_call = "tool_call"  # the agent invoked a tool
    finding = "finding"  # a structured finding was reported
    token = "token"  # streamed assistant token (optional)
    error = "error"
    done = "done"  # session finished; `collect` is now meaningful


@dataclass(slots=True)
class Event:
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Session:
    """A harness session bound to a sandbox + run."""

    run_id: str
    session_id: str
    sandbox: SandboxHandle
    harness_session_id: str | None = None


@runtime_checkable
class HarnessAdapter(Protocol):
    name: str

    def runtime_env(self, bundle: Bundle, task: TaskSpec, model: ModelSpec) -> dict[str, str]:
        """Non-secret env injected into the sandbox so the in-sandbox runtime
        knows which harness/bundle/model to boot. Called by the orchestrator
        *before* `create_sandbox`."""
        ...

    async def start(self, sandbox: SandboxHandle, run_id: str, session_id: str) -> Session:
        """Establish a session handle once the sandbox + bridge are up."""
        ...

    async def run(self, session: Session, task: TaskSpec) -> AsyncIterator[Event]:
        """Drive the task to completion, yielding events as the bridge relays
        them. Terminates with an `EventType.done` event."""
        ...

    async def stop(self, session: Session) -> None: ...
