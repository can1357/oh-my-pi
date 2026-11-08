"""Unit tests for `robomp.pr_status` — phase mapping, monotonic guard,
per-key serialization, idle-only eviction, best-effort.

Every test gets a fresh `StatusTracker` (the per-app seam); no module state
is mutated, so the suite is order-independent.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from robomp import pr_status
from robomp.github_client import GitHubError


class _RecordingGithub:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def create_commit_status(
        self,
        repo: str,
        sha: str,
        *,
        state: str,
        context: str,
        description: str = "",
        target_url: str | None = None,
    ) -> None:
        self.calls.append(
            {
                "repo": repo,
                "sha": sha,
                "state": state,
                "context": context,
                "description": description,
                "target_url": target_url,
            }
        )


def _settings(enabled: bool = True) -> SimpleNamespace:
    return SimpleNamespace(pr_review_status_enabled=enabled)


@pytest.fixture
def tracker() -> pr_status.StatusTracker:
    return pr_status.StatusTracker()


@pytest.mark.parametrize(
    ("phase", "expected_state"),
    [
        ("queued", "pending"),
        ("preparing", "pending"),
        ("reviewing", "pending"),
        ("publishing", "pending"),
        ("retrying", "pending"),
        ("success", "success"),
        ("failure", "failure"),
        ("error", "error"),
    ],
)
async def test_phase_maps_to_expected_state(phase: str, expected_state: str, tracker) -> None:
    github = _RecordingGithub()
    # Fresh sha per phase so the monotonic guard does not interleave.
    sha = f"sha-{phase}"
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha=sha, phase=phase, tracker=tracker
    )
    assert len(github.calls) == 1
    call = github.calls[0]
    assert call["state"] == expected_state
    assert call["context"] == pr_status.PR_STATUS_CONTEXT
    assert call["context"] == "robomp/pr-review"
    assert call["repo"] == "octo/widget"
    assert call["sha"] == sha


async def test_disabled_settings_posts_nothing(tracker) -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github,
        settings=_settings(enabled=False),
        repo="octo/widget",
        sha="abc",
        phase="queued",
        tracker=tracker,
    )
    assert github.calls == []


async def test_empty_sha_posts_nothing(tracker) -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="", phase="queued", tracker=tracker
    )
    assert github.calls == []


async def test_monotonic_guard_drops_stale_then_reset_reopens(tracker) -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="reviewing", tracker=tracker
    )
    # `queued` (rank 0) is stale after `reviewing` (rank 2) -> dropped.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", tracker=tracker
    )
    assert len(github.calls) == 1
    assert github.calls[0]["state"] == "pending"

    # `reset=True` restarts the ladder so a fresh delivery can land again.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=True, tracker=tracker
    )
    assert len(github.calls) == 2
    assert "Queued" in str(github.calls[1]["description"])


async def test_retrying_follows_every_nonterminal_phase(tracker) -> None:
    """A transient error can strike while ANY phase is in flight, so
    `publishing` -> `retrying` must land (GitHub keeps showing "will retry"
    through the backoff) — while stale phases and terminal overwrites stay
    blocked."""
    github = _RecordingGithub()
    for base in ("queued", "preparing", "reviewing", "publishing"):
        sha = f"after-{base}"
        for phase in (base, "retrying"):
            await pr_status.publish_pr_status(
                github, settings=_settings(), repo="octo/widget", sha=sha, phase=phase, tracker=tracker
            )
        assert [c["description"] for c in github.calls[-2:]] == [
            pr_status.PHASE_STATUS[base][1],
            pr_status.PHASE_STATUS["retrying"][1],
        ], f"retrying dropped after {base}"
        github.calls.clear()

    # Terminal protection: after a terminal state only `reset` reopens.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="term", phase="success", tracker=tracker
    )
    for phase in ("queued", "retrying", "publishing"):
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="term", phase=phase, tracker=tracker
        )
    assert len(github.calls) == 1

    # `reset=True` reopens the ladder even for a lower phase.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="term", phase="queued", reset=True, tracker=tracker
    )
    assert len(github.calls) == 2


async def test_retrying_can_repeat_across_retries(tracker) -> None:
    github = _RecordingGithub()
    for _ in range(3):
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="r", phase="retrying", tracker=tracker
        )
    assert len(github.calls) == 3
    # ...and a later `publishing` (rank 3 < 4) is NOT stale relative to `retrying`.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="r", phase="publishing", tracker=tracker
    )
    assert len(github.calls) == 4


async def test_active_key_suppresses_webhook_reset(tracker) -> None:
    """A distinct webhook delivery (`reset=None`) for a head under active
    review must not restart the ladder: `queued` lands under `reviewing` and
    is dropped. Once the review ends, the same delivery resets and posts."""
    github = _RecordingGithub()
    tracker.begin_review("octo/widget", "s")
    try:
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="reviewing", tracker=tracker
        )
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
        )
        assert len(github.calls) == 1, "webhook queued overwrote the in-flight ladder"

        # `reset=True` is explicit and always applies.
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=True, tracker=tracker
        )
        assert len(github.calls) == 2
    finally:
        tracker.end_review("octo/widget", "s")

    # After end_review, `reset=None` resets again.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
    )
    assert len(github.calls) == 3


async def test_concurrent_reviews_share_active_key_by_refcount(tracker) -> None:
    """Two PRs in the same repo can point at the same head SHA; the queue
    admits both. The first review's `end_review` must NOT un-mark the key
    while the second is still in flight, or a webhook `queued` would reset
    the ladder under the second review."""
    github = _RecordingGithub()
    tracker.begin_review("octo/widget", "s")
    tracker.begin_review("octo/widget", "s")
    try:
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="reviewing", tracker=tracker
        )
        # First review ends; the second still holds the key.
        tracker.end_review("octo/widget", "s")
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
        )
        assert len(github.calls) == 1, (
            "key un-marked while a second review was active — webhook reset cleared the in-flight ladder"
        )
    finally:
        tracker.end_review("octo/widget", "s")

    # Only once the LAST review ends does `reset=None` reset again.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
    )
    assert len(github.calls) == 2


async def test_follow_on_delivery_reopens_terminal_ladder_via_begin_review(tracker) -> None:
    """A distinct delivery for the same SHA that arrives while the first
    review is active posts `queued` with `reset=None`; the reset is deferred
    (the in-flight ladder is not touched). When the first review ends
    terminal and the follow-on starts, its `begin_review` consumes the
    deferred reset, so the follow-on's nonterminal phases land instead of
    being rank-skipped against the prior terminal state."""
    github = _RecordingGithub()
    tracker.begin_review("octo/widget", "s")
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="success", tracker=tracker
    )
    # Follow-on delivery arrives mid-review: `queued` is rank-skipped (terminal
    # final) and its reset is DEFERRED — nothing new lands, ladder untouched.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
    )
    assert len(github.calls) == 1, "deferred reset rewrote the in-flight review's terminal ladder"
    tracker.end_review("octo/widget", "s")
    # The follow-on's own bracket reopens the ladder before its first phase.
    tracker.begin_review("octo/widget", "s")
    try:
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="preparing", tracker=tracker
        )
        await pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="reviewing", tracker=tracker
        )
        assert len(github.calls) == 3, "follow-on's phases rank-skipped against the prior terminal state"
    finally:
        tracker.end_review("octo/widget", "s")

    # Documented post-end semantics: with no review active, `reset=None`
    # resets again — the deferred reset was applied exactly once (at the
    # follow-on's begin_review), not held and re-applied later.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=None, tracker=tracker
    )
    assert len(github.calls) == 4


async def test_posts_serialize_per_key(tracker) -> None:
    class _SlowGithub:
        def __init__(self) -> None:
            self.order: list[str] = []
            self.release = asyncio.Event()

        async def create_commit_status(
            self,
            repo: str,
            sha: str,
            *,
            state: str,
            context: str,
            description: str = "",
            target_url: str | None = None,
        ) -> None:
            label = "publishing" if description.startswith("Publishing") else "success"
            self.order.append(f"{label}:start")
            if label == "publishing":
                await self.release.wait()
            self.order.append(f"{label}:end")

    github = _SlowGithub()
    publishing = asyncio.create_task(
        pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="publishing", tracker=tracker
        )
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if github.order:
            break
    assert github.order == ["publishing:start"]

    # The terminal post must queue behind the in-flight `publishing` request,
    # not overtake it on GitHub (arrival order decides the combined status).
    success = asyncio.create_task(
        pr_status.publish_pr_status(
            github, settings=_settings(), repo="octo/widget", sha="s", phase="success", tracker=tracker
        )
    )
    await asyncio.sleep(0)
    assert not success.done()

    github.release.set()
    await publishing
    await success
    assert github.order == ["publishing:start", "publishing:end", "success:start", "success:end"]


class _RaisingGithub:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc
        self.calls = 0

    async def create_commit_status(self, *args: object, **kwargs: object) -> None:
        self.calls += 1
        raise self._exc


async def test_github_error_is_swallowed(tracker) -> None:
    github = _RaisingGithub(GitHubError(403, "Resource not accessible"))
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="a", phase="queued", tracker=tracker
    )
    assert github.calls == 1


async def test_generic_exception_is_swallowed(tracker) -> None:
    github = _RaisingGithub(RuntimeError("boom"))
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="b", phase="queued", tracker=tracker
    )
    assert github.calls == 1


async def test_failed_post_does_not_latch_the_rank(tracker) -> None:
    """A swallowed GitHub error must not advance the ladder: the next post of
    the SAME phase still goes out (it was never delivered)."""
    github = _RaisingGithub(GitHubError(403, "denied"))
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="n", phase="queued", tracker=tracker
    )
    ok = _RecordingGithub()
    await pr_status.publish_pr_status(
        ok, settings=_settings(), repo="octo/widget", sha="n", phase="queued", tracker=tracker
    )
    assert len(ok.calls) == 1


async def test_eviction_only_drops_idle_locks(tracker) -> None:
    """At the tracked-key cap, locks for keys with an in-flight POST must
    stay reachable: a later phase for that key serializes behind the
    in-flight one, so a slow `publishing` cannot land after `success`."""
    t = pr_status.StatusTracker(max_tracked=4)
    release = asyncio.Event()
    order: list[str] = []

    class _Github:
        async def create_commit_status(
            self,
            repo: str,
            sha: str,
            *,
            state: str,
            context: str,
            description: str = "",
            target_url: str | None = None,
        ) -> None:
            label = f"{sha}:{'publishing' if description.startswith('Publishing') else 'success'}"
            order.append(f"{label}:start")
            if sha == "kept":
                await release.wait()
            order.append(f"{label}:end")

    github = _Github()
    # One in-flight post on `kept`; the cap (4) forces eviction when the
    # next key arrives.
    kept_publishing = asyncio.create_task(
        t.publish(github, settings=_settings(), repo="o/r", sha="kept", phase="publishing")
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if order:
            break
    for i in range(3):
        await t.publish(github, settings=_settings(), repo="o/r", sha=f"filler-{i}", phase="queued")
    # Arriving key triggers the eviction; `kept`'s lock must survive it.
    fresh = asyncio.create_task(t.publish(github, settings=_settings(), repo="o/r", sha="fresh", phase="queued"))
    await asyncio.sleep(0)

    success = asyncio.create_task(t.publish(github, settings=_settings(), repo="o/r", sha="kept", phase="success"))
    for _ in range(50):
        await asyncio.sleep(0)
    assert "kept:publishing:start" in order
    assert "kept:success:start" not in order, "terminal overtook the in-flight post (lock was evicted)"

    release.set()
    await asyncio.gather(kept_publishing, success, fresh)
    publish_end = order.index("kept:publishing:end")
    success_start = order.index("kept:success:start")
    assert publish_end < success_start, "in-flight publishing landed after success on GitHub"


async def test_eviction_preserves_rank_of_kept_keys() -> None:
    """Rank state for keys that survive eviction must keep the guard live:
    an idle key whose RANK is no longer tracked can be evicted, and the guard
    for it goes with the rank — but a key that kept its rank keeps its guard."""
    t = pr_status.StatusTracker(max_tracked=3)
    github = _RecordingGithub()
    # `orphan` posts a status that RAISES: the rank latch never happens, so
    # the key is evictable even though its lock is idle.
    raising = _RaisingGithub(GitHubError(403, "denied"))
    await t.publish(raising, settings=_settings(), repo="o/r", sha="orphan", phase="reviewing")
    for i in range(2):
        await t.publish(github, settings=_settings(), repo="o/r", sha=f"kept-{i}", phase="reviewing")
    # Cap (3) reached; the new key evicts `orphan` (idle + untracked rank).
    await t.publish(github, settings=_settings(), repo="o/r", sha="new", phase="queued")
    # Locks are keyed by the FULL (repo, sha) tuple: assert the evicted tuple
    # is gone AND a kept tuple is present, so the test fails if idle-key
    # eviction is disabled (orphan survives) or if eviction is too eager
    # (kept-0 loses its lock).
    assert ("o/r", "orphan") not in t._locks, "idle untracked key was not evicted"
    assert ("o/r", "kept-0") in t._locks, "idle tracked key was evicted — eviction is not idle-only"
    assert ("o/r", "new") in t._locks, "incoming key's lock is missing"
    # Guard for a kept key must still be live.
    await t.publish(github, settings=_settings(), repo="o/r", sha="kept-0", phase="queued")
    assert len(github.calls) == 3, "stale queued landed — rank state for kept keys was wiped"


async def test_module_default_tracker_is_independent_per_publish() -> None:
    """The module-level fallback tracker (no `tracker=` kwarg) must not
    bleed state across unrelated (repo, sha) keys."""
    github = _RecordingGithub()
    await pr_status.publish_pr_status(github, settings=_settings(), repo="a/b", sha="x", phase="reviewing")
    await pr_status.publish_pr_status(github, settings=_settings(), repo="c/d", sha="y", phase="queued")
    assert len(github.calls) == 2


@pytest.mark.parametrize(
    ("attempts", "max_retries", "expected"),
    [
        (1, 3, "retrying"),
        (3, 3, "retrying"),
        (4, 3, "error"),
        (0, 3, "error"),
    ],
)
def test_phase_for_failed_attempt(attempts: int, max_retries: int, expected: str) -> None:
    assert pr_status.phase_for_failed_attempt(attempts, max_retries) == expected


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"pull_request": {"head": {"sha": "abc"}}}, "abc"),
        ({"pull_request": {"head": {}}}, ""),
        ({"pull_request": {}}, ""),
        ({}, ""),
        ({"pull_request": "not-a-mapping"}, ""),
    ],
)
def test_head_sha_from_payload(payload: dict, expected: str) -> None:
    assert pr_status.head_sha_from_payload(payload) == expected


async def test_detail_appended_to_description(tracker) -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github,
        settings=_settings(),
        repo="octo/widget",
        sha="d",
        phase="retrying",
        detail="OSError",
        tracker=tracker,
    )
    assert github.calls[0]["description"].endswith("— OSError")
