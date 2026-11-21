import asyncio
import logging
import threading
from types import SimpleNamespace

import pytest

from robomp import tasks, worker
from robomp.db import COALESCED_ERROR, coalesced_error_for
from robomp.github_client import GitHubError, IssueInfo, RepoInfo


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


async def test_handle_review_passes_full_thread_to_run_task(db, settings, monkeypatch, tmp_path):
    """The inline-triggered run MUST receive the full review thread, not just the single comment."""
    db.upsert_issue(
        key="octo/widget#5",
        repo="octo/widget",
        number=5,
        state="open",
        branch="farm/abc/5",
        pr_number=7,
    )

    repo = RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=5,
        title="bug",
        body="b",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _get_repo(_r):
        return repo

    async def _get_issue(_r, _n):
        return issue

    async def _list_comments(_r, _n):
        return []

    async def _list_review_comments(_r, _n):
        return [
            SimpleNamespace(
                author="coderabbit", body="leak at 42", path="src/foo.py", line=42, created_at="2026-05-02T10:00:00Z"
            ),
        ]

    async def _list_pr_reviews(_r, _n):
        return []

    github = SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        list_comments=_list_comments,
        list_review_comments=_list_review_comments,
        list_pr_reviews=_list_pr_reviews,
    )
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kwargs: SimpleNamespace(branch="farm/abc/5", session_dir=str(tmp_path / "sess")),
    )

    captured: dict[str, object] = {}

    async def _capturing_run_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(tasks, "run_task", _capturing_run_task)

    payload = {
        "pull_request": {"number": 7},
        "repository": {"full_name": "octo/widget"},
        "comment": {
            "user": {"login": "coderabbit"},
            "body": "leak at 42",
            "path": "src/foo.py",
            "line": 42,
        },
    }

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="d-review",
    )

    thread = captured.get("thread")
    assert isinstance(thread, tuple) and thread, "handle_review must pass the fetched thread to run_task"
    review_messages = [m for m in thread if getattr(m, "kind", "") == "review_comment"]
    assert len(review_messages) == 1
    assert review_messages[0].body == "leak at 42"
    assert review_messages[0].path == "src/foo.py"


def _coalesced_review_env(db, settings, tmp_path, monkeypatch, *, list_review_comments):
    """Shared handle_review fixture for the coalesced-sibling prompt tests."""
    db.upsert_issue(
        key="octo/widget#5",
        repo="octo/widget",
        number=5,
        state="open",
        branch="farm/abc/5",
        pr_number=7,
    )
    repo = RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=5,
        title="bug",
        body="b",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _get_repo(_r):
        return repo

    async def _get_issue(_r, _n):
        return issue

    async def _list_comments(_r, _n):
        return []

    async def _list_pr_reviews(_r, _n):
        return []

    github = SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        list_comments=_list_comments,
        list_review_comments=list_review_comments,
        list_pr_reviews=_list_pr_reviews,
    )
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kwargs: SimpleNamespace(branch="farm/abc/5", session_dir=str(tmp_path / "sess")),
    )

    # Capture what handle_review hands to run_task, then render the real prompt
    # through worker._build_prompt so the assertion is on the actual prompt text.
    captured: dict[str, object] = {}
    prompts: list[str] = []

    async def _capturing_run_task(**kwargs):
        captured.update(kwargs)
        render_kwargs = {k: v for k, v in kwargs.items() if k not in ("inputs", "task_kind")}
        prompts.append(worker._build_prompt("handle_review", kwargs["inputs"], comment=None, **render_kwargs))

    monkeypatch.setattr(tasks, "run_task", _capturing_run_task)
    return github, sandbox, captured, prompts


