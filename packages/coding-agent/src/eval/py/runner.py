"""OMP Python runner — subprocess wrapper used by the coding-agent host.

NDJSON protocol over stdin/stdout. Host writes one JSON object per line;
wrapper writes typed frames back.

Host -> wrapper:
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?}
  {"id": str, "code": str, "silent": bool?, "storeHistory": bool?, "cwd": str?, "env": dict?}
  {"type": "tool", "id": str, "op": "describe", "names": [str]}
  {"type": "tool", "id": str, "op": "call", "name": str, "args": dict}
  {"type": "exit"}                                # graceful shutdown

Wrapper -> host:
  {"type": "started",     "id": ...}
  {"type": "stdout",      "id": ..., "data": str}
  {"type": "stderr",      "id": ..., "data": str}
  {"type": "display",     "id": ..., "bundle": {<mime>: <value>}}
  {"type": "result",      "id": ..., "bundle": {<mime>: <value>}}
  {"type": "error",       "id": ..., "ename": str, "evalue": str, "traceback": [str]}
  {"type": "done",        "id": ..., "status": "ok"|"error",
                              "executionCount": int, "cancelled": bool}

The runner is intentionally self-contained: no third-party imports, no IPython.
Magics are translated by a small line-scanner before AST parsing; rich display
falls back through `_repr_*_` methods so pandas/PIL/plotly etc. still render
when installed.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import builtins
import codecs
import contextvars
import inspect
import io
import json
import hashlib
import locale
import os
import re
import runpy
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Frame writer
# ---------------------------------------------------------------------------

# Frames travel on a private dup of the original stdout. fd 1 itself is then
# repointed at a capture pipe: child processes spawned by user code without
# stdout=PIPE inherit fd 1, and their output is forwarded to the host as
# regular stdout frames by a drain thread instead of being written raw into
# the NDJSON channel (where it would be dropped as invalid JSON — or worse,
# spoof a frame). The wire protocol is unchanged: the host still reads NDJSON
# frames from the subprocess stdout.
_RAW_STDERR = sys.__stderr__
try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _RAW_STDOUT = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _CAPTURE_READ_FD, _capture_write_fd = os.pipe()
    os.dup2(_capture_write_fd, sys.__stdout__.fileno())
    os.close(_capture_write_fd)
except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
    _RAW_STDOUT = sys.__stdout__
    _CAPTURE_READ_FD = None
_OUT_LOCK = threading.Lock()


def _json_default(o: Any) -> Any:
    try:
        return repr(o)
    except Exception:
        return f"<unrepr {type(o).__name__}>"


def _emit(frame: dict) -> None:
    """Serialize a frame and write it to the host as a single NDJSON line."""
    line = json.dumps(frame, ensure_ascii=False, default=_json_default)
    with _OUT_LOCK:
        _RAW_STDOUT.write(line)
        _RAW_STDOUT.write("\n")
        _RAW_STDOUT.flush()


# ---------------------------------------------------------------------------
# User stdout/stderr proxies
# ---------------------------------------------------------------------------


class _StreamProxy(io.TextIOBase):
    """Emit ``write()`` data as typed frames tied to the current request.

    Writes are coalesced per request: a frame is emitted once the buffer holds
    a complete line (everything up to the last newline goes out together) or
    grows past ``_MAX_BUFFER`` bytes, so the common ``print()`` pair of
    ``write(text)`` + ``write("\\n")`` costs one frame instead of two. Partial
    lines are bounded by ``flush()`` and the end-of-request flush.
    """

    _MAX_BUFFER = 8192

    def __init__(self, kind: str) -> None:
        super().__init__()
        self._kind = kind
        self._lock = threading.Lock()
        self._buffers: dict[str, str] = {}

    def writable(self) -> bool:  # noqa: D401 - protocol method
        return True

    def isatty(self) -> bool:  # noqa: D401 - protocol method
        return False

    def write(self, data: Any) -> int:  # type: ignore[override]
        if not isinstance(data, str):
            data = str(data)
        if not data:
            return 0
        rid = _CURRENT_RID.get()
        if rid is None:
            _RAW_STDERR.write(data)
            _RAW_STDERR.flush()
            return len(data)
        emit_text = None
        with self._lock:
            buf = self._buffers.pop(rid, "") + data
            if len(buf) >= self._MAX_BUFFER:
                emit_text = buf
            else:
                nl = buf.rfind("\n")
                if nl >= 0:
                    emit_text = buf[: nl + 1]
                    rest = buf[nl + 1 :]
                    if rest:
                        self._buffers[rid] = rest
                else:
                    self._buffers[rid] = buf
        if emit_text:
            _emit({"type": self._kind, "id": rid, "data": emit_text})
        return len(data)

    def flush(self) -> None:  # noqa: D401 - protocol method
        rid = _CURRENT_RID.get()
        if rid is not None:
            self.flush_rid(rid)
        return None

    def flush_rid(self, rid: str) -> None:
        """Flush any buffered partial line for ``rid`` as its own frame."""
        with self._lock:
            buf = self._buffers.pop(rid, None)
        if buf:
            _emit({"type": self._kind, "id": rid, "data": buf})


def _flush_stream_proxies(rid: str) -> None:
    """Drain buffered proxy output for ``rid`` (called before its done frame)."""
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _StreamProxy):
            stream.flush_rid(rid)


# ---------------------------------------------------------------------------
# Runner state
# ---------------------------------------------------------------------------


class _RunnerState:
    def __init__(self) -> None:
        self.execution_count: int = 0
        self.namespace_revision: int = 0
        self.cancel_requested: bool = False
        # User globals — kept across requests when running in session mode.
        self.user_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__doc__": None,
            "__builtins__": builtins,
        }
        self.last_install_marker: int = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.active_executions: int = 0
        # Best-effort attribution target for captured fd-1 bytes (child
        # processes inheriting stdout). With overlapping requests the most
        # recently started one wins — strictly better than dropping the bytes.
        self.capture_rid: str | None = None


_CURRENT_RID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "omp_current_rid", default=None
)
_CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS: contextvars.ContextVar[set[int] | None] = (
    contextvars.ContextVar(
        "omp_displayed_matplotlib_figure_ids",
        default=None,
    )
)


_STATE = _RunnerState()

_SHADOW_SNAPSHOT_MAX_DEPTH = 16
_SHADOW_SNAPSHOT_MAX_NODES = 2000
_SHADOW_SNAPSHOT_MAX_STRING_BYTES = 8 * 1024 * 1024
_SHADOW_UNSUPPORTED = object()

# Class attribute on the prelude `_ToolProxy` identifying the genuine tool
# bridge. A retained non-JSON-safe user `tool` binding is omitted from the
# shadow snapshot exactly like the genuine bridge, so snapshot absence alone
# cannot tell them apart (see `_shadow_tool_available`).
_TOOL_BRIDGE_MARKER = "__omp_tool_bridge__"

# Runner-owned reference to the genuine prelude tool bridge, captured on first
# sighting: kernel init executes the prelude before user cells, so the first
# `tool` binding observed by the planner is the installed bridge. Identity
# (`is`) plus the marker above defeats both retained shadows and spoofed
# markers; the residual is a hostile `%run` script that both runs before any
# plan and reproduces the marker.
_TRUSTED_TOOL_BRIDGE: dict[str, Any] = {}


def _tool_binding_state(user_ns: dict[str, Any]) -> str:
    """Reserved `tool` binding identity: absent, intact, or shadowed.

    Absent with nothing ever captured is the bare-harness norm (no bridge
    installed at all). Absent after a capture means user deletion. Present
    means intact only for the captured genuine bridge carrying the marker.
    """
    if "tool" not in user_ns:
        return "absent" if _TRUSTED_TOOL_BRIDGE.get("bridge") is None else "shadowed"
    current = user_ns["tool"]
    trusted = _TRUSTED_TOOL_BRIDGE.get("bridge")
    if trusted is None:
        if getattr(current, _TOOL_BRIDGE_MARKER, False) is True:
            _TRUSTED_TOOL_BRIDGE["bridge"] = current
            return "intact"
        return "shadowed"
    return "intact" if current is trusted else "shadowed"


def _shadow_identity_state() -> dict[str, str]:
    """Reserved-binding identity relevant to speculation, for the snapshot digest.

    Out-of-band namespace changes (async tasks, background threads) that replace
    `tool` or `str` may leave no JSON-safe trace and bump no revision; without
    this the digest would still match and stale plans would verify. Predicates
    mirror the planner gates exactly (`str` membership matches the seed in
    `_emit_shadow_plan`; `tool` matches `_shadow_tool_available`).
    """
    user_ns = _STATE.user_ns
    return {
        "str": "shadowed" if "str" in user_ns else "absent",
        "tool": _tool_binding_state(user_ns),
    }

def _copy_shadow_value(value: Any, depth: int, state: dict[str, Any]) -> Any:
    """Copy exact JSON-safe values without invoking user protocols."""
    if depth > _SHADOW_SNAPSHOT_MAX_DEPTH:
        return _SHADOW_UNSUPPORTED
    state["nodes"] += 1
    if state["nodes"] > _SHADOW_SNAPSHOT_MAX_NODES:
        return _SHADOW_UNSUPPORTED
    value_type = type(value)
    if value is None or value_type is bool or value_type is int:
        return value
    if value_type is float:
        return value if value == value and value not in (float("inf"), float("-inf")) else _SHADOW_UNSUPPORTED
    if value_type is str:
        state["bytes"] += len(value.encode("utf-8"))
        return value if state["bytes"] <= _SHADOW_SNAPSHOT_MAX_STRING_BYTES else _SHADOW_UNSUPPORTED
    if value_type not in (list, tuple, dict) or id(value) in state["seen"]:
        return _SHADOW_UNSUPPORTED
    state["seen"].add(id(value))
    try:
        if value_type in (list, tuple):
            copied = [_copy_shadow_value(item, depth + 1, state) for item in value]
            return copied if all(item is not _SHADOW_UNSUPPORTED for item in copied) else _SHADOW_UNSUPPORTED
        copied_dict: dict[str, Any] = {}
        for key, item in value.items():
            if type(key) is not str:
                return _SHADOW_UNSUPPORTED
            copied = _copy_shadow_value(item, depth + 1, state)
            if copied is _SHADOW_UNSUPPORTED:
                return _SHADOW_UNSUPPORTED
            copied_dict[key] = copied
        return copied_dict
    finally:
        state["seen"].discard(id(value))


def _snapshot_user_namespace() -> dict[str, Any]:
    values: dict[str, Any] = {}
    snapshot_state: dict[str, Any] = {"nodes": 0, "bytes": 0, "seen": set()}
    for key, value in _STATE.user_ns.items():
        if key.startswith("_"):
            continue
        copied = _copy_shadow_value(value, 0, snapshot_state)
        if copied is not _SHADOW_UNSUPPORTED:
            values[key] = copied
    return values


def _shadow_tool_available(snapshot: dict[str, Any], user_ns: dict[str, Any]) -> bool:
    """Whether a speculative `tool.read` may reach the genuine bridge.

    A JSON-safe user value is visible in the snapshot; anything else goes
    through the binding identity, which also covers bare harnesses ("absent"
    with nothing ever captured stays available as before).
    """
    if "tool" in snapshot:
        return False
    # A JSON-safe user value is visible above; anything else goes through the
    # binding identity, which also covers bare harnesses ("absent" with nothing
    # ever captured stays available as before).
    return _tool_binding_state(user_ns) in ("intact", "absent")

def _shadow_snapshot_digest(values: dict[str, Any]) -> str:
    payload = json.dumps(
        {"identity": _shadow_identity_state(), "values": values},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _emit_shadow_snapshot(req: dict) -> None:
    rid = str(req.get("id"))
    if _STATE.active_executions != 0:
        _emit({"type": "shadow_snapshot", "id": rid, "eligible": False, "reason": "kernel is busy"})
        return
    values = _snapshot_user_namespace()
    _emit(
        {
            "type": "shadow_snapshot",
            "id": rid,
            "eligible": True,
            "revision": _STATE.namespace_revision,
            "digest": _shadow_snapshot_digest(values),
            "values": values,
        }
    )


def _shadow_span(node: ast.AST, line_offsets: list[int]) -> dict[str, int]:
    start_line = max(1, int(getattr(node, "lineno", 1)))
    end_line = max(start_line, int(getattr(node, "end_lineno", start_line)))
    start = line_offsets[start_line - 1] + int(getattr(node, "col_offset", 0))
    end = line_offsets[end_line - 1] + int(getattr(node, "end_col_offset", 0))
    return {"start": start, "end": end}


def _shadow_dependencies(expression: dict[str, Any], output: set[str] | None = None) -> set[str]:
    output = output if output is not None else set()
    kind = expression.get("kind")
    if kind == "operation_result":
        output.add(str(expression["operationId"]))
    elif kind == "property":
        _shadow_dependencies(expression["target"], output)
    elif kind in ("array", "concat"):
        for item in expression["items"]:
            _shadow_dependencies(item, output)
    elif kind == "object":
        for entry in expression["entries"]:
            _shadow_dependencies(entry["value"], output)
    elif kind == "transform":
        _shadow_dependencies(expression["input"], output)
        if expression.get("argument") is not None:
            _shadow_dependencies(expression["argument"], output)
    return output




def _shadow_expression_is_string(expression: dict[str, Any]) -> bool:
    kind = expression.get("kind")
    if kind == "literal":
        return type(expression.get("value")) is str
    if kind == "concat":
        return True
    return kind == "transform" and expression.get("name") in (
        "Python.str",
        "JSON.stringify",
        "Array.join",
    )


def _shadow_expression(
    node: ast.AST,
    environment: dict[str, dict[str, Any]],
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if isinstance(node, ast.Constant) and (
        node.value is None or type(node.value) in (bool, int, float, str)
    ):
        if type(node.value) is float and (
            node.value != node.value or node.value in (float("inf"), float("-inf"))
        ):
            return None
        return {"kind": "literal", "value": node.value}
    if isinstance(node, ast.Name):
        return environment.get(node.id, {"kind": "snapshot", "name": node.id})
    if isinstance(node, (ast.List, ast.Tuple)):
        items = [_shadow_expression(item, environment, snapshot) for item in node.elts]
        return (
            {"kind": "array", "items": items}
            if all(item is not None for item in items)
            else None
        )
    if isinstance(node, ast.Dict):
        entries: list[dict[str, Any]] = []
        for key, value in zip(node.keys, node.values):
            if not isinstance(key, ast.Constant) or type(key.value) is not str:
                return None
            projected = _shadow_expression(value, environment, snapshot)
            if projected is None:
                return None
            entries.append({"key": key.value, "value": projected})
        return {"kind": "object", "entries": entries}
    if isinstance(node, ast.Subscript):
        target = _shadow_expression(node.value, environment, snapshot)
        key = _shadow_expression(node.slice, environment, snapshot)
        if target is None or key is None or key.get("kind") != "literal":
            return None
        if type(key.get("value")) not in (str, int):
            return None
        return {"kind": "property", "target": target, "property": key["value"]}
    if isinstance(node, ast.JoinedStr):
        items: list[dict[str, Any]] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and type(value.value) is str:
                items.append({"kind": "literal", "value": value.value})
            elif isinstance(value, ast.FormattedValue):
                if value.conversion != -1 or value.format_spec is not None:
                    return None
                projected = _shadow_expression(value.value, environment, snapshot)
                if projected is None:
                    return None
                items.append({"kind": "transform", "name": "Python.str", "input": projected})
            else:
                return None
        return {"kind": "concat", "items": items}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _shadow_expression(node.left, environment, snapshot)
        right = _shadow_expression(node.right, environment, snapshot)
        return (
            {"kind": "concat", "items": [left, right]}
            if left is not None
            and right is not None
            and _shadow_expression_is_string(left)
            and _shadow_expression_is_string(right)
            else None
        )
    if isinstance(node, ast.Call) and not node.keywords:
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "str"
            and node.func.id not in environment
            and (snapshot is None or "str" not in snapshot)
            and len(node.args) == 1
        ):
            projected = _shadow_expression(node.args[0], environment, snapshot)
            return (
                {"kind": "transform", "name": "Python.str", "input": projected}
                if projected is not None
                else None
            )
    return None


def _shadow_static_value(
    expression: dict[str, Any], snapshot: dict[str, Any]
) -> tuple[bool, Any]:
    kind = expression.get("kind")
    if kind == "literal":
        return True, expression.get("value")
    if kind == "snapshot":
        name = str(expression.get("name"))
        return (True, snapshot[name]) if name in snapshot else (False, None)
    if kind == "array":
        values = [_shadow_static_value(item, snapshot) for item in expression["items"]]
        return (
            (True, [value for _, value in values])
            if all(ok for ok, _ in values)
            else (False, None)
        )
    if kind == "object":
        values = [
            (entry["key"], _shadow_static_value(entry["value"], snapshot))
            for entry in expression["entries"]
        ]
        return (
            (True, {key: value for key, (_, value) in values})
            if all(ok for _, (ok, _) in values)
            else (False, None)
        )
    if kind == "property":
        ok, target = _shadow_static_value(expression["target"], snapshot)
        if not ok:
            return False, None
        property_name = expression["property"]
        if type(target) is dict and type(property_name) is str and property_name in target:
            return True, target[property_name]
        if type(target) is list and type(property_name) is int and 0 <= property_name < len(target):
            return True, target[property_name]
        return False, None
    if kind == "concat":
        values = [_shadow_static_value(item, snapshot) for item in expression["items"]]
        return (
            (True, "".join(str(value) for _, value in values))
            if all(ok for ok, _ in values)
            else (False, None)
        )
    return False, None


def _shadow_call_kind(node: ast.AST, tool_available: bool = True) -> str | None:
    if isinstance(node, ast.Await):
        node = node.value
    if not isinstance(node, ast.Call):
        return None
    if (
        isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "tool"
        and node.func.attr == "read"
        and tool_available
    ):
        return "read"
    return None


def _emit_shadow_plan(req: dict) -> None:
    rid = str(req.get("id"))
    if _STATE.active_executions != 0:
        _emit({"type": "shadow_plan", "id": rid, "eligible": False, "reason": "kernel is busy"})
        return
    code = req.get("code")
    if type(code) is not str:
        _emit({"type": "shadow_plan", "id": rid, "eligible": False, "reason": "code is not a string"})
        return
    try:
        module = ast.parse(code, mode="exec")
    except SyntaxError:
        _emit({"type": "shadow_plan", "id": rid, "eligible": False, "reason": "incomplete or invalid Python"})
        return
    snapshot = _snapshot_user_namespace()
    try:
        # Whole-cell validity gate: `ast.parse` accepts cells that `compile()`
        # rejects (e.g. use-before-global), while authoritative
        # `_compile_source()` raises SyntaxError before any bridge call.
        # Mirror its filename/mode/flags (top-level await stays legal) and
        # fail closed with zero operations plus an invalidating barrier.
        compile(module, "<cell>", "exec", flags=_TLA_FLAG)
    except SyntaxError:
        _emit(
            {
                "type": "shadow_plan",
                "id": rid,
                "eligible": True,
                "revision": _STATE.namespace_revision,
                "digest": _shadow_snapshot_digest(snapshot),
                "values": snapshot,
                "operations": [],
                "controls": [],
                "barrier": {
                    "kind": "barrier",
                    "reason": "cell does not compile",
                    "span": {"start": 0, "end": len(code)},
                },
            }
        )
        return
    # Mirror the `_compile_source` whole-cell instrumentation skip: when the
    # cell binds `__omp_with_call_site__` anywhere, authoritative execution
    # runs zero instrumented calls, so the planner must admit zero operations
    # (per-call scoping is undecidable across call order; fail closed).
    if _cell_binds_call_site_helper(module):
        _emit(
            {
                "type": "shadow_plan",
                "id": rid,
                "eligible": True,
                "revision": _STATE.namespace_revision,
                "digest": _shadow_snapshot_digest(snapshot),
                "values": snapshot,
                "operations": [],
                "controls": [],
                "barrier": {
                    "kind": "barrier",
                    "reason": "Python call-site helper binding changed",
                    "span": {"start": 0, "end": len(code)},
                },
            }
        )
        return
    tool_available = _shadow_tool_available(snapshot, _STATE.user_ns)
    line_offsets = [0]
    for line in code.splitlines(keepends=True):
        line_offsets.append(line_offsets[-1] + len(line))
    operations: list[dict[str, Any]] = []
    controls: list[dict[str, Any]] = []
    environment: dict[str, dict[str, Any]] = {}
    # A retained `str` binding shadows the builtin even when the JSON-safe snapshot
    # omits it (function values are never JSON-safe), so snapshot absence alone
    # cannot prove the builtin is intact. Seed the same snapshot-ref shape Name
    # resolution falls back to: the `str(...)` call gate below then fails closed,
    # and any other use resolves unresolvable. (`del str` needs no seed: removing
    # the binding restores builtin resolution authoritatively too.)
    if "str" in _STATE.user_ns:
        environment["str"] = {"kind": "snapshot", "name": "str"}
    occurrences: dict[str, int] = {}
    source_order = 0
    barrier: dict[str, Any] | None = None

    def add_operation(
        expression_node: ast.AST,
        dynamic_path: list[str],
        control_dependencies: list[str],
    ) -> dict[str, Any] | None:
        nonlocal source_order
        # Unawaited `tool.read(...)` never reaches the bridge: the kernel tool
        # attribute is async, so a bare call only builds a coroutine. Admit an
        # operation only for the awaited form; anything else fails closed via
        # the caller's barrier path below.
        if not isinstance(expression_node, ast.Await):
            return None
        call_node = expression_node.value
        kind = _shadow_call_kind(call_node, tool_available)
        if not isinstance(call_node, ast.Call) or kind != "read":
            return None
        if call_node.keywords or len(call_node.args) != 1:
            return None
        argument_ir = _shadow_expression(call_node.args[0], environment, snapshot)
        if argument_ir is None:
            return None
        call_span = _shadow_span(call_node, line_offsets)
        static_site = f"py:{call_span['start']}"
        path_key = f"{static_site}:{'/'.join(dynamic_path)}"
        occurrence = occurrences.get(path_key, 0)
        occurrences[path_key] = occurrence + 1
        operation_id = f"{path_key}:{occurrence}"
        operation = {
            "kind": "tool",
            "call": {
                "id": operation_id,
                "siteId": static_site,
                "dynamicPath": list(dynamic_path),
                "occurrence": occurrence,
                "name": kind,
                "args": argument_ir,
                "dependencies": sorted(_shadow_dependencies(argument_ir)),
                "controlDependencies": list(control_dependencies),
                "sourceOrder": source_order,
                "span": call_span,
            },
        }
        source_order += 1
        operations.append(operation)
        return operation

    def project_statements(
        statements: list[ast.stmt],
        dynamic_path: list[str],
        control_dependencies: list[str],
    ) -> bool:
        nonlocal barrier
        for statement in statements:
            if isinstance(statement, (ast.Assign, ast.AnnAssign)):
                target = (
                    statement.targets[0]
                    if isinstance(statement, ast.Assign) and len(statement.targets) == 1
                    else getattr(statement, "target", None)
                )
                value_node = statement.value
                if not isinstance(target, ast.Name) or value_node is None:
                    barrier = {
                        "kind": "barrier",
                        "reason": "unsupported Python assignment",
                        "span": _shadow_span(statement, line_offsets),
                    }
                    return False
                if target.id == "tool":
                    barrier = {
                        "kind": "barrier",
                        "reason": "Python tool binding changed",
                        "span": _shadow_span(statement, line_offsets),
                    }
                    return False
                operation = add_operation(value_node, dynamic_path, control_dependencies)
                if operation is not None:
                    environment[target.id] = {"kind": "operation_result", "operationId": operation["call"]["id"]}
                    continue
                projected = _shadow_expression(value_node, environment, snapshot)
                if projected is None:
                    barrier = {
                        "kind": "barrier",
                        "reason": "unsupported Python assignment value",
                        "span": _shadow_span(value_node, line_offsets),
                    }
                    return False
                if not _shadow_static_value(projected, snapshot)[0]:
                    barrier = {
                        "kind": "barrier",
                        "reason": "unsupported Python assignment value",
                        "span": _shadow_span(value_node, line_offsets),
                    }
                    return False
                environment[target.id] = projected
                continue
            if isinstance(statement, ast.Expr):
                if add_operation(statement.value, dynamic_path, control_dependencies) is not None:
                    continue
                projected = _shadow_expression(statement.value, environment, snapshot)
                if projected is not None and _shadow_static_value(projected, snapshot)[0]:
                    continue
                barrier = {
                    "kind": "barrier",
                    "reason": "unsupported Python statement",
                    "span": _shadow_span(statement, line_offsets),
                }
                return False
            if isinstance(statement, ast.If):
                test = _shadow_expression(statement.test, environment, snapshot)
                if test is None:
                    barrier = {
                        "kind": "barrier",
                        "reason": "unsupported Python condition",
                        "span": _shadow_span(statement.test, line_offsets),
                    }
                    return False
                ok, selected = _shadow_static_value(test, snapshot)
                conditional_id = f"py:{_shadow_span(statement, line_offsets)['start']}:if"
                if ok:
                    branch = statement.body if selected else statement.orelse
                    if not project_statements(
                        branch,
                        [*dynamic_path, "if:true" if selected else "if:false"],
                        control_dependencies,
                    ):
                        return False
                    continue
                controls.append(
                    {
                        "kind": "conditional",
                        "id": conditional_id,
                        "test": test,
                        "consequentPath": "if:true",
                        "alternatePath": "if:false",
                        "span": _shadow_span(statement, line_offsets),
                    }
                )
                if not project_statements(
                    statement.body,
                    [*dynamic_path, "if:true"],
                    [*control_dependencies, conditional_id],
                ):
                    return False
                if not project_statements(
                    statement.orelse,
                    [*dynamic_path, "if:false"],
                    [*control_dependencies, conditional_id],
                ):
                    return False
                continue
            if isinstance(statement, ast.For) and isinstance(statement.target, ast.Name):
                if statement.target.id == "tool":
                    barrier = {
                        "kind": "barrier",
                        "reason": "Python tool binding changed",
                        "span": _shadow_span(statement.target, line_offsets),
                    }
                    return False
                iterable = _shadow_expression(statement.iter, environment, snapshot)
                ok, values = _shadow_static_value(iterable, snapshot) if iterable is not None else (False, None)
                if not ok or type(values) is not list or len(values) > 32:
                    barrier = {
                        "kind": "barrier",
                        "reason": "unbounded or dynamic Python loop",
                        "span": _shadow_span(statement, line_offsets),
                    }
                    return False
                controls.append(
                    {
                        "kind": "loop",
                        "id": f"py:{_shadow_span(statement, line_offsets)['start']}:loop",
                        "iterable": iterable,
                        "iterations": len(values),
                        "span": _shadow_span(statement, line_offsets),
                    }
                )
                previous = environment.get(statement.target.id)
                for index, value in enumerate(values):
                    environment[statement.target.id] = {"kind": "literal", "value": value}
                    if not project_statements(
                        statement.body,
                        [*dynamic_path, f"loop:{index}"],
                        control_dependencies,
                    ):
                        return False
                if values:
                    environment[statement.target.id] = {"kind": "literal", "value": values[-1]}
                elif previous is None:
                    environment.pop(statement.target.id, None)
                else:
                    environment[statement.target.id] = previous
                if statement.orelse and not project_statements(
                    statement.orelse,
                    [*dynamic_path, "loop:else"],
                    control_dependencies,
                ):
                    return False
                continue
            barrier = {
                "kind": "barrier",
                "reason": "unsupported Python statement",
                "span": _shadow_span(statement, line_offsets),
            }
            return False
        return True

    project_statements(module.body, [], [])
    _emit(
        {
            "type": "shadow_plan",
            "id": rid,
            "eligible": True,
            "revision": _STATE.namespace_revision,
            "digest": _shadow_snapshot_digest(snapshot),
            "values": snapshot,
            "operations": operations,
            "controls": controls,
            "barrier": barrier,
        }
    )

def _drain_captured_stdout() -> None:
    """Forward bytes written to the captured fd 1 as stdout frames.

    Runs on a daemon thread for the life of the process. Child processes that
    inherit fd 1 (any ``subprocess`` call without ``stdout=PIPE``) land here.
    """
    if _CAPTURE_READ_FD is None:
        return
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        try:
            chunk = os.read(_CAPTURE_READ_FD, 65536)
        except OSError:
            return
        if not chunk:
            return
        text = decoder.decode(chunk)
        if not text:
            continue
        rid = _STATE.capture_rid
        if rid is None:
            _RAW_STDERR.write(text)
            _RAW_STDERR.flush()
        else:
            _emit({"type": "stdout", "id": rid, "data": text})


def _start_capture_drain() -> None:
    if _CAPTURE_READ_FD is None:
        return
    thread = threading.Thread(
        target=_drain_captured_stdout, name="omp-fd1-capture", daemon=True
    )
    thread.start()


# ---------------------------------------------------------------------------
# Magic source transformer
# ---------------------------------------------------------------------------


_MAGIC_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?:[ \t]+(?P<args>.*))?$"
)
_ASSIGN_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<lhs>[A-Za-z_][A-Za-z_0-9.\[\], ]*?)\s*=\s*(?P<rhs>.+)$"
)


def _fold_continuations(lines: list[str], start: int) -> tuple[str, int]:
    """Fold trailing backslash continuations starting at ``start``. Returns
    ``(folded_text, lines_consumed)``."""
    parts: list[str] = []
    i = start
    while i < len(lines):
        line = lines[i]
        if line.endswith("\\"):
            parts.append(line[:-1])
            i += 1
            continue
        parts.append(line)
        i += 1
        break
    return ("".join(parts), i - start)


def _quote_arg(text: str) -> str:
    """Return a Python string literal that round-trips ``text`` exactly."""
    return json.dumps(text, ensure_ascii=False)


def transform_cell(source: str) -> str:
    """Translate IPython-style magics + shell escapes into plain Python.

    Rules
    -----
    * ``%name args``              -> ``__omp_magic("name", "args")``
    * ``var = %name args``        -> ``var = __omp_magic("name", "args")``
    * ``!cmd``                    -> ``__omp_shell("cmd")``
    * ``var = !cmd``              -> ``var = __omp_shell("cmd")``
    * ``%%name args\\n<body>``    -> ``__omp_magic_cell("name", "args", "<body>")``
      (cell magic must be the first non-whitespace token of a top-level line and
      consumes the remainder of the cell)

    Lines inside strings or comments are left alone — we operate on the raw
    text before parsing, but the scanner only fires on the first token of each
    physical line and never touches the body of triple-quoted strings because
    those bodies are never first tokens themselves.
    """

    if "%" not in source and "!" not in source:
        return source

    lines = source.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]

        # Cell magic — consumes from here to EOF.
        if stripped.startswith("%%"):
            head, _ = _split_magic_head(stripped[2:])
            name, args = head
            body_lines = lines[i + 1 :]
            body = "\n".join(body_lines)
            out.append(
                f"{indent}__omp_magic_cell({_quote_arg(name)}, {_quote_arg(args)}, {_quote_arg(body)})"
            )
            return "\n".join(out)

        # Line magic / shell at start of line.
        if stripped.startswith("%") and not stripped.startswith("%%"):
            folded, consumed = _fold_continuations(lines, i)
            stripped_folded = folded.lstrip()
            indent = folded[: len(folded) - len(stripped_folded)]
            head, _ = _split_magic_head(stripped_folded[1:])
            name, args = head
            out.append(f"{indent}__omp_magic({_quote_arg(name)}, {_quote_arg(args)})")
            i += consumed
            continue

        if stripped.startswith("!"):
            folded, consumed = _fold_continuations(lines, i)
            stripped_folded = folded.lstrip()
            indent = folded[: len(folded) - len(stripped_folded)]
            cmd = stripped_folded[1:].strip()
            out.append(f"{indent}__omp_shell({_quote_arg(cmd)})")
            i += consumed
            continue

        # Assignment forms: var = %magic / var = !cmd
        m = _ASSIGN_LINE_RE.match(line)
        if m:
            rhs = m.group("rhs").strip()
            if rhs.startswith("!"):
                cmd = rhs[1:].strip()
                out.append(
                    f"{m.group('indent')}{m.group('lhs').rstrip()} = __omp_shell({_quote_arg(cmd)})"
                )
                i += 1
                continue
            if rhs.startswith("%") and not rhs.startswith("%%"):
                head, _ = _split_magic_head(rhs[1:])
                name, args = head
                out.append(
                    f"{m.group('indent')}{m.group('lhs').rstrip()} = __omp_magic({_quote_arg(name)}, {_quote_arg(args)})"
                )
                i += 1
                continue

        out.append(line)
        i += 1

    return "\n".join(out)


def _split_magic_head(text: str) -> tuple[tuple[str, str], str]:
    """Split ``"name rest"`` into ``("name", "rest")``."""
    text = text.lstrip()
    if not text:
        return ("", ""), ""
    m = re.match(r"([A-Za-z_][A-Za-z_0-9]*)(?:\s+(.*))?$", text)
    if not m:
        return ("", text), ""
    return (m.group(1), (m.group(2) or "").rstrip()), ""


# ---------------------------------------------------------------------------
# Magic registry
# ---------------------------------------------------------------------------


_LINE_MAGICS: dict[str, Callable[[str], Any]] = {}
_CELL_MAGICS: dict[str, Callable[[str, str], Any]] = {}


def line_magic(name: str) -> Callable[[Callable[[str], Any]], Callable[[str], Any]]:
    def decorator(fn: Callable[[str], Any]) -> Callable[[str], Any]:
        _LINE_MAGICS[name] = fn
        return fn

    return decorator


def cell_magic(
    name: str,
) -> Callable[[Callable[[str, str], Any]], Callable[[str, str], Any]]:
    def decorator(fn: Callable[[str, str], Any]) -> Callable[[str, str], Any]:
        _CELL_MAGICS[name] = fn
        return fn

    return decorator


def _emit_status(op: str, **data: Any) -> None:
    bundle = {"application/x-omp-status": {"op": op, **data}}
    rid = _CURRENT_RID.get()
    if rid is None:
        return
    _emit({"type": "display", "id": rid, "bundle": bundle})


_SHELL_READ_CHUNK_BYTES = 8192
_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024
_SHELL_OUTPUT_MAX_LINES = 3000
_SHELL_RESULT_CAPTURE_BYTES = _SHELL_OUTPUT_MAX_BYTES
_PIP_LINE_SCAN_CHARS = 64 * 1024
_SHELL_TRUNCATION_NOTICE = (
    f"[output truncated: shell helper exceeded {_SHELL_OUTPUT_MAX_BYTES} bytes "
    f"or {_SHELL_OUTPUT_MAX_LINES} lines; remaining output discarded]\n"
)


def _process_output_encoding() -> str:
    return locale.getpreferredencoding(False) or "utf-8"


def _process_output_decoder(encoding: str) -> codecs.IncrementalDecoder:
    return codecs.getincrementaldecoder(encoding)(errors="strict")


def _take_prefix_by_lines(text: str, max_lines: int) -> str:
    if max_lines <= 0:
        return ""
    cursor = 0
    for _ in range(max_lines):
        newline = text.find("\n", cursor)
        if newline < 0:
            return text
        cursor = newline + 1
    return text[:cursor]


def _take_prefix_by_encoded_bytes(text: str, max_bytes: int, encoding: str) -> str:
    if max_bytes <= 0:
        return ""
    if len(text.encode(encoding, errors="strict")) <= max_bytes:
        return text
    lo = 0
    hi = len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(text[:mid].encode(encoding, errors="strict")) <= max_bytes:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


class _ShellOutputLimiter:
    def __init__(self, *, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._truncated = False
        self._at_line_start = True

    def write(self, text: str) -> None:
        if not text or self._truncated:
            return
        limited = _take_prefix_by_lines(text, self._remaining_lines)
        truncated = limited != text
        byte_limited = _take_prefix_by_encoded_bytes(
            limited, self._remaining_bytes, self._encoding
        )
        truncated = truncated or byte_limited != limited
        if byte_limited:
            sys.stdout.write(byte_limited)
            sys.stdout.flush()
            self._remaining_bytes -= len(
                byte_limited.encode(self._encoding, errors="strict")
            )
            self._remaining_lines -= byte_limited.count("\n")
            self._at_line_start = byte_limited.endswith("\n")
        if truncated:
            self._emit_truncation_notice()

    def _emit_truncation_notice(self) -> None:
        if self._truncated:
            return
        prefix = "" if self._at_line_start else "\n"
        sys.stdout.write(prefix + _SHELL_TRUNCATION_NOTICE)
        sys.stdout.flush()
        self._truncated = True


def _stream_process_output(
    proc: subprocess.Popen, on_text: Callable[[str], None] | None = None
) -> None:
    assert proc.stdout is not None
    encoding = _process_output_encoding()
    decoder = _process_output_decoder(encoding)
    limiter = _ShellOutputLimiter(
        max_bytes=_SHELL_OUTPUT_MAX_BYTES,
        max_lines=_SHELL_OUTPUT_MAX_LINES,
        encoding=encoding,
    )
    while True:
        chunk = os.read(proc.stdout.fileno(), _SHELL_READ_CHUNK_BYTES)
        if not chunk:
            break
        text = decoder.decode(chunk)
        if text:
            limiter.write(text)
            if on_text is not None:
                on_text(text)
    tail = decoder.decode(b"", final=True)
    if tail:
        limiter.write(tail)
        if on_text is not None:
            on_text(tail)


class _BoundedTextCapture:
    def __init__(self, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._parts: list[str] = []

    def add(self, text: str) -> None:
        if self._remaining_bytes <= 0 or self._remaining_lines <= 0:
            return
        line_limited = _take_prefix_by_lines(text, self._remaining_lines)
        part = _take_prefix_by_encoded_bytes(
            line_limited, self._remaining_bytes, self._encoding
        )
        if not part:
            return
        self._parts.append(part)
        self._remaining_bytes -= len(part.encode(self._encoding, errors="strict"))
        self._remaining_lines -= part.count("\n")

    def text(self) -> str:
        return "".join(self._parts)


class _BoundedLineScanner:
    def __init__(self, max_chars: int, on_line: Callable[[str], None]) -> None:
        self._max_chars = max_chars
        self._on_line = on_line
        self._partial = ""

    def add(self, text: str) -> None:
        data = self._partial + text
        lines = data.splitlines(keepends=True)
        if not lines:
            return
        if lines[-1].endswith(("\n", "\r")):
            self._partial = ""
        else:
            self._partial = lines.pop()
        for line in lines:
            self._on_line(line)
        if len(self._partial) > self._max_chars:
            self._partial = self._partial[-self._max_chars :]

    def finish(self) -> None:
        if self._partial:
            self._on_line(self._partial)
            self._partial = ""


@line_magic("pip")
def _magic_pip(args: str) -> None:
    argv = shlex.split(args) if args else ["--help"]
    cmd = [sys.executable, "-m", "pip", *argv]
    # stdin=DEVNULL: see _run_shell_body.
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    installed_packages: list[str] = []

    def scan_pip_line(raw_line: str) -> None:
        m = re.search(r"Successfully installed\s+(.+)$", raw_line)
        if m:
            for token in m.group(1).split():
                # Token is name-version; drop the version suffix.
                pkg = token.rsplit("-", 1)[0]
                installed_packages.append(pkg.replace("_", "-"))

    scanner = _BoundedLineScanner(_PIP_LINE_SCAN_CHARS, scan_pip_line)
    _stream_process_output(proc, scanner.add)
    scanner.finish()
    proc.wait()
    if installed_packages:
        import importlib

        importlib.invalidate_caches()
        prefixes = {pkg.lower().replace("-", "_") for pkg in installed_packages}
        for mod_name in list(sys.modules):
            head = mod_name.split(".", 1)[0].lower()
            if head in prefixes:
                sys.modules.pop(mod_name, None)
    _emit_status(
        "pip", args=args, installed=installed_packages, exit_code=proc.returncode
    )


@line_magic("cd")
def _magic_cd(args: str) -> str:
    path = os.path.expanduser(args.strip()) or os.path.expanduser("~")
    os.chdir(path)
    cwd = os.getcwd()
    _emit_status("cd", path=cwd)
    return cwd


@line_magic("pwd")
def _magic_pwd(_args: str) -> str:
    cwd = os.getcwd()
    _emit_status("pwd", path=cwd)
    return cwd


@line_magic("ls")
def _magic_ls(args: str) -> list[str]:
    target = os.path.expanduser(args.strip()) or "."
    entries = sorted(os.listdir(target))
    _emit_status("ls", path=os.path.abspath(target), count=len(entries))
    return entries


@line_magic("env")
def _magic_env(args: str) -> Any:
    args = args.strip()
    if not args:
        return dict(sorted(os.environ.items()))
    if "=" in args:
        key, value = args.split("=", 1)
        os.environ[key.strip()] = value.strip()
        return value.strip()
    return os.environ.get(args)


@line_magic("set_env")
def _magic_set_env(args: str) -> str:
    parts = args.split(None, 1)
    if len(parts) != 2:
        raise ValueError("Usage: %set_env KEY VALUE")
    key, value = parts
    os.environ[key] = value
    return value


@line_magic("time")
def _magic_time(args: str) -> Any:
    start = time.perf_counter()
    result = eval(args, _STATE.user_ns)
    elapsed = time.perf_counter() - start
    sys.stdout.write(f"Wall time: {elapsed * 1000:.2f} ms\n")
    _emit_status("time", elapsed_ms=round(elapsed * 1000, 3))
    return result


@line_magic("timeit")
def _magic_timeit(args: str) -> None:
    import timeit as _timeit

    timer = _timeit.Timer(stmt=args, globals=_STATE.user_ns)
    iters, total = timer.autorange()
    per = total / iters
    sys.stdout.write(f"{iters} loops, best of 1: {per * 1e6:.2f} us per loop\n")
    _emit_status("timeit", loops=iters, total_ms=round(total * 1000, 3))


@line_magic("who")
def _magic_who(_args: str) -> list[str]:
    names = sorted(
        name
        for name, value in _STATE.user_ns.items()
        if not name.startswith("_")
        and not callable(value)
        or hasattr(value, "__class__")
    )
    return [n for n in names if not n.startswith("__")]


@line_magic("whos")
def _magic_whos(_args: str) -> list[tuple[str, str]]:
    rows = []
    for name in sorted(_STATE.user_ns):
        if name.startswith("__"):
            continue
        value = _STATE.user_ns[name]
        rows.append((name, type(value).__name__))
    return rows


@line_magic("reset")
def _magic_reset(_args: str) -> None:
    _STATE.user_ns.clear()
    _STATE.user_ns.update(
        {"__name__": "__main__", "__doc__": None, "__builtins__": builtins}
    )
    _install_builtins(_STATE.user_ns)
    _emit_status("reset")


@line_magic("load")
def _magic_load(args: str) -> None:
    path = Path(os.path.expanduser(args.strip()))
    source = path.read_text(encoding="utf-8")
    _emit(
        {"type": "display", "id": _CURRENT_RID.get(), "bundle": {"text/plain": source}}
    )
    _exec_source(source, _STATE.user_ns)


@line_magic("run")
def _magic_run(args: str) -> None:
    parts = shlex.split(args) if args else []
    if not parts:
        raise ValueError("Usage: %run <path>")
    target = os.path.expanduser(parts[0])
    saved_argv = sys.argv
    try:
        sys.argv = [target, *parts[1:]]
        result_ns = runpy.run_path(target, run_name="__main__")
    finally:
        sys.argv = saved_argv
    for name, value in result_ns.items():
        if name.startswith("__"):
            continue
        _STATE.user_ns[name] = value


def _resolve_bash() -> str:
    if os.name != "nt":
        return "/bin/bash"
    # Prefer Git Bash over WSL's System32 bash.exe, which runs inside a
    # separate Linux environment and does not share the Windows filesystem
    # layout or PATH.
    for env_var, suffix in (
        ("ProgramFiles", r"Git\bin\bash.exe"),
        ("ProgramFiles(x86)", r"Git\bin\bash.exe"),
        ("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"),
    ):
        root = os.environ.get(env_var)
        if root:
            candidate = os.path.join(root, suffix)
            if os.path.isfile(candidate):
                return candidate
    found = shutil.which("bash")
    if found and "system32" not in found.lower():
        return found
    # WSL's System32 bash.exe runs in a separate Linux environment, so
    # silently falling back to it would execute the cell somewhere the user
    # did not intend; fail loudly instead.
    raise RuntimeError(
        "%%bash requires a POSIX bash, but none was found. "
        "Install Git for Windows or add a non-WSL bash to PATH."
    )


@cell_magic("bash")
def _magic_cell_bash(args: str, body: str) -> int:
    return _run_shell_body(body, shell_arg=_resolve_bash())


@cell_magic("capture")
def _magic_cell_capture(args: str, body: str) -> str:
    """Capture stdout/stderr of body; bind to ``args`` (a name) if provided."""
    captured = io.StringIO()
    saved_stdout, saved_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = captured
    try:
        _exec_source(body, _STATE.user_ns)
    finally:
        sys.stdout, sys.stderr = saved_stdout, saved_stderr
    text = captured.getvalue()
    name = args.strip()
    if name:
        _STATE.user_ns[name] = text
    return text


@cell_magic("timeit")
def _magic_cell_timeit(args: str, body: str) -> None:
    import timeit as _timeit

    timer = _timeit.Timer(stmt=body, globals=_STATE.user_ns)
    iters, total = timer.autorange()
    per = total / iters
    sys.stdout.write(f"{iters} loops, best of 1: {per * 1e6:.2f} us per loop\n")
    _emit_status("timeit", loops=iters, total_ms=round(total * 1000, 3))


@cell_magic("writefile")
def _magic_cell_writefile(args: str, body: str) -> str:
    path = Path(os.path.expanduser(args.strip()))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    _emit_status("writefile", path=str(path), bytes=len(body))
    return str(path)


def _run_shell_body(body: str, *, shell_arg: str) -> int:
    # stdin=DEVNULL: children must not inherit the runner's stdin, which is
    # the host's NDJSON control channel (a reading child would steal frames,
    # and inheriting the pipe deadlocks nested interpreters on Windows).
    proc = subprocess.Popen(
        [shell_arg, "-c", body],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    _stream_process_output(proc)
    proc.wait()
    return proc.returncode


def __omp_magic(name: str, args: str) -> Any:
    fn = _LINE_MAGICS.get(name)
    if fn is None:
        raise NameError(f"UsageError: Line magic function '%{name}' not found.")
    return fn(args)


def __omp_magic_cell(name: str, args: str, body: str) -> Any:
    fn = _CELL_MAGICS.get(name)
    if fn is None:
        raise NameError(f"UsageError: Cell magic function '%%{name}' not found.")
    return fn(args, body)


class _ShellResult(list):
    """Result of ``!cmd`` — list of stripped output lines."""

    def __init__(self, lines: list[str], returncode: int) -> None:
        super().__init__(lines)
        self.returncode = returncode

    @property
    def n(self) -> str:  # IPython compat
        return "\n".join(self)

    @property
    def s(self) -> str:  # IPython compat
        return " ".join(self)


def __omp_shell(cmd: str) -> _ShellResult:
    # stdin=DEVNULL: see _run_shell_body.
    proc = subprocess.Popen(
        cmd,
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    capture = _BoundedTextCapture(
        _SHELL_RESULT_CAPTURE_BYTES, _SHELL_OUTPUT_MAX_LINES, _process_output_encoding()
    )
    _stream_process_output(proc, capture.add)
    proc.wait()
    lines = [line for line in capture.text().splitlines()]
    return _ShellResult(lines, proc.returncode)


# ---------------------------------------------------------------------------
# Display dispatch
# ---------------------------------------------------------------------------


_REPR_MIMES = [
    ("_repr_html_", "text/html"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_json_", "application/json"),
    ("_repr_latex_", "text/latex"),
]


def _is_matplotlib_figure(value: Any) -> bool:
    figure_module = sys.modules.get("matplotlib.figure")
    figure_cls = getattr(figure_module, "Figure", None)
    if isinstance(figure_cls, type) and isinstance(value, figure_cls):
        return True

    value_type = type(value)
    return (
        value_type.__module__ == "matplotlib.figure" and value_type.__name__ == "Figure"
    )


def _matplotlib_figure_png(value: Any) -> str | None:
    if not _is_matplotlib_figure(value):
        return None

    savefig = getattr(value, "savefig", None)
    if not callable(savefig):
        return None

    try:
        buf = io.BytesIO()
        savefig(buf, format="png", bbox_inches="tight")
    except Exception:
        return None

    displayed_ids = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get()
    if displayed_ids is not None:
        displayed_ids.add(id(value))
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _coerce_image_bytes(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str):
        return value
    return base64.b64encode(repr(value).encode("utf-8")).decode("ascii")


def _mime_bundle(value: Any) -> dict:
    """Build a Jupyter-style MIME bundle for ``value``.

    Honors ``_repr_mimebundle_`` first, falls back to individual ``_repr_*_``
    accessors, and always provides ``text/plain``.
    """
    bundle: dict[str, Any] = {}
    matplotlib_png = _matplotlib_figure_png(value)
    if matplotlib_png is not None:
        bundle["image/png"] = matplotlib_png

    mimebundle = getattr(value, "_repr_mimebundle_", None)
    if callable(mimebundle):
        try:
            data = mimebundle()
        except Exception:
            data = None
        if isinstance(data, tuple):
            data = data[0]
        if isinstance(data, dict):
            bundle.update({str(k): v for k, v in data.items()})

    for attr, mime in _REPR_MIMES:
        if mime in bundle:
            continue
        repr_fn = getattr(value, attr, None)
        if not callable(repr_fn):
            continue
        try:
            data = repr_fn()
        except Exception:
            continue
        if data is None:
            continue
        if mime in ("image/png", "image/jpeg"):
            bundle[mime] = _coerce_image_bytes(data)
        else:
            bundle[mime] = data

    if "text/plain" not in bundle:
        try:
            bundle["text/plain"] = repr(value)
        except Exception:
            bundle["text/plain"] = f"<unrepr {type(value).__name__}>"

    return bundle


def _emit_display(bundle: dict, *, kind: str = "display") -> None:
    rid = _CURRENT_RID.get()
    if rid is None:
        return
    _emit({"type": kind, "id": rid, "bundle": bundle})


def __omp_display(value: Any, *, raw: bool = False, kind: str = "display") -> None:
    if raw:
        if not isinstance(value, dict):
            raise TypeError("display(..., raw=True) requires a MIME bundle dict")
        bundle = {str(k): v for k, v in value.items()}
        if "text/plain" not in bundle:
            bundle["text/plain"] = ""
        _emit_display(bundle, kind=kind)
        return
    _emit_display(_mime_bundle(value), kind=kind)


# ---------------------------------------------------------------------------
# Matplotlib post-cell flush
# ---------------------------------------------------------------------------


def _flush_matplotlib_figures() -> None:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        fignums = list(plt.get_fignums())
    except Exception:
        return
    for num in fignums:
        try:
            fig = plt.figure(num)
            if id(fig) in (_CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.get() or set()):
                plt.close(fig)
                continue
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            data = base64.b64encode(buf.getvalue()).decode("ascii")
            _emit_display({"image/png": data, "text/plain": f"<Figure {num}>"})
            plt.close(fig)
        except Exception:
            continue


# Force a non-interactive backend before user code imports matplotlib. Set as
# environ default so the user can still override it explicitly.
os.environ.setdefault("MPLBACKEND", "Agg")


# ---------------------------------------------------------------------------
# Builtin injection
# ---------------------------------------------------------------------------


def _install_builtins(ns: dict) -> None:
    ns["display"] = __omp_display
    ns["__omp_display"] = __omp_display
    ns["__omp_magic"] = __omp_magic
    ns["__omp_magic_cell"] = __omp_magic_cell
    ns["__omp_shell"] = __omp_shell
    ns["__omp_current_run_id__"] = lambda: _CURRENT_RID.get()


_install_builtins(_STATE.user_ns)


# ---------------------------------------------------------------------------
# Source execution (split last expression for rich display)
# ---------------------------------------------------------------------------


_TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def _await_sync(coro) -> Any:
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if running_loop is not None and running_loop.is_running():
        raise RuntimeError(
            "top-level await is not supported from synchronous magic execution"
        )
    return asyncio.run(coro)


def _run_compiled_sync(code, ns: dict, *, want_value: bool) -> Any:
    """Synchronous execution path used by nested magic helpers."""
    if code.co_flags & inspect.CO_COROUTINE:
        result = _await_sync(eval(code, ns))
        return result if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None


async def _run_compiled_async(code, ns: dict, *, want_value: bool) -> Any:
    """Execute a code object in the persistent event loop.

    Coroutine code is awaited in this task so top-level ``await`` interleaves
    with sibling requests. Plain statement/expression code runs on the main
    runner thread so SIGINT can interrupt it reliably.
    """
    if code.co_flags & inspect.CO_COROUTINE:
        result = await eval(code, ns)
        return result if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None



_CALL_SITE_HELPER_NAME = "__omp_with_call_site__"

# Runner-owned reference to the genuine instrumentation helper. The helper is
# defined by the eval prelude inside the user namespace, so the first callable
# observed there is trusted: kernel init always executes the prelude before
# user cells. Any later replacement is pollution from a retained cell.
_TRUSTED_CALL_SITE_HELPERS: dict[str, Any] = {}


def _restore_call_site_helper(ns: dict) -> None:
    """Reinstall the genuine helper after retained-cell pollution.

    A previous cell can assign or delete `__omp_with_call_site__`; without
    this, the next rewritten `tool.read(...)` would resolve to
    user-controlled state and change ordinary eval behavior even with
    speculation disabled.
    """
    current = ns.get(_CALL_SITE_HELPER_NAME)
    trusted = _TRUSTED_CALL_SITE_HELPERS.get(_CALL_SITE_HELPER_NAME)
    if trusted is None:
        if callable(current):
            _TRUSTED_CALL_SITE_HELPERS[_CALL_SITE_HELPER_NAME] = current
        return
    if current is not trusted:
        ns[_CALL_SITE_HELPER_NAME] = trusted


def _cell_binds_call_site_helper(module: ast.Module) -> bool:
    """Whether the cell binds the reserved helper name in any scope."""
    for node in ast.walk(module):
        if isinstance(node, ast.Name):
            if node.id == _CALL_SITE_HELPER_NAME and isinstance(node.ctx, (ast.Store, ast.Del)):
                return True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == _CALL_SITE_HELPER_NAME:
                return True
        elif isinstance(node, ast.arg):
            if node.arg == _CALL_SITE_HELPER_NAME:
                return True
        elif isinstance(node, ast.alias):
            if node.asname == _CALL_SITE_HELPER_NAME:
                return True
        elif isinstance(node, ast.ExceptHandler):
            if node.name == _CALL_SITE_HELPER_NAME:
                return True
    return False

class _ShadowCallSiteTransformer(ast.NodeTransformer):
    def __init__(self, line_offsets: list[int]) -> None:
        self._line_offsets = line_offsets

    def visit_Call(self, node: ast.Call) -> ast.AST:
        transformed = self.generic_visit(node)
        if (
            not isinstance(transformed, ast.Call)
            or _shadow_call_kind(transformed) != "read"
            or transformed.keywords
            or len(transformed.args) != 1
        ):
            return transformed
        if any(
            isinstance(child, (ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr))
            for child in ast.walk(transformed)
        ):
            return transformed
        # Passing the callable and evaluated argument keeps `locals()` in the
        # user cell's frame; a thunk would introduce a lambda frame.
        site_id = f"py:{_shadow_span(node, self._line_offsets)['start']}"
        wrapped = ast.Call(
            func=ast.Name(id=_CALL_SITE_HELPER_NAME, ctx=ast.Load()),
            args=[
                ast.Constant(value=site_id),
                transformed.func,
                transformed.args[0],
            ],
            keywords=[],
        )
        return ast.copy_location(wrapped, node)


def _compile_source(source: str) -> tuple[Any, Any | None, bool]:
    module = ast.parse(source, "<cell>", "exec")
    line_offsets = [0]
    for line in source.splitlines(keepends=True):
        line_offsets.append(line_offsets[-1] + len(line))
    if _CALL_SITE_HELPER_NAME not in source or not _cell_binds_call_site_helper(module):
        module = _ShadowCallSiteTransformer(line_offsets).visit(module)
    ast.fix_missing_locations(module)
    if not module.body:
        return None, None, False

    last = module.body[-1]
    if isinstance(last, ast.Expr):
        body_module = ast.Module(body=module.body[:-1], type_ignores=[])
        expr_module = ast.Expression(body=last.value)
        ast.copy_location(expr_module, last)
        body_code = compile(body_module, "<cell>", "exec", flags=_TLA_FLAG)
        expr_code = compile(expr_module, "<cell>", "eval", flags=_TLA_FLAG)
        return body_code, expr_code, True

    return compile(module, "<cell>", "exec", flags=_TLA_FLAG), None, False


def _exec_source(source: str, ns: dict) -> None:
    """Synchronous source execution for legacy magic helpers."""
    _restore_call_site_helper(ns)
    body_code, expr_code, has_expr = _compile_source(source)
    if body_code is None:
        return
    _run_compiled_sync(body_code, ns, want_value=False)
    if has_expr and expr_code is not None:
        value = _run_compiled_sync(expr_code, ns, want_value=True)
        if value is not None:
            __omp_display(value, kind="result")


async def _exec_source_async(source: str, ns: dict) -> None:
    """Compile + execute ``source``; if the last node is an expression, route
    its value through ``__omp_display`` so dataframes/figures render rich.
    Top-level ``await`` / ``async for`` / ``async with`` is permitted; awaited
    regions yield to other requests in the runner's persistent event loop."""
    _restore_call_site_helper(ns)
    body_code, expr_code, has_expr = _compile_source(source)
    if body_code is None:
        return
    await _run_compiled_async(body_code, ns, want_value=False)
    if has_expr and expr_code is not None:
        value = await _run_compiled_async(expr_code, ns, want_value=True)
        if value is not None:
            __omp_display(value, kind="result")


# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------


def _install_idle_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (OSError, ValueError):
        # Some platforms (Windows in non-console mode) reject this; fine.
        pass


def _install_exec_sigint() -> None:
    try:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    except (OSError, ValueError):
        pass


def _begin_exec_sigint() -> None:
    _STATE.active_executions += 1
    _install_exec_sigint()


def _end_exec_sigint() -> None:
    if _STATE.active_executions > 0:
        _STATE.active_executions -= 1
    if _STATE.active_executions == 0:
        _install_idle_sigint()


_MANAGED_ENV_KEYS = (
    "PI_SESSION_FILE",
    "PI_ARTIFACTS_DIR",
    "PI_TOOL_BRIDGE_URL",
    "PI_TOOL_BRIDGE_TOKEN",
    "PI_TOOL_BRIDGE_SESSION",
    "PI_EVAL_LOCAL_ROOTS",
)


def _apply_request_runtime(req: dict) -> None:
    cwd = req.get("cwd")
    if isinstance(cwd, str) and cwd:
        os.chdir(cwd)
        try:
            sys.path.remove(cwd)
        except ValueError:
            pass
        sys.path.insert(0, cwd)

    env = req.get("env")
    if isinstance(env, dict):
        for key in _MANAGED_ENV_KEYS:
            value = env.get(key)
            if isinstance(value, str):
                os.environ[key] = value
            elif value is None:
                os.environ.pop(key, None)


