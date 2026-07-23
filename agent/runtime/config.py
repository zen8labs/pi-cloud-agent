"""Environment-backed inputs for one sandbox run."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .constants import WORKSPACE_DIR


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    run_id: str
    session_id: str
    control_plane_url: str
    sandbox_token: str
    profile: str
    task_prompt: str
    repo_name: str
    repo_clone_url: str
    repo_base_sha: str
    repo_head_sha: str
    repo_head_branch: str
    repo_default_branch: str

    @classmethod
    def from_env(cls) -> RuntimeConfig:
        value = os.environ.get
        return cls(
            run_id=value("RUN_ID", ""),
            session_id=value("SESSION_ID", ""),
            control_plane_url=value("CONTROL_PLANE_URL", ""),
            sandbox_token=value("SANDBOX_AUTH_TOKEN", ""),
            profile=value("PROFILE", "general_agent"),
            task_prompt=value("TASK_PROMPT", "Complete the requested task."),
            repo_name=value("REPO_NAME", ""),
            repo_clone_url=value("REPO_CLONE_URL", ""),
            repo_base_sha=value("REPO_BASE_SHA", ""),
            repo_head_sha=value("REPO_HEAD_SHA", ""),
            repo_head_branch=value("REPO_HEAD_BRANCH", ""),
            repo_default_branch=value("REPO_DEFAULT_BRANCH", "main"),
        )

    @property
    def repo_path(self):
        return WORKSPACE_DIR / (self.repo_name or "repo")