async def test_handle_review_surfaces_coalesced_sibling_on_hydration_failure(db, settings, monkeypatch, tmp_path):
    """With a hydration failure the coalesced sibling's stored payload MUST appear
    in the rendered prompt: its live-thread message was dropped by the failed
    sub-fetch, and the skipped sibling's row is the only remaining copy."""
    # Survivor + coalesced sibling, as the dispatcher's claim path leaves them.
    db.record_event(
        delivery_id="sibling-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "comment": {
                "user": {"login": "coderabbit"},
                "body": "sibling finding: null deref",
                "path": "src/bar.py",
                "line": 7,
            },
        },
    )
    await asyncio.sleep(0.01)
    db.record_event(
        delivery_id="survivor-1",
        event_type="pull_request_review_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "pull_request": {"number": 7},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42", "path": "src/foo.py", "line": 42},
        },
    )
    db.mark_event("sibling-1", "skipped", error=coalesced_error_for("survivor-1"))
    db.mark_event("survivor-1", "running")

    async def _failing_list_review_comments(_r, _n):
        raise GitHubError(500, "review-comments endpoint exploded")

    github, sandbox, captured, prompts = _coalesced_review_env(
        db, settings, tmp_path, monkeypatch, list_review_comments=_failing_list_review_comments
    )
    payload = {
        "pull_request": {"number": 7},
        "repository": {"full_name": "octo/widget"},
        "comment": {
            "user": {"login": "coderabbit"},
            "body": "leak at 42",
            "path": "src/foo.py",
            "line": 42,
        },
    }

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="survivor-1",
    )

    # The hydration failure really dropped the sibling from the live thread.
    thread = captured.get("thread")
    assert isinstance(thread, tuple) and not any(
        getattr(m, "body", "") == "sibling finding: null deref" for m in thread
    ), "test precondition: the failed sub-fetch must drop the sibling's live message"
    # The survivor's own comment stays the primary finding.
    assert captured.get("review_payload", {}).get("body") == "leak at 42"
    prompt = prompts[0]
    assert "sibling finding: null deref" in prompt, "coalesced sibling's stored body must be in the prompt"
    assert "Also coalesced into this run" in prompt
    assert "@coderabbit — review comment on `src/bar.py`:L7" in prompt


async def test_handle_review_dedupes_hydrated_coalesced_sibling(db, settings, monkeypatch, tmp_path):
    sibling_body = "sibling finding: null deref"
    db.record_event(
        delivery_id="sibling-live-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "comment": {
                "user": {"login": "coderabbit"},
                "body": sibling_body,
                "path": "src/bar.py",
                "line": 7,
            },
        },
    )
    await asyncio.sleep(0.01)
    db.record_event(
        delivery_id="survivor-live-1",
        event_type="pull_request_review_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "pull_request": {"number": 7},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42", "path": "src/foo.py", "line": 42},
        },
    )
    db.mark_event("sibling-live-1", "skipped", error=coalesced_error_for("survivor-live-1"))
    db.mark_event("survivor-live-1", "running")

    async def _list_review_comments(_r, _n):
        return [
            SimpleNamespace(
                author="coderabbit",
                body=sibling_body,
                created_at="2026-05-02T10:00:00Z",
                path="src/bar.py",
                line=7,
            )
        ]

    github, sandbox, captured, prompts = _coalesced_review_env(
        db, settings, tmp_path, monkeypatch, list_review_comments=_list_review_comments
    )
    payload = {
        "pull_request": {"number": 7},
        "repository": {"full_name": "octo/widget"},
        "comment": {
            "user": {"login": "coderabbit"},
            "body": "leak at 42",
            "path": "src/foo.py",
            "line": 42,
        },
    }

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="survivor-live-1",
    )

    thread = captured.get("thread")
    assert any(getattr(m, "body", "") == sibling_body for m in thread)
    prompt = prompts[0]
    assert prompt.count(sibling_body) == 1
    assert "Also coalesced into this run" not in prompt


async def test_handle_review_prompt_unchanged_without_coalesced_sibling(db, settings, monkeypatch, tmp_path):
    """With no coalesced sibling the rendered prompt carries no coalesced section."""
    db.record_event(
        delivery_id="unrelated-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={"action": "created", "comment": {"body": "a skipped row with a DIFFERENT marker"}},
    )
    db.mark_event("unrelated-1", "skipped", error="something else")
    await asyncio.sleep(0.01)
    db.record_event(
        delivery_id="survivor-2",
        event_type="pull_request_review_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "pull_request": {"number": 7},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42", "path": "src/foo.py", "line": 42},
        },
    )
    db.mark_event("survivor-2", "running")

    async def _no_review_comments(_r, _n):
        return []

    github, sandbox, captured, prompts = _coalesced_review_env(
        db, settings, tmp_path, monkeypatch, list_review_comments=_no_review_comments
    )
    payload = {
        "pull_request": {"number": 7},
        "repository": {"full_name": "octo/widget"},
        "comment": {
            "user": {"login": "coderabbit"},
            "body": "leak at 42",
            "path": "src/foo.py",
            "line": 42,
        },
    }

    await tasks.handle_review(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="survivor-2",
    )

    assert captured.get("coalesced", ()) == (), "no sibling carries the coalesced marker"
    prompt = prompts[0]

    # Contract: the feature only INSERTED a coalesced placeholder into the
    # template, which renders empty here. A full byte-for-byte snapshot is
    # brittle and would fail on the one cosmetic artifact of that empty
    # placeholder (extra blank lines), so the no-sibling contract is
    # semantic: (a) every pre-existing content block renders verbatim,
    # (b) the section document order is unchanged, (c) no new or
    # unrendered placeholder leaks into the prompt, (d) no coalesced
    # content at all.
    # (a) Pre-existing blocks, verbatim: title, hydrated thread entry,
    # and the primary finding comment.
    assert "# PR review: octo/widget#7" in prompt
    assert "### @alice — PR body\n\nb" in prompt
    assert "## @coderabbit — `src/foo.py`:L42\n\nleak at 42" in prompt
    assert "MUST read diff context around cited line range before acting." in prompt
    # (b) Pre-feature document order is preserved.
    assert (
        prompt.index("## Prior conversation") < prompt.index("## @coderabbit — `src/foo.py`:L42") < prompt.index("---")
    )
    # (c) No unrendered/unknown placeholder reached the consumer.
    assert "{{" not in prompt
    # (d) No coalesced section, marker, or skip marker leaked in.
    assert "Also coalesced into this run" not in prompt
    assert "a skipped row with a DIFFERENT marker" not in prompt
    assert COALESCED_ERROR not in prompt


