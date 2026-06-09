"""The pr_review capability bundle.

Wires the task builder to the per-harness prompt assets on disk (the pr-review
skill + reviewer/critic subagents). Registers itself at import time so the core
can resolve it by name without importing bundles directly.

There is no structured-output contract: the agent reads the diff, reviews it,
and posts its own inline + summary PR comments via ``gh`` using the SCM token
baked into the sandbox env. The controller never publishes on its behalf.
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
        """No MCP servers and no plugin tools.

        The agent uses the harness's built-in bash/read/grep tools plus the
        ``gh`` CLI (authenticated by the baked SCM token) to read the diff and
        post review comments. There is no callback tool to declare.
        """
        return []

    def harness_assets(self, harness: str) -> Path:
        """Directory of prompt assets for `harness` (e.g. the `opencode/` dir)."""
        return Path(__file__).parent / harness

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return _build_task(trigger)


register_bundle("pr_review", PRReviewBundle)
