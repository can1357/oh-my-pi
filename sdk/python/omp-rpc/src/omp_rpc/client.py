from __future__ import annotations

import base64
import binascii
import json
import os
import queue
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generic, Mapping, Sequence, TypeVar, cast

from ._wire import (
    _TODO_STATUS_VALUES,
    AgentEndEvent,
    AgentMessage,
    AgentStartEvent,
    AskAnswer,
    AssistantMessage,
    ExtensionUiRequest,
    ImageContent,
    MessageEndEvent,
    PromptResultEvent,
    ReadyEvent,
    RpcAgentEvent,
    RpcNotification,
    SessionSettledEvent,
    StreamingBehavior,
    ThinkingLevel,
    TodoItem,
    TodoPhase,
    TodoStatus,
    WireClient,
    parse_agent_message,
    parse_notification,
    parse_todo_phase,
)
from ._wire_runtime import (
    JsonObject,
    JsonValue,
    UnknownNotification,
    array,
    decode_str,
    expect_object,
    required,
)
from .host_tools import HostTool, HostToolContext
from .host_uris import HostUri, HostUriContext, normalize_read_result
from .protocol import assistant_text

AgentEventListener = Callable[[RpcAgentEvent], None]
NotificationListener = Callable[[RpcNotification], None]
UiRequestListener = Callable[[ExtensionUiRequest], None]
ProtocolErrorListener = Callable[["RpcProtocolError"], None]
ListenerErrorListener = Callable[["ListenerErrorEvent"], None]
HostToolCompletedListener = Callable[["HostToolCompletedEvent"], None]
TListener = TypeVar("TListener")
THistoryItem = TypeVar("THistoryItem")

_ASYNC_COMMANDS = frozenset({"prompt", "abort_and_prompt"})
_DEFAULT_ERROR_HISTORY_LIMIT = 128
_MAX_RPC_FRAME_BYTES = 1024 * 1024
_MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024
_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024
_RPC_MESSAGES_PAGE_BUSY_ERROR = "Cannot page messages while the session is changing"
_RPC_MESSAGES_PAGE_STALE_ERROR = "RPC message cursor is stale"
_RPC_MESSAGES_PAGE_FALLBACK_CODES = frozenset({"session_busy", "stale_cursor"})


@dataclass(slots=True)
class _PendingRpcChunks:
    chunk_id: str
    count: int
    byte_length: int
    next_index: int = 0
    chunks: list[bytes] = field(default_factory=list)
    received_bytes: int = 0


class _RpcFrameDecoder:
    def __init__(self) -> None:
        self._pending: _PendingRpcChunks | None = None

    def push(self, value: object) -> JsonObject | None:
        if not isinstance(value, dict) or value.get("type") != "rpc_chunk":
            if self._pending is not None:
                raise RpcError("RPC chunk sequence was interrupted")
            if not isinstance(value, dict):
                raise RpcError("RPC frame must be a JSON object")
            return cast(JsonObject, value)

        chunk_id = value.get("chunkId")
        index = value.get("index")
        count = value.get("count")
        byte_length = value.get("byteLength")
        data = value.get("data")
        max_chunk_count = (
            _MAX_RPC_REASSEMBLED_BYTES + _RPC_CHUNK_PAYLOAD_BYTES - 1
        ) // _RPC_CHUNK_PAYLOAD_BYTES
        if (
            not isinstance(chunk_id, str)
            or not chunk_id
            or len(chunk_id) > 128
            or not isinstance(index, int)
            or isinstance(index, bool)
            or not isinstance(count, int)
            or isinstance(count, bool)
            or not isinstance(byte_length, int)
            or isinstance(byte_length, bool)
            or index < 0
            or count < 2
            or count > max_chunk_count
            or index >= count
            or byte_length < _MAX_RPC_FRAME_BYTES
            or byte_length > _MAX_RPC_REASSEMBLED_BYTES
            or not isinstance(data, str)
            or not data
        ):
            raise RpcError("Invalid RPC chunk metadata")
        try:
            chunk = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RpcError("Invalid RPC chunk data") from exc
        if base64.b64encode(chunk).decode("ascii") != data:
            raise RpcError("Invalid RPC chunk data")
        if len(chunk) > _RPC_CHUNK_PAYLOAD_BYTES:
            raise RpcError("RPC chunk payload exceeds the transport limit")

        if self._pending is None:
            if index != 0:
                raise RpcError("RPC chunk sequence must start at index 0")
            self._pending = _PendingRpcChunks(chunk_id, count, byte_length)
        pending = self._pending
        if (
            pending.chunk_id != chunk_id
            or pending.count != count
            or pending.byte_length != byte_length
            or pending.next_index != index
        ):
            raise RpcError("RPC chunk sequence mismatch")
        pending.chunks.append(chunk)
        pending.received_bytes += len(chunk)
        pending.next_index += 1
        if pending.received_bytes > pending.byte_length:
            raise RpcError("RPC chunk sequence exceeds its declared length")
        if pending.next_index < pending.count:
            return None
        if pending.received_bytes != pending.byte_length:
            raise RpcError("RPC chunk sequence length mismatch")

        self._pending = None
        try:
            decoded = b"".join(pending.chunks).decode("utf-8")
            frame = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RpcError("Failed to decode reassembled RPC frame") from exc
        if not isinstance(frame, dict):
            raise RpcError("RPC frame must be a JSON object")
        return cast(JsonObject, frame)


def _process_group_id(process: subprocess.Popen[Any]) -> int | None:
    """Process-group id of `process`, or `None` when groups are unavailable.

    Captured right after spawn so teardown can signal the whole group even
    after the leader is reaped — POSIX `os.getpgid` fails on a reaped pid.
    """
    getpgid = getattr(os, "getpgid", None)
    if getpgid is None:
        return None
    try:
        return getpgid(process.pid)
    except OSError:
        return None


# After SIGKILL, killed descendants linger as dying processes or zombies until
# their (re)parent reaps them, so the group probe needs a short settle window
# before a still-visible member means a real survivor.
_KILL_SETTLE_TIMEOUT = 1.0
_KILL_SETTLE_POLL_INTERVAL = 0.02


def _terminate_process_group(process: subprocess.Popen[Any], pgid: int | None) -> bool:
    """Terminate the subprocess *and* every descendant sharing its group.

    omp is spawned with `start_new_session=True`, so it leads a session/group
    that also contains children spawned by the agent's `bash` tool (e.g. a
    `bun test` run). Signalling only the leader pid would orphan those
    grandchildren: they reparent to the container init and keep running
    untracked — how a runaway test ballooned to tens of GB of RAM. Signal the
    whole group, escalating SIGTERM -> SIGKILL, so descendants die with the
    task even when the leader has already exited on its own (the graceful
    stdin-close path).

    `pgid` is captured at spawn; `os.killpg` is POSIX-only, so without it
    (Windows) we fall back to terminating the leader process alone.

    Returns `True` only when teardown is *confirmed*: the leader has exited and,
    where a process group is available, the group is empty. An already-empty
    group is detected before any signal is sent, so a re-reap never signals a
    pgid that may since have been reused. After SIGKILL the group gets a short
    settle window (`_KILL_SETTLE_TIMEOUT`) for killed members to be reaped.
    Returns `False` when a survivor remains after that — e.g. a child in
    uninterruptible sleep whose pending SIGKILL cannot land until it leaves that
    state. Callers MUST retain the handle/pgid on `False` so the survivor stays
    observable and can be reaped by a later pass; a swallowed timeout here is how
    a multi-GB child outlived its task's hard timeout, unreaped and still holding
    a concurrency slot.
    """
    killpg = getattr(os, "killpg", None)

    def _leader_exited() -> bool:
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            return False
        return True

    if pgid is None or killpg is None:
        if process.poll() is not None:
            return True
        process.terminate()
        if _leader_exited():
            return True
        process.kill()
        return _leader_exited()

    def _signal_group(sig: int) -> None:
        try:
            killpg(pgid, sig)
        except OSError:
            # ESRCH: the group is already empty. The return value below, not this
            # best-effort signal, reports whether teardown actually succeeded.
            pass

    def _group_gone() -> bool:
        # Signal 0 probes the group without touching it: ESRCH means no member
        # survives. A living member — signalable, or present-but-EPERM — means
        # teardown has not completed.
        try:
            killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        return False

    if process.poll() is not None and _group_gone():
        return True
    _signal_group(signal.SIGTERM)
    if _leader_exited() and _group_gone():
        return True
    _signal_group(signal.SIGKILL)
    if not _leader_exited():
        return False
    deadline = time.monotonic() + _KILL_SETTLE_TIMEOUT
    while not _group_gone():
        if time.monotonic() >= deadline:
            return False
        time.sleep(_KILL_SETTLE_POLL_INTERVAL)
    return True


