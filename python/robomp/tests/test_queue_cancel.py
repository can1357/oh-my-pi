"""Cancellation primitives on WorkerPool.

These tests stay at the public-ish surface of `WorkerPool` — they exercise the
hook registration contextvar that workers use and verify the dispatcher marks
cancelled events as failed with the documented marker. They do NOT spin up a
real omp subprocess; that's covered by the integration smoke test.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

import pytest

from robomp.cancellation import (
    clear_current_event,
    register_cancel_hook,
    set_current_event,
    unregister_cancel_hook,
)
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
async def test_cancel_fires_hook_armed_by_worker(settings: Settings, db: Database) -> None:
    """A worker that armed a hook gets it invoked when cancel_event runs."""
    pool = _make_pool(settings, db)
    row = _row()

    fired = asyncio.Event()

    async def fake_worker() -> None:
        # Mimic _run_event entering its contextvar scope: the helpers below are
        # what worker.py invokes from inside the asyncio.to_thread call.
        token = set_current_event(pool, row.delivery_id)
        try:
            await asyncio.to_thread(register_cancel_hook, fired.set)
            # Park until somebody fires the hook.
            await fired.wait()
        finally:
            await asyncio.to_thread(unregister_cancel_hook)
            clear_current_event(token)

    worker = asyncio.create_task(fake_worker())
    try:
        # Give the worker a tick to register.
        for _ in range(20):
            await asyncio.sleep(0)
            if row.delivery_id in pool._cancel_hooks:  # noqa: SLF001 — test inspecting state
                break
        assert row.delivery_id in pool._cancel_hooks  # noqa: SLF001

        assert await pool.cancel_event(row.delivery_id) is True
        await asyncio.wait_for(worker, timeout=1.0)
        assert row.delivery_id in pool._cancelled  # noqa: SLF001
        # Hook is consumed.
        assert row.delivery_id not in pool._cancel_hooks  # noqa: SLF001
    finally:
        if not worker.done():
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker


@pytest.mark.asyncio
async def test_cancel_before_arm_fires_immediately(settings: Settings, db: Database) -> None:
    """Cancelling before the worker arms must still terminate it on register."""
    pool = _make_pool(settings, db)
    row = _row("d2")

    # Cancel is requested before any worker has armed a hook.
    assert await pool.cancel_event(row.delivery_id) is False
    assert row.delivery_id in pool._cancelled  # noqa: SLF001

    # When the worker eventually registers, the hook must fire synchronously.
    calls: list[int] = []
    token = set_current_event(pool, row.delivery_id)
    try:
        register_cancel_hook(lambda: calls.append(1))
    finally:
        clear_current_event(token)

    assert calls == [1]
    # Late-armed hook is NOT retained; cancel state is one-shot.
    assert row.delivery_id not in pool._cancel_hooks  # noqa: SLF001


@pytest.mark.asyncio
async def test_dispatch_marks_cancelled_event_failed_with_marker(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dispatch that observed cancellation marks the row failed + 'cancelled by operator'."""
    pool = _make_pool(settings, db)

    db.record_event(
        delivery_id="d3",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )
    row = _row("d3")

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        # Simulate cancellation hitting mid-task and the omp subprocess raising.
        await pool.cancel_event(r.delivery_id)
        raise RuntimeError("subprocess died")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(row)  # noqa: SLF001 — testing the dispatcher branch directly

    stored = db.get_event("d3")
    assert stored is not None
    assert stored.state == "failed"
    assert stored.last_error == "cancelled by operator"
    # State is cleared for future events.
    assert row.delivery_id not in pool._cancelled  # noqa: SLF001
    assert row.delivery_id not in pool._cancel_hooks  # noqa: SLF001


@pytest.mark.asyncio
async def test_non_cancelled_failure_keeps_real_traceback(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A garden-variety dispatch failure still records the traceback path."""
    pool = _make_pool(settings, db)
    monkeypatch.setattr(settings, "event_max_retries", 0)  # assert terminal failure, not retry
    db.record_event(
        delivery_id="d4",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )
    row = _row("d4")

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        raise ValueError("boom 42")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(row)  # noqa: SLF001

    stored = db.get_event("d4")
    assert stored is not None
    assert stored.state == "failed"
    assert stored.last_error is not None
    assert "boom 42" in stored.last_error
    assert "cancelled by operator" not in stored.last_error


@pytest.mark.asyncio
async def test_run_event_marks_failed_when_not_shutting_down(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When `_shutting_down` is False, a dispatch failure still marks the row failed."""
    pool = _make_pool(settings, db)
    monkeypatch.setattr(settings, "event_max_retries", 0)  # assert terminal failure, not retry
    assert pool._shutting_down is False  # noqa: SLF001
    db.record_event(
        delivery_id="d5",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )
    row = _row("d5")

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        raise RuntimeError("regular failure")

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)
    await pool._run_event(row)  # noqa: SLF001

    stored = db.get_event("d5")
    assert stored is not None
    assert stored.state == "failed"
    assert stored.last_error is not None
    assert "regular failure" in stored.last_error


@pytest.mark.asyncio
async def test_cancel_unknown_delivery_returns_false(settings: Settings, db: Database) -> None:
    """Cancelling an unknown delivery is a no-op that returns False."""
    pool = _make_pool(settings, db)
    assert await pool.cancel_event("never-existed") is False
    # The set still records the request — a later register would fire — but
    # since no worker is armed, the cancel is harmless.
    assert "never-existed" in pool._cancelled  # noqa: SLF001


@pytest.mark.asyncio
async def test_start_reaps_configured_slot_uids(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []
    monkeypatch.setattr("robomp.queue._reap_slot", lambda uid: calls.append(uid))
    pool = WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool([2001, 2002]),
    )

    await pool.start()
    try:
        assert sorted(calls) == [2001, 2002]
    finally:
        await pool.stop(drain_timeout=0.01, kill_timeout=0.01)


@pytest.mark.asyncio
async def test_run_event_reaps_slot_before_release(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    slot_pool = SlotPool([2001])
    pool = WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=slot_pool,
    )
    db.record_event(
        delivery_id="d-slot",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={"action": "opened"},
        state="running",
    )
    order: list[tuple[str, int | None]] = []
    monkeypatch.setattr("robomp.queue._reap_slot", lambda uid: order.append(("reap", uid)))
    release = slot_pool.release

    def record_release(slot_uid: int | None) -> None:
        order.append(("release", slot_uid))
        release(slot_uid)

    monkeypatch.setattr(slot_pool, "release", record_release)

    async def fake_dispatch(self: WorkerPool, r: EventRow, *, slot_uid: int | None = None) -> None:
        assert r.delivery_id == "d-slot"
        assert slot_uid == 2001

    monkeypatch.setattr(WorkerPool, "_dispatch", fake_dispatch)

    await pool._run_event(_row("d-slot"))  # noqa: SLF001

    stored = db.get_event("d-slot")
    assert stored is not None
    assert stored.state == "done"
    assert order == [("reap", 2001), ("release", 2001)]
