"""Typed Python client for the omp RPC protocol.

Wire types, decoders, and command methods are generated into `_wire` from the
RPC wire schema (`bun run gen:rpc`); this module re-exports that surface with
the hand-written client, host tool/URI helpers, and text helpers.
"""

from . import _wire
from ._extension_ui import (
    INTERACTIVE_EXTENSION_UI_METHODS,
    PASSIVE_EXTENSION_UI_METHODS,
    VALUE_EXTENSION_UI_METHODS,
)
from ._wire import *  # noqa: F403 - generated surface, bounded by `_wire.__all__`
from ._wire_runtime import JsonObject, JsonPrimitive, JsonValue, UnknownNotification
from .client import (
    AgentEventListener,
    HostToolCompletedEvent,
    HostToolCompletedListener,
    ListenerErrorEvent,
    ListenerErrorListener,
    NotificationListener,
    PromptTurn,
    ProtocolErrorListener,
    RpcClient,
    RpcCommandError,
    RpcConcurrencyError,
    RpcError,
    RpcProcessExitError,
    RpcProtocolError,
    RpcTimeoutError,
    UiRequestListener,
)
from .host_tools import (
    HostTool,
    HostToolContext,
    HostToolResultPayload,
    HostToolResultValue,
    host_tool,
)
from .host_uris import (
    HostUri,
    HostUriContentType,
    HostUriContext,
    HostUriReadHandler,
    HostUriReadResult,
    HostUriReadValue,
    HostUriWriteHandler,
    host_uri,
)
from .protocol import (
    assistant_text,
    assistant_text_with_thinking,
    image_from_path,
    message_text,
    message_text_with_thinking,
)

__all__ = [
    "AgentEventListener",
    "HostTool",
    "HostToolContext",
    "HostToolResultPayload",
    "HostToolResultValue",
    "HostUri",
    "HostUriContentType",
    "HostUriContext",
    "HostUriReadHandler",
    "HostUriReadResult",
    "HostUriReadValue",
    "HostUriWriteHandler",
    "INTERACTIVE_EXTENSION_UI_METHODS",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "HostToolCompletedEvent",
    "HostToolCompletedListener",
    "ListenerErrorEvent",
    "ListenerErrorListener",
    "NotificationListener",
    "PASSIVE_EXTENSION_UI_METHODS",
    "PromptTurn",
    "ProtocolErrorListener",
    "RpcClient",
    "RpcCommandError",
    "RpcConcurrencyError",
    "RpcError",
    "RpcProcessExitError",
    "RpcProtocolError",
    "RpcTimeoutError",
    "UiRequestListener",
    "UnknownNotification",
    "VALUE_EXTENSION_UI_METHODS",
    "assistant_text",
    "assistant_text_with_thinking",
    "host_tool",
    "host_uri",
    "image_from_path",
    "message_text",
    "message_text_with_thinking",
]
__all__ += _wire.__all__
