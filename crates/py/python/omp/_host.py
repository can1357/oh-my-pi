"""Live CONTROL transport for one isolated extension-host child.

Importing this module is inert. :func:`bootstrap` is the only operation that
adopts the inherited descriptor; :meth:`Host.run_forever` retains the child
until that descriptor closes.
"""
from __future__ import annotations

import asyncio
import base64
import contextvars
import dataclasses
import datetime
import importlib
import inspect
import json
import os
import struct
import sys
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from threading import Lock, Timer
from typing import Any

from _omp import (
    HostDisconnected,
    InvocationPhase,
    LifecyclePhase,
    _interrupt,
    _principal_from_host,
    _resource_receipt_from_host,
    _thread_id,
)

from . import _scope
from ._errors import CapabilityError, DeadlineExceeded, EffectsNotAuthorized, FrameTooLarge
from .limits import (
    CANCEL_GRACE,
    MAX_FRAME_BYTES,
    MAX_PENDING_EFFECTS,
    REENTRANCY_DEPTH,
)

_MAX_PENDING = MAX_PENDING_EFFECTS
_MAX_DISPATCH_PROGRESS_EVENTS = 1024
_MAX_DISPATCH_PROGRESS_FRAME_BYTES = 1024 * 1024
_MAX_DISPATCH_RESULT_BYTES = 256 * 1024 * 1024
_DISPATCH_RESULT_CHUNK_BYTES = 512 * 1024
_dispatch_progress: contextvars.ContextVar[Callable[[object], None] | None] = (
    contextvars.ContextVar("omp_dispatch_progress", default=None)
)
_effects: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "omp_effects", default=None
)
_reentrancy: contextvars.ContextVar[int] = contextvars.ContextVar(
    "omp_control_depth", default=0
)


class _ControlEof(HostDisconnected):
    """The parent closed the dedicated descriptor."""


