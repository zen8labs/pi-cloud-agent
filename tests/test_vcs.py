"""VCS provider webhook tests for GitLab and Bitbucket (no network)."""

from __future__ import annotations

import hashlib
import hmac
import json
import os

import pytest

os.environ.setdefault("GITLAB_WEBHOOK_SECRET", "gitlab-secret")
os.environ.setdefault("BITBUCKET_WEBHOOK_SECRET", "bb-secret")


def test_gitlab_merge_request_open_parses():
    from core.vcs import get_vcs_provider
    from core.vcs.types import WebhookKind

    payload = {
        "object_kind": "merge_request",
        "object_attributes": {
            "action": "open",
            "iid": 9,
            "source_branch": "feat",
            "base_commit_sha": "base",
            "last_commit": {"id": "head"},
        },
        "project": {
            "path_with_namespace": "group/repo",
            "web_url": "https://gitlab.com/group/repo",
            "git_http_url": "https://gitlab.com/group/repo.git",
            "default_branch": "main",
        },
    }
    body = json.dumps(payload).encode()
    headers = {"X-Gitlab-Token": "gitlab-secret", "X-Gitlab-Event": "Merge Request Hook"}
    parsed = get_vcs_provider("gitlab").verify_and_parse_webhook(headers, body)
    assert parsed.kind is WebhookKind.pr_opened
    assert parsed.repo is not None
    assert parsed.repo.full_name == "group/repo"
    assert parsed.repo.pr_number == 9


def test_gitlab_bad_token_raises():
    from core.vcs import get_vcs_provider

    body = b'{"object_kind":"merge_request"}'
    headers = {"X-Gitlab-Token": "wrong"}
    with pytest.raises(ValueError, match="invalid GitLab"):
        get_vcs_provider("gitlab").verify_and_parse_webhook(headers, body)


def test_bitbucket_pr_created_parses():
    from core.vcs import get_vcs_provider
    from core.vcs.types import WebhookKind

    payload = {
        "repository": {"full_name": "workspace/repo", "mainbranch": {"name": "main"}},
        "pullrequest": {
            "id": 55,
            "source": {"branch": {"name": "feat"}, "commit": {"hash": "head"}},
            "destination": {"commit": {"hash": "base"}},
        },
    }
    body = json.dumps(payload).encode()
    headers = {"X-Event-Key": "pullrequest:created", "X-Hook-Secret": "bb-secret"}
    parsed = get_vcs_provider("bitbucket").verify_and_parse_webhook(headers, body)
    assert parsed.kind is WebhookKind.pr_opened
    assert parsed.repo is not None
    assert parsed.repo.full_name == "workspace/repo"
    assert parsed.repo.pr_number == 55


def test_bitbucket_hmac_signature_accepted():
    from core.vcs import get_vcs_provider
    from core.vcs.types import WebhookKind

    payload = {
        "repository": {"full_name": "w/r", "mainbranch": {"name": "main"}},
        "pullrequest": {
            "id": 1,
            "source": {"branch": {"name": "f"}, "commit": {"hash": "h"}},
            "destination": {"commit": {"hash": "b"}},
        },
    }
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(b"bb-secret", body, hashlib.sha256).hexdigest()
    headers = {"X-Event-Key": "pullrequest:created", "X-Hub-Signature": sig}
    parsed = get_vcs_provider("bitbucket").verify_and_parse_webhook(headers, body)
    assert parsed.kind is WebhookKind.pr_opened