def _clone_json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return cast(JsonValue, value)
    if isinstance(value, list):
        return [_clone_json_value(item) for item in value]
    if isinstance(value, dict):
        cloned: JsonObject = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise RpcError("RPC payload objects must use string keys")
            cloned[key] = _clone_json_value(item)
        return cloned
    raise RpcError("RPC payload must be JSON-serializable")


def _clone_json_object(value: object) -> JsonObject:
    if not isinstance(value, dict):
        raise RpcError("RPC response payload must be an object")
    return cast(JsonObject, _clone_json_value(value))


class RpcError(RuntimeError):
    """Base exception for the Python RPC client."""


class RpcTimeoutError(RpcError):
    """Raised when the server does not respond before a timeout."""


class RpcProcessExitError(RpcError):
    """Raised when the RPC process exits while a request is pending."""


class RpcConcurrencyError(RpcError):
    """Raised when overlapping prompt lifecycle collectors would be ambiguous."""


class RpcCommandError(RpcError):
    """Raised when the RPC server returns `success: false`.

    `code` carries the server's machine-readable error code when present.
    """

    def __init__(self, command: str, error: str, code: str | None = None):
        super().__init__(f"{command}: {error}")
        self.command = command
        self.error = error
        self.code = code


class RpcProtocolError(RpcError):
    """Raised or reported when the transport receives an unmatched RPC error response."""

    def __init__(self, payload: JsonObject):
        self.payload = dict(payload)
        command = payload.get("command")
        request_id = payload.get("id")
        error = payload.get("error")
        self.command = str(command) if isinstance(command, str) else None
        self.request_id = str(request_id) if isinstance(request_id, str) else None
        self.remote_error = str(error) if isinstance(error, str) else None

        fragments = ["Received unmatched RPC error response"]
        if self.command:
            fragments.append(f"for {self.command}")
        if self.request_id:
            fragments.append(f"(id={self.request_id})")
        if self.remote_error:
            fragments.append(f": {self.remote_error}")
        super().__init__(" ".join(fragments))


@dataclass(slots=True, frozen=True)
class ListenerErrorEvent:
    listener_kind: str
    source_type: str | None
    listener: Callable[..., None]
    error: BaseException


@dataclass(slots=True, frozen=True)
class HostToolCompletedEvent:
    """A registered host tool's `execute()` returned without raising.

    Emitted by `RpcClient.on_host_tool_completed` for every dispatch path —
    top-level call, `xd://` device write, or the eval bridge — unlike
    `tool_execution_end`, which only names the transport tool the agent
    invoked. `tool_call_id` is the id omp dispatched with; for eval-bridged
    calls it is synthetic and matches no `tool_execution_*` event.
    """

    tool_name: str
    tool_call_id: str



@dataclass(slots=True, frozen=True)
class PromptTurn:
    events: tuple[RpcAgentEvent, ...]
    messages: tuple[AgentMessage, ...]
    assistant_message: AssistantMessage | None
    assistant_text: str | None
    result: PromptResultEvent | None = None
    """The prompt's own `prompt_result`; None when the server handled the prompt
    locally and answered `agentInvoked: false` without emitting one."""

    def require_assistant_text(self) -> str:
        if self.assistant_text is None:
            raise RpcError("Prompt completed without a text assistant message")
        return self.assistant_text


TodoSeed = str | TodoItem | Mapping[str, object]
TodoPhaseSeed = TodoPhase | Mapping[str, object]


@dataclass(slots=True)
class _PendingRequest:
    command: str
    response_queue: queue.Queue[JsonObject | BaseException]


@dataclass(slots=True)
class _PendingHostToolCall:
    cancel_event: threading.Event


@dataclass(slots=True)
class _PendingHostUriRequest:
    cancel_event: threading.Event


@dataclass(slots=True)
class _BoundedHistory(Generic[THistoryItem]):
    limit: int | None
    items: list[THistoryItem] = field(default_factory=list)
    offset: int = 0

    def clear(self) -> None:
        self.items.clear()
        self.offset = 0

    def append(self, item: THistoryItem) -> None:
        self.items.append(item)
        if self.limit is not None and len(self.items) > self.limit:
            trim = len(self.items) - self.limit
            del self.items[:trim]
            self.offset += trim

    def current_index(self) -> int:
        return self.offset + len(self.items)

    def snapshot(self) -> tuple[THistoryItem, ...]:
        return tuple(self.items)

    def snapshot_from(self, start_index: int) -> tuple[THistoryItem, ...]:
        return tuple(self.items[start_index - self.offset :])


@dataclass(slots=True)
class _PromptLifecycleCoordinator:
    lock: threading.Lock = field(default_factory=threading.Lock)
    active_operation: str | None = None

    def acquire(self, operation: str) -> None:
        with self.lock:
            if self.active_operation is not None:
                raise RpcConcurrencyError(
                    f"Cannot start {operation} while {self.active_operation} is already collecting prompt lifecycle events"
                )
            self.active_operation = operation

    def release(self, operation: str) -> None:
        with self.lock:
            if self.active_operation == operation:
                self.active_operation = None


