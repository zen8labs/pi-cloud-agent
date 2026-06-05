#!/usr/bin/env python3
"""Git credential helper backed by the CoReview controller.

Implements git's ``credential`` protocol (see gitcredentials(7)) so every git
operation inside the sandbox — clone, fetch, push, ls-remote, submodule update
— mints a fresh short-lived SCM credential on demand instead of relying on a
token captured at sandbox-creation time. No long-lived token is ever stored.

Ported from the reference ``sandbox_runtime.credentials.git_credential_helper``
with the transport retargeted from the Open-Inspect control plane to our
FastAPI controller endpoint::

    POST {CONTROL_PLANE_URL}/internal/runs/{RUN_ID}/git-credentials
        Authorization: Bearer {SANDBOX_AUTH_TOKEN}
        body: {"protocol": ..., "host": ..., "path": ...}
        -> {"username": ..., "password": ...}

Protocol summary (action = "get"):

    Input on stdin:  key=value lines terminated by an empty line.
    Output on stdout: request context lines plus username=… and password=…

Caching: a successful response is persisted to ``/tmp/coreview/scm-creds.json``
(mode 0600). Because the controller does not return an expiry, the cache is
trusted for a short local TTL (``SCM_CRED_LOCAL_TTL_SECONDS``) — long enough to
keep the many helper invocations of a single git op coherent, short enough not
to outlive the controller-side mint. Concurrent invocations are serialised with
an advisory ``flock`` so two git commands racing on first boot don't both call
the controller.

The cache is never used as a fallback for a failed refresh: if the controller
rejects us, we exit non-zero. A stale token silently authenticating is worse
than a visible failure.

Run directly as ``python -m runtime.git_credential_helper`` (git invokes it via
the configured ``credential.helper``).
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sys
import time
from pathlib import Path
from typing import IO, cast

import httpx

# Importable both as ``runtime.git_credential_helper`` (package) and, defensively,
# when run as a loose module — fall back to literals matching constants.py.
try:
    from .constants import (
        SCM_CRED_CACHE_DIR,
        SCM_CRED_CACHE_FILE,
        SCM_CRED_LOCAL_TTL_SECONDS,
        SCM_CRED_LOCK_FILE,
    )
except ImportError:  # pragma: no cover - fallback for non-package execution
    SCM_CRED_CACHE_DIR = Path("/tmp/coreview")
    SCM_CRED_CACHE_FILE = SCM_CRED_CACHE_DIR / "scm-creds.json"
    SCM_CRED_LOCK_FILE = SCM_CRED_CACHE_DIR / "scm-creds.lock"
    SCM_CRED_LOCAL_TTL_SECONDS = 5 * 60

# Allow tests/overrides to relocate the cache without touching code.
CACHE_DIR = Path(os.environ.get("COREVIEW_SCM_CRED_CACHE_DIR", str(SCM_CRED_CACHE_DIR)))
CACHE_FILE = CACHE_DIR / SCM_CRED_CACHE_FILE.name
LOCK_FILE = CACHE_DIR / SCM_CRED_LOCK_FILE.name

REQUEST_TIMEOUT_SECONDS = 15


def _log(message: str) -> None:
    """Emit a diagnostic line to stderr.

    Stdout is reserved for the git credential protocol — anything written there
    that isn't ``key=value`` confuses git.
    """
    sys.stderr.write(f"[coreview-git-credentials] {message}\n")


def _read_protocol_input(stream: IO[str]) -> dict[str, str]:
    """Read git's credential protocol input until a blank line."""
    parsed: dict[str, str] = {}
    for raw in stream:
        line = raw.rstrip("\n")
        if line == "":
            break
        key, sep, value = line.partition("=")
        if sep:
            parsed[key] = value
    return parsed


def _resolve_endpoint() -> tuple[str, str, str] | None:
    """Resolve (control_plane_url, run_id, auth_token) from env.

    Returns ``None`` if any of the three is missing — the helper then refuses
    rather than guessing, since serving the wrong/absent credential is worse
    than a clean failure.
    """
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "").rstrip("/")
    run_id = os.environ.get("RUN_ID", "").strip()
    auth_token = os.environ.get("SANDBOX_AUTH_TOKEN", "").strip()
    if not (control_plane_url and run_id and auth_token):
        return None
    return control_plane_url, run_id, auth_token


def _is_authorized_request(input_lines: dict[str, str]) -> tuple[bool, str]:
    """Decide whether to serve credentials for this credential request.

    A system-wide helper would otherwise hand the SCM token to any host git
    resolves — a malicious submodule URL or ``git ls-remote https://attacker/…``
    could exfiltrate the brokered token. We scope by protocol and host:

    * protocol must be ``https`` (never hand a token to a plaintext remote);
    * host must equal the run's ``REPO_HOST``.

    Returns ``(authorized, reason)`` so the caller can log the rejection.
    """
    protocol = input_lines.get("protocol", "").strip().lower()
    if protocol != "https":
        return False, f"protocol={protocol!r} is not https"

    requested_host = input_lines.get("host", "").strip().lower()
    if not requested_host:
        return False, "no host provided"
    expected_host = os.environ.get("REPO_HOST", "github.com").strip().lower()
    if requested_host != expected_host:
        return False, f"host={requested_host!r} (expected {expected_host!r})"

    return True, ""


