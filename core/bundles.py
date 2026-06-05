"""Capability bundles.

A bundle specializes the task-agnostic core for a concrete job (PR review is the
first). It contributes:

  * portable parts: MCP tool servers, an output schema, and a `build_task`
    that turns a trigger into a `TaskSpec`;
  * per-harness assets: skill/subagent prompt files, located on disk and loaded
    into the sandbox by the harness adapter.

The core never imports a bundle directly; bundles register themselves here.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from core.types import TaskSpec


@dataclass(slots=True)
class McpToolServer:
    """Declares an MCP tool server the sandbox runtime should expose to the agent.

    `command`/`args` launch a stdio MCP server inside the sandbox. For our
    callback-style tools (e.g. report_finding) the server is a thin shim that
    POSTs to the controller using SANDBOX_AUTH_TOKEN.
    """

    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class Bundle(Protocol):
    name: str

    def mcp_tools(self) -> list[McpToolServer]: ...

    def harness_assets(self, harness: str) -> Path:
        """Directory containing this bundle's prompt assets for `harness`."""
        ...

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec: ...


_REGISTRY: dict[str, Callable[[], Bundle]] = {}


def register_bundle(name: str, factory: Callable[[], Bundle]) -> None:
    _REGISTRY[name] = factory


def get_bundle(name: str) -> Bundle:
    if name not in _REGISTRY:
        # Import side-effect registration for built-in bundles.
        _import_builtin_bundles()
    if name not in _REGISTRY:
        raise KeyError(f"Unknown bundle: {name!r}")
    return _REGISTRY[name]()


def _import_builtin_bundles() -> None:
    for module in ("bundles.pr_review.bundle", "bundles.general_agent.bundle"):
        try:
            __import__(module)  # registers on import
        except Exception:
            pass
