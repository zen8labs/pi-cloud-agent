"""The general_agent capability bundle.

A free-form coding agent: takes a user prompt and works the repo checkout
directly. It needs no harness-specific assets: the user's prompt is sufficient.
The agent's work is surfaced live as events. Registers itself at import time.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from bundles.general_agent.task import build_task as _build_task
from core.bundles import Bundle, McpToolServer, register_bundle
from core.types import TaskSpec


class GeneralAgentBundle(Bundle):
    """Runs a free-form coding/agent task against a repo checkout."""

    name: str = "general_agent"

    def mcp_tools(self) -> list[McpToolServer]:
        """No MCP servers and no plugin tools: this bundle reports nothing back
        through a callback tool — its work streams to the controller as the
        harness's normal token/tool_call events."""
        return []

    def harness_assets(self, harness: str) -> Path:
        """Directory of prompt assets for `harness`."""
        return Path(__file__).parent / harness

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return _build_task(trigger)


register_bundle("general_agent", GeneralAgentBundle)
