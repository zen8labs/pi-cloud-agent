"""VCS provider abstraction.

GitHub is primary; GitLab and Bitbucket are day-0 (see ARCHITECTURE.md → "VCS
providers").
Implementations are ported/adapted from ../pr-agent's git_providers and the
reference repo's source-control providers, but reshaped to this small contract.
"""

from core.vcs.base import VCSProvider
from core.vcs.types import (
    DiffFile,
    InlineComment,
    ParsedWebhook,
    PullRequest,
    WebhookKind,
)

__all__ = [
    "VCSProvider",
    "PullRequest",
    "DiffFile",
    "InlineComment",
    "ParsedWebhook",
    "WebhookKind",
    "get_vcs_provider",
]


def get_vcs_provider(provider: str) -> VCSProvider:
    if provider == "github":
        from core.vcs.github import GitHubProvider

        return GitHubProvider()
    if provider == "gitlab":
        from core.vcs.gitlab import GitLabProvider

        return GitLabProvider()
    if provider == "bitbucket":
        from core.vcs.bitbucket import BitbucketProvider

        return BitbucketProvider()
    raise ValueError(f"Unknown VCS provider: {provider!r}")
