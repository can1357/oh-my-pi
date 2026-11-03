"""Unit tests for `robomp.pr_status` — phase mapping, monotonic guard, best-effort."""

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


@pytest.fixture(autouse=True)
def _reset_guard():
    # `pr_status` keeps a module-level monotonic ladder plus asyncio locks
    # (one guard + one per tracked repo/sha key). pytest-asyncio hands each
    # test a fresh loop, so clear the state and swap in fresh unbound locks
    # to keep tests independent.
    pr_status._last_rank.clear()
    pr_status._locks.clear()
    pr_status._guard = asyncio.Lock()
    yield
    pr_status._last_rank.clear()
    pr_status._locks.clear()


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
async def test_phase_maps_to_expected_state(phase: str, expected_state: str) -> None:
    github = _RecordingGithub()
    # Fresh sha per phase so the monotonic guard does not interleave.
    sha = f"sha-{phase}"
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha=sha, phase=phase)
    assert len(github.calls) == 1
    call = github.calls[0]
    assert call["state"] == expected_state
    assert call["context"] == pr_status.PR_STATUS_CONTEXT
    assert call["context"] == "robomp/pr-review"
    assert call["repo"] == "octo/widget"
    assert call["sha"] == sha


async def test_disabled_settings_posts_nothing() -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github, settings=_settings(enabled=False), repo="octo/widget", sha="abc", phase="queued"
    )
    assert github.calls == []


async def test_empty_sha_posts_nothing() -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="", phase="queued")
    assert github.calls == []


async def test_monotonic_guard_drops_stale_then_reset_reopens() -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="s", phase="reviewing")
    # `queued` (rank 0) is stale after `reviewing` (rank 2) -> dropped.
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="s", phase="queued")
    assert len(github.calls) == 1
    assert github.calls[0]["state"] == "pending"

    # `reset=True` restarts the ladder so a fresh delivery can land again.
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="s", phase="queued", reset=True
    )
    assert len(github.calls) == 2
    assert "Queued" in str(github.calls[1]["description"])


async def test_posts_serialize_per_key() -> None:
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
        pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="s", phase="publishing")
    )
    for _ in range(50):
        await asyncio.sleep(0)
        if github.order:
            break
    assert github.order == ["publishing:start"]

    # The terminal post must queue behind the in-flight `publishing` request,
    # not overtake it on GitHub (arrival order decides the combined status).
    success = asyncio.create_task(
        pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="s", phase="success")
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


async def test_github_error_is_swallowed() -> None:
    github = _RaisingGithub(GitHubError(403, "Resource not accessible"))
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="a", phase="queued")
    assert github.calls == 1


async def test_generic_exception_is_swallowed() -> None:
    github = _RaisingGithub(RuntimeError("boom"))
    await pr_status.publish_pr_status(github, settings=_settings(), repo="octo/widget", sha="b", phase="queued")
    assert github.calls == 1


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


async def test_detail_appended_to_description() -> None:
    github = _RecordingGithub()
    await pr_status.publish_pr_status(
        github, settings=_settings(), repo="octo/widget", sha="d", phase="retrying", detail="OSError"
    )
    assert github.calls[0]["description"].endswith("— OSError")
