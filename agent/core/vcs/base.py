"""The VCS provider contract every backend implements.

Deliberately small — read + auth only. The agent actuates its own outcomes
(comments, pushes) from inside the sandbox using the baked SCM token, so the
controller-side provider never writes:
  * parse + verify webhooks,
  * mint a short-lived, repo-scoped SCM token (baked into the sandbox env at
    creation — see core/orchestrator/runner.py),
  * fetch the PR (metadata + diff) to resolve coordinates before launch.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.vcs.types import ParsedWebhook, PullRequest


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
