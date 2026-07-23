"""The pr_review profile.

There is no structured-output contract: the agent reads the diff, reviews it,
and posts its own inline + summary PR comments via ``gh`` using the SCM token
baked into the sandbox env. The controller never publishes on its behalf.
"""

from __future__ import annotations

from typing import Any

from core.profiles import Profile
from core.types import TaskSpec
from profiles.pr_review.task import build_task


class PRReviewProfile(Profile):
    """Reviews a pull request and reports grounded findings."""

    name: str = "pr_review"

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return build_task(trigger)
