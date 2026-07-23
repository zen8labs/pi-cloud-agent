"""Trigger -> TaskSpec for the general_agent bundle.

A manual chat session normalizes to a flat trigger dict (repo coordinates + the
user's free-form ``user_prompt``). Unlike pr_review there is usually no PR, so
base/head SHAs are optional — the supervisor clones the repo's default-branch
tip when ``head_sha`` is empty. The user's prompt is carried in ``inputs`` so the
The harness adapter surfaces it to the in-sandbox supervisor as ``USER_PROMPT``.
"""

from __future__ import annotations

from typing import Any

from core.types import RepoRef, RunLimits, TaskSpec


def build_task(trigger: dict[str, Any]) -> TaskSpec:
    """Build the general_agent `TaskSpec` from a normalized trigger dict."""
    repo = RepoRef(
        provider=trigger["provider"],
        host=trigger["host"],
        owner=trigger["owner"],
        name=trigger["name"],
        clone_url=trigger["clone_url"],
        default_branch=trigger.get("default_branch") or "main",
        base_sha=trigger.get("base_sha", ""),
        head_sha=trigger.get("head_sha", ""),
        head_branch=trigger.get("head_branch") or trigger.get("default_branch") or "",
        pr_number=trigger.get("pr_number"),
    )
    return TaskSpec(
        bundle="general_agent",
        instructions="Follow the general-agent skill to carry out the user's request.",
        repo=repo,
        inputs=trigger,
        limits=RunLimits(),
    )
