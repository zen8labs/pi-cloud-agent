"""VCS data contracts shared by all providers."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from core.types import RepoRef


class WebhookKind(str, Enum):
    pr_opened = "pr_opened"
    pr_updated = "pr_updated"  # new commits pushed
    pr_comment = "pr_comment"  # a human typed a command (e.g. /review)
    ignored = "ignored"


@dataclass(slots=True)
class ParsedWebhook:
    """Normalized result of parsing a provider webhook payload."""

    kind: WebhookKind
    provider: str
    repo: RepoRef | None = None
    command: str | None = None  # for pr_comment, the slash command text
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class DiffFile:
    path: str
    old_path: str | None
    status: str  # "added" | "modified" | "deleted" | "renamed"
    patch: str | None  # unified diff hunk text (may be None for binary)


@dataclass(slots=True)
class PullRequest:
    repo: RepoRef
    title: str
    body: str
    author: str
    files: list[DiffFile] = field(default_factory=list)


@dataclass(slots=True)
class InlineComment:
    """A single inline review comment anchored to a file+line on the head SHA."""

    file: str
    line: int
    body: str
    side: str = "RIGHT"  # RIGHT = new code; LEFT = old
