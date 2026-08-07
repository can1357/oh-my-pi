import asyncio
import logging
import threading
from types import SimpleNamespace

import pytest

from robomp import tasks
from robomp.github_client import GitHubError, IssueInfo, RepoInfo, ReviewCommentInfo


async def test_triage_issue_keeps_event_loop_live_while_workspace_setup_blocks(db, settings, monkeypatch, tmp_path):
    async def _resolve_repo_and_issue(_github, _payload):
        repo = RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url="https://x/octo/widget.git",
            private=False,
        )
        issue = IssueInfo(
            repo="octo/widget",
            number=1,
            title="bug",
            body="b",
            state="open",
            author="alice",
            labels=(),
            is_pull_request=False,
        )
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve_repo_and_issue)

    async def _no_closing(*a, **k):
        return ()

    github = SimpleNamespace(list_closing_pull_requests=_no_closing)

    entered = threading.Event()
    release = threading.Event()
    captured: dict[str, object] = {}

    def _blocking_ensure(**_kwargs):
        entered.set()
        # True ONLY if a concurrent coroutine set `release` while we blocked here.
        # Blocks a WORKER THREAD (via to_thread) in the fixed code; blocks the
        # LOOP itself in the broken code.
        captured["release_seen_in_time"] = release.wait(1.0)
        return SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "sess"))

    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_blocking_ensure)

    async def _noop_run_task(**_kwargs):
        return None

    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    async def _releaser():
        # Waits (off-loop) until ensure_workspace has actually started, then
        # releases it. This coroutine can ONLY make progress if the event loop
        # is live while ensure_workspace is blocking.
        await asyncio.to_thread(entered.wait, 1.0)
        assert entered.is_set(), "ensure_workspace never started"
        release.set()

    triage_task = asyncio.create_task(
        tasks.triage_issue(
            settings=settings,
            db=db,
            github=github,
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload={},
            delivery_id="d1",
        )
    )
    releaser_task = asyncio.create_task(_releaser())

    await asyncio.wait_for(triage_task, timeout=3.0)
    await asyncio.wait_for(releaser_task, timeout=1.0)

    assert captured.get("release_seen_in_time") is True, (
        "event loop was frozen during ensure_workspace: the concurrent releaser "
        "could not run, so release.wait timed out (this is the pre-fix hang)"
    )


async def test_run_workspace_op_drains_thread_before_propagating_cancel():
    started = threading.Event()
    proceed = threading.Event()
    finished = threading.Event()

    def slow_op(**_kwargs):
        started.set()
        # Block on the worker thread until the test releases us.
        assert proceed.wait(2.0), "proceed was never set — test bug"
        finished.set()
        return "done"

    task = asyncio.create_task(tasks._run_workspace_op(slow_op))
    # Wait (off-loop) until the worker thread is actually running.
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    async def pump(turns: int = 20) -> None:
        # Deterministically advance the loop without a wall-clock sleep: each
        # sleep(0) drains the ready queue, so a DETACHING (pre-fix) helper would
        # resolve `task` within these turns. A draining helper keeps it pending
        # while the worker thread is still blocked on `proceed`.
        for _ in range(turns):
            await asyncio.sleep(0)

    # Cancel the AWAITING coroutine while the thread is mid-flight, then a SECOND
    # time while it is still blocked. The repeated cancel must land on the drain
    # loop's re-`await` and be swallowed by its `continue` branch, NOT abandon
    # the thread. The whole sequence runs under try/finally so any failed assert
    # still releases the worker and cannot leak a blocked thread into later tests.
    try:
        task.cancel()
        await pump()
        assert not task.done(), "helper propagated the first cancel before the thread completed (thread abandoned)"
        task.cancel()
        await pump()
        # The thread is still blocked on `proceed`, so it has not finished and
        # the task has not resolved despite two cancels.
        assert not finished.is_set(), "thread finished before we released it — impossible unless abandoned"
        assert not task.done(), "helper abandoned the thread after a repeated cancel"
    finally:
        proceed.set()

    # The helper must now let the thread finish, THEN raise CancelledError.
    with pytest.raises(asyncio.CancelledError):
        await task
    # Deterministic in the fixed helper: the thread completed before the cancel propagated.
    assert finished.is_set(), "thread did not complete before cancellation propagated"


