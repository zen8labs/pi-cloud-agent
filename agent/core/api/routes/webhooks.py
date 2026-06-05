"""VCS webhook intake.

Verifies the signature, resolves the legacy/agentic flag, and (for agentic)
enqueues a run. Returns fast — the worker picks the run up.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from core.config.flags import resolve_review_mode
from core.logger import get_logger
from core.state import get_session
from core.state import repo as runs
from core.types import ReviewMode
from core.vcs import get_vcs_provider
from core.vcs.types import WebhookKind

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
log = get_logger("webhooks")

# Which webhook kinds trigger a review.
_TRIGGER_KINDS = {WebhookKind.pr_opened, WebhookKind.pr_updated, WebhookKind.pr_comment}


@router.post("/{provider}")
async def receive_webhook(provider: str, request: Request) -> Response:
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}

    vcs = get_vcs_provider(provider)
    try:
        parsed = vcs.verify_and_parse_webhook(headers, body)
    except Exception as e:  # signature/parse failure → reject, don't 500
        log.warning("webhook rejected", extra={"provider": provider, "error": str(e)})
        raise HTTPException(status_code=401, detail="invalid webhook signature") from e

    if parsed.kind not in _TRIGGER_KINDS or parsed.repo is None:
        return Response(status_code=204)

    # For comment triggers, only act on an explicit review command.
    if parsed.kind is WebhookKind.pr_comment and not _is_review_command(parsed.command):
        return Response(status_code=204)

    # Some providers (e.g. GitHub issue_comment) don't carry head/base SHAs on
    # the webhook. Enrich from the PR API so the sandbox can clone the exact SHA.
    repo = parsed.repo
    if repo.pr_number is not None and (not repo.head_sha or not repo.base_sha):
        try:
            pr = await vcs.get_pull_request(repo, repo.pr_number)
            repo = pr.repo
            parsed.repo = repo
        except Exception:
            log.warning("PR enrichment failed", extra={"repo": repo.full_name})

    async with get_session() as db:
        mode = await resolve_review_mode(db, provider, parsed.repo.full_name)
        if mode is ReviewMode.legacy:
            # Legacy path is handled by the standalone ../pr-agent deployment.
            log.info("routing to legacy", extra={"repo": parsed.repo.full_name})
            return Response(status_code=202, headers={"X-CoReview-Route": "legacy"})

        run = await runs.create_run(
            db,
            bundle="pr_review",
            provider=provider,
            repo_full_name=parsed.repo.full_name,
            pr_number=parsed.repo.pr_number,
            head_sha=parsed.repo.head_sha,
            trigger=_trigger_payload(parsed),
        )
    log.info("run queued", extra={"run_id": run.id, "repo": parsed.repo.full_name})
    return Response(
        status_code=202, headers={"X-CoReview-Route": "agentic", "X-CoReview-Run": run.id}
    )


def _is_review_command(command: str | None) -> bool:
    if not command:
        return False
    c = command.strip().lower()
    return c.startswith("/review") or c.startswith("/coreview")


def _trigger_payload(parsed) -> dict:
    r = parsed.repo
    return {
        "provider": parsed.provider,
        "host": r.host,
        "owner": r.owner,
        "name": r.name,
        "clone_url": r.clone_url,
        "default_branch": r.default_branch,
        "base_sha": r.base_sha,
        "head_sha": r.head_sha,
        "head_branch": r.head_branch,
        "pr_number": r.pr_number,
    }
