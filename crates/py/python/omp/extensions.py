"""Declare engine-owned extension Directors and journal-derived Components.

These decorators record import-time metadata only. Python callbacks execute in
its killable extension-host process; durable state is materialized below the
session ``<meta>`` subtree by the registered Component, never in module globals.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
import inspect
from types import MappingProxyType
from typing import TypeVar

from ._registry import registry


_T = TypeVar("_T", bound=Callable[..., object] | type)
_DIRECTOR_CLAIMS = frozenset({"mode", "loop", "tool_choice", "worktree"})
_JOURNAL_KINDS = frozenset(
    {
        "journal@1",
        "turn.start@1",
        "msg.user@1",
        "msg.assistant.start@1",
        "stream@1",
        "msg.assistant.end@1",
        "tool.call@1",
        "tool.update@1",
        "tool.result@1",
        "turn.receipt@1",
        "patch@1",
        "compaction@1",
    }
)


def director(
    director_id: str,
    *,
    claims: Sequence[str] = (),
    binds: Mapping[str, bool | int | float | str] | None = None,
) -> Callable[[_T], _T]:
    """Register a lifecycle callback on the engine Director stack.

    The decorated callable may provide ``before_inference`` and ``on_yield``
    behavior. Any state it needs must be read from the session DOM and changed
    through a registered Component or a DOM patch.
    """

    identity = _identity(director_id, "director")
    claim_tuple = tuple(claims)
    if len(set(claim_tuple)) != len(claim_tuple):
        raise ValueError("director claims must be unique")
    unknown = set(claim_tuple) - _DIRECTOR_CLAIMS
    if unknown:
        raise ValueError(f"unknown Director claims: {sorted(unknown)!r}")
    bind_values = dict(binds or {})
    for name, value in bind_values.items():
        if not isinstance(name, str) or not name:
            raise TypeError("Director bind names must be non-empty strings")
        if isinstance(value, (dict, list, tuple, set)) or value is None:
            raise TypeError("Director binds must be scalar values")

    def decorate(callback: _T) -> _T:
        if not callable(callback):
            raise TypeError("@omp.director may decorate only a callable or class")
        registry.register_director(
            identity,
            callback,
            claim_tuple,
            MappingProxyType(bind_values),
        )
        return callback

    return decorate


def component(
    component_id: str,
    *,
    interested: Sequence[str] = ("patch@1",),
) -> Callable[[_T], _T]:
    """Register a pure journal-to-``<meta>`` reducer.

    Extension-defined journal kinds are intentionally unsupported. Reducers
    consume the engine's closed kind vocabulary and stage ordinary DOM ops.
    """

    identity = _identity(component_id, "component")
    kinds = tuple(interested)
    if not kinds:
        raise ValueError("Component interested kinds must not be empty")
    if len(set(kinds)) != len(kinds):
        raise ValueError("Component interested kinds must be unique")
    unknown = set(kinds) - _JOURNAL_KINDS
    if unknown:
        raise ValueError(f"unknown journal kinds: {sorted(unknown)!r}")

    def decorate(callback: _T) -> _T:
        if not callable(callback):
            raise TypeError("@omp.component may decorate only a callable or class")
        registry.register_component(identity, callback, kinds)
        return callback

    return decorate


def _registered(kind: str, identity: str, callable: str) -> object:
    definitions = (
        registry.director_definitions()
        if kind == "director"
        else registry.component_definitions()
    )
    for definition in definitions:
        if definition.id != identity:
            continue
        target = definition.callable
        expected = f"{target.__module__}.{target.__qualname__}"
        if expected != callable:
            raise RuntimeError(f"{kind} callable identity does not match frozen registry")
        return target() if isinstance(target, type) else target
    raise LookupError(f"unknown registered {kind} {identity!r}")


async def _dispatch_director_before_inference(
    callable: str,
    director: str,
    request: Mapping[str, object],
    state: Mapping[str, object],
) -> Mapping[str, object]:
    target = _registered("director", director, callable)
    handler = getattr(target, "before_inference", target)
    event = dict(request)
    event["state"] = dict(state)
    result = handler(event)
    if inspect.isawaitable(result):
        result = await result
    if result is None:
        return {"prepared": "unchanged", "ops": []}
    if not isinstance(result, Mapping):
        raise TypeError("before_inference must return a mapping or None")
    return dict(result)


def _dispatch_director_on_yield(
    callable: str,
    director: str,
    turn: Mapping[str, object],
    state: Mapping[str, object],
) -> Mapping[str, object]:
    target = _registered("director", director, callable)
    handler = getattr(target, "on_yield", target)
    event = dict(turn)
    event["state"] = dict(state)
    result = handler(event)
    if inspect.isawaitable(result):
        raise TypeError("on_yield must be synchronous")
    if isinstance(result, str):
        return {"verdict": result}
    if not isinstance(result, Mapping):
        raise TypeError("on_yield must return a verdict string or mapping")
    return dict(result)


def _dispatch_component_apply(
    callable: str, component: str, entry: Mapping[str, object]
) -> Mapping[str, object]:
    target = _registered("component", component, callable)
    result = target(entry)
    if inspect.isawaitable(result):
        raise TypeError("Component reducers must be synchronous")
    if result is None:
        return {"ops": []}
    if isinstance(result, Mapping):
        return dict(result)
    return {"ops": list(result)}


def _identity(value: str, kind: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{kind} id must be a string")
    if not value or value.strip() != value:
        raise ValueError(f"{kind} id must be non-empty without surrounding whitespace")
    return value


__all__ = ("component", "director")
