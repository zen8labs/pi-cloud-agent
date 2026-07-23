"""Agent profile registry.

A profile is the smallest useful unit of specialization: it turns a normalized
trigger into a task. Profiles own behavior; the controller only coordinates
infrastructure.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any, Protocol, runtime_checkable

from core.types import TaskSpec


@runtime_checkable
class Profile(Protocol):
    name: str

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec: ...


_BUILTINS = {
    "general_agent": ("profiles.general_agent.profile", "GeneralAgentProfile"),
    "pr_review": ("profiles.pr_review.profile", "PRReviewProfile"),
}


def get_profile(name: str) -> Profile:
    """Resolve a built-in profile without import-time registration side effects."""
    try:
        module_name, class_name = _BUILTINS[name]
    except KeyError as error:
        raise KeyError(f"Unknown profile: {name!r}") from error
    profile = getattr(import_module(module_name), class_name)()
    if not isinstance(profile, Profile):
        raise TypeError(f"Invalid profile implementation: {name!r}")
    return profile
