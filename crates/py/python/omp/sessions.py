"""Frozen historical session index, usage, and management surface."""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from _omp import Duration, EnvPath, OmpError, SessionSetup

from ._errors import NotWiredError
from .journal import EntryId, JournalEntry
from ._verdicts import BlobPart, TextPart


class SessionError(OmpError):
    """Base error for historical session operations."""


class SessionAccessDenied(SessionError):
    """The caller may not read the requested historical session."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        super().__init__(f"historical session {session_id!r} is not readable")


class SessionNotFound(OmpError):
    """The requested session does not exist or is not visible to the caller."""

class SessionTransitionDenied(SessionError):
    """Core refused a session transition before creating any durable state."""

    def __init__(
        self, reason: str, *, details: Mapping[str, object] | None = None
    ) -> None:
        self.reason = reason
        self.details = {} if details is None else dict(details)
        super().__init__(reason)


class SessionTransitionIndeterminate(SessionError):
    """Core cannot prove whether a create transaction became durable."""

    def __init__(
        self,
        idempotency_key: str | None,
        reason: str,
        *,
        details: Mapping[str, object] | None = None,
    ) -> None:
        self.idempotency_key = idempotency_key
        self.reason = reason
        self.details = {} if details is None else dict(details)
        super().__init__(reason)


class SessionStatus(StrEnum):
    """Disposition derived from the latest durable turn records."""

    COMPLETE = "complete"
    INTERRUPTED = "interrupted"
    ABORTED = "aborted"
    ERROR = "error"
    PENDING = "pending"
    UNKNOWN = "unknown"


class SessionKind(StrEnum):
    """Runtime role represented by a session index row."""

    INTERACTIVE = "interactive"
    SUBAGENT = "subagent"
    ADVISOR = "advisor"


class TitleSource(StrEnum):
    """Authority that assigned a session title."""

    USER = "user"
    MODEL = "model"
    SYSTEM = "system"


class GroupBy(StrEnum):
    """Available dimensions for indexed usage aggregation."""

    MODEL = "model"
    PROVIDER = "provider"
    PROJECT = "project"
    SESSION = "session"
    KIND = "kind"


class Bucket(StrEnum):
    """Time bucket applied to usage series output."""

    NONE = "none"
    HOUR = "hour"
    DAY = "day"
    WEEK = "week"
    MONTH = "month"


class UsageAccuracy(StrEnum):
    """Provenance of token counts in a usage aggregate."""

    EXACT = "exact"
    ESTIMATED = "estimated"
    MIXED = "mixed"


@dataclass(frozen=True, slots=True)
class Usage:
    """Unabridged token accounting stored in the sessions index."""

    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0
    premium_requests: int = 0
    context: int | None = None
    total: int = 0
    accuracy: UsageAccuracy = UsageAccuracy.EXACT
    detail: Mapping[str, int | str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Cost:
    """Nano-USD cost aggregate with a display-only USD projection."""

    nanos_usd: int = 0
    estimated: bool = False

    input_nanos_usd: int | None = None
    
    output_nanos_usd: int | None = None

    @property
    def usd(self) -> float:
        """Return the display value in USD."""

        return self.nanos_usd / 1_000_000_000


@dataclass(frozen=True, slots=True)
class SessionInfo:
    """Frozen row from the write-time sessions index."""

    id: str
    title: str | None
    title_source: TitleSource
    cwd: EnvPath
    project: str
    created_ms: int
    updated_ms: int
    status: SessionStatus
    kind: SessionKind
    parent: str | None
    entries: int
    turns: int
    usage: Usage
    cost: Cost
    models: Sequence[str]
    remote: bool


@dataclass(frozen=True, slots=True)
class SessionLink:
    """One durable parent relation in a session lineage chain."""

    id: str
    parent: str | None
    at: int | None = None


@dataclass(frozen=True, slots=True)
class SessionNode:
    """One immutable node in a materialized physical session tree."""

    id: EntryId
    parent: EntryId | None
    kind: str
    ts: int
    data: Mapping[str, object]
    label: str | None = None
    children: tuple[SessionNode, ...] = ()


@dataclass(frozen=True, slots=True)
class SessionFilter:
    """Indexed filters for session listing and usage queries."""

    project: str | None = None
    since_ms: int | None = None
    until_ms: int | None = None
    status: Sequence[SessionStatus] | None = None
    kind: Sequence[SessionKind] | None = (SessionKind.INTERACTIVE,)
    contains_kind: str | None = None
    limit: int = 200


@dataclass(frozen=True, slots=True)
class UsageQuery:
    """Grouping and time bounds for a durable usage aggregation."""

    since_ms: int | None = None
    until_ms: int | None = None
    group_by: Sequence[GroupBy] = (GroupBy.MODEL,)
    bucket: Bucket = Bucket.NONE
    filter: SessionFilter | None = None
    include_subagents: bool = True


@dataclass(frozen=True, slots=True)
class UsageBucket:
    """One total, grouping row, or time-series bucket."""

    key: Mapping[str, str]
    start_ms: int | None
    usage: Usage
    cost: Cost
    requests: int
    errors: int
    duration: Duration


@dataclass(frozen=True, slots=True)
class UsageReport:
    """Complete result of one indexed usage query."""

    total: UsageBucket
    groups: Sequence[UsageBucket]
    series: Sequence[UsageBucket]
    sessions: int
    truncated: bool


def _wire_filter(value: SessionFilter | None) -> dict[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, SessionFilter):
        raise TypeError("filter must be an omp.SessionFilter or None")
    return {
        "project": value.project,
        "since_ms": value.since_ms,
        "until_ms": value.until_ms,
        "status": (
            None if value.status is None else [status.value for status in value.status]
        ),
        "kind": None if value.kind is None else [kind.value for kind in value.kind],
        "contains_kind": value.contains_kind,
        "limit": value.limit,
    }


def _wire_query(value: UsageQuery) -> dict[str, object]:
    if not isinstance(value, UsageQuery):
        raise TypeError("query must be an omp.UsageQuery")
    return {
        "since_ms": value.since_ms,
        "until_ms": value.until_ms,
        "group_by": [group.value for group in value.group_by],
        "bucket": value.bucket.value,
        "filter": _wire_filter(value.filter),
        "include_subagents": value.include_subagents,
    }


def _decode_duration(value: object) -> Duration:
    if isinstance(value, Duration):
        return value
    if isinstance(value, Mapping):
        try:
            return Duration(f"{int(value['value'])}{value['unit']}")
        except (KeyError, TypeError, ValueError) as error:
            raise TypeError("usage duration is malformed") from error
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return Duration(
            str(value) if isinstance(value, str) else None,
            seconds=None if isinstance(value, str) else float(value),
        )
    raise TypeError("usage duration is malformed")


def _decode_usage(value: object) -> Usage:
    if isinstance(value, Usage):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("session usage must be a mapping")
    try:
        detail = value.get("detail", {})
        if not isinstance(detail, Mapping):
            raise TypeError("usage detail must be a mapping")
        return Usage(
            input=int(value.get("input", 0)),
            output=int(value.get("output", 0)),
            cache_read=int(value.get("cache_read", 0)),
            cache_write=int(value.get("cache_write", 0)),
            reasoning=int(value.get("reasoning", 0)),
            premium_requests=int(value.get("premium_requests", 0)),
            context=None if value.get("context") is None else int(value["context"]),
            total=int(value.get("total", 0)),
            accuracy=UsageAccuracy(
                str(value.get("accuracy", UsageAccuracy.EXACT.value)).lower()
            ),
            detail=dict(detail),
        )
    except (TypeError, ValueError) as error:
        raise TypeError("session usage response is malformed") from error


def _decode_cost(value: object) -> Cost:
    if isinstance(value, Cost):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("session cost must be a mapping")
    try:
        return Cost(
            nanos_usd=int(value.get("nanos_usd", 0)),
            estimated=bool(value.get("estimated", False)),
            input_nanos_usd=(
                None
                if value.get("input_nanos_usd") is None
                else int(value["input_nanos_usd"])
            ),
            output_nanos_usd=(
                None
                if value.get("output_nanos_usd") is None
                else int(value["output_nanos_usd"])
            ),
        )
    except (TypeError, ValueError) as error:
        raise TypeError("session cost response is malformed") from error


def _decode_session(value: object) -> SessionInfo:
    if isinstance(value, SessionInfo):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("session response must be a mapping")
    try:
        models = value.get("models", ())
        if not isinstance(models, Sequence) or isinstance(
            models, (str, bytes, bytearray)
        ):
            raise TypeError("session models must be a sequence")
        raw_cwd = value["cwd"]
        cwd = raw_cwd if isinstance(raw_cwd, EnvPath) else EnvPath(str(raw_cwd))
        return SessionInfo(
            id=str(value["id"]),
            title=None if value.get("title") is None else str(value["title"]),
            title_source=TitleSource(str(value["title_source"]).lower()),
            cwd=cwd,
            project=str(value["project"]),
            created_ms=int(value["created_ms"]),
            updated_ms=int(value["updated_ms"]),
            status=SessionStatus(str(value["status"]).lower()),
            kind=SessionKind(str(value["kind"]).lower()),
            parent=None if value.get("parent") is None else str(value["parent"]),
            entries=int(value["entries"]),
            turns=int(value["turns"]),
            usage=_decode_usage(value["usage"]),
            cost=_decode_cost(value["cost"]),
            models=tuple(str(model) for model in models),
            remote=bool(value["remote"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("session response is malformed") from error


def _decode_link(value: object) -> SessionLink:
    if isinstance(value, SessionLink):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("session lineage row must be a mapping")
    try:
        return SessionLink(
            id=str(value["id"]),
            parent=None if value.get("parent") is None else str(value["parent"]),
            at=None if value.get("at") is None else int(value["at"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("session lineage row is malformed") from error


def _decode_bucket(value: object) -> UsageBucket:
    if isinstance(value, UsageBucket):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("usage bucket must be a mapping")
    key = value.get("key", {})
    if not isinstance(key, Mapping):
        raise TypeError("usage bucket key must be a mapping")
    try:
        return UsageBucket(
            key={str(name): str(item) for name, item in key.items()},
            start_ms=None if value.get("start_ms") is None else int(value["start_ms"]),
            usage=_decode_usage(value["usage"]),
            cost=_decode_cost(value["cost"]),
            requests=int(value["requests"]),
            errors=int(value["errors"]),
            duration=_decode_duration(value["duration"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("usage bucket response is malformed") from error


def _decode_usage_report(value: object) -> UsageReport:
    if isinstance(value, UsageReport):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("usage report must be a mapping")
    groups = value.get("groups", ())
    series = value.get("series", ())
    if (
        not isinstance(groups, Sequence)
        or isinstance(groups, (str, bytes, bytearray))
        or not isinstance(series, Sequence)
        or isinstance(series, (str, bytes, bytearray))
    ):
        raise TypeError("usage report groups and series must be sequences")
    try:
        return UsageReport(
            total=_decode_bucket(value["total"]),
            groups=tuple(_decode_bucket(row) for row in groups),
            series=tuple(_decode_bucket(row) for row in series),
            sessions=int(value["sessions"]),
            truncated=bool(value["truncated"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("usage report response is malformed") from error


def _decode_entry_id(value: object, session_id: str) -> EntryId:
    if isinstance(value, EntryId):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return EntryId(session_id, value)
    if isinstance(value, str):
        return EntryId.parse(value)
    if isinstance(value, Mapping):
        try:
            return EntryId(str(value.get("session", session_id)), int(value["index"]))
        except (KeyError, TypeError, ValueError) as error:
            raise TypeError("journal entry id is malformed") from error
    raise TypeError("journal entry id is malformed")


def _decode_raw(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    if not isinstance(value, str):
        raise TypeError("journal raw payload must be base64")
    try:
        return base64.b64decode(value, validate=True)
    except ValueError as error:
        raise TypeError("journal raw payload has invalid base64") from error


def _decode_journal_entry(value: object, session_id: str) -> JournalEntry[Any]:
    if isinstance(value, JournalEntry):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("journal entry response must be a mapping")
    artifact = value.get("artifact")
    if artifact is not None:
        from .artifacts import _decode_ref

        artifact = _decode_ref(artifact)
    try:
        return JournalEntry(
            id=_decode_entry_id(value["id"], session_id),
            kind=str(value["kind"]),
            rev=str(value["rev"]),
            ts=int(value["ts"]),
            principal=value.get("principal"),
            provenance=value.get("provenance"),
            value=value.get("value"),
            raw=_decode_raw(value["raw"]),
            display=bool(value.get("display", False)),
            in_context=bool(value.get("in_context", False)),
            artifact=artifact,
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("journal entry response is malformed") from error


def _decode_node(value: object, session_id: str) -> SessionNode:
    if isinstance(value, SessionNode):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("session node response must be a mapping")
    data = value.get("data", {})
    if not isinstance(data, Mapping):
        raise TypeError("session node data must be a mapping")
    try:
        parent = value.get("parent")
        return SessionNode(
            id=_decode_entry_id(value["id"], session_id),
            parent=None if parent is None else _decode_entry_id(parent, session_id),
            kind=str(value["kind"]),
            ts=int(value["ts"]),
            data=dict(data),
            label=None if value.get("label") is None else str(value["label"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise TypeError("session node response is malformed") from error


def current() -> SessionInfo:
    """Read the current session's host-materialized index projection."""

    from . import _control_backend

    backend = _control_backend.get()
    getter = None if backend is None else getattr(backend, "current_session", None)
    if getter is None:
        raise NotWiredError("omp.sessions.current")
    return _decode_session(getter())


