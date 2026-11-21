"""Dispatch action -> task mapping in WorkerPool._dispatch."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.github_client import IssueInfo, PullRequestInfo, RepoInfo
from robomp.queue import WorkerPool
from robomp.slot_pool import SlotPool


class _StubGitHub:
    """Sentinel; dispatch tests stub out the task body."""


class _StubSandbox:
    natives_cache = None

    def reclaim_workspace_caches(self, *, repo: str, number: int | str) -> bool:
        del repo, number
        return False

    def reclaim_all_caches(self) -> int:
        return 0


class _StubGitTransport:
    pass


def _make_pool(settings: Settings, db: Database) -> WorkerPool:
    return WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool(),
    )


def _pr_row(action: str, *, delivery: str = "pr1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="pull_request",
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={"action": action, "pull_request": {"number": 7}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


def _issue_row(action: str, *, delivery: str = "is1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#4",
        payload={"action": action, "issue": {"number": 4}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.parametrize("action", ["opened", "reopened"])
@pytest.mark.asyncio
async def test_dispatch_routes_issue_triage_actions_to_triage_issue(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Every issue action `route` can queue for triage MUST reach `tasks.triage_issue`."""
    seen: list[str] = []

    async def fake_triage_issue(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "triage_issue", fake_triage_issue)

    await _make_pool(settings, db)._dispatch(_issue_row(action))  # noqa: SLF001

    assert seen == [action]


@pytest.mark.parametrize("action", ["opened", "reopened", "ready_for_review"])
@pytest.mark.asyncio
async def test_dispatch_routes_pr_review_actions_to_review_pr(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Every PR action `route` can queue for review MUST reach `tasks.review_pr`."""
    seen: list[str] = []

    async def fake_review_pr(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    await _make_pool(settings, db)._dispatch(_pr_row(action))  # noqa: SLF001

    assert seen == [action]


@pytest.mark.asyncio
async def test_dispatch_pr_synchronize_is_noop(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Actions `route` never queues for review must NOT spawn a review task."""
    called = False

    async def fake_review_pr(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    await _make_pool(settings, db)._dispatch(_pr_row("synchronize"))  # noqa: SLF001

    assert called is False


@pytest.mark.asyncio
async def test_dispatch_routes_completed_workflow_to_release_handler(
    settings: Settings,
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, int]] = []

    async def fake_handle_release_ci(*, payload, attempts, **_kwargs) -> None:
        seen.append((str(payload.get("action")), attempts))

    monkeypatch.setattr(tasks, "handle_release_ci", fake_handle_release_ci, raising=False)
    row = EventRow(
        delivery_id="release-1",
        event_type="workflow_run",
        repo="octo/widget",
        issue_key="octo/widget#release",
        payload={"action": "completed", "workflow_run": {"id": 10}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=2,
        last_error=None,
    )

    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert seen == [("completed", 2)]


@pytest.mark.asyncio
async def test_pr_review_uses_pool_tracker_through_worker_inputs(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The WorkerPool-owned `StatusTracker` MUST reach BOTH `review_pr`
    (dispatch) AND the `TaskInputs` the worker consumes (handoff contract):
    the webhook's terminal posts and the worker's `reviewing`/`publishing`
    posts have to share ONE ladder + per-key locks. A regressed handoff —
    e.g. `TaskInputs` built with `status_tracker=None` while `review_pr` is
    handed the pool's tracker — would let them post on separate trackers and
    this identity assertion is the only test catching it."""
    captured: dict[str, object] = {}

    async def fake_run_task(*, inputs, **_kw) -> None:
        # The `TaskInputs` the worker consumes is built inside `review_pr` —
        # `run_task` is the handoff seam between dispatch and worker.
        captured["inputs"] = inputs

    monkeypatch.setattr(tasks, "run_task", fake_run_task)

    repo = RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=7,
        title="pr",
        body="b",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=True,
    )
    pr = PullRequestInfo(
        repo="octo/widget",
        number=7,
        html_url="https://example/7",
        head_ref="feat",
        base_ref="main",
        state="open",
        head_sha="deadbeef",
    )

    async def _get_repo(_full):
        return repo

    async def _get_issue(_full, _n):
        return issue

    async def _get_pr(_full, _n):
        return pr

    github = SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        get_pull_request=_get_pr,
        create_commit_status=None,
    )
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="farm/x/y", session_dir="/tmp/s"),
    )

    pool = _make_pool(settings, db)
    monkeypatch.setattr(pool, "github", github)
    monkeypatch.setattr(pool, "sandbox", sandbox)
    row = _pr_row("opened")
    # The real `review_pr` (not stubbed here) reads the repo from the payload.
    row.payload["repository"] = {"full_name": "octo/widget"}
    await pool._dispatch(row)  # noqa: SLF001

    inputs = captured["inputs"]
    assert inputs is not None
    assert inputs.status_tracker is not None
    # The dispatch seam and the worker seam carry the SAME instance the pool
    # owns.
    assert inputs.status_tracker is pool.status_tracker
