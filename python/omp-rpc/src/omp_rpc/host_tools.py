from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Generic, TypeAlias, TypeVar, TypedDict, cast

from .protocol import ImageContent, JsonObject, JsonValue, TextContent

TParams = TypeVar("TParams")
TDetails = TypeVar("TDetails")


class HostToolResultPayload(TypedDict, total=False):
    content: list[TextContent | ImageContent]
    details: JsonValue


HostToolResultValue: TypeAlias = HostToolResultPayload | str


def _normalize_result(result: HostToolResultValue) -> JsonObject:
    if isinstance(result, str):
        return {"content": [{"type": "text", "text": result}]}
    return dict(result)


@dataclass(slots=True)
class HostToolContext(Generic[TDetails]):
    tool_call_id: str
    _cancel_event: threading.Event
    _send_update: Callable[[JsonObject], None]

    @property
    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def send_update(self, result: HostToolResultValue) -> None:
        if self.cancelled:
            return
        self._send_update(_normalize_result(result))


@dataclass(slots=True, frozen=True)
class HostTool(Generic[TParams, TDetails]):
    name: str
    description: str
    parameters: JsonObject
    execute: Callable[[TParams, HostToolContext[TDetails]], HostToolResultValue]
    label: str | None = None
    hidden: bool = False
    decode: Callable[[JsonObject], TParams] | None = None

    def parse_params(self, payload: JsonObject) -> TParams:
        if self.decode is not None:
            return self.decode(payload)
        return cast(TParams, payload)

    def normalize_result(self, result: HostToolResultValue) -> JsonObject:
        return _normalize_result(result)


def host_tool(
    *,
    name: str,
    description: str,
    parameters: JsonObject,
    execute: Callable[[TParams, HostToolContext[TDetails]], HostToolResultValue],
    label: str | None = None,
    hidden: bool = False,
    decode: Callable[[JsonObject], TParams] | None = None,
) -> HostTool[TParams, TDetails]:
    return HostTool(
        name=name,
        description=description,
        parameters=dict(parameters),
        execute=execute,
        label=label,
        hidden=hidden,
        decode=decode,
    )
