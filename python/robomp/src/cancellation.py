"""Per-event cancellation primitives shared by `WorkerPool` and the workers.

The dispatcher sets `_current_event` to `(pool, delivery_id)` for the lifetime
of a single event. Worker threads call `register_cancel_hook` / `unregister_cancel_hook`
from inside that scope to attach a stop callable the pool can fire on demand.
The contextvar propagates through `asyncio.to_thread` automatically because
`asyncio` copies the current context into the executed coroutine context.

Kept in its own module so `worker.py` doesn't have to import `queue.py` (the
dispatcher already imports `tasks`, which imports `worker` — a cycle).
"""

from __future__ import annotations

import contextvars
import logging
from collections.abc import Callable
from typing import Protocol

log = logging.getLogger(__name__)


class _CancelSink(Protocol):
    """Just the slice of `WorkerPool` the helpers below depend on."""

    def _arm_cancel(self, delivery_id: str, hook: Callable[[], None]) -> None: ...
    def _disarm_cancel(self, delivery_id: str) -> None: ...


_current_event: contextvars.ContextVar[tuple[_CancelSink, str] | None] = contextvars.ContextVar(
    "robomp_current_event", default=None
)


def set_current_event(sink: _CancelSink, delivery_id: str) -> contextvars.Token:
    """Open a per-event cancellation scope; returns a reset token for the caller."""
    return _current_event.set((sink, delivery_id))


def clear_current_event(token: contextvars.Token) -> None:
    """Close the scope opened by `set_current_event`."""
    _current_event.reset(token)


def register_cancel_hook(hook: Callable[[], None]) -> None:
    """Arm cancellation for the event currently running on this thread.

    Called from the worker thread once it owns a resource that can be safely
    torn down from outside (e.g. an `RpcClient` whose `.stop()` kills the
    subprocess). Safe to call when no event context is active — no-ops.
    """
    ctx = _current_event.get()
    if ctx is None:
        return
    sink, delivery_id = ctx
    sink._arm_cancel(delivery_id, hook)


def unregister_cancel_hook() -> None:
    """Disarm cancellation for the current event. Idempotent."""
    ctx = _current_event.get()
    if ctx is None:
        return
    sink, delivery_id = ctx
    sink._disarm_cancel(delivery_id)


__all__ = [
    "clear_current_event",
    "register_cancel_hook",
    "set_current_event",
    "unregister_cancel_hook",
]
