"""The VCS provider contract every backend implements.

Deliberately small — only what a headless review run needs:
  * parse + verify webhooks,
  * mint a short-lived clone credential (used by the sandbox git credential
    helper, never persisted into the sandbox),
  * fetch the PR (metadata + diff),
  * publish inline + summary review comments.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.vcs.types import InlineComment, ParsedWebhook, PullRequest


@runtime_checkable
class VCSProvider(Protocol):
    name: str

    def verify_and_parse_webhook(
        self, headers: dict[str, str], body: bytes
    ) -> ParsedWebhook:
        """Verify the signature and normalize the payload. Raise on bad signature."""
        ...

    async def mint_clone_token(self, repo_full_name: str) -> str:
        """Return a short-lived credential for cloning `repo_full_name`.

        For GitHub this is an App installation token; for GitLab/Bitbucket a
        scoped token. The controller hands this to the sandbox's git credential
        helper on demand — it is never baked into the sandbox image/env.
        """
        ...

    async def get_pull_request(self, repo, pr_number: int) -> PullRequest:  # repo: RepoRef
        ...

    async def publish_inline_comments(
        self, repo, pr_number: int, comments: list[InlineComment]
    ) -> None:
        ...

    async def publish_summary(self, repo, pr_number: int, body: str) -> None:
        ...
