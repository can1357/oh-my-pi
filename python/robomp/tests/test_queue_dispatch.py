"""Dispatch action -> task mapping in WorkerPool._dispatch."""

from __future__ import annotations

import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.proxy_client import GitHubProxyClient, ProxyGitTransport
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


@pytest.mark.parametrize("action", ["created", "reviewed", "edited"])
@pytest.mark.asyncio
async def test_dispatch_routes_review_comment_actions_to_handle_review(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Every review comment action MUST reach tasks.handle_review."""
    seen: list[str] = []

    async def fake_handle_review(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "handle_review", fake_handle_review)

    row = EventRow(
        delivery_id=f"rc-{action}",
        event_type="pull_request_review_comment",
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={
            "action": action,
            "pull_request": {"number": 7},
            "comment": {"body": "nit", "user": {"login": "alice"}},
        },
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert seen == [action]


@pytest.mark.parametrize(
    ("event_type", "action"),
    [
        ("pull_request_review_comment", "created"),
        ("pull_request_comment", "reviewed"),
        ("pull_request_approved", "reviewed"),
        ("pull_request_rejected", "reviewed"),
    ],
)
@pytest.mark.asyncio
async def test_dispatch_routes_review_submission_to_handle_review(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, event_type: str, action: str
) -> None:
    """Every event type `route` queues for review MUST reach tasks.handle_review.

    Forgejo review submissions (approve/reject verdicts) arrive under
    pull_request_approved/pull_request_rejected; a dispatch gap there drops
    review bodies exactly like the route() gap did.
    """
    seen: list[str] = []

    async def fake_handle_review(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "handle_review", fake_handle_review)

    row = EventRow(
        delivery_id=f"rc-{event_type}-{action}",
        event_type=event_type,
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={
            "action": action,
            "number": 7,
            "pull_request": {"number": 7},
            "review": {"content": "verdict body", "id": 553},
            "sender": {"login": "alice"},
        },
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert seen == [action]


@pytest.mark.asyncio
async def test_dispatch_review_comment_deleted_is_noop(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deleted review comments must NOT spawn a handle_review task."""
    called = False

    async def fake_handle_review(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "handle_review", fake_handle_review)

    row = EventRow(
        delivery_id="rc-del",
        event_type="pull_request_review_comment",
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={
            "action": "deleted",
            "pull_request": {"number": 7},
            "comment": {"body": "", "user": {"login": "alice"}},
        },
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert called is False


def test_platform_github_routes_forgejo_to_proxy_client(settings: Settings, db: Database) -> None:
    """`_platform_github` returns a platform-scoped proxy client for forgejo,
    and the shared singleton for the default github platform."""
    pool = _make_pool(settings, db)

    forgejo = pool._platform_github("forgejo")  # noqa: SLF001
    assert isinstance(forgejo, GitHubProxyClient)
    assert forgejo._platform == "forgejo"  # type: ignore[attr-defined]

    assert pool._platform_github("github") is pool.github  # noqa: SLF001


def test_platform_transport_routes_forgejo_to_proxy_transport(settings: Settings, db: Database) -> None:
    """`_platform_transport` returns a platform-scoped git transport for forgejo,
    and the shared git transport for the default github platform."""
    pool = _make_pool(settings, db)

    forgejo = pool._platform_transport("forgejo")  # noqa: SLF001
    assert isinstance(forgejo, ProxyGitTransport)
    assert forgejo._platform == "forgejo"  # type: ignore[attr-defined]

    assert pool._platform_transport("github") is pool.git_transport  # noqa: SLF001


@pytest.mark.asyncio
async def test_dispatch_uses_platform_scoped_client_for_forgejo(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A forgejo-platform event reaches the dispatcher with a platform-scoped
    proxy client + transport, not the shared github singletons."""
    seen: dict[str, object] = {}

    async def fake_triage_issue(*, github, git_transport, **_kwargs) -> None:
        seen["github"] = github
        seen["git_transport"] = git_transport

    monkeypatch.setattr(tasks, "triage_issue", fake_triage_issue)
    forgejo_row = EventRow(
        delivery_id="fj1",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#4",
        payload={"action": "opened", "issue": {"number": 4}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
        platform="forgejo",
    )
    await _make_pool(settings, db)._dispatch(forgejo_row)  # noqa: SLF001

    assert isinstance(seen["github"], GitHubProxyClient)
    assert isinstance(seen["git_transport"], ProxyGitTransport)


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
