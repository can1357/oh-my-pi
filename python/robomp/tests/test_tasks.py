import asyncio
import logging
import threading
from types import SimpleNamespace

import httpx
import pytest

from robomp import pr_status, tasks
from robomp.github_client import GitHubError, IssueInfo, PullRequestInfo, RepoInfo


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


# ---------- review_pr commit-status publication ----------


@pytest.fixture(autouse=True)
def _reset_pr_status_guard():
    # `pr_status` keeps a process-wide monotonic ladder keyed by (repo, sha)
    # guarded by a module-level asyncio.Lock. Every review_pr test below reuses
    # ("octo/widget", "deadbeef"), so clear the ladder and hand out a fresh,
    # unbound lock (pytest-asyncio gives each test a new loop) before and after
    # each test to keep them independent.
    pr_status._last_rank.clear()
    pr_status._locks.clear()
    pr_status._guard = asyncio.Lock()
    yield
    pr_status._last_rank.clear()
    pr_status._locks.clear()


def _phase_of(description: str) -> str:
    """Recover the phase a recorded status description came from.

    A detail suffix, when present, is appended as `base — detail`, so each
    base is a distinct prefix and `startswith` alone disambiguates.
    """
    for phase, (_state, base) in pr_status.PHASE_STATUS.items():
        if description.startswith(base):
            return phase
    raise AssertionError(f"no phase matches description: {description!r}")


def _noop_run_task(**_kw):
    async def _c():
        return None

    return _c()


def _never_run_task(**_kw):
    async def _c():
        raise AssertionError("run_task must not be reached")

    return _c()


def _pr_payload(pr_number: int = 7, sha: str = "deadbeef") -> dict:
    return {
        "pull_request": {"number": pr_number, "head": {"sha": sha}},
        "repository": {"full_name": "octo/widget"},
    }


def _pr_github(record: list, *, fail_fetch: bool = False, fail_exc: Exception | None = None) -> SimpleNamespace:
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
        if fail_exc is not None:
            raise fail_exc
        if fail_fetch:
            raise GitHubError(500, "upstream 500")
        return pr

    async def _create_commit_status(_repo, sha, *, state, context, description="", target_url=None):
        record.append((sha, state, context, description))

    return SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        get_pull_request=_get_pr,
        create_commit_status=_create_commit_status,
    )


async def test_review_pr_publishes_preparing_then_terminal_status(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "s")),
    )
    await tasks.review_pr(
        settings=settings,
        db=db,
        github=_pr_github(record),
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=_pr_payload(),
        delivery_id="d1",
        attempts=1,
    )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["preparing", "failure"]


async def test_review_pr_success_variants(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []

    async def _fake_run_task(**_kw):
        # The agent posted the review during the turn.
        db.log_tool_call(issue_key="octo/widget#7", tool="submit_pr_review", args={})

    monkeypatch.setattr(tasks, "run_task", _fake_run_task)
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "s")),
    )
    await tasks.review_pr(
        settings=settings,
        db=db,
        github=_pr_github(record),
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=_pr_payload(),
        delivery_id="d1",
        attempts=1,
    )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["preparing", "success"]


async def test_review_pr_workspace_failure_is_retrying_and_propagates(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    monkeypatch.setattr(tasks, "run_task", _never_run_task)

    def _boom(**_kw):
        raise OSError("clone failed")

    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_boom)
    with pytest.raises(OSError):
        await tasks.review_pr(
            settings=settings,
            db=db,
            github=_pr_github(record),
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload=_pr_payload(),
            delivery_id="d1",
            attempts=1,
        )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["preparing", "retrying"]


async def test_review_pr_exhausted_retries_are_terminal_error(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    monkeypatch.setattr(tasks, "run_task", _never_run_task)

    def _boom(**_kw):
        raise OSError("clone failed")

    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_boom)
    with pytest.raises(OSError):
        await tasks.review_pr(
            settings=settings,
            db=db,
            github=_pr_github(record),
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload=_pr_payload(),
            delivery_id="d1",
            attempts=4,  # > event_max_retries (3)
        )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["preparing", "error"]


async def test_review_pr_already_reviewed_posts_only_success(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    # Pre-seed a successful submit so the idempotency check short-circuits.
    db.log_tool_call(issue_key="octo/widget#7", tool="submit_pr_review", args={})
    monkeypatch.setattr(tasks, "run_task", _never_run_task)

    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="b", session_dir=str(tmp_path / "s")),
    )
    await tasks.review_pr(
        settings=settings,
        db=db,
        github=_pr_github(record),
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=_pr_payload(),
        delivery_id="d1",
        attempts=1,
    )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["success"]


async def test_review_pr_fetch_failure_posts_terminal_from_payload_sha(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    github = _pr_github(record, fail_fetch=True)
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="b", session_dir=str(tmp_path / "s")),
    )
    # Must NOT raise — the fetch-failure path returns early.
    await tasks.review_pr(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=_pr_payload(sha="deadbeef"),
        delivery_id="d1",
        attempts=4,  # exhausted -> terminal `error`
    )
    assert len(record) == 1
    sha, state, context, description = record[0]
    assert sha == "deadbeef"
    assert state == "error"
    assert context == "robomp/pr-review"


async def test_review_pr_fetch_github_error_is_terminal_even_on_first_attempt(db, settings, monkeypatch, tmp_path):
    # The fetch-failure path returns without re-raising, so the queue never
    # retries — "will retry" would be a lie that sticks at pending forever.
    record: list[tuple] = []
    github = _pr_github(record, fail_fetch=True)
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="b", session_dir=str(tmp_path / "s")),
    )
    await tasks.review_pr(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=_pr_payload(),
        delivery_id="d1",
        attempts=1,
    )
    assert [(_sha, _state) for (_sha, _state, _ctx, _d) in record] == [("deadbeef", "error")]


async def test_review_pr_fetch_transport_error_posts_per_retry_predicate(db, settings, monkeypatch, tmp_path):
    # httpx transport failures re-raise, so the queue DOES retry: the ladder
    # must mirror the queue's predicate instead of staying stuck at `queued`.
    record: list[tuple] = []
    github = _pr_github(record, fail_exc=httpx.ConnectError("boom"))
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="b", session_dir=str(tmp_path / "s")),
    )
    with pytest.raises(httpx.ConnectError):
        await tasks.review_pr(
            settings=settings,
            db=db,
            github=github,
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload=_pr_payload(),
            delivery_id="d1",
            attempts=1,
        )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["retrying"]

    record.clear()
    with pytest.raises(httpx.TimeoutException):
        await tasks.review_pr(
            settings=settings,
            db=db,
            github=_pr_github(record, fail_exc=httpx.ReadTimeout("slow")),
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload=_pr_payload(),
            delivery_id="d2",
            attempts=4,  # exhausted -> terminal
        )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["error"]


async def test_review_pr_fetch_cancellation_posts_retrying(db, settings, monkeypatch, tmp_path):
    record: list[tuple] = []
    github = _pr_github(record, fail_exc=asyncio.CancelledError())
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kw: SimpleNamespace(branch="b", session_dir=str(tmp_path / "s")),
    )
    with pytest.raises(asyncio.CancelledError):
        await tasks.review_pr(
            settings=settings,
            db=db,
            github=github,
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload=_pr_payload(),
            delivery_id="d1",
            attempts=1,
        )
    assert [_phase_of(d) for (_sha, _state, _ctx, d) in record] == ["retrying"]