async def list(filter: SessionFilter | None = None) -> Sequence[SessionInfo]:
    """List visible sessions by newest indexed activity."""

    rows = await _request("omp.sessions.list", filter=_wire_filter(filter))
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        raise TypeError("session list response must be a sequence")
    return tuple(_decode_session(row) for row in rows)


async def _request(operation: str, /, **arguments: object) -> Any:
    """Dispatch one session operation through the installed CONTROL bridge."""

    from . import _control_backend, _control_request

    if _control_backend.get() is None:
        raise NotWiredError(operation)
    return await _control_request(operation, **arguments)


async def get(session_id: str) -> SessionInfo:
    """Return one visible session's indexed metadata."""

    return _decode_session(
        await _request("omp.sessions.get", session_id=session_id)
    )


async def lineage(session_id: str) -> Sequence[SessionLink]:
    """Return the durable lineage reaching a session, oldest first."""

    rows = await _request("omp.sessions.lineage", session_id=session_id)
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        raise TypeError("session lineage response must be a sequence")
    return tuple(_decode_link(row) for row in rows)


async def resume(session_id: str) -> SessionInfo:
    """Resume an interactive session and journal the host transition receipt."""

    return _decode_session(
        await _request("omp.sessions.resume", session_id=session_id)
    )

def _wire_initial_prompt(value: str | tuple[object, ...] | None) -> object:
    if value is None:
        return None
    if isinstance(value, str):
        return [{"kind": "text", "text": value}]
    if not value:
        raise ValueError("SessionSetup.initial_prompt tuple must not be empty")
    parts: list[dict[str, object]] = []
    for part in value:
        if isinstance(part, TextPart):
            parts.append({"kind": "text", "text": part.text})
        elif isinstance(part, BlobPart):
            from .agents import _wire

            parts.append({"kind": "blob", "blob": _wire(part.blob), "alt": part.alt})
        else:
            raise TypeError(
                "SessionSetup.initial_prompt accepts only omp.Part.text() and omp.Part.blob() values"
            )
    return parts


