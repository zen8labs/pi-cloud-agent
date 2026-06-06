"""Small dashboard-support endpoints (config the web client needs).

  * GET /repos                    — repo list for the chat page's repo selector
  * GET /repos/{owner}/{name}/branches — branches + resolved default for a repo
  * GET /config                   — non-secret defaults (model, bundles) shown in the UI
"""

from __future__ import annotations

from fastapi import APIRouter

from core.config import get_settings

router = APIRouter(tags=["meta"])


@router.get("/repos/{owner}/{name}/branches")
async def list_branches(owner: str, name: str, provider: str = "github"):
    """Branches for the chat page's branch selector, plus the resolved default.

    Best-effort: returns whatever the provider can fetch. The `default` is the
    repo's real default branch (so the selector defaults correctly instead of
    assuming `main`); falls back to the first branch when it can't be resolved.
    """
    full_name = f"{owner}/{name}"
    branches: list[str] = []
    default: str | None = None
    try:
        from core.vcs import get_vcs_provider

        vcs = get_vcs_provider(provider)
        if hasattr(vcs, "list_branches"):
            branches = await vcs.list_branches(full_name)
        if hasattr(vcs, "get_default_branch"):
            default = await vcs.get_default_branch(full_name)
    except Exception:  # noqa: BLE001 — selector must still render on failure
        pass
    if not default:
        default = branches[0] if branches else None
    return {"branches": branches, "default": default}


async def configured_repos() -> tuple[list[str], str]:
    """Return (repos, source) the dashboard can target.

    Prefer the explicit `WEB_REPOS` allowlist; if it's empty, fall back to the
    repos the configured GitHub App/PAT can actually access. Best-effort —
    callers still allow a typed `owner/name`. Shared by `/repos` and the
    settings page's per-repo branch list.
    """
    configured = get_settings().web_repo_list()
    if configured:
        return configured, "config"
    try:
        from core.vcs import get_vcs_provider

        vcs = get_vcs_provider("github")
        if hasattr(vcs, "list_installed_repos"):
            return await vcs.list_installed_repos(), "github"
    except Exception:  # noqa: BLE001 — selector must still render on failure
        pass
    return [], "none"


@router.get("/repos")
async def list_repos():
    """Repos offered in the chat page selector."""
    repos, source = await configured_repos()
    return {"repos": repos, "source": source}


@router.get("/config")
async def get_config():
    """Non-secret defaults the dashboard surfaces (model, available bundles)."""
    s = get_settings()
    return {
        "model": s.agent_model,
        "bundles": ["general_agent", "pr_review"],
        "default_bundle": "general_agent",
    }
