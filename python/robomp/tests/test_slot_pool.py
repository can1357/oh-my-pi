from __future__ import annotations

import asyncio

import pytest

from robomp.slot_pool import SlotPool


@pytest.mark.asyncio
async def test_empty_pool_is_noop() -> None:
    pool = SlotPool()

    assert await pool.acquire() is None
    pool.release(None)


@pytest.mark.asyncio
async def test_acquire_release_reuses_uid() -> None:
    pool = SlotPool([2001])

    assert await pool.acquire() == 2001
    pool.release(2001)

    assert await pool.acquire() == 2001


@pytest.mark.asyncio
async def test_double_release_rejected() -> None:
    pool = SlotPool([2001])

    slot_uid = await pool.acquire()
    pool.release(slot_uid)

    with pytest.raises(ValueError, match="not acquired"):
        pool.release(slot_uid)


def test_duplicate_slots_rejected() -> None:
    with pytest.raises(ValueError, match="unique"):
        SlotPool([2001, 2001])


@pytest.mark.asyncio
async def test_concurrent_acquire_waits_until_release() -> None:
    pool = SlotPool([2001])

    first_slot_uid = await pool.acquire()
    second_acquire = asyncio.create_task(pool.acquire())
    await asyncio.sleep(0)

    assert not second_acquire.done()

    pool.release(first_slot_uid)

    assert await second_acquire == 2001
