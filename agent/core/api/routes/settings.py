"""Dashboard settings the web `/settings` page reads and writes.

Currently the per-repo PR-review branch (which branch the PR agent clones for
each connected repo; empty = the repo's real default branch).

  * GET /settings/repo-branches  — every connected repo + its pinned branch ("")
  * PUT /settings/repo-branches  — pin (or clear) one repo's branch
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from core.api.routes.meta import configured_repos
from core.config.global_settings import get_global_setting, set_global_setting
from core.config.repo_settings import get_all_pr_review_branches, set_pr_review_branch
from core.config import get_settings
from core.llm.registry import available_models
from core.state import get_session

router = APIRouter(prefix="/settings", tags=["settings"])


class RepoBranchIn(BaseModel):
    repo: str = Field(..., description="owner/name")
    branch: str = ""  # empty clears the override → repo default
    provider: str = "github"


@router.get("/repo-branches")
async def list_repo_branches():
    """All connected repos with their pinned PR-review branch ("" = default).

    The list is the configured/installed repos plus any repo that already has a
    saved override (so a pin never disappears if the live repo list is briefly
    empty).
    """
    repos, source = await configured_repos()
    async with get_session() as db:
        overrides = await get_all_pr_review_branches(db)
    ordered = list(repos) + [r for r in sorted(overrides) if r not in repos]
    return {
        "source": source,
        "repos": [{"repo": r, "branch": overrides.get(r, "")} for r in ordered],
    }


@router.put("/repo-branches")
async def set_repo_branch(body: RepoBranchIn):
    """Pin (or clear, with an empty branch) one repo's PR-review branch."""
    async with get_session() as db:
        await set_pr_review_branch(db, body.provider, body.repo, body.branch.strip())
    return {"repo": body.repo, "branch": body.branch.strip()}


class DefaultModelIn(BaseModel):
    model: str = Field(..., min_length=1)


@router.get("/default-model")
async def get_default_model():
    """Current default model for headless tasks (PR review).

    Returns the DB-persisted value when set, otherwise the AGENT_MODEL env var.
    Also returns the full list of available models for the settings UI selector.
    """
    s = get_settings()
    async with get_session() as db:
        model = await get_global_setting(db, "default_model")
    if not model:
        model = s.agent_model
    models = available_models()
    return {
        "model": model,
        "available_models": [{"id": m.id, "label": m.label} for m in models],
    }


@router.put("/default-model")
async def set_default_model(body: DefaultModelIn):
    """Persist the default model for headless tasks without a controller restart."""
    async with get_session() as db:
        await set_global_setting(db, "default_model", body.model)
    return {"model": body.model}
