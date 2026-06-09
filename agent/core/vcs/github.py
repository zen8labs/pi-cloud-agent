"""GitHub VCS provider.

Primary backend (see ARCHITECTURE.md → "VCS providers"). Auth prefers a GitHub
App installation
token (short-lived, scoped to the installation) and falls back to a static PAT
so local/dev setups work without an App. All network calls are async via httpx
because the controller runs inside an asyncio event loop.

Ported/adapted from ../pr-agent's github_provider.py (diff + review APIs incl.
the 422 inline-comment fallback) and its github-app.py (installation-token
minting). We keep our own async httpx client and the VCSProvider contract.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import time
from typing import Any

import httpx
import jwt

from core.config import get_settings
from core.logger import get_logger
from core.types import RepoRef
from core.vcs.types import (
    DiffFile,
    ParsedWebhook,
    PullRequest,
    WebhookKind,
)

# Base URL is configurable so the same provider drives GitHub Enterprise later;
# GHE's REST API lives under https://<host>/api/v3. Read from the env directly
# (not the typed Settings) so we can ship without touching the settings schema.
_API_BASE = os.environ.get("GITHUB_API_BASE", "https://api.github.com").rstrip("/")
_ACCEPT = "application/vnd.github+json"
_API_VERSION = "2022-11-28"
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# Installation tokens live ~1h; refresh a little early to avoid edge-of-expiry
# 401s mid-run.
_TOKEN_TTL_SLACK_SECONDS = 300

log = get_logger("vcs.github")


def _status_from_github_file(f: dict[str, Any]) -> str:
    """Normalize GitHub's file `status` into our DiffFile vocabulary."""
    status = f.get("status", "modified")
    # GitHub uses added/modified/removed/renamed (also copied/changed/unchanged);
    # map removed → deleted and treat the rare extras as modified.
    if status == "removed":
        return "deleted"
    if status in ("added", "modified", "renamed"):
        return status
    return "modified"


