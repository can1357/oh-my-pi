"""DOM patch values for journal-derived extension Components.

This module performs no I/O and exposes no extension-owned journal vocabulary.
Component callbacks return ordinary ADR 0003 operations; the host commits them
as one ``patch@1`` entry before applying them to the session DOM.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
import base64
import json
from typing import Any, Generic, TypeVar

from _omp import OmpError, Principal

from ._verdicts import ArtifactRef
from .packages import Provenance

_T = TypeVar("_T")


@dataclass(frozen=True, slots=True, order=True)
class EntryId:
    """Opaque journal entry identity used by read-only projections."""

    session: str
    index: int

    @classmethod
    def parse(cls, value: str) -> EntryId:
        """Parse the retained ``<session>:<index>`` projection identity."""

        if not isinstance(value, str):
            raise TypeError("entry id must be a string")
        session, separator, raw_index = value.rpartition(":")
        if (
            not separator
            or not session
            or not raw_index.isascii()
            or not raw_index.isdecimal()
            or (len(raw_index) > 1 and raw_index.startswith("0"))
        ):
            raise ValueError(f"invalid entry id: {value!r}")
        return cls(session=session, index=int(raw_index))

    def __str__(self) -> str:
        return f"{self.session}:{self.index}"


class JournalError(OmpError):
    """Base error for journal-derived DOM projections."""

    def __init__(self, message: str, *, appended: Iterable[EntryId] = ()) -> None:
        super().__init__(message)
        self.appended = list(appended)


class EntryTooLarge(JournalError):
    """A projected entry exceeds an engine-owned bound."""

    def __init__(self, actual: int, limit: int) -> None:
        self.actual = actual
        self.limit = limit
        super().__init__(f"journal entry is {actual} bytes; limit is {limit}")


class EntryAccessDenied(JournalError):
    """The caller may not read the requested journal projection."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        super().__init__(f"journal projection {kind!r} is not readable")


class JournalIndeterminate(JournalError):
    """A host-owned journal operation's durability could not be proven."""

    def __init__(
        self, operation: str = "journal mutation", *, appended: Iterable[EntryId] = ()
    ) -> None:
        self.operation = operation
        super().__init__(
            f"{operation} has an indeterminate durability outcome", appended=appended
        )


class EntryUndecodable(JournalError):
    """Canonical projection bytes could not be decoded without repair."""

    def __init__(self, raw: bytes, reason: str) -> None:
        self.raw = raw
        self.reason = reason
        super().__init__(f"journal entry bytes are not canonical: {reason}")


@dataclass(frozen=True, slots=True)
class JournalEntry(Generic[_T]):
    """Immutable read-only projection of an engine journal entry."""

    id: EntryId
    kind: str
    rev: str
    ts: int
    principal: Principal
    provenance: Provenance
    value: _T | None
    raw: bytes
    display: bool
    in_context: bool
    artifact: ArtifactRef | None = None


def insert(
    parent: int,
    after: int | None,
    tag: str,
    *,
    props: Mapping[str, object] | None = None,
    content: str | None = None,
) -> list[object]:
    """Build one ``ins`` operation for a Component result."""

    _handle(parent, "parent")
    if after is not None:
        _handle(after, "after")
    if not isinstance(tag, str) or not tag:
        raise TypeError("tag must be a non-empty string")
    node: dict[str, object] = {"tag": tag, "props": dict(props or {}), "kids": []}
    if content is not None:
        if not isinstance(content, str):
            raise TypeError("content must be a string or None")
        node["content"] = content
    return ["ins", parent, after, node]


def remove(handle: int) -> list[object]:
    """Build one ``rm`` operation."""

    _handle(handle, "handle")
    return ["rm", handle]


def set_prop(handle: int, prop: str, value: object) -> list[object]:
    """Build one ``set`` operation."""

    _handle(handle, "handle")
    if not isinstance(prop, str) or not prop:
        raise TypeError("prop must be a non-empty string")
    return ["set", handle, prop, value]


def move(handle: int, parent: int, after: int | None = None) -> list[object]:
    """Build one ``mv`` operation."""

    _handle(handle, "handle")
    _handle(parent, "parent")
    if after is not None:
        _handle(after, "after")
    return ["mv", handle, parent, after]


def patch(*ops: Sequence[object]) -> dict[str, list[list[object]]]:
    """Return the canonical Component callback result for DOM operations."""

    return {"ops": [list(op) for op in ops]}


def decode(raw: bytes) -> Any:
    """Decode exact canonical JSON from a read-only projection."""

    if not isinstance(raw, bytes):
        raise TypeError("journal entry data must be bytes")

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite number {value!r}")

    try:
        value = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
        canonical = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (UnicodeError, ValueError, TypeError, OverflowError) as error:
        raise EntryUndecodable(raw, str(error)) from error
    if canonical != raw:
        raise EntryUndecodable(raw, "encoding differs from canonical JSON")
    return value


def raw_bytes(row: Mapping[str, object]) -> bytes:
    """Read canonical bytes from an engine projection row."""

    raw = row.get("raw")
    if isinstance(raw, bytes):
        return raw
    if isinstance(raw, str):
        return raw.encode("utf-8")
    encoded = row.get("raw_base64")
    if isinstance(encoded, str):
        try:
            return base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise TypeError("journal raw_base64 is invalid") from error
    raise TypeError("journal projection must contain raw canonical JSON")


def _handle(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise TypeError(f"{name} must be a positive integer handle")


__all__ = (
    "EntryAccessDenied",
    "EntryId",
    "EntryTooLarge",
    "EntryUndecodable",
    "JournalEntry",
    "JournalError",
    "JournalIndeterminate",
    "decode",
    "insert",
    "move",
    "patch",
    "raw_bytes",
    "remove",
    "set_prop",
)
