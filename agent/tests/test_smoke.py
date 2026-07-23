"""Smoke tests that need neither network nor a database.

They exercise the seams most likely to drift: webhook verification/parsing and
the profile's trigger-to-task mapping.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os

import pytest

os.environ.setdefault("GITHUB_WEBHOOK_SECRET", "testsecret")


def _gh_sig(body: bytes, secret: str = "testsecret") -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_github_webhook_valid_signature_parses_pr():
    from core.vcs import get_vcs_provider
    from core.vcs.types import WebhookKind

    payload = {
        "action": "opened",
        "number": 7,
        "pull_request": {
            "number": 7,
            "title": "t",
            "body": "b",
            "head": {"sha": "headsha", "ref": "feature"},
            "base": {"sha": "basesha", "ref": "main"},
            "user": {"login": "alice"},
        },
        "repository": {
            "name": "repo",
            "owner": {"login": "octo"},
            "html_url": "https://github.com/octo/repo",
            "clone_url": "https://github.com/octo/repo.git",
            "default_branch": "main",
        },
    }
    body = json.dumps(payload).encode()
    headers = {
        "x-github-event": "pull_request",
        "x-hub-signature-256": _gh_sig(body),
        "content-type": "application/json",
    }
    parsed = get_vcs_provider("github").verify_and_parse_webhook(headers, body)
    assert parsed.kind is WebhookKind.pr_opened
    assert parsed.repo is not None
    assert parsed.repo.full_name == "octo/repo"
    assert parsed.repo.pr_number == 7


def test_github_webhook_bad_signature_raises():
    from core.vcs import get_vcs_provider

    body = b'{"action":"opened"}'
    headers = {"x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef"}
    with pytest.raises(ValueError):
        get_vcs_provider("github").verify_and_parse_webhook(headers, body)


def test_pr_review_profile_build_task():
    from core.profiles import get_profile

    trig = dict(
        provider="github",
        host="github.com",
        owner="octo",
        name="repo",
        clone_url="https://github.com/octo/repo.git",
        default_branch="main",
        base_sha="b",
        head_sha="h",
        head_branch="feat",
        pr_number=7,
    )
    task = get_profile("pr_review").build_task(trig)
    assert task.profile == "pr_review"
    assert task.repo.full_name == "octo/repo"
    assert task.repo.head_sha == "h"
