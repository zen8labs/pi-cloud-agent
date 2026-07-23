"""The general_agent profile.

A free-form coding agent: takes a user prompt and works the repo checkout
directly. The agent's work is surfaced live as events.
"""

from __future__ import annotations

from typing import Any

from core.profiles import Profile
from core.types import TaskSpec
from profiles.general_agent.task import build_task


class GeneralAgentProfile(Profile):
    """Runs a free-form coding/agent task against a repo checkout."""

    name: str = "general_agent"

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return build_task(trigger)
