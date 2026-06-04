"""Output contract for the pr_review bundle.

A `Finding` is the single unit the agent reports back through the
`report_finding` MCP tool. Keeping it a strict, typed schema lets the
controller validate every callback and the publisher render it consistently
into VCS review comments.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["blocker", "warning", "nit"]


class Finding(BaseModel):
    """One grounded issue introduced by the PR under review."""

    file: str = Field(..., description="Repo-relative path the finding applies to.")
    line: int | None = Field(
        None, description="1-based line in the head revision, or null if file-level."
    )
    severity: Severity = Field(..., description="blocker | warning | nit")
    title: str = Field(..., description="Short, specific summary of the issue.")
    body: str = Field(..., description="Explanation and suggested fix.")
    evidence: str = Field(
        ...,
        description="Concrete grounding: a read range or command/linter output proving the issue.",
    )