def _start_parent_watchdog() -> None:
    """Self-terminate when the host process dies.

    The main loop only exits when stdin EOFs, which only happens once user
    code finishes and the next ``readline`` call returns. If the host gets
    SIGKILL mid-execution (or any way that skips graceful shutdown) the
    runner would otherwise outlive its parent and keep holding kernel
    state. Poll ``os.getppid()`` instead and ``os._exit`` the moment we get
    reparented \u2014 covers POSIX hosts. Windows has no reliable ppid
    equivalent; there we still bail out on the next stdin read.
    """
    if os.name != "posix":
        return
    original_ppid = os.getppid()
    if original_ppid <= 1:
        return

    def watch() -> None:
        while True:
            try:
                if os.getppid() != original_ppid:
                    os._exit(0)
            except Exception:
                return
            time.sleep(10)

    thread = threading.Thread(target=watch, name="omp-parent-watchdog", daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------


def _jsonable(value: Any) -> Any:
    """Convert a tool result into a JSON-safe value without failing the request."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    return repr(value)


def _handle_tool_request(req: dict) -> None:
    """Describe or invoke a kernel-defined tool on a dedicated runner thread."""
    rid = str(req.get("id"))
    token = _CURRENT_RID.set(rid)
    status = "ok"
    _emit({"type": "started", "id": rid})
    try:
        tools = _STATE.user_ns.get("__omp_tools__") or {}
        op = req.get("op")
        if op == "describe":
            requested = req.get("names") or list(tools)
            envelope = {
                "ok": True,
                "tools": [tools[name].describe() for name in requested if name in tools],
                "missing": [name for name in requested if name not in tools],
            }
        elif op == "call":
            name = str(req.get("name") or "")
            spec = tools.get(name)
            if spec is None:
                raise KeyError(f"tool {name!r} is not defined")
            result = spec.fn(**(req.get("args") or {}))
            if inspect.isawaitable(result):
                result = asyncio.run(result)
            envelope = {"ok": True, "value": _jsonable(result)}
        else:
            raise ValueError(f"unknown tool operation {op!r}")
        _emit_display({"application/json": envelope})
    except BaseException as exc:  # noqa: BLE001 - protocol errors must settle the request
        status = "error"
        _emit_error(rid, exc)
    finally:
        _flush_stream_proxies(rid)
        _emit(
            {
                "type": "done",
                "id": rid,
                "status": status,
                "executionCount": _STATE.execution_count,
                "cancelled": False,
            }
        )
        _CURRENT_RID.reset(token)


async def _handle_request_async(req: dict) -> None:
    rid = str(req.get("id"))
    execution_reserved = bool(req.pop("_execution_reserved", False))
    execution_started = False
    token = _CURRENT_RID.set(rid)
    displayed_matplotlib_token = _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.set(set())
    _STATE.capture_rid = rid
    reset_call_occurrences = _STATE.user_ns.get("__omp_reset_call_occurrences__")
    if callable(reset_call_occurrences):
        reset_call_occurrences()
    _STATE.namespace_revision += 1
    _STATE.user_ns["__omp_run_id__"] = rid
    _STATE.cancel_requested = False
    _STATE.execution_count += 1
    execution_count = _STATE.execution_count
    _emit({"type": "started", "id": rid})

    status: str = "ok"
    cancelled = False

    try:
        try:
            _apply_request_runtime(req)
            transformed = transform_cell(req.get("code", ""))
        except SyntaxError as exc:
            _emit_error(rid, exc)
            _emit(
                {
                    "type": "done",
                    "id": rid,
                    "status": "error",
                    "executionCount": execution_count,
                    "cancelled": False,
                }
            )
            return
        except BaseException as exc:  # noqa: BLE001 - runtime setup errors must settle the request
            _emit_error(rid, exc)
            _emit(
                {
                    "type": "done",
                    "id": rid,
                    "status": "error",
                    "executionCount": execution_count,
                    "cancelled": False,
                }
            )
            return

        if execution_reserved:
            _install_exec_sigint()
        else:
            _begin_exec_sigint()
        execution_started = True
        try:
            await _exec_source_async(transformed, _STATE.user_ns)
        except KeyboardInterrupt:
            cancelled = True
            status = "error"
            _emit_error(rid, KeyboardInterrupt("Execution interrupted"))
        except SystemExit as exc:
            status = "error"
            _emit_error(rid, exc)
        except BaseException as exc:  # noqa: BLE001 - we want to surface every user error
            status = "error"
            _emit_error(rid, exc)
        finally:
            _end_exec_sigint()
            try:
                _flush_matplotlib_figures()
            except Exception:
                pass

        _flush_stream_proxies(rid)
        _emit(
            {
                "type": "done",
                "id": rid,
                "status": status,
                "executionCount": execution_count,
                "cancelled": cancelled,
            }
        )
    finally:
        if _STATE.capture_rid == rid:
            _STATE.capture_rid = None
        _flush_stream_proxies(rid)
        _CURRENT_RID.reset(token)
        _CURRENT_DISPLAYED_MATPLOTLIB_FIGURE_IDS.reset(displayed_matplotlib_token)
        if execution_reserved and not execution_started:
            _end_exec_sigint()


def _emit_error(rid: str, exc: BaseException) -> None:
    if isinstance(exc, SyntaxError) and exc.filename == "<cell>":
        # Syntax error in the cell source itself: every stack frame is runner
        # machinery, so emit only the caret display, like a REPL.
        tb_lines = traceback.format_exception_only(type(exc), exc)
    else:
        # Drop the leading runner-internal frames (_handle_request_async ->
        # _exec_source_async -> _run_compiled_*) so tracebacks start at user
        # code. If the exception never reached user code it is a runner bug;
        # keep the full traceback because those frames are the diagnosis.
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
            tb = tb.tb_next
        tb_lines = traceback.format_exception(
            type(exc), exc, tb if tb is not None else exc.__traceback__
        )
    _emit(
        {
            "type": "error",
            "id": rid,
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": [line.rstrip("\n") for line in tb_lines],
        }
    )


def _admit_shadow_run(req: dict) -> bool:
    expected_revision = req.get("expectedShadowRevision")
    expected_digest = req.get("expectedShadowDigest")
    if expected_revision is not None or expected_digest is not None:
        values = _snapshot_user_namespace()
        eligible = (
            _STATE.active_executions == 0
            and expected_revision == _STATE.namespace_revision
            and expected_digest == _shadow_snapshot_digest(values)
        )
        if not eligible:
            _emit(
                {
                    "type": "done",
                    "id": str(req.get("id")),
                    "status": "ok",
                    "executionCount": _STATE.execution_count,
                    "cancelled": False,
                    "admissionRejected": True,
                }
            )
            return False
    _STATE.active_executions += 1
    req["_execution_reserved"] = True
    return True

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def _parse_request(line: str) -> dict | None:
    """Parse one NDJSON control line, or ``None`` when it should be skipped.

    Emits a ``ProtocolError`` frame for malformed JSON so the host sees the
    same diagnostic the reader has always produced.
    """
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        _emit(
            {
                "type": "error",
                "id": "",
                "ename": "ProtocolError",
                "evalue": f"Invalid JSON request: {exc}",
                "traceback": [],
            }
        )
        return None


def _read_stdin(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, stdin) -> None:
    """Feed control-channel requests to the event loop from a reader thread.

    POSIX only -- see ``_serve_windows`` for why Windows cannot run a
    perpetually blocked stdin reader.
    """
    for raw_line in stdin:
        line = raw_line.strip()
        if not line:
            continue
        req = _parse_request(line)
        if req is None:
            continue
        if req.get("type") == "tool":
            threading.Thread(
                target=_handle_tool_request,
                args=(req,),
                name=f"omp-tool-{req.get('id')}",
                daemon=True,
            ).start()
            continue
        loop.call_soon_threadsafe(queue.put_nowait, req)
    loop.call_soon_threadsafe(queue.put_nowait, {"type": "exit"})


async def _serve_posix(loop: asyncio.AbstractEventLoop, stdin) -> None:
    """Dispatch requests concurrently, one asyncio task per request.

    A background thread reads stdin and enqueues requests so a cell parked on
    a top-level ``await`` (an ``await agent(...)`` bridge call, say) does not
    block sibling requests: eval sessions are shared across concurrent agents
    (subagents inherit the parent's eval session id), so multiple requests can
    be in flight on one kernel at once. The reader thread stays blocked in a
    ``sys.stdin`` read for its whole life, which is safe on POSIX but wedges
    native-extension imports on Windows (see ``_serve_windows``).
    """
    queue: asyncio.Queue = asyncio.Queue()
    reader = threading.Thread(
        target=_read_stdin,
        args=(loop, queue, stdin),
        name="omp-stdin-reader",
        daemon=True,
    )
    reader.start()

    tasks: set[asyncio.Task] = set()

    def _task_done(task: asyncio.Task) -> None:
        tasks.discard(task)
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            _emit_error("", exc)

    try:
        while True:
            req = await queue.get()
            if req.get("type") == "exit":
                break
            if req.get("type") == "shadow_snapshot":
                _emit_shadow_snapshot(req)
                continue
            if req.get("type") == "shadow_plan":
                _emit_shadow_plan(req)
                continue
            if not _admit_shadow_run(req):
                continue
            task = asyncio.create_task(_handle_request_async(req))
            tasks.add(task)
            task.add_done_callback(_task_done)
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def _serve_windows(loop: asyncio.AbstractEventLoop, stdin) -> None:
    """Dispatch requests serially, serving tool requests between cells.

    A thread perpetually parked in a blocking ``sys.stdin`` read deadlocks
    native-extension imports (NumPy in particular) under a pipe-backed
    subprocess on Windows: the native DLL load and the concurrent stdin read
    wedge each other (numpy#24290, issue #7985). Reading each line via
    ``run_in_executor`` confines the stdin read to the gap *between* requests
    -- once a line arrives the reader returns, so no thread is reading stdin
    while a cell (and its imports) run. The trade-off is that requests are
    handled one at a time instead of interleaved; on Windows that is strictly
    better than the alternative, since any concurrent reader deadlocks the
    import outright.
    """
    while True:
        raw_line = await loop.run_in_executor(None, stdin.readline)
        if not raw_line:
            break  # EOF: the host closed the control channel.
        line = raw_line.strip()
        if not line:
            continue
        req = _parse_request(line)
        if req is None:
            continue
        if req.get("type") == "exit":
            break
        if req.get("type") == "shadow_snapshot":
            _emit_shadow_snapshot(req)
            continue
        if req.get("type") == "shadow_plan":
            _emit_shadow_plan(req)
            continue
        if req.get("type") == "tool":
            threading.Thread(
                target=_handle_tool_request,
                args=(req,),
                name=f"omp-tool-{req.get('id')}",
                daemon=True,
            ).start()
            continue
        if not _admit_shadow_run(req):
            continue
        try:
            await _handle_request_async(req)
        except asyncio.CancelledError:
            raise  # task cancellation must propagate; never swallow it and spin
        except BaseException as exc:  # noqa: BLE001 - one bad request must not wedge the loop
            _emit_error(str(req.get("id", "")), exc)


async def _main_async() -> None:
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")
    _install_idle_sigint()
    _start_parent_watchdog()
    _start_capture_drain()

    stdin = sys.__stdin__
    if stdin is None:
        return

    loop = asyncio.get_running_loop()
    _STATE.loop = loop

    if os.name == "nt":
        await _serve_windows(loop, stdin)
    else:
        await _serve_posix(loop, stdin)


def main() -> None:
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