async def test_run_workspace_op_logs_worker_exception_on_concurrent_cancel(caplog):
    started = threading.Event()
    proceed = threading.Event()
    boom = RuntimeError("git exploded")

    def failing_op(**_kwargs):
        started.set()
        assert proceed.wait(2.0), "proceed was never set — test bug"
        raise boom

    task = asyncio.create_task(tasks._run_workspace_op(failing_op))
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    # Cancel the caller while the worker is still blocked (mid-flight), so the
    # helper enters its cancel-drain loop and is awaiting the shielded inner.
    task.cancel()
    await asyncio.sleep(0.05)

    with caplog.at_level(logging.WARNING, logger="robomp.tasks"):
        # Release the worker so inner completes WITH an exception while the
        # helper is draining -> the drain's `await shield(inner)` re-raises boom,
        # breaks the loop, and the guarded log.warning must fire.
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "worker exception during cancel was not logged"
    assert any(r.exc_info and r.exc_info[1] is boom for r in warnings), (
        "the worker's exception was not attached to the warning"
    )


async def test_triage_issue_reopen_tears_down_finalized_workspace(db, settings, monkeypatch, tmp_path):
    """Re-triage of a finalized (reopened) issue must clear the stale workspace first.

    The prior branch was merged/deleted when the issue finalized, so a reopen has
    to branch afresh — mirroring the maintainer directive-reopen teardown.
    """

    async def _resolve_repo_and_issue(_github, _payload):
        repo = RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url="https://x/octo/widget.git",
            private=False,
        )
        issue = IssueInfo(
            repo="octo/widget",
            number=1,
            title="bug",
            body="b",
            state="open",
            author="alice",
            labels=(),
            is_pull_request=False,
        )
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve_repo_and_issue)

    # The bot previously finalized this issue: a stale row + workspace exist.
    db.upsert_issue(key="octo/widget#1", repo="octo/widget", number=1, state="closed")

    calls: list[str] = []

    def _remove(**_kwargs):
        calls.append("remove")

    def _ensure(**_kwargs):
        calls.append("ensure")
        return SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "sess"))

    async def _fail_closing(*_a, **_k):
        raise AssertionError("closing-PR guard must not run when a DB row already exists")

    github = SimpleNamespace(list_closing_pull_requests=_fail_closing)
    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_ensure, remove_workspace=_remove)

    async def _noop_run_task(**_kwargs):
        return None

    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    # Teardown must precede re-provisioning, and the row resets to a live state.
    assert calls == ["remove", "ensure"]
    row = db.get_issue("octo/widget#1")
    assert row is not None
    assert row.state == "reproducing"


async def test_handle_review_forgejo_empty_body_fetches_comment_text_by_id(db, settings, monkeypatch) -> None:
    """Forgejo #7935: a `pull_request_review_comment` payload with empty `body`
    must pull the real text via `get_review_comment(id)` before handing off."""
    key = tasks.issue_key("octo/widget", 9)
    db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=9,
        state="opened",
        branch="farm/abc/review",
        session_dir="/tmp/sess",
        pr_number=99,
    )
    row = db.get_issue(key)
    assert row is not None

    fetched_calls: list[tuple[str, int]] = []

    class _FakeGH:
        async def get_repo(self, repo):
            return RepoInfo(
                full_name=repo,
                default_branch="main",
                clone_url="https://x/octo/widget.git",
                private=False,
            )

        async def get_issue(self, repo, number):
            return IssueInfo(
                repo=repo,
                number=number,
                title="t",
                body="b",
                state="open",
                author="a",
                labels=(),
                is_pull_request=False,
            )

        async def get_review_comment(self, repo, comment_id):
            fetched_calls.append((repo, int(comment_id)))
            return ReviewCommentInfo(
                id=int(comment_id),
                author="alice",
                body="the real comment text",
                path="src/app.py",
                line=5,
                created_at="2026-01-01T00:00:00Z",
            )

    captured: dict[str, object] = {}

    async def fake_run_task(*, task_kind, inputs, pr_number, review_payload, **_kwargs):
        del inputs, pr_number
        captured["kind"] = task_kind
        captured["review_payload"] = review_payload

    async def fake_resolve(**_kwargs):
        return (row, None)

    async def fake_workspace_op(func, **_kwargs):
        del func
        return SimpleNamespace(branch="farm/abc/review", session_dir="/tmp/sess")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    monkeypatch.setattr(tasks, "_resolve_issue_row_for_pr", fake_resolve)
    monkeypatch.setattr(tasks, "_run_workspace_op", fake_workspace_op)

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=_FakeGH(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **k: None),
        git_transport=None,
        payload={
            "pull_request": {"number": 99},
            "repository": {"full_name": "octo/widget"},
            "review": {"content": "", "id": 42},  # forgejo empty-body review
            "sender": {"login": "alice"},
        },
        delivery_id="d1",
    )

    assert fetched_calls == [("octo/widget", 42)]
    assert captured["kind"] == "handle_review"
    payload = captured["review_payload"]  # type: ignore[index]
    assert payload["body"] == "the real comment text"
    assert payload["path"] == "src/app.py"
    assert payload["line"] == 5