def _wire_setup(setup: SessionSetup) -> dict[str, object]:
    if not isinstance(setup, SessionSetup):
        raise TypeError("setup must be an omp.SessionSetup")
    return {
        "schema": "omp.sessions.setup.v1",
        "title": setup.title,
        "parent": setup.parent,
        "entries": [],
        "initial_prompt": _wire_initial_prompt(setup.initial_prompt),
    }


async def create(setup: SessionSetup = SessionSetup()) -> SessionInfo:
    """Atomically create, seed, and switch to a top-level interactive session."""

    try:
        return _decode_session(
            await _request("omp.sessions.create", setup=_wire_setup(setup))
        )
    except Exception as error:
        code = getattr(error, "code", None)
        details = getattr(error, "details", None)
        detail = details if isinstance(details, Mapping) else {}
        if code == "SessionTransitionDenied":
            raise SessionTransitionDenied(str(error), details=detail) from error
        if code == "SessionTransitionIndeterminate":
            key = detail.get("idempotency_key")
            raise SessionTransitionIndeterminate(
                None if key is None else str(key),
                str(error),
                details=detail,
            ) from error
        raise


async def rename(session_id: str, title: str) -> SessionInfo:
    """Assign a user title and journal the durable rename receipt."""

    return _decode_session(
        await _request("omp.sessions.rename", session_id=session_id, title=title)
    )