class GitHubProvider:
    """GitHub.com / GitHub Enterprise provider."""

    name = "github"

    def __init__(self) -> None:
        self._settings = get_settings()
        # Cache the installation token per repo full_name so back-to-back API
        # calls (e.g. get_pull_request → mint_clone_token) don't re-mint.
        self._token_cache: dict[str, tuple[str, float]] = {}
        self._token_lock = asyncio.Lock()

    # ── webhook ──────────────────────────────────────────────────────────

    def verify_and_parse_webhook(
        self, headers: dict[str, str], body: bytes
    ) -> ParsedWebhook:
        """Verify `X-Hub-Signature-256` then normalize the payload.

        We verify before parsing so an attacker-controlled body never reaches
        our JSON handling with a bad signature. Headers are looked up
        case-insensitively because WSGI/ASGI servers vary in casing.
        """
        self._verify_signature(headers, body)
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(f"invalid webhook JSON body: {exc}") from exc
        event = self._header(headers, "X-GitHub-Event") or ""

        if event == "pull_request":
            return self._parse_pull_request(payload)
        if event == "issue_comment":
            return self._parse_issue_comment(payload)
        return ParsedWebhook(kind=WebhookKind.ignored, provider=self.name, raw=payload)

    def _verify_signature(self, headers: dict[str, str], body: bytes) -> None:
        """Constant-time HMAC-SHA256 check of the delivery signature.

        Fail closed: an unconfigured secret or missing/short signature must
        never be treated as authentic.
        """
        secret = self._settings.github_webhook_secret
        sig = self._header(headers, "X-Hub-Signature-256")
        if not secret:
            raise ValueError("github_webhook_secret is not configured")
        if not sig:
            raise ValueError("missing X-Hub-Signature-256 header")
        expected = (
            "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        )
        # compare_digest is constant-time and safe on unequal lengths.
        if not hmac.compare_digest(expected, sig):
            raise ValueError("invalid GitHub webhook signature")

    def _parse_pull_request(self, payload: dict[str, Any]) -> ParsedWebhook:
        action = payload.get("action")
        kind = {
            "opened": WebhookKind.pr_opened,
            "reopened": WebhookKind.pr_opened,
            "synchronize": WebhookKind.pr_updated,
        }.get(action or "")
        if kind is None:
            return ParsedWebhook(
                kind=WebhookKind.ignored, provider=self.name, raw=payload
            )
        repo = self._repo_from_payload(payload, payload.get("pull_request"))
        log.info(
            "parsed pull_request webhook action=%s repo=%s pr=%s",
            action,
            repo.full_name,
            repo.pr_number,
        )
        return ParsedWebhook(kind=kind, provider=self.name, repo=repo, raw=payload)

    def _parse_issue_comment(self, payload: dict[str, Any]) -> ParsedWebhook:
        # Only `created` comments on an actual PR are commands; plain issue
        # comments (no `pull_request` key) are ignored.
        issue = payload.get("issue") or {}
        if payload.get("action") != "created" or "pull_request" not in issue:
            return ParsedWebhook(
                kind=WebhookKind.ignored, provider=self.name, raw=payload
            )
        # issue_comment payloads carry no PR head/base SHA — the controller
        # enriches via get_pull_request before running. We still build a
        # RepoRef carrying the PR number so the command can be routed.
        repo = self._repo_from_payload(payload, pr=None, pr_number=issue.get("number"))
        command = (payload.get("comment") or {}).get("body")
        log.info(
            "parsed issue_comment webhook repo=%s pr=%s", repo.full_name, repo.pr_number
        )
        return ParsedWebhook(
            kind=WebhookKind.pr_comment,
            provider=self.name,
            repo=repo,
            command=command,
            raw=payload,
        )

    def _repo_from_payload(
        self,
        payload: dict[str, Any],
        pr: dict[str, Any] | None,
        pr_number: int | None = None,
    ) -> RepoRef:
        """Build a complete RepoRef from a webhook's `repository` (+ optional PR)."""
        repo = payload["repository"]
        owner = (repo.get("owner") or {}).get("login", "")
        name = repo["name"]
        # Enterprise installs send the API host in `repository.html_url`; default
        # to github.com for the public cloud.
        html_url = repo.get("html_url") or "https://github.com"
        host = html_url.split("/")[2] if "//" in html_url else "github.com"
        head = (pr or {}).get("head") or {}
        base = (pr or {}).get("base") or {}
        return RepoRef(
            provider=self.name,
            host=host,
            owner=owner,
            name=name,
            clone_url=repo.get("clone_url") or f"https://{host}/{owner}/{name}.git",
            default_branch=repo.get("default_branch", "main"),
            base_sha=base.get("sha", ""),
            head_sha=head.get("sha", ""),
            head_branch=head.get("ref", ""),
            pr_number=(pr or {}).get("number", pr_number),
        )

    # ── auth ─────────────────────────────────────────────────────────────

    async def mint_clone_token(self, repo_full_name: str) -> str:
        """Return a short-lived credential for cloning `repo_full_name`.

        Prefer a GitHub App installation token scoped to the repo's installation;
        fall back to the static PAT when no App is configured. The token is handed
        to the sandbox credential helper on demand and never persisted.
        """
        s = self._settings
        if s.github_app_id and s.github_app_private_key:
            return await self._installation_token(repo_full_name)
        if s.github_token:
            return s.github_token
        raise ValueError(
            "no GitHub credentials configured: set GITHUB_APP_ID + "
            "GITHUB_APP_PRIVATE_KEY (App) or GITHUB_TOKEN (PAT)"
        )

    async def _installation_token(self, repo_full_name: str) -> str:
        """Mint (or reuse a cached) installation access token for the repo."""
        now = time.time()
        cached = self._token_cache.get(repo_full_name)
        if cached and cached[1] - _TOKEN_TTL_SLACK_SECONDS > now:
            return cached[0]
        # Serialize minting so concurrent calls for the same repo don't each
        # spend an App-JWT round-trip.
        async with self._token_lock:
            cached = self._token_cache.get(repo_full_name)
            if cached and cached[1] - _TOKEN_TTL_SLACK_SECONDS > time.time():
                return cached[0]
            token, expires_at = await self._mint_installation_token(repo_full_name)
            self._token_cache[repo_full_name] = (token, expires_at)
            return token

    async def _mint_installation_token(
        self, repo_full_name: str
    ) -> tuple[str, float]:
        """Resolve the repo's installation and mint a repo-scoped access token."""
        app_jwt = self._app_jwt()
        owner, _, repo = repo_full_name.partition("/")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            # 1) Resolve the installation that owns this repo.
            inst = await client.get(
                f"{_API_BASE}/repos/{owner}/{repo}/installation",
                headers=self._jwt_headers(app_jwt),
            )
            if inst.status_code == 404:
                raise ValueError(
                    f"GitHub App is not installed on {repo_full_name} "
                    "(GET installation returned 404)"
                )
            inst.raise_for_status()
            installation_id = inst.json()["id"]
            # 2) Mint a token scoped to just this repo (least privilege).
            resp = await client.post(
                f"{_API_BASE}/app/installations/{installation_id}/access_tokens",
                headers=self._jwt_headers(app_jwt),
                json={"repositories": [repo]},
            )
            resp.raise_for_status()
            data = resp.json()
        token = data["token"]
        expires_at = self._parse_expiry(data.get("expires_at"))
        log.info(
            "minted installation token repo=%s installation=%s",
            repo_full_name,
            installation_id,
        )
        return token, expires_at

    @staticmethod
    def _parse_expiry(expires_at: str | None) -> float:
        """Parse GitHub's ISO-8601 `expires_at`; default ~1h out on failure."""
        if not expires_at:
            return time.time() + 3600
        try:
            from datetime import datetime

            return datetime.fromisoformat(
                expires_at.replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            return time.time() + 3600

    def _app_jwt(self) -> str:
        """Sign a ~10-minute JWT for App authentication (RS256 with the App key)."""
        now = int(time.time())
        payload = {
            "iat": now - 60,  # clock-skew tolerance
            "exp": now + 540,  # < 10 min; GitHub rejects exp > 10 min out
            "iss": self._settings.github_app_id,
        }
        try:
            return jwt.encode(payload, self._private_key_pem(), algorithm="RS256")
        except Exception as exc:  # bad/empty PEM, wrong key type, etc.
            raise ValueError(f"failed to sign GitHub App JWT: {exc}") from exc

    def _private_key_pem(self) -> str:
        """Return the App private key as a real multi-line PEM.

        `.env` files commonly store the PEM on one line with literal ``\\n``
        escapes (or wrapped in quotes); `cryptography` then can't parse it and
        JWT signing fails. Restore newlines and strip stray quotes so the key
        loads whether provided as a true multi-line value or an escaped one-liner.
        """
        key = (self._settings.github_app_private_key or "").strip().strip('"').strip("'")
        if "\\n" in key and "-----BEGIN" in key:
            key = key.replace("\\n", "\n")
        return key

    def _jwt_headers(self, app_jwt: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {app_jwt}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": _API_VERSION,
        }

    async def _api_headers(self, repo: RepoRef) -> dict[str, str]:
        token = await self.mint_clone_token(repo.full_name)
        return {
            "Authorization": f"Bearer {token}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": _API_VERSION,
        }

    def _client(self, headers: dict[str, str]) -> httpx.AsyncClient:
        """A shared-config async client (base_url + auth headers + timeouts)."""
        return httpx.AsyncClient(
            base_url=_API_BASE, headers=headers, timeout=_TIMEOUT
        )

    async def list_installed_repos(self, limit: int = 200) -> list[str]:
        """Best-effort list of repos the agent can access, for the dashboard's
        repo selector. Uses the App's installations (every repo the App is
        installed on) or, with only a PAT, the token's own repos. Returns an
        empty list rather than raising if creds are missing or the call fails —
        the selector also allows a custom `owner/name`.
        """
        s = self._settings
        accept = {"Accept": _ACCEPT, "X-GitHub-Api-Version": _API_VERSION}
        repos: set[str] = set()
        if s.github_app_id and s.github_app_private_key:
            app_jwt = self._app_jwt()
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                insts = await client.get(
                    f"{_API_BASE}/app/installations",
                    headers=self._jwt_headers(app_jwt),
                    params={"per_page": 100},
                )
                insts.raise_for_status()
                for inst in insts.json():
                    tok = await client.post(
                        f"{_API_BASE}/app/installations/{inst['id']}/access_tokens",
                        headers=self._jwt_headers(app_jwt),
                    )
                    if tok.status_code >= 300:
                        continue
                    itoken = tok.json()["token"]
                    r = await client.get(
                        f"{_API_BASE}/installation/repositories",
                        headers={"Authorization": f"Bearer {itoken}", **accept},
                        params={"per_page": 100},
                    )
                    if r.status_code >= 300:
                        continue
                    repos.update(x["full_name"] for x in r.json().get("repositories", []))
        elif s.github_token:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.get(
                    f"{_API_BASE}/user/repos",
                    headers={"Authorization": f"Bearer {s.github_token}", **accept},
                    params={"per_page": 100, "sort": "updated"},
                )
                r.raise_for_status()
                repos.update(x["full_name"] for x in r.json())
        return sorted(repos)[:limit]

    async def get_default_branch(self, repo_full_name: str) -> str | None:
        """Return the repo's real default branch (`main`, `master`, …), or None.

        Best-effort: a manual chat session has no PR payload to read the branch
        from, so we resolve it here instead of assuming `main`. Returns None on
        any failure so callers can fall back to a priority guess.
        """
        owner, _, name = repo_full_name.partition("/")
        if not owner or not name:
            return None
        try:
            token = await self.mint_clone_token(repo_full_name)
        except ValueError:
            return None
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": _API_VERSION,
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.get(f"{_API_BASE}/repos/{owner}/{name}", headers=headers)
                r.raise_for_status()
                return r.json().get("default_branch") or None
        except httpx.HTTPError as exc:
            log.warning("get_default_branch failed repo=%s: %s", repo_full_name, exc)
            return None

    async def list_branches(self, repo_full_name: str, limit: int = 300) -> list[str]:
        """List branch names for the repo's branch selector (paginated).

        Best-effort — returns an empty list rather than raising if creds are
        missing or the call fails; the selector still allows the resolved default.
        """
        owner, _, name = repo_full_name.partition("/")
        if not owner or not name:
            return []
        try:
            token = await self.mint_clone_token(repo_full_name)
        except ValueError:
            return []
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": _API_VERSION,
        }
        branches: list[str] = []
        page = 1
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                while len(branches) < limit:
                    r = await client.get(
                        f"{_API_BASE}/repos/{owner}/{name}/branches",
                        headers=headers,
                        params={"per_page": 100, "page": page},
                    )
                    r.raise_for_status()
                    batch = r.json()
                    if not batch:
                        break
                    branches.extend(b["name"] for b in batch)
                    if len(batch) < 100:
                        break
                    page += 1
        except httpx.HTTPError as exc:
            log.warning("list_branches failed repo=%s: %s", repo_full_name, exc)
        return branches[:limit]

    # ── reads ────────────────────────────────────────────────────────────

    async def get_pull_request(self, repo: RepoRef, pr_number: int) -> PullRequest:
        """Fetch PR metadata + its full (paginated) changed-file diff.

        The returned PullRequest's `.repo` has base/head sha+ref filled from the
        PR itself, so a comment-triggered run (whose webhook lacked SHAs) gets
        enriched here and can anchor an inline review.
        """
        headers = await self._api_headers(repo)
        pr_path = f"/repos/{repo.owner}/{repo.name}/pulls/{pr_number}"
        async with self._client(headers) as client:
            meta_resp = await client.get(pr_path)
            meta_resp.raise_for_status()
            meta = meta_resp.json()
            files = await self._fetch_files(client, pr_path)

        enriched = self._enrich_repo(repo, meta, pr_number)
        log.info(
            "fetched PR %s#%s files=%d head=%s",
            repo.full_name,
            pr_number,
            len(files),
            (enriched.head_sha or "")[:7],
        )
        return PullRequest(
            repo=enriched,
            title=meta.get("title", ""),
            body=meta.get("body") or "",
            author=(meta.get("user") or {}).get("login", ""),
            files=files,
        )

    @staticmethod
    def _enrich_repo(
        repo: RepoRef, meta: dict[str, Any], pr_number: int
    ) -> RepoRef:
        """Copy `repo` with base/head sha+ref + pr_number filled from PR metadata."""
        head = meta.get("head") or {}
        base = meta.get("base") or {}
        return RepoRef(
            provider=repo.provider,
            host=repo.host,
            owner=repo.owner,
            name=repo.name,
            clone_url=repo.clone_url,
            default_branch=repo.default_branch,
            base_sha=base.get("sha") or repo.base_sha,
            head_sha=head.get("sha") or repo.head_sha,
            head_branch=head.get("ref") or repo.head_branch,
            pr_number=pr_number,
        )

    async def _fetch_files(
        self, client: httpx.AsyncClient, pr_path: str
    ) -> list[DiffFile]:
        """Page through the PR's changed files (GitHub caps at 100/page, 3000 total)."""
        files: list[DiffFile] = []
        page = 1
        while True:
            resp = await client.get(
                f"{pr_path}/files", params={"per_page": 100, "page": page}
            )
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            for f in batch:
                files.append(
                    DiffFile(
                        path=f["filename"],
                        # GitHub only sends previous_filename for renames/copies.
                        old_path=f.get("previous_filename"),
                        status=_status_from_github_file(f),
                        # `patch` is absent for binary files and files whose diff
                        # is too large to inline — keep it None, not "".
                        patch=f.get("patch"),
                    )
                )
            if len(batch) < 100:
                break
            page += 1
        return files

    # NOTE: There is no publish path. The controller mints a scoped SCM token
    # and bakes it into the sandbox env (see core/orchestrator/runner.py); the
    # agent posts its own PR comments / pushes via `gh` or the REST API. This
    # provider stays read-only + auth (webhooks, PR fetch, token minting).

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _header(headers: dict[str, str], key: str) -> str | None:
        """Case-insensitive header lookup (ASGI/WSGI casing varies)."""
        lowered = key.lower()
        for k, v in headers.items():
            if k.lower() == lowered:
                return v
        return None