@pytest.mark.asyncio
async def test_handle_review_attaches_conversation_thread(db, settings, monkeypatch) -> None:
    """The PR conversation thread is fetched and passed to run_task."""
    from robomp.github_client import ReviewCommentInfo

    key = tasks.issue_key("octo/widget", 9)
    db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=9,
        state="opened",
        branch="farm/abc/review",
        session_dir="/tmp/sess",
        pr_number=99,
    )
    row = db.get_issue(key)
    assert row is not None

    class _FakeGH:
        async def get_repo(self, repo):
            return RepoInfo(
                full_name=repo,
                default_branch="main",
                clone_url="https://x/octo/widget.git",
                private=False,
            )

        async def get_issue(self, repo, number):
            return IssueInfo(
                repo=repo,
                number=number,
                title="Fix",
                body="PR body text",
                state="open",
                author="robomp-bot",
                labels=(),
                is_pull_request=True,
            )

        async def get_review_comment(self, repo, comment_id):
            return ReviewCommentInfo(
                id=int(comment_id),
                author="mira",
                body="finding",
                path="src/app.py",
                line=5,
                created_at="2026-01-01T00:00:00Z",
            )

        async def list_comments(self, repo, number):
            from robomp.github_client import CommentInfo

            return [CommentInfo(id=1, author="alice", body="prior request", created_at="2026-05-01T10:00:00Z")]

        async def list_review_comments(self, repo, number):
            return []

        async def list_pr_reviews(self, repo, number):
            return []

    captured: dict[str, object] = {}

    async def fake_run_task(*, task_kind, inputs, pr_number, review_payload, thread, **_kwargs):
        del inputs, pr_number, review_payload
        captured["kind"] = task_kind
        captured["thread"] = thread

    async def fake_resolve(**_kwargs):
        return (row, None)

    async def fake_workspace_op(func, **_kwargs):
        del func
        return SimpleNamespace(branch="farm/abc/review", session_dir="/tmp/sess")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    monkeypatch.setattr(tasks, "_resolve_issue_row_for_pr", fake_resolve)
    monkeypatch.setattr(tasks, "_run_workspace_op", fake_workspace_op)

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=_FakeGH(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **k: None),
        git_transport=None,
        payload={
            "pull_request": {"number": 99},
            "repository": {"full_name": "octo/widget"},
            "comment": {
                "id": 42,
                "body": "finding",
                "path": "src/app.py",
                "line": 5,
                "user": {"login": "mira"},
            },
            "sender": {"login": "mira"},
        },
        delivery_id="d1",
    )

    assert captured["kind"] == "handle_review"
    thread = captured["thread"]
    assert isinstance(thread, tuple)
    assert len(thread) >= 2
    bodies = [m.body for m in thread]
    assert "PR body text" in bodies
    assert "prior request" in bodies


