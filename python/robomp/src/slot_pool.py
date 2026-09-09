from __future__ import annotations

import asyncio
from collections.abc import Iterable


class SlotPool:
    def __init__(self, slot_uids: Iterable[int] = ()) -> None:
        self._slot_uids = tuple(slot_uids)
        if len(self._slot_uids) != len(set(self._slot_uids)):
            raise ValueError("slot UIDs must be unique")

        self._available: asyncio.Queue[int] = asyncio.Queue()
        for slot_uid in self._slot_uids:
            self._available.put_nowait(slot_uid)
        self._checked_out: set[int] = set()

    @property
    def slot_uids(self) -> tuple[int, ...]:
        return self._slot_uids

    async def acquire(self) -> int | None:
        if not self._slot_uids:
            return None

        slot_uid = await self._available.get()
        self._checked_out.add(slot_uid)
        return slot_uid

    def release(self, slot_uid: int | None) -> None:
        if not self._slot_uids and slot_uid is None:
            return
        if slot_uid is None or slot_uid not in self._checked_out:
            raise ValueError("slot UID was not acquired")

        self._checked_out.remove(slot_uid)
        self._available.put_nowait(slot_uid)
