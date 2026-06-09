"""GitLab VCS provider.

Token-auth backend for GitLab.com / self-managed (base = `gitlab_url`). Webhook
authenticity is asserted via the shared `X-Gitlab-Token` header (GitLab does not
HMAC-sign payloads). Inline comments use the MR Discussions API, which requires a
`position` object pinned to the diff refs (base/start/head SHA).

Adapted from ../pr-agent's gitlab_provider.py and the reference repo's
gitlab-provider.ts.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import httpx

from core.config import get_settings
from core.logger import get_logger
from core.types import RepoRef
from core.vcs.types import (
    DiffFile,
    ParsedWebhook,
    PullRequest,
    WebhookKind,
)

_TIMEOUT = httpx.Timeout(30.0)

log = get_logger("vcs.gitlab")


def _project_path(repo: RepoRef) -> str:
    """URL-encode `owner/name` into a single GitLab project identifier."""
    return quote(repo.full_name, safe="")


class GitLabProvider:
    """GitLab provider using a Personal/Project Access Token."""

    name = "gitlab"

    def __init__(self) -> None:
        self._settings = get_settings()

    @property
    def _api_base(self) -> str:
        return f"{self._settings.gitlab_url.rstrip('/')}/api/v4"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._settings.gitlab_token}"}

    # ── webhook ──────────────────────────────────────────────────────────

    def verify_and_parse_webhook(
        self, headers: dict[str, str], body: bytes
    ) -> ParsedWebhook:
        """Validate the shared secret token then normalize the MR/note event."""
        self._verify_token(headers)
        payload = json.loads(body)
        kind_header = self._header(headers, "X-Gitlab-Event") or ""
        object_kind = payload.get("object_kind")

        if object_kind == "merge_request":
            return self._parse_merge_request(payload)
        if object_kind == "note":
            return self._parse_note(payload)
        log.debug("ignoring gitlab event: %s", kind_header)
        return ParsedWebhook(kind=WebhookKind.ignored, provider=self.name, raw=payload)

    def _verify_token(self, headers: dict[str, str]) -> None:
        secret = self._settings.gitlab_webhook_secret
        token = self._header(headers, "X-Gitlab-Token")
        if not secret:
            raise ValueError("gitlab_webhook_secret is not configured")
        if not token or token != secret:
            raise ValueError("invalid GitLab webhook token")

    def _parse_merge_request(self, payload: dict[str, Any]) -> ParsedWebhook:
        attrs = payload.get("object_attributes", {})
        action = attrs.get("action")
        # `open`/`reopen` → opened; `update` with new commits → updated.
        if action in ("open", "reopen"):
            kind = WebhookKind.pr_opened
        elif action == "update" and attrs.get("oldrev"):
            kind = WebhookKind.pr_updated
        else:
            return ParsedWebhook(kind=WebhookKind.ignored, provider=self.name, raw=payload)
        repo = self._repo_from_payload(payload, attrs)
        return ParsedWebhook(kind=kind, provider=self.name, repo=repo, raw=payload)

    def _parse_note(self, payload: dict[str, Any]) -> ParsedWebhook:
        # Only comments on a merge request carry a command for us.
        if "merge_request" not in payload:
            return ParsedWebhook(kind=WebhookKind.ignored, provider=self.name, raw=payload)
        mr = payload["merge_request"]
        repo = self._repo_from_payload(payload, mr)
        command = (payload.get("object_attributes", {}) or {}).get("note")
        return ParsedWebhook(
            kind=WebhookKind.pr_comment,
            provider=self.name,
            repo=repo,
            command=command,
            raw=payload,
        )

    def _repo_from_payload(self, payload: dict[str, Any], mr: dict[str, Any]) -> RepoRef:
        project = payload.get("project", {})
        path_with_namespace = project.get("path_with_namespace", "")
        owner, _, name = path_with_namespace.rpartition("/")
        host = (project.get("web_url") or self._settings.gitlab_url).split("/")[2]
        return RepoRef(
            provider=self.name,
            host=host,
            owner=owner,
            name=name,
            clone_url=project.get("git_http_url") or f"https://{host}/{path_with_namespace}.git",
            default_branch=project.get("default_branch", "main"),
            base_sha=mr.get("base_commit_sha") or "",
            head_sha=mr.get("last_commit", {}).get("id") or mr.get("source_branch_sha") or "",
            head_branch=mr.get("source_branch", ""),
            pr_number=mr.get("iid"),
        )

    # ── auth ─────────────────────────────────────────────────────────────

    async def mint_clone_token(self, repo_full_name: str) -> str:
        """GitLab uses a long-lived PAT; just hand it back for the clone."""
        token = self._settings.gitlab_token
        if not token:
            raise ValueError("gitlab_token is not configured")
        return token

    # ── reads ────────────────────────────────────────────────────────────

    async def get_pull_request(self, repo: RepoRef, pr_number: int) -> PullRequest:
        base = f"{self._api_base}/projects/{_project_path(repo)}/merge_requests/{pr_number}"
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=self._headers()) as client:
            meta_resp = await client.get(base)
            meta_resp.raise_for_status()
            meta = meta_resp.json()
            changes_resp = await client.get(f"{base}/changes")
            changes_resp.raise_for_status()
            changes = changes_resp.json().get("changes", [])
        return PullRequest(
            repo=repo,
            title=meta.get("title", ""),
            body=meta.get("description") or "",
            author=(meta.get("author") or {}).get("username", ""),
            files=[self._diff_file(c) for c in changes],
        )

    @staticmethod
    def _diff_file(change: dict[str, Any]) -> DiffFile:
        if change.get("new_file"):
            status = "added"
        elif change.get("deleted_file"):
            status = "deleted"
        elif change.get("renamed_file"):
            status = "renamed"
        else:
            status = "modified"
        old_path = change.get("old_path")
        return DiffFile(
            path=change.get("new_path") or old_path or "",
            old_path=old_path if old_path != change.get("new_path") else None,
            status=status,
            patch=change.get("diff") or None,
        )

    # NOTE: No publish path — the agent posts MR comments itself from the
    # sandbox using the baked SCM token (see core/orchestrator/runner.py).

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _header(headers: dict[str, str], key: str) -> str | None:
        lowered = key.lower()
        for k, v in headers.items():
            if k.lower() == lowered:
                return v
        return None