def _read_cached() -> dict[str, object] | None:
    """Return the cached credentials if present and still within the local TTL."""
    if not CACHE_FILE.exists():
        return None
    try:
        with CACHE_FILE.open("r", encoding="utf-8") as fp:
            raw_cached = json.load(fp)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw_cached, dict):
        return None
    cached = cast("dict[str, object]", raw_cached)

    cached_at = cached.get("cached_at_epoch_ms")
    if not isinstance(cached_at, (int, float)):
        return None
    age_seconds = time.time() - cached_at / 1000
    if age_seconds >= SCM_CRED_LOCAL_TTL_SECONDS:
        return None

    if not (cached.get("username") and cached.get("password")):
        return None
    return cached


def _atomic_write_cache(payload: dict[str, object]) -> None:
    """Persist credentials to disk with restrictive (0600) permissions."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = CACHE_DIR / ".scm-creds.json.tmp"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(payload).encode("utf-8"))
    finally:
        os.close(fd)
    tmp_path.replace(CACHE_FILE)


def _fetch_from_controller(
    endpoint: tuple[str, str, str], input_lines: dict[str, str]
) -> dict[str, object]:
    """Mint a fresh credential set from the controller.

    Forwards git's protocol fields (protocol/host/path) so the controller can
    scope the minted token, and stamps a local ``cached_at`` since the response
    carries no expiry of its own.
    """
    control_plane_url, run_id, auth_token = endpoint
    url = f"{control_plane_url}/internal/runs/{run_id}/git-credentials"
    body = {
        "protocol": input_lines.get("protocol"),
        "host": input_lines.get("host"),
        "path": input_lines.get("path"),
    }

    with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = client.post(
            url,
            headers={"Authorization": f"Bearer {auth_token}"},
            json=body,
        )

    if response.status_code != 200:
        snippet = response.text[:200]
        raise RuntimeError(f"controller returned {response.status_code}: {snippet}")

    data = response.json()
    if not isinstance(data, dict) or not data.get("username") or not data.get("password"):
        raise RuntimeError("controller response missing username/password")

    return {
        "username": data["username"],
        "password": data["password"],
        "cached_at_epoch_ms": int(time.time() * 1000),
    }


def _get_credentials(input_lines: dict[str, str]) -> dict[str, object]:
    """Return cached credentials if fresh, otherwise refresh under a lock."""
    endpoint = _resolve_endpoint()
    if endpoint is None:
        raise RuntimeError(
            "Missing required environment: CONTROL_PLANE_URL, RUN_ID, SANDBOX_AUTH_TOKEN"
        )

    cached = _read_cached()
    if cached is not None:
        return cached

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w", encoding="utf-8") as lock_fp:
        fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX)
        try:
            # Re-check after acquiring the lock: a concurrent helper may have
            # refreshed already.
            cached = _read_cached()
            if cached is not None:
                return cached

            fresh = _fetch_from_controller(endpoint, input_lines)
            _atomic_write_cache(fresh)
            return fresh
        finally:
            fcntl.flock(lock_fp.fileno(), fcntl.LOCK_UN)


def _emit_response(input_lines: dict[str, str], credentials: dict[str, object]) -> None:
    """Write the protocol response (context lines + fresh username/password)."""
    for key, value in input_lines.items():
        if key in {"username", "password"}:
            continue
        sys.stdout.write(f"{key}={value}\n")
    sys.stdout.write(f"username={credentials['username']}\n")
    sys.stdout.write(f"password={credentials['password']}\n")
    sys.stdout.write("\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    action = args[0] if args else "get"

    # We only mint credentials on ``get``. ``store`` and ``erase`` are no-ops:
    # the controller owns the truth and we don't persist anything git tells us.
    if action != "get":
        # Drain stdin so git doesn't see a SIGPIPE on the next helper.
        with contextlib.suppress(OSError):
            sys.stdin.read()
        return 0

    input_lines = _read_protocol_input(sys.stdin)

    # Scope to https on the configured host. git treats an empty response as
    # "I have nothing", so returning 0 with no output lets it fall through to
    # another helper or fail auth cleanly — without us ever leaking the token
    # to the wrong host.
    authorized, reason = _is_authorized_request(input_lines)
    if not authorized:
        _log(f"refusing to serve credentials: {reason}")
        return 0

    try:
        credentials = _get_credentials(input_lines)
    except Exception as e:  # noqa: BLE001 - never fall back on failure; fail loud.
        _log(f"failed to obtain credentials: {e}")
        return 1

    _emit_response(input_lines, credentials)
    return 0


if __name__ == "__main__":
    sys.exit(main())
