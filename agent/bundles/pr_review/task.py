"""Trigger -> TaskSpec for the pr_review bundle.

The webhook layer normalizes a VCS event into a flat trigger dict; here we
reconstruct the `RepoRef` and wrap it in a harness-agnostic `TaskSpec`. The
`instructions` are deliberately thin — they just activate the bundle's
pr-review skill; the real behaviour lives in the skill + MCP tools.
"""

from __future__ import annotations

from typing import Any

from core.types import RepoRef, RunLimits, TaskSpec


def build_task(trigger: dict[str, Any]) -> TaskSpec:
    """Build the pr_review `TaskSpec` from a normalized trigger dict."""
    repo = RepoRef(
        provider=trigger["provider"],
        host=trigger["host"],
        owner=trigger["owner"],
        name=trigger["name"],
        clone_url=trigger["clone_url"],
        default_branch=trigger["default_branch"],
        base_sha=trigger["base_sha"],
        head_sha=trigger["head_sha"],
        head_branch=trigger["head_branch"],
        pr_number=trigger.get("pr_number"),
    )
    return TaskSpec(
        bundle="pr_review",
        instructions="Run the pr-review skill to review this pull request.",
        repo=repo,
        inputs=trigger,
        limits=RunLimits(),
    )
