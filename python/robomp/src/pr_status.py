"""Commit-status reporting for incoming-PR reviews.

GitHub check runs (what mira posts) are GitHub-App-only; RoboMP holds a PAT,
so reviews report through the commit-statuses API under one fixed context.
Every call is best-effort: a status failure must never fail a review.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

from robomp.github_client import GitHubError

log = logging.getLogger(__name__)

PR_STATUS_CONTEXT = "robomp/pr-review"
"""Fixed context label. GitHub's combined status for a SHA tracks the most
recent status record per context, so re-posting under one context reads as a
single check that advances."""

# phase -> (state, description). All descriptions are far under the 140-char cap.
PHASE_STATUS: dict[str, tuple[str, str]] = {
    "queued": ("pending", "Queued — waiting for RoboMP to pick up the review"),
    "preparing": ("pending", "Preparing an isolated workspace at the PR head"),
    "reviewing": ("pending", "Reviewing the changed code"),
    "publishing": ("pending", "Publishing review findings"),
    "retrying": ("pending", "Interrupted by a transient error — will retry"),
    "success": ("success", "Review complete — findings posted to the PR"),
    "failure": ("failure", "Review finished without submitting findings"),
    "error": ("error", "Review stopped on an unexpected error"),
}

# Monotonic guard: a phase may only move forward for a given (repo, sha), so a
# late-arriving `queued` (posted from the webhook handler) can never overwrite a
# `reviewing` already written by the worker. Ranks: `retrying` shares
# `reviewing`'s rank — both are "in progress", and neither may leapfrog the other.
_PHASE_RANK: dict[str, int] = {
    "queued": 0,
    "preparing": 1,
    "reviewing": 2,
    "retrying": 2,
    "publishing": 3,
    "success": 4,
    "failure": 4,
    "error": 4,
}

_MAX_TRACKED = 512
_last_rank: dict[tuple[str, str], int] = {}
# `_guard` protects the two dicts; the per-key lock serializes the actual HTTP
# POSTs so a slow in-flight `publishing` can never land on GitHub AFTER the
# terminal post (GitHub's combined status keeps the most recent record per
# context, and arrival order decides "most recent"). `_guard` is only ever
# held briefly for dict access, never while a per-key lock is held.
_guard = asyncio.Lock()
_locks: dict[tuple[str, str], asyncio.Lock] = {}


def head_sha_from_payload(payload: Mapping[str, Any]) -> str:
    """Extract `pull_request.head.sha` from a GitHub webhook payload ("" if absent)."""
    pr_node = payload.get("pull_request")
    if not isinstance(pr_node, Mapping):
        return ""
    head = pr_node.get("head")
    if not isinstance(head, Mapping):
        return ""
    return str(head.get("sha") or "")


def phase_for_failed_attempt(attempts: int, max_retries: int) -> str:
    """Phase to publish when an attempt raised.

    Mirrors `queue._run_event`'s retry predicate exactly: the dispatcher
    re-queues when `0 < attempts <= max_retries`. A failure the queue will
    retry must NOT be shown as a terminal `error`.
    """
    return "retrying" if 0 < attempts <= max_retries else "error"


async def publish_pr_status(
    github: Any,
    *,
    settings: Any,
    repo: str,
    sha: str,
    phase: str,
    detail: str = "",
    reset: bool = False,
) -> None:
    """Publish one commit status for `phase`. Never raises.

    `reset=True` clears the monotonic guard for this (repo, sha) so a new
    delivery or a retry attempt restarts the ladder from the bottom.
    """
    if not settings.pr_review_status_enabled or not sha:
        return
    state, description = PHASE_STATUS[phase]
    if detail:
        description = f"{description} — {detail}"
    key = (repo, sha)
    async with _guard:
        lock = _locks.get(key)
        if lock is None:
            if len(_locks) >= _MAX_TRACKED:
                _locks.clear()
            lock = _locks[key] = asyncio.Lock()
    # Hold the per-key lock across the POST: rank decisions and the requests
    # they authorize then reach GitHub in ladder order, even when an earlier
    # phase was scheduled fire-and-forget from the worker's RPC thread.
    async with lock:
        if reset:
            _last_rank.pop(key, None)
        rank = _PHASE_RANK[phase]
        previous = _last_rank.get(key)
        if previous is not None and rank < previous:
            log.info(
                "pr_status skipped (stale phase)",
                extra={"repo": repo, "sha": sha, "phase": phase, "previous_rank": previous},
            )
            return
        if len(_last_rank) >= _MAX_TRACKED:
            _last_rank.clear()
        _last_rank[key] = rank
        try:
            await github.create_commit_status(
                repo,
                sha,
                state=state,
                context=PR_STATUS_CONTEXT,
                description=description,
            )
        except GitHubError as exc:
            log.warning(
                "pr_status publish failed",
                extra={"repo": repo, "sha": sha, "phase": phase, "status": exc.status, "err": exc.message},
            )
        except Exception:
            log.exception("pr_status publish raised", extra={"repo": repo, "sha": sha, "phase": phase})


__all__ = [
    "PHASE_STATUS",
    "PR_STATUS_CONTEXT",
    "head_sha_from_payload",
    "phase_for_failed_attempt",
    "publish_pr_status",
]