@pytest.mark.asyncio
async def test_handle_review_refetch_failure_falls_back_to_webhook_body(db, settings, monkeypatch) -> None:
    """When get_review_comment raises, the webhook body + path/line are preserved."""
    key = tasks.issue_key("octo/widget", 9)
    db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=9,
        state="opened",
        branch="farm/abc/review",
        session_dir="/tmp/sess",
        pr_number=99,
    )
    row = db.get_issue(key)
    assert row is not None

    class _FakeGH:
        async def get_repo(self, repo):
            return RepoInfo(
                full_name=repo,
                default_branch="main",
                clone_url="https://x/octo/widget.git",
                private=False,
            )

        async def get_issue(self, repo, number):
            return IssueInfo(
                repo=repo,
                number=number,
                title="t",
                body="b",
                state="open",
                author="a",
                labels=(),
                is_pull_request=False,
            )

        async def get_review_comment(self, repo, comment_id):
            raise GitHubError(500, "internal error")

    captured: dict[str, object] = {}

    async def fake_run_task(*, task_kind, inputs, pr_number, review_payload, **_kwargs):
        del inputs, pr_number
        captured["kind"] = task_kind
        captured["review_payload"] = review_payload

    async def fake_resolve(**_kwargs):
        return (row, None)

    async def fake_workspace_op(func, **_kwargs):
        del func
        return SimpleNamespace(branch="farm/abc/review", session_dir="/tmp/sess")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    monkeypatch.setattr(tasks, "_resolve_issue_row_for_pr", fake_resolve)
    monkeypatch.setattr(tasks, "_run_workspace_op", fake_workspace_op)

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=_FakeGH(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **k: None),
        git_transport=None,
        payload={
            "pull_request": {"number": 99},
            "repository": {"full_name": "octo/widget"},
            "comment": {
                "id": 42,
                "body": "webhook body",
                "path": "src/webhook.py",
                "line": 10,
                "user": {"login": "alice"},
            },
            "sender": {"login": "alice"},
        },
        delivery_id="d1",
    )

    assert captured["kind"] == "handle_review"
    payload = captured["review_payload"]  # type: ignore[index]
    assert payload["body"] == "webhook body"
    assert payload["path"] == "src/webhook.py"
    assert payload["line"] == 10


@pytest.mark.asyncio
async def test_handle_review_placeholder_body_is_replaced_by_authoritative_refetch(db, settings, monkeypatch) -> None:
    """GitHub: non-empty placeholder body ("Reviewing this PR…") is overridden
    by the authoritative text fetched from the canonical API endpoint."""
    from robomp.github_client import ReviewCommentInfo

    key = tasks.issue_key("octo/widget", 9)
    db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=9,
        state="opened",
        branch="farm/abc/review",
        session_dir="/tmp/sess",
        pr_number=99,
    )
    row = db.get_issue(key)
    assert row is not None

    fetched_calls: list[tuple[str, int]] = []

    class _FakeGH:
        async def get_repo(self, repo):
            return RepoInfo(
                full_name=repo,
                default_branch="main",
                clone_url="https://x/octo/widget.git",
                private=False,
            )

        async def get_issue(self, repo, number):
            return IssueInfo(
                repo=repo,
                number=number,
                title="t",
                body="b",
                state="open",
                author="a",
                labels=(),
                is_pull_request=False,
            )

        async def get_review_comment(self, repo, comment_id):
            fetched_calls.append((repo, int(comment_id)))
            return ReviewCommentInfo(
                id=int(comment_id),
                author="mira",
                body="Trailing descriptor parse misses the case when the imported person has no credit.",
                path="internal/import/person_credit.go",
                line=145,
                created_at="2026-08-07T21:48:00Z",
            )

    captured: dict[str, object] = {}

    async def fake_run_task(*, task_kind, inputs, pr_number, review_payload, **_kwargs):
        del inputs, pr_number
        captured["kind"] = task_kind
        captured["review_payload"] = review_payload

    async def fake_resolve(**_kwargs):
        return (row, None)

    async def fake_workspace_op(func, **_kwargs):
        del func
        return SimpleNamespace(branch="farm/abc/review", session_dir="/tmp/sess")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    monkeypatch.setattr(tasks, "_resolve_issue_row_for_pr", fake_resolve)
    monkeypatch.setattr(tasks, "_run_workspace_op", fake_workspace_op)

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=_FakeGH(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **k: None),
        git_transport=None,
        payload={
            "pull_request": {"number": 99},
            "repository": {"full_name": "octo/widget"},
            "comment": {
                "id": 42,
                "body": "Reviewing this PR…",
                "path": "legacy/path.go",
                "line": 100,
                "user": {"login": "mira"},
            },
            "sender": {"login": "mira"},
        },
        delivery_id="d1",
    )

    assert fetched_calls == [("octo/widget", 42)]
    assert captured["kind"] == "handle_review"
    payload = captured["review_payload"]  # type: ignore[index]
    assert "Trailing descriptor" in payload["body"]
    assert payload["path"] == "internal/import/person_credit.go"
    assert payload["line"] == 145