class RpcClient(WireClient):
    """Process-backed RPC client.

    Command methods and per-frame `on_<type>` listeners come from the generated
    `WireClient`; this class owns the transport, prompt lifecycle, extension UI,
    and host tool/URI dispatch.
    """

    def __init__(
        self,
        *,
        command: Sequence[str] | None = None,
        executable: str = "omp",
        provider: str | None = None,
        model: str | None = None,
        session_dir: str | Path | None = None,
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        user: int | str | None = None,
        group: int | str | None = None,
        extra_groups: Sequence[int | str] | None = None,
        thinking: ThinkingLevel | None = None,
        append_system_prompt: str | None = None,
        provider_session_id: str | None = None,
        tools: Sequence[str] | None = None,
        custom_tools: Sequence[HostTool[Any, Any]] | None = None,
        host_uris: Sequence[HostUri[Any]] | None = None,
        no_session: bool = False,
        no_skills: bool = False,
        no_rules: bool = False,
        no_title: bool | None = None,
        no_ui: bool = False,
        rpc_defaults: bool = True,
        extra_args: Sequence[str] = (),
        startup_timeout: float = 30.0,
        request_timeout: float = 30.0,
        max_event_history: int | None = 10_000,
        max_stderr_chunks: int | None = 512,
    ) -> None:
        self._argv = tuple(command) if command is not None else None
        self._executable = executable
        self._provider = provider
        self._model = model
        self._session_dir = Path(session_dir) if session_dir is not None else None
        self._cwd = Path(cwd) if cwd is not None else None
        self._env = dict(env or {})
        self._user = user
        self._group = group
        self._extra_groups = list(extra_groups) if extra_groups is not None else None
        self._thinking = thinking
        self._append_system_prompt = append_system_prompt
        self._provider_session_id = provider_session_id
        self._tools = tuple(tools) if tools is not None else None
        self._custom_tools = tuple(custom_tools) if custom_tools is not None else ()
        self._host_uris = tuple(host_uris) if host_uris is not None else ()
        self._no_session = no_session
        self._no_skills = no_skills
        self._no_rules = no_rules
        self._no_title = no_title
        self._no_ui = no_ui
        self._rpc_defaults = rpc_defaults
        self._extra_args = tuple(extra_args)
        self._startup_timeout = startup_timeout
        self._request_timeout = request_timeout
        self._max_event_history = self._validate_history_limit(
            "max_event_history", max_event_history
        )
        self._max_stderr_chunks = self._validate_history_limit(
            "max_stderr_chunks", max_stderr_chunks
        )

        self._process: subprocess.Popen[str] | None = None
        self._pgid: int | None = None
        # Children that outlived teardown (SIGKILL still pending against an
        # uninterruptible-sleep process), with their pgids. Every one is kept —
        # a restart followed by another stop() must not drop an earlier child —
        # so `reap()` can re-attempt and each stays observable via
        # `survivor_pids`.
        self._survivors: list[tuple[subprocess.Popen[str], int | None]] = []
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._event_condition = threading.Condition()
        self._pending: dict[str, _PendingRequest] = {}
        self._pending_host_tool_calls: dict[str, _PendingHostToolCall] = {}
        self._host_tool_dispatch_names: dict[str, str] = {}
        self._pending_host_uri_requests: dict[str, _PendingHostUriRequest] = {}
        self._request_id = 0
        self._events = _BoundedHistory[JsonObject](self._max_event_history)
        self._async_errors = _BoundedHistory[BaseException](
            _DEFAULT_ERROR_HISTORY_LIMIT
        )
        # Accepted prompt request ids still awaiting their `prompt_result`.
        self._pending_prompt_ids: set[str] = set()
        # `prompt_and_wait` slots keyed by request id: the prompt's result and
        # the event-history index at which it arrived, once received.
        self._prompt_results: dict[str, tuple[PromptResultEvent, int] | None] = {}
        self._last_schedule_async_error_index = 0
        # Number of `session_settled` frames received; `wait_for_settled` waits for it to advance.
        self._session_settled_count = 0
        self._ui_requests: queue.Queue[ExtensionUiRequest] = queue.Queue()
        self._stderr_chunks = _BoundedHistory[str](self._max_stderr_chunks)
        self._closed_error: BaseException | None = None
        self._stopping = False
        self._ready_received = False
        self._ready_event: ReadyEvent | None = None
        self._protocol_version = 1
        self._protocol_v2_enabled = False
        self._frame_decoder = _RpcFrameDecoder()
        self._protocol_errors = _BoundedHistory[RpcProtocolError](
            _DEFAULT_ERROR_HISTORY_LIMIT
        )
        self._listener_errors = _BoundedHistory[ListenerErrorEvent](
            _DEFAULT_ERROR_HISTORY_LIMIT
        )
        self._prompt_lifecycle = _PromptLifecycleCoordinator()

        self._notification_listeners: list[NotificationListener] = []
        self._event_listeners: list[AgentEventListener] = []
        # Frame `type` → listeners registered through the generated `on_<type>` methods.
        self._typed_listeners: dict[str, list[Callable[..., None]]] = {}
        self._protocol_error_listeners: list[ProtocolErrorListener] = []
        self._listener_error_listeners: list[ListenerErrorListener] = []
        self._host_tool_completed_listeners: list[HostToolCompletedListener] = []

    def __enter__(self) -> RpcClient:
        return self.start()

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.stop()

    @property
    def stderr(self) -> str:
        with self._state_lock:
            return "".join(self._stderr_chunks.snapshot())

    @property
    def command(self) -> tuple[str, ...]:
        return self._build_command()

    @property
    def protocol_errors(self) -> tuple[RpcProtocolError, ...]:
        with self._state_lock:
            return self._protocol_errors.snapshot()

    @property
    def listener_errors(self) -> tuple[ListenerErrorEvent, ...]:
        with self._state_lock:
            return self._listener_errors.snapshot()

    def start(self) -> RpcClient:
        if self._process is not None:
            raise RpcError("RPC client is already started")

        self._ready.clear()
        self._stopping = False
        self._closed_error = None
        self._ready_received = False
        self._ready_event = None
        self._protocol_version = 1
        self._protocol_v2_enabled = False
        self._frame_decoder = _RpcFrameDecoder()
        self._events.clear()
        self._async_errors.clear()
        self._pending_prompt_ids.clear()
        self._last_schedule_async_error_index = 0
        self._session_settled_count = 0
        self._ui_requests = queue.Queue()
        with self._state_lock:
            self._stderr_chunks.clear()
        with self._state_lock:
            self._protocol_errors.clear()
            self._listener_errors.clear()

        process = subprocess.Popen(
            list(self._build_command()),
            cwd=str(self._cwd) if self._cwd is not None else None,
            env={**os.environ, **self._env},
            user=self._user,
            group=self._group,
            extra_groups=self._extra_groups,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
        self._process = process
        self._pgid = _process_group_id(process)

        self._stdout_thread = threading.Thread(
            target=self._read_stdout_loop, name="omp-rpc-stdout", daemon=True
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr_loop, name="omp-rpc-stderr", daemon=True
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

        if not self._ready.wait(self._startup_timeout):
            stderr = self.stderr
            self.stop()
            raise RpcTimeoutError(
                f"Timed out waiting for RPC ready signal. Stderr: {stderr}"
            )

        if not self._ready_received:
            error = self._closed_error
            stderr = self.stderr
            self.stop()
            if isinstance(error, RpcError):
                raise error
            if error is not None:
                raise RpcProcessExitError(
                    f"RPC process stopped before ready: {error}. Stderr: {stderr}"
                ) from error
            raise RpcTimeoutError(
                f"Timed out waiting for RPC ready signal. Stderr: {stderr}"
            )

        ready_event = self._ready_event
        if (
            ready_event is not None
            and ready_event.supported_protocol_versions is not None
            and 2 in ready_event.supported_protocol_versions
            and ready_event.max_frame_bytes == _MAX_RPC_FRAME_BYTES
            and ready_event.max_reassembled_frame_bytes == _MAX_RPC_REASSEMBLED_BYTES
        ):
            try:
                self._protocol_v2_enabled = True
                negotiation = self._request("negotiate_protocol", protocolVersion=2)
                if negotiation.get("protocolVersion") != 2:
                    raise RpcError("RPC protocol v2 negotiation failed")
                self._protocol_version = 2
            except BaseException:
                self.stop()
                raise

        if self._custom_tools:
            self.set_custom_tools(self._custom_tools)
        if self._host_uris:
            self.set_host_uris(self._host_uris)
        return self

    def stop(self) -> bool:
        """Tear down the RPC child and its process group.

        Returns `True` when teardown is confirmed (no survivor remains, including
        any retained by an earlier `stop()` before a restart) and `False` when a
        child outlived the SIGTERM->SIGKILL escalation. On `False` every
        survivor's handle and pgid are retained: inspect `survivor_pids` and call
        `reap()` (or `stop()`) again to re-attempt once the child becomes
        killable. Safe to call repeatedly.
        """
        process = self._process
        if process is None:
            # Either never started, or a prior stop() retained survivors whose
            # SIGKILL was still pending. Re-attempt the reap instead of the old
            # unconditional no-op that left survivors orphaned forever.
            return self._reap_survivors()

        self._stopping = True
        for pending_call in self._pending_host_tool_calls.values():
            pending_call.cancel_event.set()
        for pending_uri in self._pending_host_uri_requests.values():
            pending_uri.cancel_event.set()

        pgid = self._pgid
        reaped = False
        try:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except Exception:
                    # Never let a stdin-close failure skip the kill below: the
                    # finally block clears `_process`, so an escaped exception
                    # would drop the handle to a still-running child.
                    pass

            reaped = _terminate_process_group(process, pgid)
        finally:
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass
            if process.stderr is not None:
                try:
                    process.stderr.close()
                except OSError:
                    pass
            # Mark the client closed so any thread blocked in a lifecycle
            # wait raises `RpcProcessExitError` instead of
            # waiting for its request timeout. The stdout reader loop would
            # normally do this when it observes the closed pipe, but it
            # guards on `if not self._stopping:` — which is True by the time
            # we get here — and so skips it. Calling `_mark_closed` directly
            # closes the gap. It is idempotent: a second call (e.g. from the
            # reader's exception path) returns early.
            self._mark_closed(RpcProcessExitError("RPC process stopped"))
            self._pending_host_tool_calls.clear()
            self._host_tool_dispatch_names.clear()
            self._pending_host_uri_requests.clear()
            self._process = None
            self._pgid = None
            if not reaped:
                # Retain the survivor so a later reap()/stop() can observe and
                # re-kill it. Without this the child becomes unobservable and the
                # second stop() (from the `with` exit / cancel hook) is a no-op.
                self._survivors.append((process, pgid))
            if self._stdout_thread is not None:
                self._stdout_thread.join(timeout=1.0)
            if self._stderr_thread is not None:
                self._stderr_thread.join(timeout=1.0)
            self._stdout_thread = None
            self._stderr_thread = None
        # Survivors retained before a restart are re-attempted too, so `True`
        # means no child this client spawned remains. The one just retained was
        # already escalated above; re-signalling it would only double the wait.
        earlier_reaped = self._reap_survivors(exclude=process)
        return reaped and earlier_reaped

    @property
    def survivor_pids(self) -> tuple[int, ...]:
        """PIDs of children that outlived teardown, oldest first; empty when none.

        A non-empty value means `stop()` could not confirm those children died —
        for example a process stuck in uninterruptible sleep, whose pending
        SIGKILL lands only after it wakes. Poll `reap()` to re-attempt and
        observe whether they have finally exited.
        """
        return tuple(process.pid for process, _ in self._survivors)

    def reap(self) -> bool:
        """Re-attempt teardown of every survivor retained by prior `stop()` calls.

        Returns `True` when no survivor remains — either there never was one, or
        all have now exited. Idempotent and safe to poll from a background reaper.
        """
        return self._reap_survivors()

    def _reap_survivors(self, exclude: subprocess.Popen[str] | None = None) -> bool:
        """Re-attempt each retained survivor except `exclude`; drop confirmed ones.

        Returns `True` when no survivor other than `exclude` remains.
        """
        for entry in list(self._survivors):
            process, pgid = entry
            if process is exclude:
                continue
            if _terminate_process_group(process, pgid):
                try:
                    self._survivors.remove(entry)
                except ValueError:
                    # A concurrent reap()/stop() already confirmed and removed it.
                    pass
        return all(process is exclude for process, _ in self._survivors)

    def on_host_tool_completed(self, listener: HostToolCompletedListener) -> Callable[[], None]:
        self._host_tool_completed_listeners.append(listener)
        return lambda: self._remove_listener(self._host_tool_completed_listeners, listener)

    def on_event(self, listener: AgentEventListener) -> Callable[[], None]:
        self._event_listeners.append(listener)
        return lambda: self._remove_listener(self._event_listeners, listener)

    def on_notification(self, listener: NotificationListener) -> Callable[[], None]:
        self._notification_listeners.append(listener)
        return lambda: self._remove_listener(self._notification_listeners, listener)

    def on_protocol_error(self, listener: ProtocolErrorListener) -> Callable[[], None]:
        self._protocol_error_listeners.append(listener)
        return lambda: self._remove_listener(self._protocol_error_listeners, listener)

    def on_listener_error(self, listener: ListenerErrorListener) -> Callable[[], None]:
        self._listener_error_listeners.append(listener)
        return lambda: self._remove_listener(self._listener_error_listeners, listener)

    def on_unknown_notification(
        self, listener: Callable[[UnknownNotification], None]
    ) -> Callable[[], None]:
        """Subscribe to frames this client does not model or could not parse."""
        return self._listen("unknown", listener)

    def _listen(
        self, frame_type: str, listener: Callable[..., None]
    ) -> Callable[[], None]:
        listeners = self._typed_listeners.setdefault(frame_type, [])
        listeners.append(listener)
        return lambda: self._remove_listener(listeners, listener)

    def _command(
        self,
        command: str,
        params: Mapping[str, object],
        *,
        timeout: float | None = None,
    ) -> JsonObject | None:
        # Generated methods already omit unset optional params; a required `None`
        # (e.g. `set_event_filter(None)`) must reach the wire.
        return self._request_data(
            command,
            self._next_request_id(),
            cast(Mapping[str, JsonValue], params),
            drop_none=False,
            timeout=timeout,
        )

    def install_headless_ui(
        self,
        *,
        on_request: UiRequestListener | None = None,
        confirm: bool = False,
        select_value: str | None = None,
        input_value: str | None = None,
        editor_value: str | None = None,
    ) -> Callable[[], None]:
        """Auto-handle RPC UI requests for non-interactive hosts.

        Passive UI methods such as notifications and status updates are ignored.
        Confirm dialogs default to `False`. Select, input, and editor requests
        are cancelled unless an explicit value is provided; `ask` requests are
        always cancelled.
        """

        def handle(request: ExtensionUiRequest) -> None:
            if on_request is not None:
                try:
                    on_request(request)
                except Exception as exc:
                    self._record_listener_error(
                        ListenerErrorEvent(
                            listener_kind="headless_ui_request",
                            source_type=request.type,
                            listener=on_request,
                            error=exc,
                        )
                    )

            if request.method == "cancel" or request.is_passive():
                return
            if request.method == "confirm":
                self.send_ui_confirmation(request.id, confirm)
                return
            if request.method == "select":
                if select_value is not None:
                    self.send_ui_value(request.id, select_value)
                else:
                    self.cancel_ui_request(request.id)
                return
            if request.method == "input":
                if input_value is not None:
                    self.send_ui_value(request.id, input_value)
                else:
                    self.cancel_ui_request(request.id)
                return
            if request.method == "editor":
                if editor_value is not None:
                    self.send_ui_value(request.id, editor_value)
                else:
                    self.cancel_ui_request(request.id)
                return
            if request.method == "ask":
                self.cancel_ui_request(request.id)

        return self.on_ui_request(handle)

    def next_ui_request(self, timeout: float | None = None) -> ExtensionUiRequest:
        try:
            return self._ui_requests.get(timeout=timeout)
        except queue.Empty as exc:
            raise RpcTimeoutError(
                "Timed out waiting for an extension UI request"
            ) from exc

    def send_ui_value(self, request_id: str, value: str) -> None:
        self._send_notification(
            {"type": "extension_ui_response", "id": request_id, "value": value}
        )

    def send_ui_confirmation(self, request_id: str, confirmed: bool) -> None:
        self._send_notification(
            {"type": "extension_ui_response", "id": request_id, "confirmed": confirmed}
        )

    def send_ui_answers(self, request_id: str, answers: Sequence[AskAnswer]) -> None:
        """Answer an `ask` request with one `AskAnswer` per question, in question order."""
        wire_answers: list[JsonValue] = []
        for answer in answers:
            entry: JsonObject = {
                "id": answer.id,
                "selectedOptions": list(answer.selected_options),
            }
            if answer.custom_input is not None:
                entry["customInput"] = answer.custom_input
            wire_answers.append(entry)
        self._send_notification(
            {"type": "extension_ui_response", "id": request_id, "answers": wire_answers}
        )

    def cancel_ui_request(self, request_id: str, *, timed_out: bool = False) -> None:
        payload: JsonObject = {
            "type": "extension_ui_response",
            "id": request_id,
            "cancelled": True,
        }
        if timed_out:
            payload["timedOut"] = True
        self._send_notification(payload)

    def get_todos(self) -> tuple[TodoPhase, ...]:
        return self.get_state().todo_phases

    def set_todos(
        self, todos: Sequence[TodoSeed | TodoPhaseSeed]
    ) -> tuple[TodoPhase, ...]:
        phases = self._normalize_todo_phases(todos)
        data = self._command("set_todos", {"phases": phases})
        return required(
            expect_object(data, "set_todos"), "todoPhases", array(parse_todo_phase), "set_todos"
        )

    def clear_todos(self) -> tuple[TodoPhase, ...]:
        return self.set_todos(())

    def get_messages(self) -> tuple[AgentMessage, ...]:
        if self._protocol_version == 2:
            try:
                messages: list[AgentMessage] = []
                seen_cursors: set[str] = set()
                total_messages: int | None = None
                cursor: str | None = None
                while True:
                    page = self.get_messages_page(cursor=cursor, limit=256)
                    if (
                        total_messages is not None
                        and page.total_messages != total_messages
                    ):
                        raise RpcError(
                            "RPC message pagination returned an inconsistent total"
                        )
                    total_messages = page.total_messages
                    messages.extend(page.messages)
                    cursor = page.next_cursor
                    if cursor is None:
                        break
                    if cursor in seen_cursors:
                        raise RpcError("RPC message pagination repeated a cursor")
                    seen_cursors.add(cursor)
                if len(messages) != total_messages:
                    raise RpcError(
                        "RPC message pagination ended before the advertised total"
                    )
                return tuple(messages)
            except RpcCommandError as error:
                if error.command != "get_messages_page" or not (
                    error.code in _RPC_MESSAGES_PAGE_FALLBACK_CODES
                    or error.error
                    in (
                        _RPC_MESSAGES_PAGE_BUSY_ERROR,
                        _RPC_MESSAGES_PAGE_STALE_ERROR,
                    )
                ):
                    raise
        data = self._command("get_messages", {})
        return required(
            expect_object(data, "get_messages"),
            "messages",
            array(parse_agent_message),
            "get_messages",
        )

    def set_custom_tools(self, tools: Sequence[HostTool[Any, Any]]) -> tuple[str, ...]:
        self._custom_tools = tuple(tools)
        if self._process is None:
            return tuple(tool.name for tool in self._custom_tools)

        definitions: list[JsonObject] = []
        for tool in self._custom_tools:
            definition: JsonObject = {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "hidden": tool.hidden,
                "readsSkillUris": tool.reads_skill_uris,
            }
            if tool.label is not None:
                definition["label"] = tool.label
            if tool.load_mode is not None:
                definition["loadMode"] = tool.load_mode
            definitions.append(definition)
        data = self._command("set_host_tools", {"tools": definitions})
        return required(
            expect_object(data, "set_host_tools"), "toolNames", array(decode_str), "set_host_tools"
        )

    def set_host_uris(self, host_uris: Sequence[HostUri[Any]]) -> tuple[str, ...]:
        self._host_uris = tuple(host_uris)
        if self._process is None:
            return tuple(uri.scheme for uri in self._host_uris)

        schemes_payload: list[JsonObject] = []
        for uri in self._host_uris:
            entry: JsonObject = {
                "scheme": uri.scheme,
                "writable": uri.writable,
                "immutable": uri.immutable,
            }
            if uri.description is not None:
                entry["description"] = uri.description
            schemes_payload.append(entry)

        data = self._command("set_host_uri_schemes", {"schemes": schemes_payload})
        return required(
            expect_object(data, "set_host_uri_schemes"),
            "schemes",
            array(decode_str),
            "set_host_uri_schemes",
        )

    def prompt(
        self,
        message: str,
        *,
        images: Sequence[ImageContent] | None = None,
        streaming_behavior: StreamingBehavior | None = None,
    ) -> str:
        """Submit a prompt and return its request id once accepted.

        The prompt's `prompt_result` (see `on_prompt_result`) carries the same id.
        """
        request_id = self._next_request_id()
        self._submit_prompt(
            "prompt",
            request_id,
            message=message,
            images=cast(JsonValue, list(images)) if images is not None else None,
            streamingBehavior=streaming_behavior,
        )
        return request_id

    def abort_and_prompt(
        self, message: str, *, images: Sequence[ImageContent] | None = None
    ) -> str:
        """Abort the current run and submit a prompt; returns its request id."""
        request_id = self._next_request_id()
        self._submit_prompt(
            "abort_and_prompt",
            request_id,
            message=message,
            images=cast(JsonValue, list(images)) if images is not None else None,
        )
        return request_id

    def prompt_and_wait(
        self,
        message: str,
        *,
        images: Sequence[ImageContent] | None = None,
        streaming_behavior: StreamingBehavior | None = None,
        timeout: float | None = None,
    ) -> PromptTurn:
        """Submit a prompt and wait for its own `prompt_result`, i.e. the agent's yield.

        Returns every agent event streamed from submission until that result. A
        terminal `agent_end` belonging to an earlier run does not end the wait.
        Background jobs may still wake the session afterwards
        (`turn.result.session_settled` is False); use `wait_for_settled()` to
        wait until the session is done.
        """
        operation = "prompt_and_wait"
        self._prompt_lifecycle.acquire(operation)
        request_id = self._next_request_id()
        with self._event_condition:
            self._prompt_results[request_id] = None
        try:
            start_index = self._current_event_index()
            start_async_error_index = self._current_async_error_index()
            agent_invoked = self._submit_prompt(
                "prompt",
                request_id,
                message=message,
                images=cast(JsonValue, list(images)) if images is not None else None,
                streamingBehavior=streaming_behavior,
            )
            if not agent_invoked:
                with self._event_condition:
                    events = self._event_slice(
                        start_index, self._events.current_index()
                    )
                return self._build_prompt_turn(events, None)
            result, events = self._wait_for_prompt_result(
                request_id, start_index, start_async_error_index, timeout=timeout
            )
            return self._build_prompt_turn(events, result)
        finally:
            with self._event_condition:
                self._prompt_results.pop(request_id, None)
            self._prompt_lifecycle.release(operation)

    def wait_for_idle(self, timeout: float | None = None) -> None:
        """Wait until every prompt this client submitted has received its `prompt_result`."""
        operation = "wait_for_idle"
        self._prompt_lifecycle.acquire(operation)
        try:
            start_async_error_index = self._current_async_error_index()
            deadline = time.monotonic() + (timeout if timeout is not None else 60.0)
            with self._event_condition:
                while True:
                    if self._closed_error is not None:
                        raise RpcProcessExitError(str(self._closed_error))
                    self._raise_async_errors_since(start_async_error_index)
                    if not self._pending_prompt_ids:
                        self._raise_async_errors_since(
                            self._last_schedule_async_error_index
                        )
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RpcTimeoutError(
                            f"Timed out waiting for prompt_result. Stderr: {self.stderr}"
                        )
                    self._event_condition.wait(remaining)
        finally:
            self._prompt_lifecycle.release(operation)

    def wait_for_settled(self, timeout: float | None = None) -> None:
        """Wait until the session is done: no live run, nothing queued, no background work.

        Returns at once when `get_state()` reports the session settled; otherwise
        blocks until the next `session_settled` frame. Unlike `prompt_and_wait()`,
        which returns when the agent yields, this also waits out follow-up runs
        triggered by async job results.
        """
        deadline = time.monotonic() + (timeout if timeout is not None else 60.0)
        # Snapshot before querying state: a frame arriving in between still counts.
        with self._event_condition:
            start_count = self._session_settled_count
        if self.get_state().is_settled:
            return
        with self._event_condition:
            while self._session_settled_count == start_count:
                if self._closed_error is not None:
                    raise RpcProcessExitError(str(self._closed_error))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RpcTimeoutError(
                        f"Timed out waiting for session_settled. Stderr: {self.stderr}"
                    )
                self._event_condition.wait(remaining)

    def collect_events(self, timeout: float | None = None) -> tuple[RpcAgentEvent, ...]:
        operation = "collect_events"
        self._prompt_lifecycle.acquire(operation)
        try:
            start_index = self._current_event_index()
            start_async_error_index = self._current_async_error_index()
            return self._wait_for_agent_end(
                start_index, start_async_error_index, timeout=timeout
            )
        finally:
            self._prompt_lifecycle.release(operation)

    def request_raw(self, command_type: str, **payload: JsonValue) -> JsonObject:
        return self._request(command_type, **payload)

    def _current_event_index(self) -> int:
        with self._event_condition:
            return self._events.current_index()

    def _current_async_error_index(self) -> int:
        with self._event_condition:
            return self._async_errors.current_index()

    def _submit_prompt(
        self, command_type: str, request_id: str, **payload: JsonValue
    ) -> bool:
        """Send a prompt command, tracking it until its `prompt_result`.

        Returns False when the server handled it locally (`agentInvoked: false`),
        in which case no `prompt_result` follows.
        """
        # Registered before sending: the result may arrive before the response
        # has been handed back to this thread.
        with self._event_condition:
            self._pending_prompt_ids.add(request_id)
            self._last_schedule_async_error_index = self._async_errors.current_index()
        try:
            data = self._request_with_id(command_type, request_id, payload)
        except BaseException:
            self._settle_prompt(request_id)
            raise
        if data.get("agentInvoked") is False:
            self._settle_prompt(request_id)
            return False
        return True

    def _settle_prompt(self, request_id: str) -> None:
        with self._event_condition:
            self._pending_prompt_ids.discard(request_id)
            self._event_condition.notify_all()

    def _raise_async_errors_since(self, start_async_error_index: int) -> None:
        """Raise the first async error recorded since the index; caller holds `_event_condition`."""
        if start_async_error_index < self._async_errors.offset:
            raise RpcError(
                "Async error history limit was exceeded while waiting for the agent. "
                "Increase max_event_history if your host needs to retain more background failures."
            )
        errors = self._async_errors.snapshot_from(start_async_error_index)
        if errors:
            raise errors[0]

    def _check_event_history(self, start_index: int) -> None:
        """Fail once events since `start_index` were evicted; caller holds `_event_condition`."""
        if start_index < self._events.offset:
            raise RpcError(
                "Event history limit was exceeded while waiting for the agent. "
                "Increase max_event_history to retain more streamed events."
            )

    def _event_slice(
        self, start_index: int, end_index: int
    ) -> tuple[RpcAgentEvent, ...]:
        """Parse retained events in `[start_index, end_index)`; caller holds `_event_condition`."""
        self._check_event_history(start_index)
        payloads = self._events.snapshot_from(start_index)[: end_index - start_index]
        return tuple(cast(RpcAgentEvent, parse_notification(p)) for p in payloads)

    def _wait_for_prompt_result(
        self,
        request_id: str,
        start_index: int,
        start_async_error_index: int,
        timeout: float | None = None,
    ) -> tuple[PromptResultEvent, tuple[RpcAgentEvent, ...]]:
        deadline = time.monotonic() + (timeout if timeout is not None else 60.0)
        with self._event_condition:
            while True:
                if self._closed_error is not None:
                    raise RpcProcessExitError(str(self._closed_error))
                self._check_event_history(start_index)
                self._raise_async_errors_since(start_async_error_index)
                slot = self._prompt_results.get(request_id)
                if slot is not None:
                    result, end_index = slot
                    return result, self._event_slice(start_index, end_index)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RpcTimeoutError(
                        f"Timed out waiting for prompt_result. Stderr: {self.stderr}"
                    )
                self._event_condition.wait(remaining)

    def _record_prompt_result(self, result: PromptResultEvent) -> None:
        with self._event_condition:
            if result.id is not None:
                self._pending_prompt_ids.discard(result.id)
                if result.id in self._prompt_results:
                    self._prompt_results[result.id] = (
                        result,
                        self._events.current_index(),
                    )
            self._event_condition.notify_all()

    def _build_prompt_turn(
        self,
        events: tuple[RpcAgentEvent, ...],
        result: PromptResultEvent | None,
    ) -> PromptTurn:
        final_messages: tuple[AgentMessage, ...] = ()
        for event_index in range(len(events) - 1, -1, -1):
            event = events[event_index]
            if isinstance(event, AgentEndEvent):
                final_messages = self._complete_agent_end_messages(
                    events[:event_index], event
                )
                break

        assistant_message: AssistantMessage | None = None
        for message in reversed(final_messages):
            if message.get("role") == "assistant":
                assistant_message = cast(AssistantMessage, message)
                break

        if assistant_message is None:
            for event in reversed(events):
                if hasattr(event, "message"):
                    message = cast(AgentMessage | None, getattr(event, "message", None))
                    if isinstance(message, dict) and message.get("role") == "assistant":
                        assistant_message = cast(AssistantMessage, message)
                        break

        return PromptTurn(
            events=events,
            messages=final_messages,
            assistant_message=assistant_message,
            assistant_text=assistant_text(assistant_message)
            if assistant_message is not None
            else None,
            result=result,
        )

    @staticmethod
    def _complete_agent_end_messages(
        events: tuple[RpcAgentEvent, ...], terminal: AgentEndEvent
    ) -> tuple[AgentMessage, ...]:
        if terminal.message_count is None or terminal.message_count <= len(
            terminal.messages
        ):
            return terminal.messages

        run_start = 0
        for event_index in range(len(events) - 1, -1, -1):
            if isinstance(events[event_index], AgentStartEvent):
                run_start = event_index + 1
                break

        streamed_messages = tuple(
            event.message
            for event in events[run_start:]
            if isinstance(event, MessageEndEvent)
        )
        streamed_prefix_count = terminal.message_count - len(terminal.messages)
        if streamed_prefix_count > len(streamed_messages):
            raise RpcError(
                "Compacted agent_end references "
                f"{streamed_prefix_count} streamed messages, but only "
                f"{len(streamed_messages)} were retained"
            )
        return streamed_messages[:streamed_prefix_count] + terminal.messages

    def _wait_for_agent_end(
        self,
        start_index: int,
        start_async_error_index: int,
        timeout: float | None = None,
    ) -> tuple[RpcAgentEvent, ...]:
        deadline = time.monotonic() + (timeout if timeout is not None else 60.0)
        with self._event_condition:
            while True:
                if self._closed_error is not None:
                    raise RpcProcessExitError(str(self._closed_error))
                self._check_event_history(start_index)
                self._raise_async_errors_since(start_async_error_index)

                end_index = self._events.current_index()
                if any(
                    payload.get("type") == "agent_end"
                    and payload.get("isTerminal") is not False
                    for payload in self._events.snapshot_from(start_index)
                ):
                    return self._event_slice(start_index, end_index)

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RpcTimeoutError(
                        f"Timed out waiting for agent_end. Stderr: {self.stderr}"
                    )
                self._event_condition.wait(remaining)

    def _request(self, command_type: str, **payload: JsonValue) -> JsonObject:
        return self._request_with_id(command_type, self._next_request_id(), payload)

    def _request_with_id(
        self,
        command_type: str,
        request_id: str,
        payload: Mapping[str, JsonValue],
        *,
        drop_none: bool = True,
        timeout: float | None = None,
    ) -> JsonObject:
        """Send one command and return its `data` (`{}` when absent or null)."""
        data = self._request_data(
            command_type, request_id, payload, drop_none=drop_none, timeout=timeout
        )
        return data if data is not None else {}

    def _request_data(
        self,
        command_type: str,
        request_id: str,
        payload: Mapping[str, JsonValue],
        *,
        drop_none: bool = True,
        timeout: float | None = None,
    ) -> JsonObject | None:
        """Send one command and return its `data`, None when absent or null.

        `timeout` overrides the client's `request_timeout` for this command.
        """
        process = self._require_process()
        envelope: JsonObject = {"id": request_id, "type": command_type}
        for key, value in payload.items():
            if value is not None or not drop_none:
                envelope[key] = value

        response_queue: queue.Queue[JsonObject | BaseException] = queue.Queue(maxsize=1)
        with self._state_lock:
            self._pending[request_id] = _PendingRequest(
                command=command_type, response_queue=response_queue
            )

        try:
            self._write_json(process, envelope)
        except BaseException:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise

        try:
            response = response_queue.get(
                timeout=self._request_timeout if timeout is None else timeout
            )
        except queue.Empty as exc:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise RpcTimeoutError(
                f"Timed out waiting for response to {command_type}. Stderr: {self.stderr}"
            ) from exc

        if isinstance(response, BaseException):
            raise response

        if not bool(response.get("success", False)):
            raw_code = response.get("code")
            raise RpcCommandError(
                command=str(response.get("command", command_type)),
                error=str(response.get("error", "")),
                code=raw_code if isinstance(raw_code, str) else None,
            )

        data = response.get("data")
        if data is None:
            return None
        return _clone_json_object(data)

    def _send_notification(self, payload: JsonObject) -> None:
        process = self._require_process()
        self._write_json(process, payload)

    def _normalize_host_tool_result(self, result: object) -> JsonObject:
        if isinstance(result, str):
            return {"content": [{"type": "text", "text": result}]}
        if isinstance(result, Mapping):
            return cast(JsonObject, dict(result))
        raise RpcError("Host tool handlers must return a string or a result mapping")

    def _normalize_host_tool_event(self, payload: JsonObject) -> None:
        """Rename transport tool events for in-flight host-tool dispatches.

        With `tools.xdev` enabled, omp mounts custom tools as `xd://` devices
        and the agent invokes them through the `write` tool, so
        `tool_execution_update`/`tool_execution_end` events report the
        transport tool (`write`) rather than the host tool that actually ran.
        The `host_tool_call` frame carries the outer call's `toolCallId` (the
        device dispatch forwards it verbatim), which lets events for that call
        be renamed to the executed host tool — consumers observe the same tool
        names regardless of transport. A top-level call (xdev off) maps the
        name onto itself. `tool_execution_start` precedes the `host_tool_call`
        frame on the wire, so start events keep the transport name.
        """
        tool_call_id = payload.get("toolCallId")
        if not isinstance(tool_call_id, str):
            return
        if payload.get("type") == "tool_execution_end":
            tool_name = self._host_tool_dispatch_names.pop(tool_call_id, None)
        else:
            tool_name = self._host_tool_dispatch_names.get(tool_call_id)
        if tool_name is not None:
            payload["toolName"] = tool_name

    def _handle_host_tool_call(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        tool_name = payload.get("toolName")
        tool_call_id = payload.get("toolCallId")
        raw_arguments = payload.get("arguments")
        if (
            not isinstance(request_id, str)
            or not isinstance(tool_name, str)
            or not isinstance(tool_call_id, str)
        ):
            return
        # Remember the dispatch so tool_execution_* events for this call id can
        # be renamed from the transport tool to the host tool that ran; see
        # _normalize_host_tool_event.
        self._host_tool_dispatch_names[tool_call_id] = tool_name
        if not isinstance(raw_arguments, Mapping):
            self._send_notification(
                {
                    "type": "host_tool_result",
                    "id": request_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": "Host tool arguments must be an object",
                            }
                        ],
                        "details": {},
                    },
                    "isError": True,
                }
            )
            return

        tool = next(
            (
                candidate
                for candidate in self._custom_tools
                if candidate.name == tool_name
            ),
            None,
        )
        if tool is None:
            self._send_notification(
                {
                    "type": "host_tool_result",
                    "id": request_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": f'Host tool "{tool_name}" is not registered',
                            }
                        ],
                        "details": {},
                    },
                    "isError": True,
                }
            )
            return

        pending_call = _PendingHostToolCall(cancel_event=threading.Event())
        self._pending_host_tool_calls[request_id] = pending_call

        def run_tool() -> None:
            try:
                params = tool.parse_params(cast(JsonObject, dict(raw_arguments)))
                context = HostToolContext(
                    tool_call_id=tool_call_id,
                    _cancel_event=pending_call.cancel_event,
                    _send_update=lambda result: self._send_notification(
                        {
                            "type": "host_tool_update",
                            "id": request_id,
                            "partialResult": result,
                        }
                    ),
                )
                result = self._normalize_host_tool_result(tool.execute(params, context))
                self._dispatch_listeners(
                    "host_tool_completed",
                    tool_name,
                    self._host_tool_completed_listeners,
                    HostToolCompletedEvent(tool_name=tool_name, tool_call_id=tool_call_id),
                )
                if pending_call.cancel_event.is_set():
                    return
                self._send_notification(
                    {
                        "type": "host_tool_result",
                        "id": request_id,
                        "result": result,
                    }
                )
            except Exception as exc:
                if pending_call.cancel_event.is_set():
                    return
                self._send_notification(
                    {
                        "type": "host_tool_result",
                        "id": request_id,
                        "result": {
                            "content": [{"type": "text", "text": str(exc)}],
                            "details": {},
                        },
                        "isError": True,
                    }
                )
            finally:
                self._pending_host_tool_calls.pop(request_id, None)

        threading.Thread(
            target=run_tool, name=f"omp-rpc-host-tool:{tool_name}", daemon=True
        ).start()

    def _handle_host_tool_cancel(self, payload: JsonObject) -> None:
        target_id = payload.get("targetId")
        if not isinstance(target_id, str):
            return
        pending_call = self._pending_host_tool_calls.get(target_id)
        if pending_call is not None:
            pending_call.cancel_event.set()

    def _send_host_uri_error(self, request_id: str, message: str) -> None:
        self._send_notification(
            {
                "type": "host_uri_result",
                "id": request_id,
                "error": message,
                "isError": True,
            }
        )

    def _handle_host_uri_request(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        operation = payload.get("operation")
        url = payload.get("url")
        if (
            not isinstance(request_id, str)
            or not isinstance(operation, str)
            or not isinstance(url, str)
        ):
            return
        if operation not in ("read", "write"):
            self._send_host_uri_error(
                request_id, f"Unsupported host URI operation: {operation}"
            )
            return

        try:
            from urllib.parse import urlparse

            parsed = urlparse(url)
        except ValueError:
            self._send_host_uri_error(request_id, f"Could not parse host URI: {url}")
            return
        scheme = (parsed.scheme or "").lower()
        uri = next(
            (candidate for candidate in self._host_uris if candidate.scheme == scheme),
            None,
        )
        if uri is None:
            self._send_host_uri_error(
                request_id, f'Host URI scheme "{scheme}://" is not registered'
            )
            return

        if operation == "write" and uri.write is None:
            self._send_host_uri_error(
                request_id,
                f'Host URI scheme "{scheme}://" was not registered with a write handler',
            )
            return

        pending = _PendingHostUriRequest(cancel_event=threading.Event())
        self._pending_host_uri_requests[request_id] = pending

        def run() -> None:
            try:
                context = HostUriContext(
                    url=url,
                    operation=cast(Any, operation),
                    _cancel_event=pending.cancel_event,
                )
                if operation == "read":
                    value = uri.read(url, context)
                    if pending.cancel_event.is_set():
                        return
                    result_fields = normalize_read_result(value)
                    self._send_notification(
                        {
                            "type": "host_uri_result",
                            "id": request_id,
                            **result_fields,
                        }
                    )
                else:
                    raw_content = payload.get("content")
                    content = str(raw_content) if raw_content is not None else ""
                    assert uri.write is not None
                    uri.write(url, content, context)
                    if pending.cancel_event.is_set():
                        return
                    self._send_notification(
                        {"type": "host_uri_result", "id": request_id}
                    )
            except Exception as exc:
                if pending.cancel_event.is_set():
                    return
                self._send_host_uri_error(request_id, str(exc))
            finally:
                self._pending_host_uri_requests.pop(request_id, None)

        threading.Thread(
            target=run, name=f"omp-rpc-host-uri:{scheme}:{operation}", daemon=True
        ).start()

    def _handle_host_uri_cancel(self, payload: JsonObject) -> None:
        target_id = payload.get("targetId")
        if not isinstance(target_id, str):
            return
        pending = self._pending_host_uri_requests.get(target_id)
        if pending is not None:
            pending.cancel_event.set()

    @staticmethod
    def _normalize_todo_phases(
        todos: Sequence[TodoSeed | TodoPhaseSeed],
    ) -> list[JsonObject]:
        if len(todos) == 0:
            return []

        def wire_item(
            content: str,
            status: TodoStatus,
            blocker: object,
            details: object,
            notes: object,
        ) -> JsonObject:
            item: JsonObject = {"content": content, "status": status}
            if isinstance(blocker, str):
                item["blocker"] = blocker
            if isinstance(details, str):
                item["details"] = details
            if isinstance(notes, str):
                item["notes"] = [notes]
            elif isinstance(notes, (list, tuple)) and all(isinstance(n, str) for n in notes):
                item["notes"] = list(cast(Sequence[str], notes))
            return item

        def normalize_todo_item(seed: TodoSeed) -> JsonObject:
            if isinstance(seed, str):
                return {"content": seed, "status": "pending"}

            if isinstance(seed, TodoItem):
                if seed.status not in _TODO_STATUS_VALUES:
                    raise RpcError(f"Unsupported todo status: {seed.status}")
                return wire_item(seed.content, seed.status, seed.blocker, seed.details, seed.notes)

            content = seed.get("content")
            if not isinstance(content, str) or not content.strip():
                raise RpcError("Todo items must provide a non-empty 'content' value")

            raw_status = seed.get("status")
            if isinstance(raw_status, str):
                if raw_status not in _TODO_STATUS_VALUES:
                    raise RpcError(f"Unsupported todo status: {raw_status}")
                status: TodoStatus = cast(TodoStatus, raw_status)
            else:
                status = "pending"
            return wire_item(
                content, status, seed.get("blocker"), seed.get("details"), seed.get("notes")
            )

        def is_phase_seed(seed: TodoSeed | TodoPhaseSeed) -> bool:
            if isinstance(seed, TodoPhase):
                return True
            if not isinstance(seed, Mapping):
                return False
            return "tasks" in seed or ("name" in seed and "content" not in seed)

        def normalize_phase(seed: TodoPhaseSeed) -> JsonObject:
            if isinstance(seed, TodoPhase):
                name = seed.name
                tasks = [normalize_todo_item(task) for task in seed.tasks]
            else:
                raw_name = seed.get("name")
                if not isinstance(raw_name, str) or not raw_name.strip():
                    raise RpcError("Todo phases must provide a non-empty 'name' value")
                raw_tasks = seed.get("tasks") or ()
                if not isinstance(raw_tasks, Sequence) or isinstance(
                    raw_tasks, (str, bytes)
                ):
                    raise RpcError("Todo phase 'tasks' must be a sequence")
                name = raw_name
                tasks = [
                    normalize_todo_item(cast(TodoSeed, task)) for task in raw_tasks
                ]

            return {"name": name, "tasks": cast(JsonValue, tasks)}

        if any(is_phase_seed(todo) for todo in todos):
            phases: list[JsonObject] = []
            for seed in todos:
                if not is_phase_seed(seed):
                    raise RpcError(
                        "Cannot mix flat todo items with todo phases in one set_todos() call"
                    )
                phases.append(normalize_phase(cast(TodoPhaseSeed, seed)))
            return phases

        return [
            {
                "name": "Todos",
                "tasks": [normalize_todo_item(cast(TodoSeed, todo)) for todo in todos],
            }
        ]

    def _build_command(self) -> tuple[str, ...]:
        if self._argv is not None:
            return self._argv

        command: list[str] = [self._executable, "--mode", "rpc"]
        if self._provider:
            command.extend(["--provider", self._provider])
        if self._model:
            command.extend(["--model", self._model])
        if self._session_dir is not None:
            command.extend(["--session-dir", str(self._session_dir)])
        if self._thinking is not None:
            command.extend(["--thinking", self._thinking])
        if self._append_system_prompt is not None:
            command.extend(["--append-system-prompt", self._append_system_prompt])
        if self._provider_session_id is not None:
            command.extend(["--provider-session-id", self._provider_session_id])
        if self._tools is not None:
            if len(self._tools) == 0:
                command.append("--no-tools")
            else:
                command.extend(["--tools", ",".join(self._tools)])
        if self._no_session:
            command.append("--no-session")
        if self._no_skills:
            command.append("--no-skills")
        if self._no_rules:
            command.append("--no-rules")
        emit_no_title = (
            self._no_title if self._no_title is not None else self._rpc_defaults
        )
        if emit_no_title:
            command.append("--no-title")
        if self._no_ui:
            command.append("--no-ui")
        command.extend(self._extra_args)
        return tuple(command)

    def _next_request_id(self) -> str:
        with self._state_lock:
            self._request_id += 1
            return f"req_{self._request_id}"

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise RpcError("RPC client is not started")
        return self._process

    def _write_json(self, process: subprocess.Popen[str], payload: JsonObject) -> None:
        if process.stdin is None:
            raise RpcProcessExitError("RPC process stdin is unavailable")
        with self._write_lock:
            try:
                process.stdin.write(json.dumps(payload))
                process.stdin.write("\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise RpcProcessExitError(
                    f"Failed to write RPC command: {exc}"
                ) from exc

    def _read_stdout_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return

        line_number = 0
        try:
            for line in process.stdout:
                line_number += 1
                stripped = line.strip()
                if not stripped:
                    continue

                try:
                    raw_payload = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    snippet = stripped
                    if len(snippet) > 240:
                        snippet = f"{snippet[:237]}..."
                    raise RpcError(
                        f"Failed to decode RPC output on line {line_number}: {exc}. Frame: {snippet!r}"
                    ) from exc
                if (
                    isinstance(raw_payload, dict)
                    and raw_payload.get("type") == "rpc_chunk"
                    and not self._protocol_v2_enabled
                ):
                    raise RpcError("RPC chunk received before protocol negotiation")
                payload = self._frame_decoder.push(raw_payload)
                if payload is None:
                    continue
                if payload.get("type") == "response":
                    self._handle_response(payload)
                    continue
                if payload.get("type") == "host_tool_call":
                    self._handle_host_tool_call(payload)
                    continue
                if payload.get("type") == "host_tool_cancel":
                    self._handle_host_tool_cancel(payload)
                    continue
                if payload.get("type") == "host_uri_request":
                    self._handle_host_uri_request(payload)
                    continue
                if payload.get("type") == "host_uri_cancel":
                    self._handle_host_uri_cancel(payload)
                    continue

                payload_type = payload.get("type")
                if payload_type in ("tool_execution_update", "tool_execution_end"):
                    self._normalize_host_tool_event(payload)
                try:
                    notification = parse_notification(payload)
                except (TypeError, ValueError) as exc:
                    # Protocol drift must not terminate the reader. This also
                    # demotes parser defects to UnknownNotification; consumers
                    # that need visibility should register an unknown listener.
                    notification = UnknownNotification(
                        _clone_json_object(payload), parse_error=str(exc)
                    )
                    if (
                        payload_type == "agent_end"
                        and payload.get("isTerminal") is not False
                    ):
                        self._append_async_error(
                            RpcError(f"Failed to parse terminal agent_end: {exc}")
                        )
                    elif payload_type == "prompt_result":
                        self._append_async_error(
                            RpcError(f"Failed to parse prompt_result: {exc}")
                        )
                        prompt_id = payload.get("id")
                        if isinstance(prompt_id, str):
                            self._settle_prompt(prompt_id)
                self._dispatch_listeners(
                    "notification",
                    notification.type,
                    self._notification_listeners,
                    notification,
                )

                # Client state first, so a listener observes it already updated.
                if isinstance(notification, ReadyEvent):
                    self._ready_event = notification
                    self._ready_received = True
                    self._ready.set()
                elif isinstance(notification, ExtensionUiRequest):
                    self._ui_requests.put(notification)
                elif isinstance(notification, PromptResultEvent):
                    self._record_prompt_result(notification)
                elif isinstance(notification, SessionSettledEvent):
                    with self._event_condition:
                        self._session_settled_count += 1
                        self._event_condition.notify_all()
                elif isinstance(notification, RpcAgentEvent):
                    self._append_event(payload)
                    self._dispatch_listeners(
                        "event", notification.type, self._event_listeners, notification
                    )

                self._dispatch_listeners(
                    "typed",
                    notification.type,
                    self._typed_listeners.get(notification.type, []),
                    notification,
                )
        except Exception as exc:
            self._mark_closed(exc)
        else:
            if not self._stopping:
                exit_code = process.poll()
                if exit_code is None:
                    try:
                        exit_code = process.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        self._mark_closed(
                            RpcProcessExitError(
                                "RPC process stdout closed before the process exited"
                            )
                        )
                        return
                self._mark_closed(
                    RpcProcessExitError(
                        f"RPC process exited with code {exit_code}. Stderr: {self.stderr}"
                    )
                )

    def _read_stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            for chunk in process.stderr:
                with self._state_lock:
                    self._stderr_chunks.append(chunk)
        except Exception as exc:
            if not self._stopping:
                self._mark_closed(RpcError(f"Failed to read RPC stderr: {exc}"))

    def _mark_closed(self, error: BaseException) -> None:
        if self._closed_error is not None:
            return
        self._closed_error = error
        self._ready.set()
        self._fail_pending(error)
        with self._event_condition:
            self._event_condition.notify_all()

    def _fail_pending(self, error: BaseException) -> None:
        with self._state_lock:
            pending = [pending.response_queue for pending in self._pending.values()]
            self._pending.clear()
        for response_queue in pending:
            response_queue.put(error)

    def _handle_response(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        if isinstance(request_id, str):
            with self._state_lock:
                pending = self._pending.pop(request_id, None)
            if pending is not None:
                pending.response_queue.put(payload)
                return

        if self._deliver_correlated_error_response(payload):
            return

        protocol_error = self._build_protocol_error(payload)
        if protocol_error is None:
            return

        if (
            protocol_error.command in _ASYNC_COMMANDS
            and protocol_error.remote_error is not None
        ):
            self._append_async_error(
                RpcCommandError(protocol_error.command, protocol_error.remote_error)
            )

        self._record_protocol_error(protocol_error)

    def _deliver_correlated_error_response(self, payload: JsonObject) -> bool:
        if bool(payload.get("success", False)):
            return False

        command = payload.get("command")
        if not isinstance(command, str):
            return False

        with self._state_lock:
            matching_ids = [
                request_id
                for request_id, pending in self._pending.items()
                if pending.command == command
            ]
            target_id: str | None = None
            if len(matching_ids) == 1:
                target_id = matching_ids[0]
            elif command == "parse" and len(self._pending) == 1:
                target_id = next(iter(self._pending))

            if target_id is None:
                return False

            pending = self._pending.pop(target_id)

        pending.response_queue.put(payload)
        return True

    def _build_protocol_error(self, payload: JsonObject) -> RpcProtocolError | None:
        if payload.get("type") != "response":
            return None
        if bool(payload.get("success", False)):
            return None
        return RpcProtocolError(_clone_json_object(payload))

    def _append_event(self, payload: JsonObject) -> None:
        with self._event_condition:
            self._events.append(_clone_json_object(payload))
            self._event_condition.notify_all()

    def _append_async_error(self, error: BaseException) -> None:
        with self._event_condition:
            self._async_errors.append(error)
            self._event_condition.notify_all()

    def _record_protocol_error(self, error: RpcProtocolError) -> None:
        with self._state_lock:
            self._protocol_errors.append(error)
        self._dispatch_listeners(
            "protocol_error", error.command, self._protocol_error_listeners, error
        )

    def _record_listener_error(self, event: ListenerErrorEvent) -> None:
        with self._state_lock:
            self._listener_errors.append(event)

        for listener in list(self._listener_error_listeners):
            try:
                listener(event)
            except Exception:
                continue

    def _dispatch_listeners(
        self,
        listener_kind: str,
        source_type: str | None,
        listeners: Sequence[Callable[[Any], None]],
        payload: Any,
    ) -> None:
        for listener in list(listeners):
            try:
                listener(payload)
            except Exception as exc:
                self._record_listener_error(
                    ListenerErrorEvent(
                        listener_kind=listener_kind,
                        source_type=source_type,
                        listener=listener,
                        error=exc,
                    )
                )

    @staticmethod
    def _validate_history_limit(name: str, limit: int | None) -> int | None:
        if limit is None:
            return None
        if limit <= 0:
            raise ValueError(f"{name} must be greater than zero")
        return limit

    @staticmethod
    def _remove_listener(listeners: list[TListener], listener: TListener) -> None:
        try:
            listeners.remove(listener)
        except ValueError:
            pass