async def delete(session_id: str) -> None:
    """Delete only through a Core-approved policy ticket.

    This operation never bypasses approval.  Without the approval grant the
    Core rejects the request with :class:`omp.PermissionDenied`.
    """

    await _request("omp.sessions.delete", session_id=session_id)


async def usage(query: UsageQuery) -> UsageReport:
    """Aggregate token and cost usage from the write-time index."""

    return _decode_usage_report(
        await _request("omp.sessions.usage", query=_wire_query(query))
    )


def _wire_bound(value: object | None, session_id: str, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, EntryId):
        if value.session != session_id:
            raise ValueError(f"{name} belongs to a different session")
        return value.index
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    raise TypeError(f"{name} must be an EntryId, non-negative int, or None")


async def journal(
    session_id: str,
    *,
    kinds: Sequence[str] | None = None,
    since: object | None = None,
    until: object | None = None,
    live: bool = True,
) -> AsyncIterator[Any]:
    """Stream decoded historical entries in bounded authoritative pages."""

    cursor: str | None = None
    while True:
        response = await _request(
            "omp.sessions.journal",
            session_id=session_id,
            kinds=None if kinds is None else [str(kind) for kind in kinds],
            since=_wire_bound(since, session_id, "since"),
            until=_wire_bound(until, session_id, "until"),
            live=bool(live),
            cursor=cursor,
        )
        if not isinstance(response, Mapping):
            raise TypeError("session journal response must be a page mapping")
        rows = response.get("entries", ())
        if not isinstance(rows, Sequence) or isinstance(
            rows, (str, bytes, bytearray)
        ):
            raise TypeError("session journal page entries must be a sequence")
        for row in rows:
            yield _decode_journal_entry(row, session_id)
        if bool(response.get("done", False)):
            return
        next_cursor = response.get("cursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
            raise TypeError("session journal page omitted its continuation cursor")
        cursor = next_cursor

async def _structure(session_id: str) -> tuple[tuple[SessionNode, ...], EntryId | None]:
    cursor: str | None = None
    nodes: list[SessionNode] = []
    leaf: EntryId | None = None
    while True:
        response = await _request(
            "omp.sessions.journal",
            session_id=session_id,
            structure=True,
            cursor=cursor,
        )
        if not isinstance(response, Mapping):
            raise TypeError("session structure response must be a page mapping")
        rows = response.get("entries", ())
        if not isinstance(rows, Sequence) or isinstance(
            rows, (str, bytes, bytearray)
        ):
            raise TypeError("session structure page entries must be a sequence")
        nodes.extend(_decode_node(row, session_id) for row in rows)
        raw_leaf = response.get("leaf")
        if raw_leaf is not None:
            leaf = _decode_entry_id(raw_leaf, session_id)
        if bool(response.get("done", False)):
            return tuple(nodes), leaf
        next_cursor = response.get("cursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
            raise TypeError("session structure page omitted its continuation cursor")
        cursor = next_cursor


async def tree(session_id: str | None = None) -> tuple[SessionNode, ...]:
    """Materialize the physical session tree, returning every orphan as a root."""

    selected = current().id if session_id is None else str(session_id)
    nodes, _leaf = await _structure(selected)
    by_id = {node.id: node for node in nodes}
    children: dict[EntryId, list[SessionNode]] = {}
    roots: list[SessionNode] = []
    for node in nodes:
        if node.parent is None or node.parent not in by_id:
            roots.append(node)
        else:
            children.setdefault(node.parent, []).append(node)

    seen: set[EntryId] = set()

    def materialize(node: SessionNode, visiting: frozenset[EntryId]) -> SessionNode:
        if node.id in visiting:
            return node
        seen.add(node.id)
        branch = visiting | {node.id}
        return SessionNode(
            id=node.id,
            parent=node.parent,
            kind=node.kind,
            ts=node.ts,
            data=node.data,
            label=node.label,
            children=tuple(
                materialize(child, branch)
                for child in children.get(node.id, ())
                if child.id not in branch
            ),
        )

    result = [materialize(root, frozenset()) for root in roots]
    result.extend(
        materialize(node, frozenset())
        for node in nodes
        if node.id not in seen
    )
    return tuple(result)


async def branch(from_id: EntryId | int | None = None) -> tuple[SessionNode, ...]:
    """Materialize one root-first physical branch, defaulting to the live leaf."""

    if isinstance(from_id, EntryId):
        session_id = from_id.session
        target = from_id
    else:
        session_id = current().id
        if from_id is not None and (
            not isinstance(from_id, int) or isinstance(from_id, bool) or from_id < 0
        ):
            raise TypeError("from_id must be an EntryId, non-negative int, or None")
        target = None if from_id is None else EntryId(session_id, from_id)
    nodes, leaf = await _structure(session_id)
    cursor = leaf if target is None else target
    by_id = {node.id: node for node in nodes}
    path: list[SessionNode] = []
    seen: set[EntryId] = set()
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        node = by_id.get(cursor)
        if node is None:
            break
        path.append(node)
        cursor = node.parent
    path.reverse()
    return tuple(path)


__all__ = (
    "Bucket", "Cost", "GroupBy", "SessionAccessDenied", "SessionError",
    "SessionFilter", "SessionInfo", "SessionKind", "SessionLink", "SessionNotFound",
    "SessionNode",
    "SessionSetup", "SessionStatus", "SessionTransitionDenied",
    "SessionTransitionIndeterminate", "TitleSource", "Usage",
    "UsageAccuracy", "UsageBucket", "UsageQuery", "UsageReport", "create", "current", "delete",
    "get", "journal", "lineage", "list", "rename", "resume", "usage",
    "branch", "tree",
)
