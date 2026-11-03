"""Commit-status reporting for incoming-PR reviews.

GitHub check runs (what mira posts) are GitHub-App-only; RoboMP holds a PAT,
so reviews report through the commit-statuses API under one fixed context.
Every call is best-effort: a status failure must never fail a review.

The phase ladder, its rank guard, and the per-key POST locks live on a
`StatusTracker` instance owned by the app (created by `WorkerPool`, shared
with the webhook handler). Process-wide module state would leak across app
instances and event loops; the module-level `publish_pr_status` keeps the
existing call shape and falls back to a shared default tracker when none is
injected.
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
# `reviewing` already written by the worker. `retrying` follows every nonterminal
# phase (a transient error can strike while any of them is in flight) and repeats
# freely across the retry loop, but is itself transient: it does not advance the
# stored rank, so the ladder resumes where it left off. Terminal phases are final
# until a `reset` reopens the ladder.
_PHASE_RANK: dict[str, int] = {
    "queued": 0,
    "preparing": 1,
    "reviewing": 2,
    "publishing": 3,
    "retrying": 4,
    "success": 4,
    "failure": 4,
    "error": 4,
}
_TERMINAL_PHASES = frozenset({"success", "failure", "error"})

_MAX_TRACKED = 512


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


class StatusTracker:
    """Per-app coordinator for the (repo, sha) phase ladder.

    Owns three pieces of state, all guarded by one lock held briefly for dict
    access (never while a POST is in flight):

    - `_last_rank`: `(rank, terminal)` per key — the highest rank posted and
      whether the post that set it was terminal (monotonic guard). Terminal
      posts are final until a `reset`; `retrying` shares their rank without
      being one of them, so it must not latch the terminal flag.
    - `_locks` / `_inflight`: one lock per key serializing the actual HTTP
      POSTs so a slow in-flight `publishing` can never land on GitHub AFTER
      the terminal post (arrival order decides the combined status). A lock is
      only ever evicted when `_inflight[key] == 0`; an in-flight key stays
      reachable until its post completes. Rank entries for in-flight keys are
      preserved across eviction, so rank monotonicity survives the cap.
    - `_active`: per-key REFERENCE COUNT of reviews currently running (worker
      called `begin_review`). The queue admits concurrent reviews for distinct
      issue keys, and two PRs in the same repo can point at the same head SHA,
      so a plain set would let the first review's `end_review` un-mark a key
      whose second review is still in flight — after which a webhook reset
      would clear the ladder under it. The key reads as "active" while the
      count is > 0, and only the count's zero-crossing clears the mark.
    - `_reset_pending`: keys whose ladder a `reset=None` publish wanted to
      clear while a review was active. The reset is deferred, not dropped:
      the follow-on's own `begin_review` (which brackets its attempts)
      consumes the flag and clears the ladder BEFORE its first phase post, so
      a follow-on starting after a terminal state is not rank-stuck. The flag
      is also consumed when the count reaches zero (a queued delivery that
      arrived between two concurrent reviews on the same SHA).
    """

    def __init__(self, *, max_tracked: int = _MAX_TRACKED) -> None:
        self._max = max_tracked
        self._guard = asyncio.Lock()
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._inflight: dict[tuple[str, str], int] = {}
        self._last_rank: dict[tuple[str, str], tuple[int, bool]] = {}
        self._active: dict[tuple[str, str], int] = {}
        self._reset_pending: set[tuple[str, str]] = set()

    def begin_review(self, repo: str, sha: str) -> None:
        """Mark the key as under active review (webhook resets stay off).

        Consumes a deferred `reset=None` first: a follow-on delivery for the
        same SHA queued while a prior review was active reopens the ladder
        here, before this attempt's first phase post, so its nonterminal
        phases are not rank-skipped against the prior terminal state.
        """
        if not sha:
            return
        key = (repo, sha)
        self._active[key] = self._active.get(key, 0) + 1
        self._consume_reset_pending(key)

    def end_review(self, repo: str, sha: str) -> None:
        """Release one review's claim on the key; clear the active mark only
        when no review is left, then consume any deferred reset the key had."""
        if not sha:
            return
        key = (repo, sha)
        remaining = self._active.get(key, 0) - 1
        if remaining > 0:
            self._active[key] = remaining
        else:
            self._active.pop(key, None)
            self._consume_reset_pending(key)

    def _consume_reset_pending(self, key: tuple[str, str]) -> None:
        if key in self._reset_pending:
            self._reset_pending.discard(key)
            self._last_rank.pop(key, None)

    async def _acquire_key_lock(self, key: tuple[str, str]) -> asyncio.Lock:
        async with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                self._evict_idle_locked(key)
                lock = self._locks[key] = asyncio.Lock()
            self._inflight[key] = self._inflight.get(key, 0) + 1
            return lock

    def _evict_idle_locked(self, incoming: tuple[str, str]) -> None:
        """Evict idle (repo, sha) entries until under the cap.

        A key is evictable only when it has NO in-flight POST (`_inflight`
        0) and is not the incoming key — an in-flight `publishing` keeps its
        lock reachable so it can never be discarded mid-POST. Evicting drops
        only that one key's lock AND rank entry; every remaining key keeps
        its rank, so rank monotonicity survives the cap (a stale `queued`
        can never leapfrog a `success` the tracker still remembers).
        """
        while len(self._locks) >= self._max:
            candidates = [k for k in self._locks if k != incoming and self._inflight.get(k, 0) == 0]
            if not candidates:
                return  # every remaining key is live; grow past the cap
            # Lowest rank = least progressed = first to fall out of the window.
            victim = min(candidates, key=lambda k: self._last_rank.get(k, (0, False))[0])
            self._locks.pop(victim, None)
            self._last_rank.pop(victim, None)

    async def publish(
        self,
        github: Any,
        *,
        settings: Any,
        repo: str,
        sha: str,
        phase: str,
        detail: str = "",
        reset: bool | None = False,
    ) -> None:
        """Publish one commit status for `phase`. Never raises.

        `reset=True` clears the monotonic guard for this (repo, sha);
        `reset=None` resets only when no review is currently active for the
        key (webhook path); while one IS active, the reset is deferred to
        that key's next `begin_review` (the follow-on's own bracket), so the
        follow-on's ladder starts clean without touching the in-flight
        review's; `reset=False` never clears it.
        """
        if not settings.pr_review_status_enabled or not sha:
            return
        state, description = PHASE_STATUS[phase]
        if detail:
            description = f"{description} — {detail}"
        key = (repo, sha)
        lock = await self._acquire_key_lock(key)
        # Hold the per-key lock across the POST: rank decisions and the
        # requests they authorize then reach GitHub in ladder order, even
        # when an earlier phase was scheduled fire-and-forget from the
        # worker's RPC thread.
        try:
            async with lock:
                if reset is True:
                    self._last_rank.pop(key, None)
                elif reset is None:
                    if self._active.get(key, 0) == 0:
                        self._last_rank.pop(key, None)
                    else:
                        # A review holds the key: defer the reset to that
                        # key's next `begin_review` (see class docstring).
                        self._reset_pending.add(key)
                rank = _PHASE_RANK[phase]
                previous = self._last_rank.get(key)
                if previous is not None and previous[1] and phase not in _TERMINAL_PHASES:
                    # A terminal state is final: only `reset` reopens the ladder.
                    log.info(
                        "pr_status skipped (post-terminal phase)",
                        extra={"repo": repo, "sha": sha, "phase": phase, "previous_rank": previous[0]},
                    )
                    return
                if previous is not None and phase != "retrying" and rank < previous[0]:
                    log.info(
                        "pr_status skipped (stale phase)",
                        extra={"repo": repo, "sha": sha, "phase": phase, "previous_rank": previous[0]},
                    )
                    return
                try:
                    await github.create_commit_status(
                        repo,
                        sha,
                        state=state,
                        context=PR_STATUS_CONTEXT,
                        description=description,
                    )
                except GitHubError as exc:
                    # A post that never reached GitHub must NOT advance the
                    # ladder: the same phase re-posted later (after a transient
                    # 403/network blip) has to land again.
                    log.warning(
                        "pr_status publish failed",
                        extra={
                            "repo": repo,
                            "sha": sha,
                            "phase": phase,
                            "status": exc.status,
                            "err": exc.message,
                        },
                    )
                except Exception:
                    log.exception("pr_status publish raised", extra={"repo": repo, "sha": sha, "phase": phase})
                else:
                    # `retrying` is transient — store the rank the ladder was
                    # at BEFORE the failure, so the next attempt resumes there
                    # and a later `publishing` is not misread as stale.
                    if phase == "retrying":
                        self._last_rank[key] = (previous[0] if previous is not None else 0, False)
                    else:
                        self._last_rank[key] = (rank, phase in _TERMINAL_PHASES)
        finally:
            async with self._guard:
                remaining = self._inflight.get(key, 0) - 1
                if remaining > 0:
                    self._inflight[key] = remaining
                else:
                    self._inflight.pop(key, None)


# Default tracker for callers that do not inject one (CLI paths, unit tests
# that call the module-level helper directly). One per process, which matches
# the single-app layout those callers run in.
_shared_tracker = StatusTracker()
"""Process-wide fallback tracker; apps always inject their own via
`WorkerPool.status_tracker` / `app.state.bag["status_tracker"]`."""


async def publish_pr_status(
    github: Any,
    *,
    settings: Any,
    repo: str,
    sha: str,
    phase: str,
    detail: str = "",
    reset: bool | None = False,
    tracker: StatusTracker | None = None,
) -> None:
    """Publish one commit status for `phase`. Never raises.

    `reset`/`tracker` semantics live on `StatusTracker.publish`.
    """
    await (tracker or _shared_tracker).publish(
        github,
        settings=settings,
        repo=repo,
        sha=sha,
        phase=phase,
        detail=detail,
        reset=reset,
    )


__all__ = [
    "PHASE_STATUS",
    "PR_STATUS_CONTEXT",
    "StatusTracker",
    "head_sha_from_payload",
    "phase_for_failed_attempt",
    "publish_pr_status",
]
