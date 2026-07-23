"""Environment-backed settings.

Model routing follows pr-agent's spirit: a primary LiteLLM model id plus an
ordered list of fallbacks. Provider API keys are read straight from the
environment (LiteLLM picks them up too).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from core.types import ModelSpec, ReviewMode


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # service
    env: str = Field("local", alias="AGENT_ENV")
    host: str = Field("0.0.0.0", alias="AGENT_HOST")
    port: int = Field(8080, alias="AGENT_PORT")
    control_plane_url: str = Field("http://localhost:8080", alias="CONTROL_PLANE_URL")

    # state
    database_url: str = Field(
        "postgresql+asyncpg://coreview:coreview@localhost:5432/coreview_agent",
        alias="DATABASE_URL",
    )

    # sandbox
    e2b_api_key: str = Field("", alias="E2B_API_KEY")
    e2b_template: str = Field("coreview-agent", alias="E2B_TEMPLATE")
    sandbox_timeout_seconds: int = Field(3900, alias="SANDBOX_TIMEOUT_SECONDS")
    sandbox_egress_allowlist: str = Field("", alias="SANDBOX_EGRESS_ALLOWLIST")
    run_wall_clock_seconds: int = Field(3600, alias="RUN_WALL_CLOCK_SECONDS")

    # Pi model — defaults to self-hosted MiniMax over an OpenAI-compatible gateway.
    agent_model: str = Field("aigateway/MiniMax/MiniMax-M2.7", alias="AGENT_MODEL")
    agent_fallback_models: str = Field("", alias="AGENT_FALLBACK_MODELS")
    agent_temperature: float = Field(0.2, alias="AGENT_TEMPERATURE")
    # Internal AI gateway (e.g. self-hosted MiniMax over an OpenAI-compatible API).
    aigateway_base_url: str = Field("", alias="AIGATEWAY_BASE_URL")
    aigateway_api_key: str = Field("", alias="AIGATEWAY_API_KEY")

    # Official OpenAI API — or any OpenAI-compatible service (Cerebras, etc.).
    # Leave OPENAI_BASE_URL empty to hit api.openai.com; set it to redirect to
    # another compatible endpoint (e.g. https://api.cerebras.ai/v1).
    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    openai_base_url: str = Field("", alias="OPENAI_BASE_URL")

    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")

    # rollout
    default_review_mode: ReviewMode = Field(ReviewMode.agentic, alias="DEFAULT_REVIEW_MODE")

    # web dashboard
    # Comma-separated repos ("owner/name") offered in the chat page's repo
    # selector, and the origins allowed to call the API from the browser.
    web_repos: str = Field("", alias="WEB_REPOS")
    web_cors_origins: str = Field("*", alias="WEB_CORS_ORIGINS")

    # VCS — GitHub
    github_app_id: str = Field("", alias="GITHUB_APP_ID")
    github_app_private_key: str = Field("", alias="GITHUB_APP_PRIVATE_KEY")
    github_webhook_secret: str = Field("", alias="GITHUB_WEBHOOK_SECRET")
    github_token: str = Field("", alias="GITHUB_TOKEN")

    # VCS — GitLab
    gitlab_token: str = Field("", alias="GITLAB_TOKEN")
    gitlab_webhook_secret: str = Field("", alias="GITLAB_WEBHOOK_SECRET")
    gitlab_url: str = Field("https://gitlab.com", alias="GITLAB_URL")

    # VCS — Bitbucket
    bitbucket_token: str = Field("", alias="BITBUCKET_TOKEN")
    bitbucket_webhook_secret: str = Field("", alias="BITBUCKET_WEBHOOK_SECRET")

    def model_spec(self) -> ModelSpec:
        fallbacks = [m.strip() for m in self.agent_fallback_models.split(",") if m.strip()]
        return ModelSpec(
            model=self.agent_model, fallbacks=fallbacks, temperature=self.agent_temperature
        )

    def egress_allowlist(self) -> list[str]:
        return [h.strip() for h in self.sandbox_egress_allowlist.split(",") if h.strip()]

    def web_repo_list(self) -> list[str]:
        return [r.strip() for r in self.web_repos.split(",") if r.strip()]

    def web_cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.web_cors_origins.split(",") if o.strip()] or ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
