from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable, Generic, Literal, TypeAlias, TypeVar, TypedDict

from .protocol import JsonObject

TPayload = TypeVar("TPayload")


HostUriContentType: TypeAlias = Literal[
    "text/markdown", "application/json", "text/plain"
]


class HostUriReadResult(TypedDict, total=False):
    """Structured response a `read` handler may return.

    Plain strings are also accepted; they are normalized to `{"content": <str>}`.
    """

    content: str
    content_type: HostUriContentType
    notes: list[str]
    immutable: bool


HostUriReadValue: TypeAlias = HostUriReadResult | str


@dataclass(slots=True)
class HostUriContext:
    """Per-request context passed to host URI handlers.

    Mirrors the cancellation hooks `HostToolContext` exposes for parity, so
    handlers can poll for cancellation when serving long-running reads/writes.
    """

    url: str
    operation: Literal["read", "write"]
    _cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def cancelled(self) -> bool:
        return self._cancel_event.is_set()


HostUriReadHandler: TypeAlias = Callable[[str, HostUriContext], HostUriReadValue]
HostUriWriteHandler: TypeAlias = Callable[[str, str, HostUriContext], None]


@dataclass(slots=True, frozen=True)
class HostUri(Generic[TPayload]):
    """Definition of a custom URI scheme served by the Python host.

    Hosts register a `HostUri` per scheme. The bridge dispatches `<scheme>://`
    URLs the agent reads (and, when `write` is provided, writes) to the
    matching callbacks. The agent's `edit` tool is not supported for virtual
    URIs — hosts that want to mutate virtual files expose a `write` handler
    and let the model use the `write` tool with the full replacement content.
    """

    scheme: str
    read: HostUriReadHandler
    write: HostUriWriteHandler | None = None
    description: str | None = None
    immutable: bool = False

    @property
    def writable(self) -> bool:
        return self.write is not None


def host_uri(
    *,
    scheme: str,
    read: HostUriReadHandler,
    write: HostUriWriteHandler | None = None,
    description: str | None = None,
    immutable: bool = False,
) -> HostUri[None]:
    cleaned = (scheme or "").strip().lower()
    if not cleaned:
        raise ValueError("scheme must be a non-empty string")
    return HostUri(
        scheme=cleaned,
        read=read,
        write=write,
        description=description,
        immutable=immutable,
    )


def normalize_read_result(value: HostUriReadValue) -> JsonObject:
    """Convert a handler's `read` return into the wire-frame fields.

    Returns a dict suitable for spreading into a `host_uri_result` payload.
    """

    if isinstance(value, str):
        return {"content": value}
    if not isinstance(value, dict):
        raise TypeError(
            "Host URI read handlers must return a string or a HostUriReadResult mapping"
        )

    payload: JsonObject = {}
    if "content" not in value:
        raise ValueError("HostUriReadResult requires a 'content' field")
    payload["content"] = str(value["content"])

    content_type = value.get("content_type")
    if content_type is not None:
        if content_type not in ("text/markdown", "application/json", "text/plain"):
            raise ValueError(f"Unsupported content_type: {content_type!r}")
        payload["contentType"] = content_type

    notes = value.get("notes")
    if notes is not None:
        payload["notes"] = [str(item) for item in notes]

    if "immutable" in value:
        payload["immutable"] = bool(value["immutable"])

    return payload
