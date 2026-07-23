"""Shape short-lived credentials for one sandbox run."""

from __future__ import annotations

import os

from core.config import get_settings
from core.logger import get_logger
from core.state.models import Run

log = get_logger("orchestrator.secrets")


def llm_provider_env(model_id: str) -> dict[str, str]:
    """Return only the provider credentials required by ``model_id``."""
    settings = get_settings()
    provider = model_id.partition("/")[0]
    env: dict[str, str] = {}

    if provider == "aigateway":
        if settings.aigateway_base_url:
            env["OPENAI_BASE_URL"] = settings.aigateway_base_url
        if settings.aigateway_api_key:
            env["OPENAI_API_KEY"] = settings.aigateway_api_key
    elif provider == "openai":
        if settings.openai_api_key:
            env["OPENAI_API_KEY"] = settings.openai_api_key
        if settings.openai_base_url:
            env["OPENAI_BASE_URL"] = settings.openai_base_url
    else:
        if settings.aigateway_base_url:
            env["OPENAI_BASE_URL"] = settings.aigateway_base_url
        if settings.aigateway_api_key:
            env["OPENAI_API_KEY"] = settings.aigateway_api_key

    if settings.anthropic_api_key:
        env["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
    for name in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"):
        if name not in env and os.environ.get(name):
            env[name] = os.environ[name]
    return env


async def scm_token_env(vcs, run: Run) -> dict[str, str]:
    """Mint one scoped SCM token and expose conventional CLI variable names."""
    try:
        token = await vcs.mint_clone_token(run.repo_full_name)
    except Exception as error:  # noqa: BLE001
        log.warning(
            "scm token mint failed; sandbox will have no git auth",
            extra={"run_id": run.id, "error": str(error)},
        )
        return {}

    env: dict[str, str] = {"SCM_TOKEN": token}
    if run.provider == "github":
        env.update(
            SCM_TOKEN_USERNAME="x-access-token",
            GITHUB_TOKEN=token,
            GH_TOKEN=token,
        )
        host = getattr(run, "repo_host", "") or "github.com"
        if host != "github.com":
            env["GH_HOST"] = host
    elif run.provider == "gitlab":
        env.update(SCM_TOKEN_USERNAME="oauth2", GITLAB_TOKEN=token)
    elif run.provider == "bitbucket":
        env.update(SCM_TOKEN_USERNAME="x-token-auth", BITBUCKET_TOKEN=token)
    else:
        env["SCM_TOKEN_USERNAME"] = "x-access-token"
    return env