async def test_handle_pr_conversation_surfaces_coalesced_sibling_on_hydration_failure(
    db, settings, monkeypatch, tmp_path
):
    """A superseded reviewer-bot issue_comment on a PR conversation MUST have its
    stored finding rendered into the survivor's prompt even when live-thread
    hydration does not expose it: `handle_pr_conversation` feeds `handle_comment`,
    whose prompt (previously) never loaded coalesced payloads, so a hydration
    failure silently dropped the skipped sibling's finding."""
    sibling_body = "sibling finding: null deref"
    db.upsert_issue(
        key="octo/widget#5",
        repo="octo/widget",
        number=5,
        state="open",
        branch="farm/abc/5",
        pr_number=7,
    )
    # Survivor + coalesced sibling, both reviewer-bot PR-conversation issue_comments
    # (the coalesce-able review events for the `handle_pr_conversation` route).
    db.record_event(
        delivery_id="sibling-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"user": {"login": "coderabbit"}, "body": sibling_body},
            "_robomp_directive": {"author": "coderabbit", "body": "address this"},
        },
    )
    await asyncio.sleep(0.01)
    db.record_event(
        delivery_id="survivor-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42"},
            "_robomp_directive": {"author": "coderabbit", "body": "address this"},
        },
    )
    db.mark_event("sibling-1", "skipped", error=coalesced_error_for("survivor-1"))
    db.mark_event("survivor-1", "running")

    repo = RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=5,
        title="bug",
        body="b",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _get_repo(_r):
        return repo

    async def _get_issue(_r, _n):
        return issue

    # Hydration exposes ONLY the PR body — the sibling's live comment is dropped,
    # so the coalesced stored payload is the only remaining copy of its finding.
    async def _no_comments(_r, _n):
        return []

    github = SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        list_comments=_no_comments,
        list_review_comments=_no_comments,
        list_pr_reviews=_no_comments,
    )
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kwargs: SimpleNamespace(branch="farm/abc/5", session_dir=str(tmp_path / "sess")),
    )

    captured: dict[str, object] = {}
    prompts: list[str] = []

    async def _capturing_run_task(**kwargs):
        captured.update(kwargs)
        render_kwargs = {k: v for k, v in kwargs.items() if k not in ("inputs", "task_kind")}
        # `handle_comment` does not pass `review_payload`; `_build_prompt` still
        # requires the kwarg (unused for this task kind), so supply a default.
        render_kwargs.setdefault("review_payload", None)
        prompts.append(worker._build_prompt("handle_comment", kwargs["inputs"], **render_kwargs))

    monkeypatch.setattr(tasks, "run_task", _capturing_run_task)

    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload={
            "action": "created",
            "repository": {"full_name": "octo/widget"},
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42"},
            "_robomp_directive": {"author": "coderabbit", "body": "address this"},
        },
        delivery_id="survivor-1",
    )

    # The hydration failure really dropped the sibling from the live thread.
    thread = captured.get("thread")
    assert isinstance(thread, tuple) and not any(getattr(m, "body", "") == sibling_body for m in thread), (
        "test precondition: the failed sub-fetch must drop the sibling's live message"
    )
    assert captured.get("coalesced", ()), "handle_pr_conversation must load coalesced payloads"

    prompt = prompts[0]
    assert sibling_body in prompt, "coalesced sibling's stored body must be in the prompt"
    assert "Also coalesced into this run" in prompt
    # Sanity: the survivor's own directive (the primary finding) is still rendered.
    assert "address this" in prompt


