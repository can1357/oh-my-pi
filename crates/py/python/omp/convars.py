"""Typed declarations, queries, and observations for the shared control plane."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from . import _control_backend, _control_request
from ._errors import NotWiredError


@dataclass(frozen=True, slots=True)
class Snapshot:
    """One effective convar value at a monotonic change sequence."""

    name: str
    kind: str
    value: object
    sequence: int


def _name(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string")
    return value


def _snapshot(value: object) -> Snapshot:
    if not isinstance(value, dict):
        raise TypeError("convar CONTROL response must be a mapping")
    name = _name(value.get("name"), "convar name")
    kind = _name(value.get("kind"), "convar kind")
    sequence = value.get("sequence")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise TypeError("convar sequence must be a non-negative integer")
    return Snapshot(name, kind, value.get("value"), sequence)


async def declare(
    key: str,
    *,
    kind: str,
    default: object,
    description: str | None = None,
    values: Sequence[str] = (),
    ui: Mapping[str, object] | None = None,
) -> Snapshot:
    """Declare one extension-owned dynamic convar.

    The host qualifies ``key`` with the authenticated extension identity.
    Repeating an identical declaration after reconnect is idempotent; changing
    it is rejected by the authoritative control plane.
    """

    _name(key, "convar key")
    if kind not in {"boolean", "number", "string", "enum"}:
        raise ValueError("kind must be 'boolean', 'number', 'string', or 'enum'")
    if description is not None and not isinstance(description, str):
        raise TypeError("description must be str or None")
    values = tuple(values)
    if any(not isinstance(value, str) or not value for value in values):
        raise TypeError("values must contain non-empty strings")
    if kind == "enum" and not values:
        raise ValueError("enum convars require values")
    if kind != "enum" and values:
        raise ValueError("values are valid only for enum convars")
    if ui is not None and not isinstance(ui, Mapping):
        raise TypeError("ui must be a mapping or None")
    if _control_backend.get() is None:
        raise NotWiredError("omp.convars.declare")
    return _snapshot(
        await _control_request(
            "omp.convars.declare",
            key=key,
            kind=kind,
            default=default,
            description=description,
            values=values,
            ui=dict(ui) if ui is not None else None,
        )
    )


async def get(name: str) -> Snapshot:
    """Read one declared harness or extension convar by canonical name."""

    _name(name, "convar name")
    if _control_backend.get() is None:
        raise NotWiredError("omp.convars.get")
    return _snapshot(await _control_request("omp.convars.get", name=name))


class Observation(AsyncIterator[Snapshot]):
    """Long-polling async iterator over committed changes to one convar."""

    __slots__ = ("_name", "_sequence")

    def __init__(self, name: str) -> None:
        self._name = _name(name, "convar name")
        self._sequence: int | None = None

    def __aiter__(self) -> Observation:
        return self

    async def __anext__(self) -> Snapshot:
        if _control_backend.get() is None:
            raise NotWiredError("omp.convars.observe")
        snapshot = _snapshot(
            await _control_request(
                "omp.convars.observe",
                name=self._name,
                after=self._sequence,
            )
        )
        self._sequence = snapshot.sequence
        return snapshot


def observe(name: str) -> Observation:
    """Observe the current value and every subsequent committed change."""

    return Observation(name)


__all__ = ("Observation", "Snapshot", "declare", "get", "observe")
