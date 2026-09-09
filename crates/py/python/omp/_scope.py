"""Per-invocation authority scopes; inert at import."""
from __future__ import annotations

import asyncio
import contextvars
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Callable, Mapping

from _omp import InvocationPhase, LifecyclePhase, Principal


class Trust(StrEnum):
    """Confinement tier granted to an extension child."""

    SANDBOXED = "sandboxed"
    TRUSTED = "trusted"


_shielded: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "omp_scope_shielded", default=False
)

@dataclass(frozen=True, slots=True)
class Scope:
    """The generation-fenced authority attached to one invocation."""
    invocation: str
    generation: int
    principal: Principal
    phase: InvocationPhase
    deadline: float | None = None
    effects: frozenset[str] = frozenset()
    extension: str = ""
    session: str = ""
    turn: int | None = None
    event: str | None = None
    call: str | None = None
    device: str | None = None
    trust: Trust = Trust.SANDBOXED
    caps: frozenset[str] = frozenset()
    place_kind: str = "host"
    lifecycle: LifecyclePhase = LifecyclePhase.ACTIVE
    roots: tuple[str, ...] = ()
    remote: bool = False
    has_ui: bool = False
    headless: bool = True
    model: object | None = None
    route: object | None = None
    thinking: object | None = None
    settings: Mapping[str, object] = field(
        default_factory=lambda: MappingProxyType({})
    )
    secret_settings: frozenset[str] = frozenset()
    cancelled: bool = False
    cancel_signal: asyncio.Event = field(
        default_factory=asyncio.Event, init=False, repr=False, compare=False
    )
    cancel_callbacks: list[Callable[[], None]] = field(default_factory=list)

_current: contextvars.ContextVar[Scope | None] = contextvars.ContextVar("omp_scope", default=None)

def current() -> Scope:
    """Return the active invocation scope."""
    scope = _current.get()
    if scope is None:
        raise RuntimeError("no active omp invocation scope")
    return scope

def install(scope: Scope) -> contextvars.Token[Scope | None]:
    """Install a scope for host dispatch and return its reset token."""
    return _current.set(scope)

def reset(token: contextvars.Token[Scope | None]) -> None:
    """Restore the scope preceding ``install``."""
    _current.reset(token)


def _request_cancel(scope: Scope) -> bool:
    """Mark a scope cancelled, returning whether this is the first request."""
    if scope.cancelled:
        return False
    object.__setattr__(scope, "cancelled", True)
    scope.cancel_signal.set()
    return True


def _fire_cancel_callbacks(
    scope: Scope,
    on_callback_error: Callable[[BaseException], None],
) -> None:
    """Fire and remove cancellation callbacks in reverse registration order."""
    callbacks = tuple(reversed(scope.cancel_callbacks))
    scope.cancel_callbacks.clear()
    for callback in callbacks:
        try:
            callback()
        except BaseException as error:
            try:
                on_callback_error(error)
            except BaseException:
                pass


__all__ = ("Scope", "Trust", "current", "install", "reset")