class ControlProtocolError(HostDisconnected):
    """A typed rejection returned by the authoritative CONTROL dispatcher."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.retryable = retryable
        self.details = dict(details or {})
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class _Frame:
    """One decoded CONTROL envelope."""

    kind: str
    correlation: int | None
    body: dict[str, Any]


@dataclass(slots=True)
class _Dispatch:
    """One live invocation and its pending cancellation escalation."""

    task: asyncio.Task[Any]
    thread_id: int
    scope: _scope.Scope | None
    escalation: Timer | None = None
    cancel_started: bool = False


class _Capture:
    """Line-buffered stream forwarding output as structured CONTROL logs."""

    __slots__ = ("_host", "_stream", "_buffer")

    def __init__(self, host: "Host", stream: str) -> None:
        self._host, self._stream, self._buffer = host, stream, ""

    def write(self, text: str) -> int:
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._host.log(self._stream, line)
        return len(text)

    def flush(self) -> None:
        if self._buffer:
            self._host.log(self._stream, self._buffer)
            self._buffer = ""


DispatchHandler = Callable[..., Any]


class _InstrumentSink:
    """Synchronous telemetry instrument facade expected by telemetry.py."""

    __slots__ = ("_host",)

    def __init__(self, host: "Host") -> None:
        self._host = host

    def add(self, name: str, value: int | float, attrs: Mapping[str, Any]) -> None:
        self._host._emit_instrument(
            {"kind": "counter", "name": name, "value": value, "attributes": attrs}
        )

    def record(self, name: str, value: int | float, attrs: Mapping[str, Any]) -> None:
        self._host._emit_instrument(
            {"kind": "histogram", "name": name, "value": value, "attributes": attrs}
        )


class Host:
    """Correlation-aware, reentrant CONTROL codec on one inherited descriptor."""

    __slots__ = (
        "_fd",
        "_lock",
        "_pending",
        "_next_id",
        "_mailbox",
        "_stdout",
        "_stderr",
        "_tasks",
        "_dispatchers",
        "_closed",
        "_host_generation",
        "_session_generation",
        "_tier_snapshot",
        "_current_session_snapshot",
        "_backend_installed",
        "_instrument_sink",
    )

    def __init__(self, fd: int) -> None:
        self._fd = fd
        # The parent creates CONTROL as a tokio socketpair whose ends are
        # O_NONBLOCK; this synchronous codec requires a blocking descriptor,
        # and EAGAIN from a nonblocking read must never read as disconnect.
        os.set_blocking(fd, True)
        self._lock = Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 1
        self._mailbox: deque[dict[str, Any]] = deque(maxlen=_MAX_PENDING)
        self._stdout: Any = None
        self._stderr: Any = None
        self._tasks: dict[str, _Dispatch] = {}
        self._dispatchers: dict[str, DispatchHandler] = {}
        self._closed = False
        self._host_generation = _generation("OMP_EXT_HOST_GENERATION")
        self._session_generation = _generation("OMP_EXT_SESSION_GENERATION")
        self._tier_snapshot: dict[tuple[str, ...], str] | None = None
        self._current_session_snapshot: Any = None
        self._backend_installed = False
        self._instrument_sink = _InstrumentSink(self)

    @staticmethod
    def _decode(raw: bytes) -> _Frame:
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise TypeError
            correlation = value.get("correlation")
            if correlation is not None and (
                isinstance(correlation, bool)
                or not isinstance(correlation, int)
                or correlation <= 0
            ):
                raise TypeError
            body = value.get("body", {})
            if not isinstance(body, dict):
                raise TypeError
            return _Frame(str(value["kind"]), correlation, body)
        except (TypeError, ValueError, KeyError) as error:
            raise HostDisconnected("invalid CONTROL frame") from error

    def _read_exact(self, count: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < count:
            try:
                chunk = os.read(self._fd, count - len(chunks))
            except OSError as error:
                raise _ControlEof("CONTROL channel disconnected") from error
            if not chunk:
                raise _ControlEof("CONTROL channel disconnected")
            chunks.extend(chunk)
        return bytes(chunks)

    def _read_frame(self) -> _Frame:
        header = self._read_exact(4)
        size = struct.unpack("!I", header)[0]
        if size > MAX_FRAME_BYTES:
            raise FrameTooLarge(size, MAX_FRAME_BYTES)
        return self._decode(self._read_exact(size))

    def _write(
        self,
        value: dict[str, Any],
        *,
        limit: int = MAX_FRAME_BYTES,
    ) -> None:
        raw = json.dumps(
            _json_value(value), separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if len(raw) > limit:
            raise FrameTooLarge(len(raw), limit)
        framed = struct.pack("!I", len(raw)) + raw
        with self._lock:
            if self._closed:
                raise HostDisconnected("CONTROL channel disconnected")
            offset = 0
            while offset < len(framed):
                try:
                    written = os.write(self._fd, framed[offset:])
                except OSError as error:
                    self._closed = True
                    raise HostDisconnected("CONTROL channel disconnected") from error
                if written <= 0:
                    self._closed = True
                    raise HostDisconnected("CONTROL channel disconnected")
                offset += written

    def _dispatch_authority(self, invocation: str) -> dict[str, Any]:
        return {
            "host_generation": self._host_generation,
            "session_generation": self._session_generation,
            "invocation": invocation,
        }

    def _authority(self) -> dict[str, Any]:
        try:
            scope = _scope.current()
        except RuntimeError:
            return {
                "host_generation": self._host_generation,
                "session_generation": self._session_generation,
            }
        return self._dispatch_authority(scope.invocation)

    def effect(self, effect: dict[str, Any]) -> None:
        """Write one generation-fenced, non-correlated UI effect frame."""
        self._write(
            {"kind": "UiEffect", "body": {"effect": effect, "authority": self._authority()}}
        )

    def intent_effect(self, operation: str, arguments: dict[str, Any]) -> None:
        """Write one generation-fenced, non-correlated intent contribution."""
        self._write(
            {
                "kind": "IntentEffect",
                "body": {
                    "effect": {"operation": operation, "arguments": arguments},
                    "authority": self._authority(),
                },
            }
        )

    @property
    def instrument(self) -> _InstrumentSink:
        """Return the telemetry instrument facade."""
        return self._instrument_sink

    def _emit_instrument(self, event: object) -> None:
        """Emit one droppable telemetry instrument effect."""
        self._write(
            {
                "kind": "Instrument",
                "body": {"event": event, "authority": self._authority()},
            }
        )

    def _dispatch_progress_sink(
        self,
        correlation: int,
        invocation: str,
    ) -> Callable[[object], None]:
        emitted = 0

        def emit(update: object) -> None:
            nonlocal emitted
            if emitted >= _MAX_DISPATCH_PROGRESS_EVENTS:
                raise ControlProtocolError(
                    "progress_overflow",
                    "dispatch emitted too many progress updates",
                )
            emitted += 1
            self._write(
                {
                    "kind": "DispatchProgress",
                    "correlation": correlation,
                    "body": {
                        "authority": self._dispatch_authority(invocation),
                        "update": update,
                    },
                },
                limit=_MAX_DISPATCH_PROGRESS_FRAME_BYTES,
            )

        return emit

    def _write_dispatch_response(
        self,
        correlation: int,
        invocation: str,
        body: dict[str, Any],
    ) -> None:
        envelope = {
            "kind": "DispatchResponse",
            "correlation": correlation,
            "body": body,
        }
        raw_envelope = json.dumps(
            _json_value(envelope), separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if len(raw_envelope) <= MAX_FRAME_BYTES:
            self._write(envelope)
            return
        raw_body = json.dumps(
            _json_value(body), separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if len(raw_body) > _MAX_DISPATCH_RESULT_BYTES:
            self._write(
                {
                    "kind": "DispatchResponse",
                    "correlation": correlation,
                    "body": {
                        "error": {
                            "code": "frame_too_large",
                            "message": (
                                f"dispatch result is {len(raw_body)} bytes; "
                                f"limit is {_MAX_DISPATCH_RESULT_BYTES}"
                            ),
                            "retryable": False,
                        }
                    },
                }
            )
            return
        chunks = 0
        for chunks, offset in enumerate(
            range(0, len(raw_body), _DISPATCH_RESULT_CHUNK_BYTES),
            start=1,
        ):
            self._write(
                {
                    "kind": "DispatchResultChunk",
                    "correlation": correlation,
                    "body": {
                        "authority": self._dispatch_authority(invocation),
                        "index": chunks - 1,
                        "data": raw_body[
                            offset : offset + _DISPATCH_RESULT_CHUNK_BYTES
                        ],
                    },
                }
            )
        self._write(
            {
                "kind": "DispatchResponse",
                "correlation": correlation,
                "body": {
                    "chunked": {
                        "chunks": chunks,
                        "bytes": len(raw_body),
                    }
                },
            }
        )

    def log(
        self,
        stream: object,
        text: str,
        fields: dict[str, Any] | None = None,
    ) -> None:
        """Emit captured text or a structured context log as one Log frame."""
        if fields is None:
            log: dict[str, Any] = {"stream": stream, "text": text}
        else:
            log = {
                "level": str(getattr(stream, "value", stream)),
                "message": text,
                "fields": fields,
            }
        self._write(
            {"kind": "Log", "body": {"log": log, "authority": self._authority()}}
        )

    def install_capture(self) -> None:
        """Capture child stdout and stderr without making prints protocol errors."""
        self._stdout, self._stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _Capture(self, "stdout"), _Capture(self, "stderr")

    def bootstrap_registry(self) -> None:
        """Import and freeze the admitted declaration registry for CONTROL."""
        try:
            manifest_json = os.environ["OMP_EXT_MANIFEST_SNAPSHOT"]
            modules_value = json.loads(os.environ["OMP_EXT_DECLARATION_MODULES"])
        except (KeyError, TypeError, ValueError) as error:
            raise HostDisconnected("missing or invalid extension manifest bootstrap") from error
        if (
            not isinstance(modules_value, list)
            or not modules_value
            or any(not isinstance(module, str) or not module for module in modules_value)
        ):
            raise HostDisconnected("declaration modules must be non-empty strings")
        entry_path = os.environ.get("OMP_EXT_ENTRY_PATH")
        registry = importlib.import_module("omp._registry")
        registry.bootstrap_extension_registry(
            manifest_json,
            modules_value,
            entry_path=entry_path,
        )

    def current_session(self) -> Any:
        """Return the immutable Core-issued current-session snapshot."""
        if self._current_session_snapshot is None:
            scope = _scope.current()
            cwd = scope.roots[0] if scope.roots else "file:///"
            return {
                "id": scope.session,
                "title": None,
                "title_source": "system",
                "cwd": cwd,
                "project": cwd,
                "created_ms": 0,
                "updated_ms": 0,
                "status": "pending",
                "kind": "interactive",
                "parent": None,
                "entries": 0,
                "turns": 0,
                "usage": {},
                "cost": {"nanos_usd": 0, "estimated": True},
                "models": (),
                "remote": scope.remote,
            }
        return self._current_session_snapshot

    def tier_of(self, target: Mapping[str, str]) -> str | None:
        """Read one exact call-target tier from the host-issued snapshot."""
        if self._tier_snapshot is None:
            raise HostDisconnected("CONTROL authority snapshot is not installed")
        if not isinstance(target, Mapping):
            raise TypeError("tier lookup target must be a mapping")
        kind = target.get("kind")
        if kind == "core":
            key = ("core", str(target.get("name", "")), str(target.get("rev", "")))
        elif kind == "device":
            key = (
                "device",
                str(target.get("name", "")),
                str(target.get("family", "")),
                str(target.get("rev", "")),
            )
        elif kind == "mcp":
            key = ("mcp", str(target.get("server", "")), str(target.get("tool", "")))
        else:
            raise ValueError(f"unknown tier lookup target kind: {kind!r}")
        if any(not item for item in key[1:]):
            raise ValueError("tier lookup target fields must be non-empty")
        return self._tier_snapshot.get(key)

    def register_dispatch(self, operation: str, handler: DispatchHandler) -> None:
        """Install one exact host-to-child operation handler."""
        if not operation.startswith("omp.") or not callable(handler):
            raise ValueError("CONTROL dispatch requires an omp.* operation and callable")
        if operation in self._dispatchers:
            raise ValueError(f"CONTROL dispatch is already registered: {operation}")
        self._dispatchers[operation] = handler

    async def request(self, operation: str, arguments: dict[str, Any]) -> Any:
        """Send a request; the retained reader resolves it without nested reads."""
        if not operation.startswith("omp."):
            raise ControlProtocolError("invalid_operation", "CONTROL operation must start with omp.")
        if _reentrancy.get() >= REENTRANCY_DEPTH:
            raise ControlProtocolError(
                "reentrancy_limit",
                f"CONTROL reentrancy exceeds depth {REENTRANCY_DEPTH}",
            )
        if len(self._pending) >= _MAX_PENDING:
            raise HostDisconnected("too many pending CONTROL requests")
        correlation, self._next_id = self._next_id, self._next_id + 1
        future = asyncio.get_running_loop().create_future()
        self._pending[correlation] = future
        token = _reentrancy.set(_reentrancy.get() + 1)
        try:
            self._write(
                {
                    "kind": "Request",
                    "correlation": correlation,
                    "body": {
                        "operation": operation,
                        "arguments": arguments,
                        "authority": self._authority(),
                    },
                }
            )
            try:
                return await future
            except asyncio.CancelledError:
                self._write(
                    {
                        "kind": "CancelRequest",
                        "correlation": correlation,
                        "body": {"authority": self._authority()},
                    }
                )
                raise
        finally:
            _reentrancy.reset(token)
            self._pending.pop(correlation, None)

    async def direct_filesystem_request(self, arguments: Mapping[str, Any]) -> Any:
        """Route the explicitly granted filesystem escape over CONTROL."""
        return await self.request("omp.direct_filesystem.request", dict(arguments))

    async def serve(self) -> None:
        """Retain the sole CONTROL reader until the parent disconnects."""
        try:
            while True:
                frame = await asyncio.to_thread(self._read_frame)
                self._accept(frame)
        except _ControlEof:
            self._disconnect()
        finally:
            await self._cancel_all()

    def run_forever(self) -> None:
        """Own the child event loop for the lifetime of CONTROL."""
        asyncio.run(self.serve())

    def _accept(self, frame: _Frame) -> None:
        if frame.kind == "AuthoritySnapshot":
            if self._backend_installed:
                raise HostDisconnected("CONTROL authority snapshot was installed twice")
            host_generation = frame.body.get("host_generation")
            session_generation = frame.body.get("session_generation")
            tiers = frame.body.get("tiers")
            agent_depth = frame.body.get("agent_depth")
            if (
                host_generation != self._host_generation
                or session_generation != self._session_generation
                or not isinstance(tiers, list)
                or isinstance(agent_depth, bool)
                or not isinstance(agent_depth, int)
                or agent_depth < 0
            ):
                raise HostDisconnected("invalid or stale CONTROL authority snapshot")
            snapshot: dict[tuple[str, ...], str] = {}
            for row in tiers:
                if not isinstance(row, dict) or not isinstance(row.get("tier"), str):
                    raise HostDisconnected("invalid CONTROL tier snapshot row")
                kind = row.get("kind")
                if kind == "core":
                    key = ("core", row.get("name"), row.get("rev"))
                elif kind == "device":
                    key = (
                        "device",
                        row.get("name"),
                        row.get("family"),
                        row.get("rev"),
                    )
                elif kind == "mcp":
                    key = ("mcp", row.get("server"), row.get("tool"))
                else:
                    raise HostDisconnected("invalid CONTROL tier snapshot target")
                if any(not isinstance(item, str) or not item for item in key[1:]):
                    raise HostDisconnected("invalid CONTROL tier snapshot identity")
                if key in snapshot:
                    raise HostDisconnected("duplicate CONTROL tier snapshot identity")
                snapshot[key] = row["tier"]
            self._tier_snapshot = snapshot
            self._current_session_snapshot = _from_json(
                frame.body.get("current_session")
            )
            agents = importlib.import_module("omp.agents")
            agents.depth = agent_depth
            # Authority is installed before declaration import. CONTROL remains
            # unavailable throughout configure/import/FREEZE, then becomes live.
            self.bootstrap_registry()
            from . import _install_control_backend

            _install_control_backend(self)
            registry = importlib.import_module("omp._registry")
            registry.services._install_control_transport(self)
            self._backend_installed = True
            return
        if frame.kind == "ResourceReceipt":
            if (
                frame.body.get("host_generation") != self._host_generation
                or frame.body.get("session_generation") != self._session_generation
            ):
                raise HostDisconnected("invalid or stale CONTROL resource receipt")
            quota_rows, dropped_rows = _resource_receipt_rows(
                frame.body.get("receipt")
            )
            native = importlib.import_module("_omp")
            native._set_resource_receipt(quota_rows, dropped_rows)
            return
        if frame.kind == "CancelDispatch":
            self._cancel_dispatch(str(frame.body.get("invocation", "")))
            return
        if frame.kind == "Effect":
            self._mailbox.append(frame.body)
            return
        if frame.kind == "Dispatch":
            if frame.correlation is None:
                raise HostDisconnected("dispatch frame has no correlation")
            operation = frame.body.get("operation")
            arguments = frame.body.get("arguments", {})
            authority = frame.body.get("authority", {})
            if not isinstance(operation, str) or not operation.startswith("omp."):
                raise HostDisconnected("dispatch frame has an invalid operation")
            if not isinstance(arguments, dict) or not isinstance(authority, dict):
                raise HostDisconnected("dispatch frame has an invalid body")
            decoded_authority = _from_json(authority)
            if not isinstance(decoded_authority, dict):
                raise HostDisconnected("dispatch authority did not decode to an object")
            invocation = str(
                decoded_authority.get("invocation") or f"dispatch:{frame.correlation}"
            )
            with self._lock:
                duplicate = self._tasks.get(invocation)
                duplicate = duplicate is not None and not duplicate.task.done()
            if duplicate:
                self._write(
                    {
                        "kind": "DispatchResponse",
                        "correlation": frame.correlation,
                        "body": {
                            "error": {
                                "code": "duplicate_dispatch",
                                "message": f"invocation is already live: {invocation}",
                                "retryable": False,
                            }
                        },
                    }
                )
                return
            scope = _scope_from_wire(invocation, decoded_authority)
            task = asyncio.create_task(
                self._execute_dispatch(
                    frame.correlation,
                    operation,
                    arguments,
                    decoded_authority,
                    scope,
                ),
                name=invocation,
            )
            self.track_dispatch(invocation, task, scope)
            return
        if frame.correlation is None:
            raise HostDisconnected(f"uncorrelated CONTROL frame: {frame.kind}")
        future = self._pending.get(frame.correlation)
        if future is None:
            raise HostDisconnected(
                f"stale CONTROL response correlation {frame.correlation}"
            )
        if future.done():
            raise HostDisconnected(
                f"duplicate CONTROL response correlation {frame.correlation}"
            )
        if frame.kind == "Response":
            error = frame.body.get("error")
            if error is not None:
                future.set_exception(_remote_error(error))
            elif "result" in frame.body:
                future.set_result(_from_json(frame.body["result"]))
            else:
                future.set_exception(
                    ControlProtocolError("malformed_response", "CONTROL response has no result")
                )
            return
        raise HostDisconnected(f"unsupported CONTROL frame kind: {frame.kind}")

    async def _execute_dispatch(
        self,
        correlation: int,
        operation: str,
        arguments: dict[str, Any],
        authority: dict[str, Any],
        scope: _scope.Scope,
    ) -> None:
        invocation = str(authority.get("invocation") or f"dispatch:{correlation}")
        token = _scope.install(scope)
        progress_token = _dispatch_progress.set(
            self._dispatch_progress_sink(correlation, invocation)
        )
        data_tokens: object | None = None
        try:
            if authority.get("data") is not None:
                env = importlib.import_module("omp.env")
                data_tokens = await env._install_invocation_backend(authority, self)
            handler = self._dispatchers.get(operation) or _builtin_dispatch(operation)
            if handler is None:
                raise ControlProtocolError(
                    "unhandled_operation", f"unhandled host dispatch operation: {operation}"
                )
            decoded_arguments = _from_json(arguments)
            if inspect.iscoroutinefunction(handler):
                result = await handler(**decoded_arguments)
            else:
                worker = asyncio.create_task(
                    asyncio.to_thread(
                        self._call_sync_handler,
                        invocation,
                        handler,
                        decoded_arguments,
                    )
                )
                try:
                    result = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    # Keep the dispatch live while the sync frame unwinds. The
                    # grace timer targets the worker thread, and Rust may still
                    # kill the process group if a C extension never returns.
                    try:
                        await worker
                    finally:
                        raise
                if inspect.isawaitable(result):
                    result = await result
            body = {"result": result}
        except asyncio.CancelledError:
            body = {
                "error": {
                    "code": "cancelled",
                    "message": f"dispatch {invocation} was cancelled",
                    "retryable": True,
                }
            }
        except BaseException as error:
            body = {"error": _local_error(error)}
        finally:
            if data_tokens is not None:
                env = importlib.import_module("omp.env")
                env._reset_backend(data_tokens)
            _dispatch_progress.reset(progress_token)
            _scope.reset(token)
        try:
            self._write_dispatch_response(correlation, invocation, body)
        except HostDisconnected:
            pass

    def take_effect(self) -> dict[str, Any] | None:
        """Return the next host-delivered effect without reentering the codec."""
        return self._mailbox.popleft() if self._mailbox else None

    def _cancel_dispatch(self, invocation: str) -> None:
        with self._lock:
            dispatch = self._tasks.get(invocation)
            if dispatch is None or dispatch.cancel_started or dispatch.task.done():
                return
            dispatch.cancel_started = True
            timer = Timer(
                CANCEL_GRACE.seconds,
                self._interrupt_dispatch,
                (invocation, dispatch),
            )
            timer.daemon = True
            dispatch.escalation = timer
            scope = dispatch.scope
        loop = dispatch.task.get_loop()
        if scope is not None:
            loop.call_soon_threadsafe(_scope._request_cancel, scope)
            loop.call_soon_threadsafe(
                _scope._fire_cancel_callbacks,
                scope,
                lambda error: self._log_cancel_callback_error(invocation, error),
            )
        loop.call_soon_threadsafe(dispatch.task.cancel)
        timer.start()

    def _log_cancel_callback_error(self, invocation: str, error: BaseException) -> None:
        try:
            self.log(
                "error",
                "cancellation callback failed",
                {"invocation": invocation, "error": repr(error)},
            )
        except BaseException:
            pass

    def _call_sync_handler(
        self,
        invocation: str,
        handler: DispatchHandler,
        arguments: dict[str, Any],
    ) -> Any:
        """Run a synchronous callback off the reader loop and record its thread."""
        with self._lock:
            dispatch = self._tasks.get(invocation)
            if dispatch is not None:
                dispatch.thread_id = _thread_id()
        return handler(**arguments)

    def _interrupt_dispatch(self, invocation: str, dispatch: _Dispatch) -> None:
        with self._lock:
            if self._tasks.get(invocation) is not dispatch or dispatch.task.done():
                return
            dispatch.escalation = None
            _interrupt(dispatch.thread_id)

    def _settle_if_current(self, invocation: str, dispatch: _Dispatch) -> None:
        with self._lock:
            if self._tasks.get(invocation) is not dispatch:
                return
            self._tasks.pop(invocation)
        if dispatch.escalation is not None:
            dispatch.escalation.cancel()

    def track_dispatch(
        self,
        invocation: str,
        task: asyncio.Task[Any],
        scope: _scope.Scope | None = None,
    ) -> None:
        """Record the task, thread, and authority scope for cancellation."""
        if scope is None:
            try:
                scope = _scope.current()
            except RuntimeError:
                pass
        dispatch = _Dispatch(task, _thread_id(), scope)
        with self._lock:
            previous = self._tasks.get(invocation)
            if previous is not None and not previous.task.done():
                raise ControlProtocolError(
                    "duplicate_dispatch", f"invocation is already live: {invocation}"
                )
            self._tasks[invocation] = dispatch
        if previous is not None and previous.escalation is not None:
            previous.escalation.cancel()
        task.add_done_callback(
            lambda _task: self._settle_if_current(invocation, dispatch)
        )

    def settle_dispatch(self, invocation: str) -> None:
        """Forget a settled invocation and cancel its pending escalation."""
        with self._lock:
            dispatch = self._tasks.pop(invocation, None)
        if dispatch is not None and dispatch.escalation is not None:
            dispatch.escalation.cancel()

    def _disconnect(self) -> None:
        with self._lock:
            self._closed = True
        error = HostDisconnected("CONTROL channel disconnected")
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(error)

    async def _cancel_all(self) -> None:
        tasks = tuple(dispatch.task for dispatch in self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def dispatch_update_sink() -> Callable[[object], None]:
    """Return the live correlated update sink for the current device dispatch."""

    sink = _dispatch_progress.get()
    if sink is None:
        raise RuntimeError("no live CONTROL device update sink")
    return sink


def emit_dispatch_update(value: object) -> None:
    """Emit one bounded update before the current dispatch completion."""

    dispatch_update_sink()(value)


def _resource_receipt_rows(
    receipt: object,
) -> tuple[list[tuple[str, int, int, str | None]], list[tuple[str, int]]]:
    if not isinstance(receipt, Mapping):
        raise HostDisconnected("CONTROL resource receipt must be an object")
    quotas = receipt.get("quotas")
    dropped = receipt.get("dropped")
    if not isinstance(quotas, Mapping) or not isinstance(dropped, Mapping):
        raise HostDisconnected("CONTROL resource receipt tables are malformed")
    quota_rows: list[tuple[str, int, int, str | None]] = []
    for name, status in quotas.items():
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(status, Mapping)
            or isinstance(status.get("limit"), bool)
            or not isinstance(status.get("limit"), int)
            or status["limit"] < 0
            or isinstance(status.get("used"), bool)
            or not isinstance(status.get("used"), int)
            or status["used"] < 0
            or (
                status.get("window") is not None
                and not isinstance(status.get("window"), str)
            )
        ):
            raise HostDisconnected("CONTROL resource quota row is malformed")
        quota_rows.append(
            (name, status["limit"], status["used"], status.get("window"))
        )
    dropped_rows: list[tuple[str, int]] = []
    for name, count in dropped.items():
        if (
            not isinstance(name, str)
            or not name
            or isinstance(count, bool)
            or not isinstance(count, int)
            or count < 0
        ):
            raise HostDisconnected("CONTROL resource drop row is malformed")
        dropped_rows.append((name, count))
    return quota_rows, dropped_rows


def _resource_receipt(receipt: object) -> object:
    quota_rows, dropped_rows = _resource_receipt_rows(receipt)
    return _resource_receipt_from_host(quota_rows, dropped_rows)


def _generation(name: str) -> int:
    try:
        value = int(os.environ[name])
    except (KeyError, ValueError) as error:
        raise HostDisconnected(f"missing or invalid {name}") from error
    if value < 0:
        raise HostDisconnected(f"missing or invalid {name}")
    return value


def _phase(kind: type[Any], value: object, fallback: str) -> Any:
    name = str(value or fallback).upper()
    try:
        return getattr(kind, name)
    except AttributeError as error:
        raise HostDisconnected(f"invalid CONTROL authority phase: {value!r}") from error


def _scope_from_wire(invocation: str, authority: Mapping[str, Any]) -> _scope.Scope:
    principal = authority.get("principal", {})
    if isinstance(principal, Mapping):
        principal = _principal_from_host(
            str(principal.get("id", "")),
            str(principal.get("display", "")),
        )
    return _scope.Scope(
        invocation=invocation,
        generation=int(authority.get("host_generation", 0)),
        principal=principal,
        phase=_phase(InvocationPhase, authority.get("phase"), "OPEN"),
        deadline=authority.get("deadline"),
        effects=frozenset(map(str, authority.get("effects", ()))),
        extension=str(authority.get("extension", "")),
        session=str(authority.get("session", "")),
        turn=authority.get("turn"),
        event=authority.get("event"),
        call=authority.get("call"),
        device=authority.get("device"),
        trust=_scope.Trust(str(authority.get("trust", "sandboxed"))),
        caps=frozenset(map(str, authority.get("capabilities", ()))),
        place_kind=str(authority.get("place_kind", "host")),
        lifecycle=_phase(LifecyclePhase, authority.get("lifecycle"), "ACTIVE"),
        roots=tuple(map(str, authority.get("roots", ()))),
        remote=bool(authority.get("remote", False)),
        has_ui=bool(authority.get("has_ui", False)),
        headless=bool(authority.get("headless", True)),
        settings=dict(authority.get("settings", {})),
        secret_settings=frozenset(map(str, authority.get("secret_settings", ()))),
    )


def _freeze_registry_ack() -> dict[str, object]:
    """Return the complete frozen declaration table over authenticated CONTROL."""
    registry_module = importlib.import_module("omp._registry")
    registry = registry_module.registry
    if not registry.sealed:
        registry.freeze()
    publication = registry_module.project_control_registry()
    provider = importlib.import_module("omp.provider")
    publication["providers"] = list(provider._sealed_provider_declarations())
    return publication


async def _dispatch_lifecycle_activate(
    payload: Mapping[str, Any],
) -> None:
    """Deliver activation to frozen hooks and the admitted entry callback."""

    payload = dict(payload)
    cli_values = payload.get("cli_values", ())
    if (
        not isinstance(cli_values, Sequence)
        or isinstance(cli_values, (str, bytes, bytearray))
        or any(
            not isinstance(row, Mapping)
            or not isinstance(row.get("sink"), str)
            or not row["sink"]
            or "value" not in row
            for row in cli_values
        )
    ):
        raise ControlProtocolError(
            "malformed_activation",
            "extension activation CLI values are malformed",
        )
    started_at_ms = payload.get("session_started_at")
    if isinstance(started_at_ms, int) and not isinstance(started_at_ms, bool):
        payload["session_started_at"] = datetime.datetime.fromtimestamp(
            started_at_ms / 1000, tz=datetime.timezone.utc
        )
    registry = importlib.import_module("omp._registry").registry
    dispatch = importlib.import_module("omp.hooks")._dispatch_hook_callback
    hook_payload = dict(payload)
    hook_payload.pop("cli_values", None)
    definitions = sorted(
        (
            definition
            for definition in registry.snapshot().hook_definitions
            if definition.event == "extension_activate"
        ),
        key=lambda definition: (
            definition.phase,
            definition.handler.order,
            definition.handler.name,
        ),
    )
    for definition in definitions:
        await dispatch(
            "extension_activate",
            definition.phase,
            definition.handler.name,
            hook_payload,
        )

    try:
        modules = json.loads(os.environ["OMP_EXT_DECLARATION_MODULES"])
    except (KeyError, TypeError, ValueError) as error:
        raise HostDisconnected("extension activation entry module is unavailable") from error
    if not isinstance(modules, list) or not modules or not isinstance(modules[0], str):
        raise HostDisconnected("extension activation entry module is malformed")
    entry = importlib.import_module(modules[0])
    callback = getattr(entry, "extension_activate", None)
    if callback is None:
        return
    if not callable(callback):
        raise TypeError("entry extension_activate attribute is not callable")
    from . import Context

    result = callback(payload, Context.current())
    if inspect.isawaitable(result):
        await result


def _builtin_dispatch(operation: str) -> DispatchHandler | None:
    targets = {
        "omp.services.dispatch": ("omp._registry", "dispatch_service"),
        "omp.hooks.dispatch": ("omp.hooks", "_dispatch_hook_callback"),
        "omp.extensions.director.before_inference": (
            "omp.extensions", "_dispatch_director_before_inference"
        ),
        "omp.extensions.director.on_yield": (
            "omp.extensions", "_dispatch_director_on_yield"
        ),
        "omp.extensions.component.apply": (
            "omp.extensions", "_dispatch_component_apply"
        ),
        "omp.devices.call": ("omp._registry", "dispatch_device_control"),
        "omp.prompts.render": ("omp._registry", "dispatch_prompt_slot"),
        "omp.ui.completion": ("omp.ui", "_dispatch_completion"),
        "omp.ui.command_completion": ("omp.ui", "_dispatch_command_completion"),
        "omp.ui.shortcut": ("omp.ui", "_dispatch_shortcut"),
        "omp.ui.command": ("omp.ui", "_dispatch_command"),
        "omp.ui.renderer": ("omp.ui", "_dispatch_renderer"),
        "omp.ui.message_renderer": ("omp.ui", "_dispatch_message_renderer"),
        "omp.ui.markdown_transformer": ("omp.ui", "_dispatch_markdown_transformer"),
        "omp.ui.activation": ("omp.ui", "_dispatch_activation"),
        "omp.ui.terminal_input": ("omp.ui", "_feed_terminal_input"),
        "omp.telemetry.dispatch": ("omp.telemetry", "_dispatch_subscription"),
        "omp.telemetry.coalesce_key": (
            "omp.telemetry",
            "_subscription_coalesce_key",
        ),
        "omp.verdicts.project": ("omp._verdicts", "_dispatch_prompt"),
        "omp.provider.callback": ("omp.provider", "dispatch_provider_callback"),
    }
    if operation == "omp.lifecycle.freeze":
        return _freeze_registry_ack
    if operation == "omp.lifecycle.activate":
        return _dispatch_lifecycle_activate
    target = targets.get(operation)
    if target is None:
        return None
    module = importlib.import_module(target[0])
    handler = getattr(module, target[1], None)
    return handler if callable(handler) else None


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode("ascii")}
    if isinstance(value, Enum):
        return _json_value(value.value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _json_value(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_value(item) for item in value]
    if hasattr(value, "__dict__"):
        return {
            str(key): _json_value(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    raise TypeError(f"value is not CONTROL JSON serializable: {type(value).__name__}")


def _from_json(value: Any) -> Any:
    if isinstance(value, list):
        return [_from_json(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {"$bytes"} and isinstance(value["$bytes"], str):
            try:
                return base64.b64decode(value["$bytes"], validate=True)
            except ValueError as error:
                raise HostDisconnected("invalid CONTROL bytes value") from error
        if set(value) == {"$principal"} and isinstance(value["$principal"], dict):
            principal = value["$principal"]
            return _principal_from_host(
                str(principal.get("id", "")),
                str(principal.get("display", "")),
            )
        if set(value) == {"$provenance"} and isinstance(value["$provenance"], dict):
            from .packages import Provenance

            return Provenance(**_from_json(value["$provenance"]))
        return {str(key): _from_json(item) for key, item in value.items()}
    return value


def _local_error(error: BaseException) -> dict[str, Any]:
    if isinstance(error, ControlProtocolError):
        return {
            "code": error.code,
            "message": str(error),
            "retryable": error.retryable,
            "details": error.details,
        }
    return {
        "code": f"python.{type(error).__name__}",
        "message": str(error) or type(error).__name__,
        "retryable": False,
    }


def _remote_error(value: object) -> BaseException:
    if not isinstance(value, Mapping):
        return ControlProtocolError("malformed_error", "malformed CONTROL error")
    code = str(value.get("code", "protocol_error"))
    message = str(value.get("message", code))
    details = value.get("details")
    detail_map = details if isinstance(details, Mapping) else {}
    if code == "capability_denied":
        return CapabilityError(detail_map.get("capability", message))
    if code == "effects_not_authorized":
        return EffectsNotAuthorized(
            str(detail_map.get("invocation", "")), detail_map.get("spec", message)
        )
    if code == "deadline_exceeded":
        return DeadlineExceeded(detail_map.get("deadline", message))
    if code == "QuotaExceeded":
        omp = importlib.import_module("omp")
        receipt_value = detail_map.get("receipt")
        receipt = (
            _resource_receipt(receipt_value)
            if isinstance(receipt_value, Mapping)
            else None
        )
        return omp.QuotaExceeded(
            str(detail_map.get("quota", message)),
            receipt,
        )
    if code == "permission_denied":
        from . import PermissionDenied

        return PermissionDenied(message)
        return journal.EntryUndecodable(
            raw if isinstance(raw, bytes) else bytes(str(raw), "utf-8"),
            str(detail_map.get("reason", message)),
        )
    if code in {
        "CompletionFailed",
        "SpawnDenied",
        "DepthExceeded",
        "ConcurrencyExhausted",
        "AgentGone",
        "RewindPending",
        "SnapshotUnsupported",
        "ScheduleRejected",
    }:
        from . import agents
        from . import Duration

        if code == "CompletionFailed":
            usage_value = detail_map.get("usage", {})
            usage_args = dict(usage_value) if isinstance(usage_value, Mapping) else {}
            wall_ms = usage_args.pop("wall_ms", None)
            if wall_ms is not None:
                usage_args["wall"] = Duration(f"{int(wall_ms)}ms")
            return agents.CompletionFailed(
                str(detail_map.get("reason", message)),
                detail_map.get("raw"),
                agents.Usage(**usage_args),
            )
        if code == "SpawnDenied":
            return agents.SpawnDenied(
                str(detail_map.get("reason", message)), detail_map.get("field")
            )
        if code == "DepthExceeded":
            return agents.DepthExceeded(
                int(detail_map.get("depth", 0)),
                int(detail_map.get("max_depth", 0)),
            )
        if code == "ConcurrencyExhausted":
            return agents.ConcurrencyExhausted(
                int(detail_map.get("running", 0)),
                int(detail_map.get("queued", 0)),
                int(detail_map.get("max_concurrency", 0)),
            )
        if code == "AgentGone":
            return agents.AgentGone(
                str(detail_map.get("ref", "")),
                agents.AgentStatus(str(detail_map.get("status", "failed"))),
                str(detail_map.get("transcript_url", "")),
            )
        if code == "RewindPending":
            return agents.RewindPending(str(detail_map.get("turn_id", "")))
        if code == "SnapshotUnsupported":
            return agents.SnapshotUnsupported(
                str(detail_map.get("capability", "env:workspace.snapshot"))
            )
        return agents.ScheduleRejected(
            str(detail_map.get("reason", message)), detail_map.get("field")
        )
    for module_name in (
        "omp",
        "omp.artifacts",
        "omp.context",
        "omp.journal",
        "omp.sessions",
        "omp.agents",
        "omp.policy",
        "omp.provider",
        "omp.workers",
    ):
        try:
            error_type = getattr(importlib.import_module(module_name), code, None)
            if isinstance(error_type, type) and issubclass(error_type, BaseException):
                try:
                    return error_type(message)
                except TypeError:
                    break
        except (ImportError, AttributeError):
            continue
    return ControlProtocolError(
        code,
        message,
        retryable=bool(value.get("retryable", False)),
        details=detail_map,
    )


def bootstrap(fd: int | None = None) -> Host:
    """Adopt CONTROL, install its bridge, and return the unstarted live host."""
    if fd is None:
        try:
            fd = int(os.environ["OMP_EXT_CONTROL_FD"])
        except (KeyError, ValueError) as error:
            raise HostDisconnected("missing or invalid OMP_EXT_CONTROL_FD") from error
    host = Host(fd)
    host.install_capture()
    return host
