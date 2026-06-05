"""Small dashboard-support endpoints (config the web client needs).

  * GET /repos   — the configured repo list for the chat page's repo selector
  * GET /config  — non-secret defaults (model, bundles) shown in the UI
"""

from __future__ import annotations

from fastapi import APIRouter

from core.config import get_settings

router = APIRouter(tags=["meta"])


@router.get("/repos")
async def list_repos():
    """Repos offered in the chat page selector.

    Prefer the explicit `WEB_REPOS` allowlist; if it's empty, fall back to the
    repos the configured GitHub App/PAT can actually access (best-effort — the
    selector still allows typing a custom `owner/name`).
    """
    configured = get_settings().web_repo_list()
    if configured:
        return {"repos": configured, "source": "config"}
    try:
        from core.vcs import get_vcs_provider

        vcs = get_vcs_provider("github")
        if hasattr(vcs, "list_installed_repos"):
            repos = await vcs.list_installed_repos()
            return {"repos": repos, "source": "github"}
    except Exception:  # noqa: BLE001 — selector must still render on failure
        pass
    return {"repos": [], "source": "none"}


@router.get("/config")
async def get_config():
    """Non-secret defaults the dashboard surfaces (model, available bundles)."""
    s = get_settings()
    return {
        "model": s.agent_model,
        "bundles": ["general_agent", "pr_review"],
        "default_bundle": "general_agent",
    }
