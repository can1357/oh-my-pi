"""Graceful shutdown drain + kill behavior on WorkerPool.

These tests poke `WorkerPool` directly: they don't spin up a dispatcher loop
or omp subprocess. The contract under test is `stop()`'s drain-then-kill
sequence and `_run_event`'s shutting-down branch that leaves the DB row in
`running` so `reset_stuck_running()` can requeue it.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

import pytest

from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.queue import WorkerPool
from robomp.slot_pool import SlotPool


class _StubGitHub:
    """Sentinel; queue tests don't talk to GitHub."""


class _StubSandbox:
    """Sentinel; queue tests don't touch the workspace pool."""

    natives_cache = None

    def reclaim_workspace_caches(self, *, repo: str, number: int | str) -> bool:
        del repo, number
        return False

    def reclaim_all_caches(self) -> int:
        return 0


class _StubGitTransport:
    """Sentinel; queue tests don't push."""


def _make_pool(settings: Settings, db: Database) -> WorkerPool:
    return WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool(),
    )


def _row(delivery: str = "d1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.asyncio
async def test_non_root_fallback_semaphore_caps_dispatch_concurrency(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.max_concurrency = 1
    monkeypatch.setattr("robomp.queue.os.geteuid", lambda: 501)

    pool = WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
    )

    db.record_event(
        delivery_id="d-one",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )
    db.record_event(
        delivery_id="d-two",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#2",
        payload={"action": "opened"},
        state="running",
    )

    dispatch_started = asyncio.Event()
    release_dispatch = asyncio.Event()
    started: list[str] = []

    async def blocked_dispatch(self: WorkerPool, row: EventRow, *, slot_uid: int | None = None) -> None:
        assert slot_uid is None
        started.append(row.delivery_id)
        dispatch_started.set()
        await release_dispatch.wait()

    monkeypatch.setattr(WorkerPool, "_dispatch", blocked_dispatch)

    first = asyncio.create_task(pool._run_event(_row("d-one")))  # noqa: SLF001
    await asyncio.wait_for(dispatch_started.wait(), timeout=1.0)

    second = asyncio.create_task(pool._run_event(_row("d-two")))  # noqa: SLF001
    await asyncio.sleep(0)
    assert started == ["d-one"]

    release_dispatch.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=1.0)
    assert started == ["d-one", "d-two"]


@pytest.mark.asyncio
async def test_stop_drains_inflight_within_timeout(settings: Settings, db: Database) -> None:
    """A short in-flight task finishes during the drain window; no kill hook needed."""
    pool = _make_pool(settings, db)

    async def short_coro() -> None:
        await asyncio.sleep(0.05)

    task = asyncio.create_task(short_coro())
    pool._inflight_tasks[task] = "d-short"  # noqa: SLF001

    await pool.stop(drain_timeout=1.0, kill_timeout=0.1)

    assert pool._shutting_down is True  # noqa: SLF001
    assert task.done()


@pytest.mark.asyncio
async def test_stop_fires_kill_hook_when_drain_exceeds_timeout(settings: Settings, db: Database) -> None:
    """When drain times out, stop() pops and runs the registered cancel hook.

    The DB row stays `running` because `_run_event` (not exercised here) is
    the only path that mutates state, and even when triggered post-kill the
    shutting_down flag suppresses `mark_event(..., 'failed')`.
    """
    pool = _make_pool(settings, db)
    db.record_event(
        delivery_id="d-blocked",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )

    hook_called = asyncio.Event()
    pool._cancel_hooks["d-blocked"] = hook_called.set  # noqa: SLF001

    never = asyncio.Event()

    async def _park() -> None:
        await never.wait()

    blocked = asyncio.create_task(_park())
    pool._inflight_tasks[blocked] = "d-blocked"  # noqa: SLF001

    try:
        await pool.stop(drain_timeout=0.05, kill_timeout=0.05)

        assert hook_called.is_set()
        stored = db.get_event("d-blocked")
        assert stored is not None
        assert stored.state == "running"
    finally:
        blocked.cancel()
        with suppress(asyncio.CancelledError):
            await blocked


@pytest.mark.asyncio
async def test_run_event_skips_mark_event_when_shutting_down(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """During shutdown, a dispatch exception on a deliberately-cancelled delivery leaves the row untouched."""
    pool = _make_pool(settings, db)
    pool._shutting_down = True  # noqa: SLF001
    pool._shutdown_cancelled.add("d-shutdown")  # noqa: SLF001

    db.record_event(
        delivery_id="d-shutdown",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        raise RuntimeError("omp died")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(_row("d-shutdown"))  # noqa: SLF001

    stored = db.get_event("d-shutdown")
    assert stored is not None
    assert stored.state == "running"
    assert stored.last_error is None


@pytest.mark.asyncio
async def test_stop_cancels_hookless_inflight_task(settings: Settings, db: Database) -> None:
    """A task claimed but stuck pre-hook MUST be cancelled by stop(), not allowed to spawn omp.

    Reproduces the P1 finding: pre-fix, stop()'s kill phase iterated cancel
    hooks only, so an in-flight task without a hook (still waiting on the
    semaphore or inside RpcClient.__enter__) was left running and could
    proceed to spawn a fresh subprocess after stop() returned.
    """
    pool = _make_pool(settings, db)

    reached_spawn = False
    pre_hook_started = asyncio.Event()

    async def stuck_pre_hook() -> None:
        nonlocal reached_spawn
        pre_hook_started.set()
        # Simulate waiting on a slow resource (semaphore / RpcClient.__enter__);
        # we never get a chance to register a cancel hook.
        try:
            await asyncio.sleep(5.0)
        except asyncio.CancelledError:
            raise
        # Pre-fix: this line was reachable after stop() returned.
        reached_spawn = True

    task = asyncio.create_task(stuck_pre_hook())
    pool._inflight_tasks[task] = "d-hookless"  # noqa: SLF001
    try:
        await asyncio.wait_for(pre_hook_started.wait(), timeout=1.0)

        await pool.stop(drain_timeout=0.05, kill_timeout=0.2)

        # Give the event loop a tick for cancellation to settle, then assert.
        await asyncio.sleep(0)
        assert task.done(), "stop() must terminate hookless in-flight tasks"
        assert task.cancelled(), "hookless task must be cancelled, not left running"
        assert reached_spawn is False, "task body must not progress past stop()"
        assert "d-hookless" in pool._shutdown_cancelled  # noqa: SLF001
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


@pytest.mark.asyncio
async def test_run_event_marks_failed_for_unrelated_failure_during_drain(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dispatch that fails for its own reasons during the drain window MUST still mark failed.

    Reproduces the P2 finding: pre-fix, `_shutting_down=True` alone gated
    the suppression branch, so any exception raised during the drain
    window was masked and the row was silently requeued on the next
    start(). After the fix, only deliveries in `_shutdown_cancelled`
    (the ones stop() actually interrupted) get the suppression.
    """
    pool = _make_pool(settings, db)
    pool._shutting_down = True  # noqa: SLF001
    monkeypatch.setattr(settings, "event_max_retries", 0)  # assert terminal failure, not retry
    # Crucially: this delivery is NOT in `_shutdown_cancelled` — stop()
    # never targeted it. Its failure is its own.

    db.record_event(
        delivery_id="d-real-fail",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        raise RuntimeError("genuine bug, not shutdown")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(_row("d-real-fail"))  # noqa: SLF001

    stored = db.get_event("d-real-fail")
    assert stored is not None
    assert stored.state == "failed", "non-shutdown failure during drain must mark failed"
    assert stored.last_error is not None
    assert "genuine bug, not shutdown" in stored.last_error
