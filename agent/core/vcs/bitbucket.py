"""Bitbucket Cloud VCS provider.

Token-auth backend for bitbucket.org. Inline comments use the PR comments API
with an `inline` anchor (path + line). Bitbucket Cloud webhooks do not natively
sign payloads, so we authenticate via a shared secret carried in a custom header
(configured when registering the webhook) — best-effort, fail-closed.

Adapted from ../pr-agent's bitbucket_provider.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

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

_API_BASE = "https://api.bitbucket.org/2.0"
_TIMEOUT = httpx.Timeout(30.0)

log = get_logger("vcs.bitbucket")


class BitbucketProvider:
    """Bitbucket Cloud provider using an access token (Bearer)."""

    name = "bitbucket"

    def __init__(self) -> None:
        self._settings = get_settings()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._settings.bitbucket_token}",
            "Content-Type": "application/json",
        }

    # ── webhook ──────────────────────────────────────────────────────────

    def verify_and_parse_webhook(
        self, headers: dict[str, str], body: bytes
    ) -> ParsedWebhook:
        """Authenticate the shared secret, then normalize the PR event.

        Bitbucket Cloud has no built-in payload signature. If the workspace adds
        an HMAC (newer feature) it arrives in `X-Hub-Signature`; otherwise we
        accept a static secret echoed in `X-Hook-Secret`. We support both and
        fail closed when neither matches the configured secret.
        """
        self._verify_secret(headers, body)
        payload = json.loads(body)
        event = self._header(headers, "X-Event-Key") or ""

        if event in ("pullrequest:created", "pullrequest:updated"):
            kind = (
                WebhookKind.pr_opened
                if event == "pullrequest:created"
                else WebhookKind.pr_updated
            )
            repo = self._repo_from_payload(payload)
            return ParsedWebhook(kind=kind, provider=self.name, repo=repo, raw=payload)
        if event == "pullrequest:comment_created":
            repo = self._repo_from_payload(payload)
            command = (payload.get("comment", {}) or {}).get("content", {}).get("raw")
            return ParsedWebhook(
                kind=WebhookKind.pr_comment,
                provider=self.name,
                repo=repo,
                command=command,
                raw=payload,
            )
        return ParsedWebhook(kind=WebhookKind.ignored, provider=self.name, raw=payload)

    def _verify_secret(self, headers: dict[str, str], body: bytes) -> None:
        secret = self._settings.bitbucket_webhook_secret
        if not secret:
            raise ValueError("bitbucket_webhook_secret is not configured")
        # Prefer an HMAC signature when present (some Bitbucket setups send one).
        sig = self._header(headers, "X-Hub-Signature")
        if sig:
            expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            if hmac.compare_digest(expected, sig):
                return
            raise ValueError("invalid Bitbucket webhook signature")
        # Fall back to a shared-secret header.
        token = self._header(headers, "X-Hook-Secret")
        if not token or not hmac.compare_digest(token, secret):
            raise ValueError("invalid Bitbucket webhook secret")

    def _repo_from_payload(self, payload: dict[str, Any]) -> RepoRef:
        repo = payload.get("repository", {})
        pr = payload.get("pullrequest", {})
        full_name = repo.get("full_name", "")
        owner, _, name = full_name.partition("/")
        source = pr.get("source", {})
        dest = pr.get("destination", {})
        return RepoRef(
            provider=self.name,
            host="bitbucket.org",
            owner=owner,
            name=name,
            clone_url=f"https://bitbucket.org/{full_name}.git",
            default_branch=(repo.get("mainbranch") or {}).get("name", "main"),
            base_sha=(dest.get("commit") or {}).get("hash", ""),
            head_sha=(source.get("commit") or {}).get("hash", ""),
            head_branch=(source.get("branch") or {}).get("name", ""),
            pr_number=pr.get("id"),
        )

    # ── auth ─────────────────────────────────────────────────────────────

    async def mint_clone_token(self, repo_full_name: str) -> str:
        """Bitbucket uses a static access token; hand it back for the clone."""
        token = self._settings.bitbucket_token
        if not token:
            raise ValueError("bitbucket_token is not configured")
        return token

    # ── reads ────────────────────────────────────────────────────────────

    async def get_pull_request(self, repo: RepoRef, pr_number: int) -> PullRequest:
        base = f"{_API_BASE}/repositories/{repo.full_name}/pullrequests/{pr_number}"
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=self._headers()) as client:
            meta_resp = await client.get(base)
            meta_resp.raise_for_status()
            meta = meta_resp.json()
            files = await self._fetch_files(client, base)
        return PullRequest(
            repo=repo,
            title=meta.get("title", ""),
            body=(meta.get("summary") or {}).get("raw") or meta.get("description") or "",
            author=(meta.get("author") or {}).get("nickname")
            or (meta.get("author") or {}).get("display_name", ""),
            files=files,
        )

    async def _fetch_files(self, client: httpx.AsyncClient, pr_base: str) -> list[DiffFile]:
        """Use the `diffstat` endpoint for file status, paging through results.

        `diffstat` gives per-file status + old/new paths but not the hunk text;
        Bitbucket exposes the unified patch only via the separate `diff` endpoint,
        which returns one blob for the whole PR. We attach that blob to each file
        so downstream review has the patch context.
        """
        files: list[DiffFile] = []
        url: str | None = f"{pr_base}/diffstat"
        while url:
            resp = await client.get(url, params={"pagelen": 100} if "?" not in url else None)
            resp.raise_for_status()
            page = resp.json()
            for entry in page.get("values", []):
                old = entry.get("old") or {}
                new = entry.get("new") or {}
                # Bitbucket status: added | removed | modified | renamed.
                status = entry.get("status", "modified")
                status = "deleted" if status == "removed" else status
                old_path = old.get("path")
                new_path = new.get("path")
                files.append(
                    DiffFile(
                        path=new_path or old_path or "",
                        old_path=old_path if old_path and old_path != new_path else None,
                        status=status,
                        patch=None,  # filled below from the full diff
                    )
                )
            url = page.get("next")

        # Best-effort: fetch the unified diff once and slice per file. If parsing
        # fails we still return the file list (status only).
        try:
            diff_resp = await client.get(f"{pr_base}/diff")
            diff_resp.raise_for_status()
            self._attach_patches(files, diff_resp.text)
        except Exception as exc:  # noqa: BLE001 - diff is supplementary
            log.warning("bitbucket diff fetch failed: %s", exc)
        return files

    @staticmethod
    def _attach_patches(files: list[DiffFile], unified: str) -> None:
        """Split a combined unified diff into per-file hunks keyed by new path."""
        by_path = {f.path: f for f in files}
        current_path: str | None = None
        buf: list[str] = []

        def flush() -> None:
            if current_path and current_path in by_path and buf:
                by_path[current_path].patch = "".join(buf)

        for line in unified.splitlines(keepends=True):
            if line.startswith("diff --git "):
                flush()
                buf = [line]
                # "diff --git a/<old> b/<new>" — take the b/ side as the key.
                parts = line.split(" b/", 1)
                current_path = parts[1].strip() if len(parts) == 2 else None
            else:
                buf.append(line)
        flush()

    # NOTE: No publish path — the agent posts PR comments itself from the
    # sandbox using the baked SCM token (see core/orchestrator/runner.py).

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _header(headers: dict[str, str], key: str) -> str | None:
        lowered = key.lower()
        for k, v in headers.items():
            if k.lower() == lowered:
                return v
        return None