async def test_handle_pr_conversation_dedupes_hydrated_sibling_via_body_when_author_differs(
    db, settings, monkeypatch, tmp_path
):
    """When the hydrated live thread already carries the sibling's body, the
    coalesced section MUST NOT render a second copy even though the (author,
    body) identity pair differs — the dedup key must fall back to the bare
    body. The stored sibling payload has no `user.login` (a real GitHub
    payload gap) while the live thread message is attributed to "coderabbit",
    so the only working identity here is the body itself."""
    sibling_body = "sibling finding: null deref"
    db.upsert_issue(
        key="octo/widget#5",
        repo="octo/widget",
        number=5,
        state="open",
        branch="farm/abc/5",
        pr_number=7,
    )
    # Sibling stored WITHOUT a login: `_coalesced_payloads` yields author "".
    db.record_event(
        delivery_id="sibling-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"body": sibling_body},
            "_robomp_directive": {"author": "coderabbit", "body": "address this"},
        },
    )
    await asyncio.sleep(0.01)
    db.record_event(
        delivery_id="survivor-1",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key="octo/widget#5",
        payload={
            "action": "created",
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42"},
            "_robomp_directive": {"author": "can1357", "body": "address this"},
        },
    )
    db.mark_event("sibling-1", "skipped", error=coalesced_error_for("survivor-1"))
    db.mark_event("survivor-1", "running")

    repo = RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=5,
        title="bug",
        body="b",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _get_repo(_r):
        return repo

    async def _get_issue(_r, _n):
        return issue

    # Hydration SUCCEEDS and returns the sibling's live comment — the same
    # body as the stored payload, attributed to a login the stored payload lacks.
    async def _comments(_r, _n):
        return [SimpleNamespace(author="coderabbit", body=sibling_body, created_at="2026-05-02T10:00:00Z")]

    async def _none(_r, _n):
        return []

    github = SimpleNamespace(
        get_repo=_get_repo,
        get_issue=_get_issue,
        list_comments=_comments,
        list_review_comments=_none,
        list_pr_reviews=_none,
    )
    sandbox = SimpleNamespace(
        natives_cache=None,
        ensure_workspace=lambda **_kwargs: SimpleNamespace(branch="farm/abc/5", session_dir=str(tmp_path / "sess")),
    )

    captured: dict[str, object] = {}
    prompts: list[str] = []

    async def _capturing_run_task(**kwargs):
        captured.update(kwargs)
        render_kwargs = {k: v for k, v in kwargs.items() if k not in ("inputs", "task_kind")}
        render_kwargs.setdefault("review_payload", None)
        prompts.append(worker._build_prompt("handle_comment", kwargs["inputs"], **render_kwargs))

    monkeypatch.setattr(tasks, "run_task", _capturing_run_task)

    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=SimpleNamespace(),
        payload={
            "action": "created",
            "repository": {"full_name": "octo/widget"},
            "issue": {"number": 7, "pull_request": {"url": "https://x/octo/widget/pulls/7"}},
            "comment": {"user": {"login": "coderabbit"}, "body": "leak at 42"},
            "_robomp_directive": {"author": "can1357", "body": "address this"},
        },
        delivery_id="survivor-1",
    )

    # Preconditions: the body IS in the hydrated live thread (so the coalesced
    # section is redundant) and the loaded coalesced payload has no author.
    # On the directive route the hydrated thread rides on the DirectiveInfo.
    directive = captured.get("directive")
    d_thread = getattr(directive, "thread", ()) if directive is not None else ()
    assert any(getattr(m, "body", "") == sibling_body and getattr(m, "author", "") == "coderabbit" for m in d_thread), (
        "test precondition: live thread carries the sibling body attributed to coderabbit"
    )
    coalesced = captured.get("coalesced", ())
    assert coalesced, "handle_pr_conversation must load the coalesced sibling payload"
    assert all(not p.get("author") for p in coalesced), "test precondition: stored sibling payload carries no author"

    prompt = prompts[0]
    assert prompt.count(sibling_body) == 1, (
        "body-only fallback MUST dedup the coalesced section against the hydrated thread"
    )
    assert "Also coalesced into this run" not in prompt
    # Sanity: the survivor's own directive is still rendered.
    assert "address this" in prompt
