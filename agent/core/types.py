"""Core, runtime- and profile-agnostic data contracts.

These are the load-bearing types referenced across the whole system
(see ARCHITECTURE.md → "Core contracts"). Keep them free of provider/harness
specifics.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ReviewMode(str, Enum):
    """Feature-flag routing target for an incoming trigger."""

    legacy = "legacy"  # hand off to ../pr-agent
    agentic = "agentic"  # handle in this service


class RunStatus(str, Enum):
    queued = "queued"
    provisioning = "provisioning"  # creating sandbox
    running = "running"  # harness session active
    publishing = "publishing"  # writing results back to the VCS
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


@dataclass(slots=True)
class RepoRef:
    """Everything needed to clone and address a repository at a point in time."""

    provider: str  # "github" | "gitlab" | "bitbucket"
    host: str  # e.g. "github.com"
    owner: str
    name: str
    clone_url: str  # https clone URL (token injected via credential helper)
    default_branch: str
    base_sha: str
    head_sha: str
    head_branch: str
    pr_number: int | None = None

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"


@dataclass(slots=True)
class RunLimits:
    wall_clock_seconds: int = 1800
    max_parallel_units: int = 4
    max_tokens: int | None = None


@dataclass(slots=True)
class ModelSpec:
    """A LiteLLM-style model identifier plus ordered fallbacks (pr-agent semantics)."""

    model: str
    fallbacks: list[str] = field(default_factory=list)
    temperature: float = 0.2


@dataclass(slots=True)
class TaskSpec:
    """A normalized unit of work produced by a profile from a trigger."""

    profile: str  # e.g. "pr_review"
    prompt: str
    repo: RepoRef
    inputs: dict[str, Any] = field(default_factory=dict)
    limits: RunLimits = field(default_factory=RunLimits)


@dataclass(slots=True)
class CorrelationContext:
    run_id: str
    session_id: str
    provider: str | None = None

    def as_dict(self) -> dict[str, str]:
        d = {"run_id": self.run_id, "session_id": self.session_id}
        if self.provider:
            d["provider"] = self.provider
        return d
