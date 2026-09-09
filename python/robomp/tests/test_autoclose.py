"""Coverage for `AutocloseScheduler` against in-process fakes."""

from __future__ import annotations

from collections.abc import Iterable

import pytest
from pydantic import SecretStr

from robomp.autoclose import AutocloseScheduler
from robomp.config import Settings
from robomp.db import Database, issue_key
from robomp.github_client import GitHubError, ReactionInfo


def _settings(*, enabled: bool = True, hours: float = 4.0, scan: float = 60.0) -> Settings:
    return Settings.model_construct(
        github_token=None,
        github_webhook_secret=SecretStr("x"),
        bot_login="robomp-bot",
        git_author_email="bot@example.invalid",
        repo_allowlist_raw="octo/widget",
        gh_proxy_url="http://proxy.invalid",
        gh_proxy_hmac_key=SecretStr("k" * 32),
        question_autoclose_enabled=enabled,
        question_autoclose_hours=hours,
        question_autoclose_scan_seconds=scan,
    )


class _FakeGitHub:
    """Minimal GitHubBackend stand-in for the scheduler.

    Only `list_comment_reactions` and `close_issue` are exercised; everything
    else raises so a misuse here surfaces loudly instead of silently.
    """

    def __init__(
        self,
        *,
        reactions: Iterable[ReactionInfo] = (),
        close_error: GitHubError | None = None,
    ) -> None:
        self._reactions = tuple(reactions)
        self._close_error = close_error
        self.close_calls: list[tuple[str, int, str]] = []
        self.reaction_calls: list[tuple[str, int]] = []

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        self.reaction_calls.append((repo, comment_id))
        return self._reactions

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        self.close_calls.append((repo, number, reason))
        if self._close_error is not None:
            raise self._close_error


_KEY = issue_key("octo/widget", 42)


def _seed(db: Database, *, close_at: str = "2000-01-01T00:00:00.000000Z") -> None:
    db.upsert_pending_closure(
        issue_key=_KEY,
        repo="octo/widget",
        number=42,
        comment_id=999,
        issue_author="alice",
        close_at=close_at,
    )


async def test_tick_closes_when_no_author_downvote(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 1, "cancelled": 0, "retried": 0}
    assert gh.close_calls == [("octo/widget", 42, "completed")]
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "closed"
    assert row.cancel_reason is None


async def test_tick_cancels_when_author_downvotes(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(
        reactions=[ReactionInfo(content="-1", user_login="Alice", user_type="User")],
    )
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 1, "retried": 0}
    assert gh.close_calls == []
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "cancelled"
    assert row.cancel_reason == "author_downvoted"


async def test_tick_ignores_downvote_from_non_author(db: Database) -> None:
    """Watchers / drive-by 👎 from anyone other than the author do not veto."""
    _seed(db)
    gh = _FakeGitHub(
        reactions=[
            ReactionInfo(content="-1", user_login="rando", user_type="User"),
            ReactionInfo(content="-1", user_login="some-bot", user_type="Bot"),
        ],
    )
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 1, "cancelled": 0, "retried": 0}
    assert gh.close_calls == [("octo/widget", 42, "completed")]


async def test_tick_retries_after_transient_close_error(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(close_error=GitHubError(502, "Bad Gateway"))
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 1}
    row = db.get_pending_closure(_KEY)
    # Failed attempt resets the row to `pending` so the next tick claims it again.
    assert row is not None and row.state == "pending"


async def test_tick_treats_404_close_as_already_closed(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(close_error=GitHubError(404, "Not Found"))
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 1, "retried": 0}
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "cancelled"
    assert row.cancel_reason == "already_closed"


async def test_tick_retries_when_list_reactions_fails(db: Database) -> None:
    _seed(db)

    class _ReactBoom(_FakeGitHub):
        async def list_comment_reactions(self, repo, comment_id):
            raise GitHubError(503, "Service Unavailable")

    gh = _ReactBoom()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 1}
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"


async def test_tick_skips_future_rows(db: Database) -> None:
    """A row whose `close_at` is in the future stays pending."""
    _seed(db, close_at="2999-01-01T00:00:00.000000Z")
    gh = _FakeGitHub()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 0}
    assert gh.close_calls == []
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"


def test_scheduler_disabled_when_feature_off() -> None:
    sched = AutocloseScheduler(
        settings=_settings(enabled=False),
        db=None,  # type: ignore[arg-type]
        github=None,  # type: ignore[arg-type]
    )
    assert not sched.enabled


def test_scheduler_disabled_when_hours_zero() -> None:
    sched = AutocloseScheduler(
        settings=_settings(hours=0.0),
        db=None,  # type: ignore[arg-type]
        github=None,  # type: ignore[arg-type]
    )
    assert not sched.enabled


@pytest.mark.asyncio
async def test_start_is_noop_when_disabled(db: Database) -> None:
    sched = AutocloseScheduler(
        settings=_settings(enabled=False),
        db=db,
        github=_FakeGitHub(),
    )
    await sched.start()
    # No background task should have been created.
    assert sched._task is None  # type: ignore[attr-defined]
    await sched.stop()  # idempotent
