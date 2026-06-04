"""The pr_review capability bundle.

Wires the portable pieces (MCP `report_finding` tool, output schema, task
builder) to the per-harness prompt assets on disk. Registers itself at import
time so the core can resolve it by name without importing bundles directly.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from bundles.pr_review.task import build_task as _build_task
from core.bundles import Bundle, McpToolServer, register_bundle
from core.types import TaskSpec


class PRReviewBundle(Bundle):
    """Reviews a pull request and reports grounded findings."""

    name: str = "pr_review"

    def mcp_tools(self) -> list[McpToolServer]:
        """No MCP servers.

        ``report_finding`` is now an OpenCode plugin tool
        (``tools/report_finding.js``, a ``tool()`` from ``@opencode-ai/plugin``)
        staged into ``.opencode/tool/`` by the in-sandbox supervisor and loaded
        directly by OpenCode — matching the reference's custom-tool pattern
        (inspect-plugin.js + ``_install_tools``). It is therefore no longer a
        launched stdio MCP server, so nothing is declared here.
        """
        return []

    def harness_assets(self, harness: str) -> Path:
        """Directory of prompt assets for `harness` (e.g. the `opencode/` dir)."""
        return Path(__file__).parent / harness

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return _build_task(trigger)


register_bundle("pr_review", PRReviewBundle)
