//! Child-local embedded-CPython implementation of [`super::EvalExec`].
//!
//! Production starts this kernel in a dedicated process owned by one eval
//! session. Within that process a worker preserves cell order and interpreter
//! state; replacing the process provides full session reset and containment.
//!
//! Output routing rides a `contextvars.ContextVar`: each cell publishes its
//! sink in the worker's context and inside the session's asyncio runner, so
//! threads and tasks started by a cell inherit it (free-threaded 3.14 copies
//! the caller's context into new threads). A write whose context sink is
//! sealed may only move to the *same session's* currently open cell; a write
//! with no context sink at all has no provenance and is discarded rather
//! than risked across sessions. A cell's sink is sealed before its terminal
//! event is sent, so
//! `Completed` is always the last event on the channel.
//!
//! Timeouts are enforced solely by a Tokio watchdog task that first cancels
//! host work, then raises `KeyboardInterrupt` in the worker after the
//! configured interrupt grace through the shared `omp_py::interrupt` API.
//! Python-side line tracing is deliberately absent because it deoptimizes the
//! whole cell without covering anything the async interrupt cannot.

use std::{
	collections::{HashMap, HashSet},
	ffi, future, io, mem, ptr,
	sync::{
		Arc, LazyLock, Weak,
		atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
	},
	thread,
	time::Duration as StdDuration,
};

use bytes::Bytes;
use flume::{Receiver, Sender};
use omp_core::{CowBytes, Duration, DurationError, Str, sf};
use omp_py::{
	Engine,
	interrupt::{current_thread_id, interrupt},
};
use parking_lot::Mutex;
use pyo3::{
	Py, PyAny, PyResult, Python,
	class::gc::{PyTraverseError, PyVisit},
	exceptions::{PyKeyError, PyOSError, PyRuntimeError, PyValueError},
	ffi::c_str,
	prelude::*,
	pyclass, pymethods,
	sync::PyOnceLock,
	types::{PyAnyMethods, PyByteArray, PyBytes, PyDict, PyDictMethods, PyModule, PyTuple},
};
use serde_json::Value;
use tokio::{runtime::Handle, sync::Mutex as AsyncMutex, task::JoinHandle, time};

#[cfg(test)]
use super::RuntimeSnapshot;
use super::{
	CellOutcome, CellStatus, CellValue, DisplayOutput, EvalExec, EvalRun, Fault, OutputChannel,
	PythonException, RunCompletion, RunEvent, RunRequest, Session, Update,
	idle_timeout::{TimeoutHandle, TimeoutPause},
};

const MAX_DISPLAY_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

const BOOTSTRAP: &ffi::CStr = c_str!(
	r#"
import ast as _omp_ast
import asyncio as _omp_asyncio
import codecs as _omp_codecs
import contextvars as _omp_contextvars
import inspect as _omp_inspect
import json as _omp_json
import os as _omp_os
import re as _omp_re
import subprocess as _omp_subprocess
import sys as _omp_sys
import threading as _omp_threading
import types as _omp_types
import time as _omp_time
import traceback as _omp_traceback

_OMP_TLA = getattr(_omp_ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)

# _OMP_SINK (a contextvars.ContextVar) is injected by the host after import;
# it carries the active cell's output sink into threads and asyncio tasks.

if not hasattr(_omp_sys, "__omp_thread_streams__"):
    _omp_sys.__omp_thread_streams__ = _omp_threading.local()

    class _OmpThreadLocalSys(_omp_types.ModuleType):
        def __getattribute__(self, name):
            if name in ("stdout", "stderr"):
                streams = _omp_types.ModuleType.__getattribute__(
                    self, "__omp_thread_streams__")
                try:
                    return getattr(streams, name)
                except AttributeError:
                    pass
            return _omp_types.ModuleType.__getattribute__(self, name)

        def __setattr__(self, name, value):
            if name in ("stdout", "stderr"):
                streams = _omp_types.ModuleType.__getattribute__(
                    self, "__omp_thread_streams__")
                setattr(streams, name, value)
                return
            _omp_types.ModuleType.__setattr__(self, name, value)

        def __delattr__(self, name):
            if name in ("stdout", "stderr"):
                streams = _omp_types.ModuleType.__getattribute__(
                    self, "__omp_thread_streams__")
                delattr(streams, name)
                return
            _omp_types.ModuleType.__delattr__(self, name)

    _omp_sys.__class__ = _OmpThreadLocalSys

def _omp_new_namespace():
    return {
        "__name__": "__main__",
        "__builtins__": __builtins__,
        "__omp_async_runner": _omp_asyncio.Runner(),
        "_omp_os": _omp_os,
        "_omp_sys": _omp_sys,
        "_omp_shell": _omp_shell,
        "_omp_magic_env": _omp_magic_env,
        "_omp_magic_who": _omp_magic_who,
        "_omp_magic_reset": _omp_magic_reset,
        "_omp_capture": _omp_capture,
        "_omp_timeit": _omp_timeit,
    }

class _OmpShellResult(list):
    def __init__(self, lines, returncode):
        super().__init__(lines)
        self.returncode = returncode

def _omp_shell(command):
    process = _omp_subprocess.Popen(
        command,
        shell=True,
        stdin=_omp_subprocess.DEVNULL,
        stdout=_omp_subprocess.PIPE,
        stderr=_omp_subprocess.STDOUT,
    )
    decoder = _omp_codecs.getincrementaldecoder("utf-8")("replace")
    pieces = []
    try:
        while True:
            chunk = process.stdout.read(64 * 1024)
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                pieces.append(text)
                print(text, end="")
        tail = decoder.decode(b"", final=True)
        if tail:
            pieces.append(tail)
            print(tail, end="")
        returncode = process.wait()
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()
    output = "".join(pieces)
    if output and not output.endswith("\n"):
        print()
    return _OmpShellResult(output.splitlines(), returncode)

def _omp_magic_env(argument):
    if "=" in argument:
        key, value = argument.split("=", 1)
        _omp_os.environ[key.strip()] = value.strip()
        return value.strip()
    if argument:
        return _omp_os.environ.get(argument.strip())
    return dict(sorted(_omp_os.environ.items()))

def _omp_magic_who(namespace):
    names = sorted(
        name for name in namespace
        if not name.startswith("_") and name not in {"display", "tool", "budget"}
    )
    print(" ".join(names))
    return names

def _omp_magic_reset(namespace):
    for name in list(namespace):
        if not name.startswith("_") and name not in {
            "display", "read", "write", "output", "tool", "completion",
            "agent", "parallel", "pipeline", "budget", "env", "log", "phase",
        }:
            namespace.pop(name, None)

class _OmpCaptured:
    def __init__(self, stdout, stderr):
        self.stdout = stdout
        self.stderr = stderr

    def __repr__(self):
        return f"<captured stdout={len(self.stdout)}ch stderr={len(self.stderr)}ch>"

def _omp_capture(name, source, namespace):
    io = __import__("io")
    builtins = __import__("builtins")
    stdout = io.StringIO()
    stderr = io.StringIO()
    missing = object()
    previous_print = namespace.get("print", missing)

    def capture_print(*values, **options):
        target = options.get("file")
        if target is None or target is _omp_sys.stdout:
            options["file"] = stdout
        elif target is _omp_sys.stderr:
            options["file"] = stderr
        builtins.print(*values, **options)

    namespace["print"] = capture_print
    try:
        exec(compile(source, "<capture>", "exec"), namespace)
    finally:
        if previous_print is missing:
            namespace.pop("print", None)
        else:
            namespace["print"] = previous_print
    captured = _OmpCaptured(stdout.getvalue(), stderr.getvalue())
    namespace[name] = captured
    return captured

def _omp_timeit(source, namespace):
    code = compile(source, "<timeit>", "exec")
    samples = []
    for _ in range(5):
        started = _omp_time.perf_counter()
        exec(code, namespace)
        samples.append(_omp_time.perf_counter() - started)
    best = min(samples)
    print(f"{best * 1000:.3f} ms per loop (best of {len(samples)})")
    return best

def _omp_cell_magic(source):
    lines = source.splitlines()
    if not lines:
        return source
    header = lines[0].strip()
    body = "\n".join(lines[1:])
    if header == "%%bash":
        return f"_omp_shell({_omp_json.dumps(body)})\nNone"
    if header.startswith("%%capture "):
        name = header[len("%%capture "):].strip()
        if not _omp_re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            raise SyntaxError("%%capture requires a variable name")
        return f"_omp_capture({_omp_json.dumps(name)}, {_omp_json.dumps(body)}, globals())"
    if header == "%%timeit":
        return f"_omp_timeit({_omp_json.dumps(body)}, globals())"
    if header.startswith("%%writefile "):
        target = header[len("%%writefile "):].strip()
        return (
            "from pathlib import Path as _OmpPath\n"
            f"_omp_write_target = _OmpPath({_omp_json.dumps(target)}).expanduser()\n"
            "_omp_write_target.parent.mkdir(parents=True, exist_ok=True)\n"
            f"_omp_write_target.write_text({_omp_json.dumps(body)}, encoding='utf-8')"
        )
    return source

def _omp_transform_cell(source):
    source = _omp_cell_magic(source)
    transformed = []
    for line in source.splitlines():
        stripped = line.lstrip()
        indent = line[:len(line) - len(stripped)]
        assignment = _omp_re.match(
            r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*!(.*)$", stripped)
        if assignment:
            transformed.append(
                f"{indent}{assignment.group(1)} = _omp_shell("
                f"{_omp_json.dumps(assignment.group(2).strip())})")
        elif stripped.startswith("!"):
            transformed.append(
                f"{indent}_omp_shell({_omp_json.dumps(stripped[1:].strip())})")
            transformed.append(f"{indent}None")
        elif stripped.startswith("%cd "):
            transformed.append(
                f"{indent}_omp_os.chdir(_omp_os.path.expanduser("
                f"{_omp_json.dumps(stripped[4:].strip())}))")
        elif stripped == "%pwd":
            transformed.append(f"{indent}print(_omp_os.getcwd())")
        elif stripped.startswith("%env"):
            transformed.append(
                f"{indent}_omp_magic_env({_omp_json.dumps(stripped[4:].strip())})")
        elif stripped in {"%who", "%whos"}:
            transformed.append(f"{indent}_omp_magic_who(globals())")
        elif stripped == "%reset":
            transformed.append(f"{indent}_omp_magic_reset(globals())")
        elif stripped.startswith("%pip "):
            command = (
                _omp_json.dumps(_omp_sys.executable)
                + " + ' -m pip ' + "
                + _omp_json.dumps(stripped[5:].strip())
            )
            transformed.append(f"{indent}_omp_shell({command})")
            transformed.append(f"{indent}None")
        elif stripped.startswith("%ls"):
            transformed.append(
                f"{indent}_omp_shell({_omp_json.dumps('ls ' + stripped[3:].strip())})")
            transformed.append(f"{indent}None")
        elif stripped.startswith("%load "):
            target = stripped[6:].strip()
            transformed.append(
                f"{indent}exec(compile(open({_omp_json.dumps(target)}, "
                f"encoding='utf-8').read(), {_omp_json.dumps(target)}, 'exec'), globals())")
        elif stripped.startswith("%timeit "):
            transformed.append(
                f"{indent}_omp_timeit({_omp_json.dumps(stripped[8:].strip())}, globals())")
        elif stripped.startswith("%run "):
            target = stripped[5:].strip()
            transformed.append(
                f"{indent}exec(compile(open({_omp_json.dumps(target)}, "
                f"encoding='utf-8').read(), {_omp_json.dumps(target)}, 'exec'), globals())")
        elif stripped.startswith("%time "):
            transformed.append(indent + stripped[6:])
        else:
            transformed.append(line)
    return "\n".join(transformed)

def _omp_compile(source):
    source = _omp_transform_cell(source)
    module = _omp_ast.parse(source, "<cell>", "exec")
    if not module.body:
        return None, None
    last = module.body[-1]
    if isinstance(last, _omp_ast.Expr):
        body = _omp_ast.Module(body=module.body[:-1], type_ignores=[])
        expr = _omp_ast.Expression(body=last.value)
        _omp_ast.copy_location(expr, last)
        return (compile(body, "<cell>", "exec", flags=_OMP_TLA),
                compile(expr, "<cell>", "eval", flags=_OMP_TLA))
    return compile(module, "<cell>", "exec", flags=_OMP_TLA), None

async def _omp_run_async(code, ns, want_value, sink):
    _OMP_SINK.set(sink)
    if code.co_flags & _omp_inspect.CO_COROUTINE:
        value = await eval(code, ns)
        return value if want_value else None
    if want_value:
        return eval(code, ns)
    exec(code, ns)
    return None

def _omp_run(code, ns, want_value, sink):
    if code is None:
        return None
    runner = ns["__omp_async_runner"]
    coro = _omp_run_async(code, ns, want_value, sink)
    try:
        return runner.run(coro)
    except BaseException:
        # An asynchronously raised KeyboardInterrupt can land in the runner's
        # own plumbing instead of the cell's frames. The cell task is then
        # left scheduled on the persistent loop and the next cell would run
        # it first; cancel and drain exactly that task before re-raising.
        loop = getattr(runner, "_loop", None)
        if loop is not None and not loop.is_closed():
            for task in _omp_asyncio.all_tasks(loop):
                if task.get_coro() is coro and not task.done():
                    task.cancel()
                    try:
                        loop.run_until_complete(task)
                    except BaseException:
                        pass
        raise

def _omp_apply_runtime(cwd, managed_env):
    if cwd is not None:
        _omp_os.chdir(cwd)
        while cwd in _omp_sys.path:
            _omp_sys.path.remove(cwd)
        _omp_sys.path.insert(0, cwd)
    for key, value in managed_env.items():
        if value is None:
            _omp_os.environ.pop(key, None)
        else:
            _omp_os.environ[key] = value

def _omp_run_cell(source, ns, timeout_control, sink):
    started = _omp_time.perf_counter()
    token = _OMP_SINK.set(sink)
    ns["__omp_timeout_pause__"] = timeout_control.pause
    ns["__omp_timeout_resume__"] = timeout_control.resume

    outcome = "complete"
    result_text = None
    result_json = None
    error_name = None
    error_message = None
    error_traceback = []
    try:
        body, expr = _omp_compile(source)
        _omp_run(body, ns, False, sink)
        if expr is not None:
            value = _omp_run(expr, ns, True, sink)
            if value is not None:
                result_text = repr(value)
                try:
                    result_json = _omp_json.dumps(value, allow_nan=False, separators=(",", ":"))
                except (TypeError, ValueError, OverflowError):
                    result_json = None
                if any(hasattr(value, name) for name in (
                    "_repr_mimebundle_", "_repr_json_", "_repr_markdown_",
                    "_repr_html_", "_repr_svg_", "_repr_png_", "_repr_jpeg_",
                    "_repr_latex_",
                )):
                    presenter = ns.get("display")
                    if callable(presenter):
                        presenter(value)
    except BaseException as exc:
        outcome = "cancelled" if isinstance(exc, KeyboardInterrupt) else "error"
        error_name = type(exc).__name__
        error_message = str(exc)
        error_traceback = _omp_traceback.format_exception(type(exc), exc, exc.__traceback__)
    finally:
        _OMP_SINK.reset(token)
        timeout_control.clear()
        ns.pop("__omp_timeout_pause__", None)
        ns.pop("__omp_timeout_resume__", None)

    return {
        "outcome": outcome,
        "result_text": result_text,
        "result_json": result_json,
        "error_name": error_name,
        "error_message": error_message,
        "error_traceback": error_traceback,
        "duration_ms": int((_omp_time.perf_counter() - started) * 1000),
    }
"#
);

/// Cloneable embedded Python kernel used inside an eval child process.
///
/// The caller owns the child-local [`Engine`] and must initialize it exactly
/// once. Production creates one child process and one kernel session per eval
/// session; multiple workers remain available for focused kernel tests.
#[derive(Clone)]
pub struct EmbeddedPython {
	inner: Arc<Inner>,
}

struct Inner {
	engine:          Arc<Engine>,
	next_cell:       AtomicU64,
	installer:       Arc<dyn NamespaceInstaller>,
	interrupt_grace: StdDuration,
	workers:         Mutex<HashMap<Bytes, Arc<Worker>>>,
}

struct Worker {
	commands: Sender<Command>,
	state:    Arc<WorkerState>,
	enqueue:  AsyncMutex<()>,
}

struct WorkerState {
	engine:          Arc<Engine>,
	thread_id:       AtomicI64,
	epoch:           AtomicU64,
	alive:           AtomicBool,
	active:          Mutex<Option<ActiveCell>>,
	installer:       Arc<dyn NamespaceInstaller>,
	interrupt_grace: StdDuration,
}

struct ActiveCell {
	cell_id:   Bytes,
	cancelled: Arc<AtomicBool>,
}

struct Command {
	cell_id:   Bytes,
	session:   Bytes,
	request:   RunRequest,
	events:    Sender<Result<RunEvent, Fault>>,
	cancelled: Arc<AtomicBool>,
	timed_out: Arc<AtomicBool>,
	runtime:   Option<Handle>,
	epoch:     u64,
}

impl WorkerState {
	fn begin_interrupt(&self, target: &Arc<AtomicBool>) -> bool {
		let cell_id = {
			let active = self.active.lock();
			let Some(active) = active
				.as_ref()
				.filter(|active| Arc::ptr_eq(&active.cancelled, target))
			else {
				return false;
			};
			active.cell_id.clone()
		};
		self.installer.cancel_cell(&cell_id);
		true
	}

	async fn interrupt_after_grace(&self, target: &Arc<AtomicBool>) -> Result<(), Fault> {
		if !self.begin_interrupt(target) {
			return Ok(());
		}
		time::sleep(self.interrupt_grace).await;
		self.interrupt_if_active(target)
	}

	async fn cancel_active(&self) -> Result<(), Fault> {
		let Some(cancelled) = self.active_cancellation() else {
			return Ok(());
		};
		cancelled.store(true, Ordering::Release);
		self.interrupt_after_grace(&cancelled).await
	}

	fn schedule_active_cancellation(self: &Arc<Self>) {
		let Some(cancelled) = self.active_cancellation() else {
			return;
		};
		cancelled.store(true, Ordering::Release);
		self.schedule_interrupt(cancelled);
	}

	fn active_cancellation(&self) -> Option<Arc<AtomicBool>> {
		let active = self.active.lock();
		active.as_ref().map(|active| Arc::clone(&active.cancelled))
	}

	fn schedule_interrupt(self: &Arc<Self>, target: Arc<AtomicBool>) {
		if !self.begin_interrupt(&target) {
			return;
		}
		let Ok(runtime) = Handle::try_current() else {
			let _ = self.interrupt_if_active(&target);
			return;
		};
		let state = Arc::clone(self);
		runtime.spawn(async move {
			time::sleep(state.interrupt_grace).await;
			let _ = state.interrupt_if_active(&target);
		});
	}

	fn interrupt_if_active(&self, target: &Arc<AtomicBool>) -> Result<(), Fault> {
		// Raise while holding the registration lock: the worker removes its
		// registration under this lock before its thread can finish the cell
		// and exit, so the loaded ident always names a live worker thread and
		// the exception can never land on a recycled thread id.
		let active = self.active.lock();
		if !active
			.as_ref()
			.is_some_and(|active| Arc::ptr_eq(&active.cancelled, target))
		{
			return Ok(());
		}
		self.interrupt_thread()
	}

	fn interrupt_thread(&self) -> Result<(), Fault> {
		let id = self.thread_id.load(Ordering::Acquire);
		let changed = self.engine.attach(|py| interrupt(py, id as u64));
		if changed {
			return Ok(());
		}
		Err(Fault::Resource {
			operation: sf!("cancel"),
			message:   sf!("CPython did not identify exactly one active eval thread"),
		})
	}
}

impl Drop for Worker {
	fn drop(&mut self) {
		self.state.schedule_active_cancellation();
	}
}

static OUTPUT_ROUTER_OBJECTS: PyOnceLock<(Py<OutputRouter>, Py<OutputRouter>)> = PyOnceLock::new();
/// Routing context variable holding the active cell's [`CellSink`]; created
/// once and injected into the bootstrap module as `_OMP_SINK`.
static SINK_VAR: PyOnceLock<Py<PyAny>> = PyOnceLock::new();
/// Registry of sinks for currently-executing cells, backing the same-session
/// redirect for writes whose context sink is already sealed.
static OPEN_SINKS: LazyLock<Arc<SinkRegistry>> =
	LazyLock::new(|| Arc::new(SinkRegistry::default()));

struct SinkState {
	open:     bool,
	sequence: u64,
}

/// Gated per-cell event sink shared by the router, the worker, and Python.
struct SinkShared {
	session: Bytes,
	events:  Sender<Result<RunEvent, Fault>>,
	state:   Mutex<SinkState>,
}

impl SinkShared {
	const fn new(session: Bytes, events: Sender<Result<RunEvent, Fault>>) -> Self {
		Self { session, events, state: Mutex::new(SinkState { open: true, sequence: 0 }) }
	}

	/// Emits one ordered output event, or `None` once the cell is sealed.
	///
	/// The sequence increment and channel send share one critical section with
	/// [`Self::close`], so no output can trail the terminal `Completed` event
	/// the worker sends after sealing.
	fn write(&self, channel: OutputChannel, text: &str) -> Option<usize> {
		let mut state = self.state.lock();
		if !state.open {
			return None;
		}
		for chunk in text.as_bytes().chunks(OUTPUT_CHUNK_BYTES) {
			let sequence = state.sequence;
			state.sequence += 1;
			let _ = self.events.send(Ok(RunEvent::Output(Update {
				channel,
				data: CowBytes::owned(Bytes::copy_from_slice(chunk)),
				sequence,
			})));
		}
		Some(text.chars().count())
	}

	/// Seals the sink. Idempotent.
	fn close(&self) {
		self.state.lock().open = false;
	}
}

/// Sinks of currently-executing cells, consulted when a write arrives from a
/// context that predates the running cell (pre-existing thread pools, threads
/// or tasks surviving their cell).
#[derive(Default)]
struct SinkRegistry {
	open: Mutex<Vec<Arc<SinkShared>>>,
}

impl SinkRegistry {
	/// Returns the open sink belonging to `session`, if that session is
	/// currently running a cell.
	///
	/// This is the only legal redirect target for output whose context names a
	/// sealed sink: the sealed sink proves the writer's session, so routing
	/// anywhere else would leak output across sessions. Writes with no context
	/// sink at all have no provenance and are never rerouted.
	fn open_for(&self, session: &Bytes) -> Option<Arc<SinkShared>> {
		self
			.open
			.lock()
			.iter()
			.find(|sink| sink.session == *session)
			.map(Arc::clone)
	}
}

/// RAII registration of one cell's sink. Closing (or dropping) seals the gate
/// and removes the redirect target before the worker emits the terminal
/// event.
struct SinkGuard {
	registry: Arc<SinkRegistry>,
	shared:   Arc<SinkShared>,
}

impl SinkGuard {
	fn open(
		registry: Arc<SinkRegistry>,
		session: Bytes,
		events: Sender<Result<RunEvent, Fault>>,
	) -> Self {
		let shared = Arc::new(SinkShared::new(session, events));
		registry.open.lock().push(Arc::clone(&shared));
		Self { registry, shared }
	}

	/// Seals the sink. Idempotent.
	fn close(&self) {
		self
			.registry
			.open
			.lock()
			.retain(|sink| !Arc::ptr_eq(sink, &self.shared));
		self.shared.close();
	}
}

impl Drop for SinkGuard {
	fn drop(&mut self) {
		self.close();
	}
}

/// Per-cell output sink carried by the routing context variable.
#[pyclass(frozen, module = "_omp_eval")]
struct CellSink {
	shared: Arc<SinkShared>,
}

/// `sys.stdout`/`sys.stderr` replacement routing writes to the owning cell.
///
/// Resolution order: the context sink (inherited by threads and asyncio tasks
/// started inside a cell); if that sink is sealed, the same session's
/// currently open cell; otherwise deliberate discard — a context with no sink
/// has no provenance and must not be guessed at.
#[pyclass(frozen, module = "_omp_eval")]
struct OutputRouter {
	channel:  OutputChannel,
	registry: Arc<SinkRegistry>,
}

#[pymethods]
impl OutputRouter {
	fn write(&self, py: Python<'_>, text: &str) -> usize {
		if text.is_empty() {
			return 0;
		}
		if let Some(sink) = context_sink(py) {
			if let Some(written) = sink.write(self.channel, text) {
				return written;
			}
			// The sealed sink names the writer's session: redirect only to that
			// session's open cell, never across sessions.
			return self
				.registry
				.open_for(&sink.session)
				.and_then(|next| next.write(self.channel, text))
				.unwrap_or_else(|| text.chars().count());
		}
		text.chars().count()
	}

	#[staticmethod]
	const fn flush() {}
}

/// Returns the process-wide routing context variable, creating it on first
/// use.
fn sink_var(py: Python<'_>) -> PyResult<&Bound<'_, PyAny>> {
	SINK_VAR
		.get_or_try_init(py, || {
			Ok::<_, PyErr>(
				PyModule::import(py, "contextvars")?
					.getattr("ContextVar")?
					.call1(("omp_eval_cell_sink",))?
					.unbind(),
			)
		})
		.map(|var| var.bind(py))
}

/// Resolves the [`CellSink`] stored in the calling thread or task context.
fn context_sink(py: Python<'_>) -> Option<Arc<SinkShared>> {
	let var = SINK_VAR.get(py)?;
	let value = var.bind(py).call_method1("get", (py.None(),)).ok()?;
	let sink = value.cast::<CellSink>().ok()?;
	Some(Arc::clone(&sink.get().shared))
}

#[pyclass(frozen, module = "_omp_eval")]
struct TimeoutControl {
	handle: TimeoutHandle,
	pauses: Mutex<Vec<TimeoutPause>>,
}

impl TimeoutControl {
	const fn new(handle: TimeoutHandle) -> Self {
		Self { handle, pauses: Mutex::new(Vec::new()) }
	}
}

#[pymethods]
impl TimeoutControl {
	fn pause(&self) {
		self.pauses.lock().push(self.handle.pause());
	}

	fn resume(&self) {
		self.pauses.lock().pop();
	}

	fn clear(&self) {
		self.pauses.lock().clear();
	}
}

#[pyclass(frozen, module = "_omp_eval")]
struct DisplayCollector {
	entries: Mutex<Vec<(Py<PyAny>, bool)>>,
}

impl DisplayCollector {
	const fn new() -> Self {
		Self { entries: Mutex::new(Vec::new()) }
	}

	fn clear(&self) {
		self.entries.lock().clear();
	}

	fn drain(&self, py: Python<'_>) -> PyResult<(Vec<DisplayOutput>, HashSet<usize>)> {
		let entries = mem::take(&mut *self.entries.lock());
		let mut outputs = Vec::with_capacity(entries.len());
		let mut displayed_figures = HashSet::new();
		for (value, raw) in entries {
			let bound = value.bind(py);
			if !raw && is_matplotlib_figure(bound)? {
				if let Ok(Some(output)) = render_matplotlib_figure(py, bound) {
					displayed_figures.insert(bound.as_ptr() as usize);
					outputs.push(output);
				}
				continue;
			}
			if raw {
				if let Ok(bundle) = bound.cast::<PyDict>()
					&& let Some(output) = display_bundle(py, bundle)?
				{
					outputs.push(output);
				}
				continue;
			}
			if let Some(bundle) = repr_mime_bundle(bound)?
				&& let Some(output) = display_bundle(py, &bundle)?
			{
				outputs.push(output);
				continue;
			}
			if let Some(data) = python_to_json(py, bound)? {
				outputs.push(DisplayOutput::Json { data });
			} else {
				outputs.push(DisplayOutput::Markdown {
					text: Str::new(bound.repr()?.extract::<String>()?),
				});
			}
		}
		Ok((outputs, displayed_figures))
	}
}

fn display_bundle(py: Python<'_>, bundle: &Bound<'_, PyDict>) -> PyResult<Option<DisplayOutput>> {
	if let Some(status) = bundle.get_item("application/x-omp-status")? {
		return python_to_json(py, &status)
			.map(|event| event.map(|event| DisplayOutput::Status { event }));
	}
	if let Some(json) = bundle.get_item("application/json")? {
		return python_to_json(py, &json).map(|data| data.map(|data| DisplayOutput::Json { data }));
	}
	for mime in ["image/png", "image/jpeg"] {
		if let Some(image) = bundle.get_item(mime)?
			&& let Some(data) = bounded_image_bytes(&image)?
		{
			return Ok(Some(DisplayOutput::ImageData { data, mime_type: Str::new(mime) }));
		}
	}
	for mime in ["text/markdown", "text/html", "image/svg+xml"] {
		if let Some(text) = bundle.get_item(mime)? {
			return Ok(Some(DisplayOutput::Markdown { text: Str::new(text.extract::<String>()?) }));
		}
	}
	if let Some(text) = bundle.get_item("text/latex")? {
		let text = text.extract::<String>()?;
		return Ok(Some(DisplayOutput::Markdown { text: sf!("$$\n{text}\n$$") }));
	}
	if let Some(text) = bundle.get_item("text/plain")? {
		return Ok(Some(DisplayOutput::Markdown { text: Str::new(text.extract::<String>()?) }));
	}
	Ok(None)
}

fn bounded_image_bytes(value: &Bound<'_, PyAny>) -> PyResult<Option<CowBytes<'static>>> {
	let data = if let Ok(bytes) = value.cast::<PyBytes>() {
		let bytes = bytes.as_bytes();
		if bytes.is_empty() || bytes.len() > MAX_DISPLAY_IMAGE_BYTES {
			return Ok(None);
		}
		CowBytes::owned(Bytes::copy_from_slice(bytes))
	} else if let Ok(bytes) = value.cast::<PyByteArray>() {
		let bytes = bytes.to_vec();
		if bytes.is_empty() || bytes.len() > MAX_DISPLAY_IMAGE_BYTES {
			return Ok(None);
		}
		CowBytes::owned(Bytes::from(bytes))
	} else {
		return Ok(None);
	};
	Ok(Some(data))
}

fn is_matplotlib_figure(value: &Bound<'_, PyAny>) -> PyResult<bool> {
	let class = value.get_type();
	Ok(class.module()? == "matplotlib.figure" && class.name()? == "Figure")
}

fn render_matplotlib_figure(
	py: Python<'_>,
	figure: &Bound<'_, PyAny>,
) -> PyResult<Option<DisplayOutput>> {
	let io = PyModule::import(py, "io")?;
	let buffer = io.getattr("BytesIO")?.call0()?;
	let backend = match PyModule::import(py, "matplotlib.backends.backend_agg") {
		Ok(backend) => backend,
		Err(error) if error.is_instance_of::<pyo3::exceptions::PyImportError>(py) => {
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	let canvas = backend.getattr("FigureCanvasAgg")?.call1((figure,))?;
	canvas.call_method1("print_png", (&buffer,))?;
	let encoded = buffer.call_method0("getvalue")?;
	let Some(data) = bounded_image_bytes(&encoded)? else {
		return Ok(None);
	};
	Ok(Some(DisplayOutput::ImageData { data, mime_type: sf!("image/png") }))
}

fn flush_matplotlib_figures(
	py: Python<'_>,
	displayed: &HashSet<usize>,
) -> PyResult<Vec<DisplayOutput>> {
	let sys = PyModule::import(py, "sys")?;
	let modules = sys.getattr("modules")?;
	let modules = modules.cast::<PyDict>()?;
	let Some(plt) = modules.get_item("matplotlib.pyplot")? else {
		return Ok(Vec::new());
	};
	let Ok(numbers) = plt.call_method0("get_fignums") else {
		return Ok(Vec::new());
	};
	let mut outputs = Vec::new();
	for number in numbers.try_iter()? {
		let number = number?;
		let figure = match plt.call_method1("figure", (&number,)) {
			Ok(figure) => figure,
			Err(_) => continue,
		};
		let identity = figure.as_ptr() as usize;
		if !displayed.contains(&identity)
			&& let Ok(Some(output)) = render_matplotlib_figure(py, &figure)
		{
			outputs.push(output);
		}
		let _ = plt.call_method1("close", (&figure,));
	}
	Ok(outputs)
}

fn repr_mime_bundle<'py>(value: &Bound<'py, PyAny>) -> PyResult<Option<Bound<'py, PyDict>>> {
	let py = value.py();
	if value.hasattr("_repr_mimebundle_")?
		&& let Ok(rendered) = value.call_method0("_repr_mimebundle_")
		&& !rendered.is_none()
	{
		let rendered = if let Ok(tuple) = rendered.cast::<PyTuple>() {
			let Ok(rendered) = tuple.get_item(0) else {
				return Ok(None);
			};
			rendered
		} else {
			rendered
		};
		if let Ok(rendered) = rendered.cast_into::<PyDict>() {
			return Ok(Some(rendered));
		}
	}
	let bundle = PyDict::new(py);
	for (method, mime) in [
		("_repr_json_", "application/json"),
		("_repr_markdown_", "text/markdown"),
		("_repr_html_", "text/html"),
		("_repr_svg_", "image/svg+xml"),
		("_repr_png_", "image/png"),
		("_repr_jpeg_", "image/jpeg"),
		("_repr_latex_", "text/latex"),
	] {
		if value.hasattr(method)?
			&& let Ok(rendered) = value.call_method0(method)
			&& !rendered.is_none()
		{
			bundle.set_item(mime, rendered)?;
		}
	}
	Ok((!bundle.is_empty()).then_some(bundle))
}

#[pymethods]
impl DisplayCollector {
	#[pyo3(signature = (value, raw=false))]
	fn __call__(&self, value: Py<PyAny>, raw: bool) {
		self.entries.lock().push((value, raw));
	}

	fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
		for (value, _) in self.entries.lock().iter() {
			visit.call(value)?;
		}
		Ok(())
	}

	fn __clear__(&self) {
		self.entries.lock().clear();
	}
}

/// Active embedded-Python cell with ordered events and cooperative interrupt.
pub struct EmbeddedRun {
	events:    Receiver<Result<RunEvent, Fault>>,
	state:     Arc<WorkerState>,
	cancelled: Arc<AtomicBool>,
	reset:     bool,
}

/// Installs session-scoped helpers into a newly-created Python namespace.
///
/// The app adapter uses this seam to inject its authenticated host bridge and
/// normative prelude without introducing an `omp-tools` → `omp-app` cycle.
/// Installation runs once at session creation and again after every reset.
pub trait NamespaceInstaller: Send + Sync + 'static {
	/// Adds helpers to `globals`; existing user state is always absent here.
	fn install(&self, py: Python<'_>, globals: &Bound<'_, PyDict>) -> PyResult<()>;
	/// Releases namespace-scoped bridge registrations before the dictionary is
	/// dropped.
	fn uninstall(&self, _py: Python<'_>, _globals: &Bound<'_, PyDict>) -> PyResult<()> {
		Ok(())
	}

	/// Activates per-cell bridge credentials.
	fn begin_cell(
		&self,
		_py: Python<'_>,
		_globals: &Bound<'_, PyDict>,
		_cell_id: &Bytes,
		timeout: Option<StdDuration>,
	) -> PyResult<TimeoutHandle> {
		Ok(TimeoutHandle::new(timeout))
	}

	/// Revokes per-cell bridge credentials and timeout accounting.
	fn end_cell(
		&self,
		_py: Python<'_>,
		_globals: &Bound<'_, PyDict>,
		_cell_id: &Bytes,
	) -> PyResult<()> {
		Ok(())
	}

	/// Cancels host work owned by an interrupted cell before Python receives its
	/// interrupt.
	fn cancel_cell(&self, _cell_id: &Bytes) {}
}

#[derive(Debug)]
struct EmptyNamespaceInstaller;

impl NamespaceInstaller for EmptyNamespaceInstaller {
	fn install(&self, _py: Python<'_>, _globals: &Bound<'_, PyDict>) -> PyResult<()> {
		Ok(())
	}
}

impl EmbeddedPython {
	/// Creates a Python eval resource over the already-booted embedded runtime.
	///
	/// This constructor installs no host helpers. Production app wiring should
	/// use [`Self::with_installer`] so the authenticated bridge and prelude are
	/// present from the first cell.
	///
	/// # Errors
	/// Returns [`DurationError::Overflow`] when `interrupt_grace` cannot be
	/// represented by the platform timer.
	pub fn new(engine: Arc<Engine>, interrupt_grace: Duration) -> Result<Self, DurationError> {
		Self::with_installer(engine, Arc::new(EmptyNamespaceInstaller), interrupt_grace)
	}

	/// Creates a Python eval resource with a namespace bootstrap installer.
	///
	/// # Errors
	/// Returns [`DurationError::Overflow`] when `interrupt_grace` cannot be
	/// represented by the platform timer.
	pub fn with_installer(
		engine: Arc<Engine>,
		installer: Arc<dyn NamespaceInstaller>,
		interrupt_grace: Duration,
	) -> Result<Self, DurationError> {
		let interrupt_grace = interrupt_grace.to_std()?;
		Ok(Self {
			inner: Arc::new(Inner {
				engine,
				installer,
				interrupt_grace,
				next_cell: AtomicU64::new(1),
				workers: Mutex::new(HashMap::new()),
			}),
		})
	}

	fn worker(&self, session: &Session) -> Result<Arc<Worker>, Fault> {
		let mut workers = self.inner.workers.lock();
		let current = workers
			.get(&session.id)
			.cloned()
			.ok_or_else(|| Fault::SessionLost { message: sf!("unknown Python session") })?;
		if current.state.alive.load(Ordering::Acquire) {
			return Ok(current);
		}
		let label = String::from_utf8_lossy(session.id.as_ref());
		let replacement = self.spawn_worker(&label)?;
		workers.insert(session.id.clone(), Arc::clone(&replacement));
		Ok(replacement)
	}

	fn spawn_worker(&self, label: &str) -> Result<Arc<Worker>, Fault> {
		let (commands, receiver) = flume::unbounded();
		let engine = Arc::clone(&self.inner.engine);
		let installer = Arc::clone(&self.inner.installer);
		let state = Arc::new(WorkerState {
			engine:          Arc::clone(&engine),
			thread_id:       AtomicI64::new(0),
			epoch:           AtomicU64::new(0),
			alive:           AtomicBool::new(true),
			active:          Mutex::new(None),
			installer:       Arc::clone(&installer),
			interrupt_grace: self.inner.interrupt_grace,
		});
		let worker =
			Arc::new(Worker { commands, state: Arc::clone(&state), enqueue: AsyncMutex::new(()) });
		thread::Builder::new()
			.name(format!("omp-eval-py-{label}"))
			.spawn(move || worker_main(&engine, &state, receiver, installer.as_ref()))
			.map_err(|error| Fault::Resource {
				operation: sf!("open_session"),
				message:   Str::new(error.to_string()),
			})?;
		Ok(worker)
	}
}

impl EvalExec for EmbeddedPython {
	type Run = EmbeddedRun;

	fn open_session(&self) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		// Process-global numbering: session ids key `OPEN_SINKS` routing, so two
		// `EmbeddedPython` values in one process must never mint the same id.
		static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
		let number = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
		let id = Bytes::from(format!("py-{number}"));
		match self.spawn_worker(&number.to_string()) {
			Ok(worker) => {
				self.inner.workers.lock().insert(id.clone(), worker);
				future::ready(Ok(Session { id }))
			},
			Err(error) => future::ready(Err(error)),
		}
	}

	async fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> Result<Self::Run, Fault> {
		let reset = request.reset;
		let runtime = Handle::try_current().ok();
		if runtime.is_none() && request.timeout.is_some() {
			return Err(Fault::Resource {
				operation: sf!("run"),
				message:   sf!("cell timeout enforcement requires a Tokio runtime context"),
			});
		}
		let worker = self.worker(session)?;
		let _enqueue = worker.enqueue.lock().await;
		let epoch = if request.reset {
			let epoch = worker
				.state
				.epoch
				.fetch_add(1, Ordering::AcqRel)
				.wrapping_add(1);
			worker.state.cancel_active().await?;
			epoch
		} else {
			worker.state.epoch.load(Ordering::Acquire)
		};
		let number = self.inner.next_cell.fetch_add(1, Ordering::Relaxed);
		let cell_id =
			Bytes::from(format!("{}:cell-{number}", String::from_utf8_lossy(session.id.as_ref())));
		let (events, receiver) = flume::bounded(1);
		let cancelled = Arc::new(AtomicBool::new(false));
		let command = Command {
			cell_id,
			session: session.id.clone(),
			request,
			events,
			cancelled: Arc::clone(&cancelled),
			timed_out: Arc::new(AtomicBool::new(false)),
			runtime,
			epoch,
		};
		worker
			.commands
			.send_async(command)
			.await
			.map_err(|_| Fault::SessionLost {
				message: sf!("Python worker stopped before accepting the cell"),
			})?;
		Ok(EmbeddedRun { events: receiver, state: Arc::clone(&worker.state), cancelled, reset })
	}
}

impl EvalRun for EmbeddedRun {
	fn reset(&self) -> bool {
		self.reset
	}

	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		match self.events.recv_async().await {
			Ok(event) => event.map(Some),
			Err(_) => Ok(None),
		}
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		self.cancelled.store(true, Ordering::Release);
		self.state.interrupt_after_grace(&self.cancelled)
	}
}
impl Drop for EmbeddedRun {
	fn drop(&mut self) {
		self.cancelled.store(true, Ordering::Release);
		self.state.schedule_interrupt(Arc::clone(&self.cancelled));
	}
}

#[cfg(unix)]
#[derive(Default)]
struct SigintState {
	original:  Option<libc::sigaction>,
	workers:   usize,
	executing: usize,
}

#[cfg(unix)]
static SIGINT_STATE: LazyLock<Mutex<SigintState>> =
	LazyLock::new(|| Mutex::new(SigintState::default()));
#[cfg(unix)]
static SIGINT_PENDING: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
static SIGINT_TARGETS: LazyLock<Mutex<Vec<Weak<WorkerState>>>> =
	LazyLock::new(|| Mutex::new(Vec::new()));
#[cfg(unix)]
static SIGINT_MONITOR: LazyLock<io::Result<()>> = LazyLock::new(|| {
	thread::Builder::new()
		.name("omp-eval-sigint".to_owned())
		.spawn(|| {
			loop {
				if SIGINT_PENDING.swap(false, Ordering::AcqRel) {
					// Raise while holding the registry lock: executing workers
					// deregister under this lock before their cell ends, so every
					// upgraded target still names a live worker thread.
					let mut targets = SIGINT_TARGETS.lock();
					targets.retain(|target| target.strong_count() != 0);
					for target in targets.iter().filter_map(Weak::upgrade) {
						let _ = target.interrupt_thread();
					}
				}
				thread::sleep(StdDuration::from_millis(1));
			}
		})
		.map(drop)
});

#[cfg(unix)]
extern "C" fn record_active_sigint(_signal: libc::c_int) {
	SIGINT_PENDING.store(true, Ordering::Release);
}

#[cfg(unix)]
fn set_sigint_action(action: &libc::sigaction) -> PyResult<()> {
	// SAFETY: `action` is a fully initialized sigaction and the call borrows it.
	if unsafe { libc::sigaction(libc::SIGINT, action, ptr::null_mut()) } == 0 {
		Ok(())
	} else {
		Err(PyOSError::new_err(io::Error::last_os_error().to_string()))
	}
}

#[cfg(unix)]
fn active_sigint_action() -> libc::sigaction {
	// SAFETY: zero is a valid starting state before sigemptyset initializes the
	// mask.
	let mut action: libc::sigaction = unsafe { mem::zeroed() };
	action.sa_sigaction = record_active_sigint as *const () as usize;
	// SAFETY: `sa_mask` points to initialized storage owned by `action`.
	unsafe { libc::sigemptyset(&mut action.sa_mask) };
	action
}

#[cfg(unix)]
fn ignored_sigint_action() -> libc::sigaction {
	// SAFETY: zero is a valid starting state before sigemptyset initializes the
	// mask.
	let mut action: libc::sigaction = unsafe { mem::zeroed() };
	action.sa_sigaction = libc::SIG_IGN;
	// SAFETY: `sa_mask` points to initialized storage owned by `action`.
	unsafe { libc::sigemptyset(&mut action.sa_mask) };
	action
}

struct IdleSigint {
	#[cfg(unix)]
	registered: bool,
}

impl IdleSigint {
	fn install() -> PyResult<Self> {
		#[cfg(unix)]
		{
			let mut state = SIGINT_STATE.lock();
			if state.workers == 0 {
				// SAFETY: `current` is writable storage populated by sigaction.
				let mut current: libc::sigaction = unsafe { mem::zeroed() };
				// SAFETY: the null action queries SIGINT without changing it.
				if unsafe { libc::sigaction(libc::SIGINT, ptr::null(), &mut current) } != 0 {
					return Err(PyOSError::new_err(io::Error::last_os_error().to_string()));
				}
				state.original = Some(current);
				set_sigint_action(&ignored_sigint_action())?;
			}
			state.workers += 1;
			if let Err(error) = LazyLock::force(&SIGINT_MONITOR) {
				state.workers -= 1;
				if state.workers == 0
					&& let Some(original) = state.original.take()
				{
					let _ = set_sigint_action(&original);
				}
				return Err(PyOSError::new_err(error.to_string()));
			}
		}
		Ok(Self {
			#[cfg(unix)]
			registered:              true,
		})
	}

	fn executing(&self, target: Option<&Arc<WorkerState>>) -> PyResult<ExecutingSigint<'_>> {
		#[cfg(unix)]
		{
			let target = target.map(Arc::downgrade);
			if let Some(target) = target.as_ref() {
				SIGINT_TARGETS.lock().push(target.clone());
			}
			let mut state = SIGINT_STATE.lock();
			if state.executing == 0
				&& let Err(error) = set_sigint_action(&active_sigint_action())
			{
				drop(state);
				if let Some(target) = target.as_ref() {
					SIGINT_TARGETS
						.lock()
						.retain(|candidate| !Weak::ptr_eq(candidate, target));
				}
				return Err(error);
			}
			state.executing += 1;
			Ok(ExecutingSigint { idle: self, target })
		}
		#[cfg(not(unix))]
		{
			let _ = target;
			Ok(ExecutingSigint { idle: self })
		}
	}
}

impl Drop for IdleSigint {
	fn drop(&mut self) {
		#[cfg(unix)]
		if self.registered {
			let last = {
				let mut state = SIGINT_STATE.lock();
				state.workers = state.workers.saturating_sub(1);
				if state.workers == 0 {
					if let Some(original) = state.original.take() {
						let _ = set_sigint_action(&original);
					}
					state.executing = 0;
					true
				} else {
					false
				}
			};
			if last {
				SIGINT_PENDING.store(false, Ordering::Release);
				SIGINT_TARGETS.lock().clear();
			}
		}
	}
}

struct ExecutingSigint<'a> {
	idle:   &'a IdleSigint,
	#[cfg(unix)]
	target: Option<Weak<WorkerState>>,
}

impl Drop for ExecutingSigint<'_> {
	fn drop(&mut self) {
		let _ = self.idle;
		#[cfg(unix)]
		{
			if let Some(target) = self.target.as_ref() {
				SIGINT_TARGETS
					.lock()
					.retain(|candidate| !Weak::ptr_eq(candidate, target));
			}
			let mut state = SIGINT_STATE.lock();
			state.executing = state.executing.saturating_sub(1);
			if state.executing == 0 && state.workers != 0 {
				let _ = set_sigint_action(&ignored_sigint_action());
			}
		}
	}
}

struct WorkerAlive<'a>(&'a AtomicBool);

impl Drop for WorkerAlive<'_> {
	fn drop(&mut self) {
		self.0.store(false, Ordering::Release);
	}
}

fn worker_main(
	engine: &Engine,
	state: &Arc<WorkerState>,
	commands: Receiver<Command>,
	installer: &dyn NamespaceInstaller,
) {
	let _alive = WorkerAlive(&state.alive);
	engine.attach(|py| {
		let thread_id = current_thread_id();
		state
			.thread_id
			.store(i64::try_from(thread_id).unwrap_or(i64::MAX), Ordering::Release);
		let setup = match prepare_python(py) {
			Ok(setup) => setup,
			Err(error) => {
				fail_worker(&commands, Str::new(format_python_error(py, error)));
				return;
			},
		};
		let (runner, namespace_factory, apply_runtime) = setup;
		let idle_sigint = match IdleSigint::install() {
			Ok(disposition) => disposition,
			Err(error) => {
				fail_worker(&commands, Str::new(format_python_error(py, error)));
				return;
			},
		};
		let mut namespace = match new_namespace(py, &namespace_factory, installer) {
			Ok(namespace) => namespace,
			Err(error) => {
				fail_worker(&commands, Str::new(format_python_error(py, error)));
				return;
			},
		};

		while let Ok(command) = py.detach(|| commands.recv()) {
			// A cancellation may land while this command is queued behind an
			// active cell. Observe it before publishing Started: otherwise a
			// never-active cell appears live and its cancellation can be mistaken
			// for an interrupt of the preceding cell.
			if command_is_stale(state, &command) && !command.request.reset {
				send_cancelled(&command);
				continue;
			}
			let _ = command
				.events
				.send(Ok(RunEvent::Started { cell_id: command.cell_id.clone() }));
			{
				let mut active = state.active.lock();
				*active = Some(ActiveCell {
					cell_id:   command.cell_id.clone(),
					cancelled: Arc::clone(&command.cancelled),
				});
			}
			if command_is_stale(state, &command) && !command.request.reset {
				clear_active(state, &command.cancelled);
				send_cancelled(&command);
				continue;
			}
			if command.request.reset {
				match replace_namespace(py, &namespace_factory, &namespace, &command, state, installer)
				{
					Ok(fresh) => namespace = fresh,
					Err(error) => {
						clear_active(state, &command.cancelled);
						let _ = command.events.send(Err(Fault::Resource {
							operation: sf!("reset"),
							message:   Str::new(format_python_error(py, error)),
						}));
						continue;
					},
				}
			}
			if command_is_stale(state, &command) {
				clear_active(state, &command.cancelled);
				send_cancelled(&command);
				continue;
			}
			let result = execute_cell(
				py,
				&runner,
				&apply_runtime,
				&namespace,
				&command,
				state,
				installer,
				&idle_sigint,
			);
			clear_active(state, &command.cancelled);
			match result {
				Ok(completion) if command.timed_out.load(Ordering::Acquire) => {
					let _ = command
						.events
						.send(Ok(RunEvent::Completed(timed_out_completion(completion))));
				},
				Ok(completion) => {
					let _ = command.events.send(Ok(RunEvent::Completed(completion)));
				},
				Err(_) if command.timed_out.load(Ordering::Acquire) => {
					let _ = command
						.events
						.send(Ok(RunEvent::Completed(timed_out_completion(cancelled_completion()))));
				},
				Err(_) if command.cancelled.load(Ordering::Acquire) => {
					send_cancelled(&command);
				},
				Err(error) => {
					state.alive.store(false, Ordering::Release);
					let _ = command.events.send(Err(Fault::Resource {
						operation: sf!("execute"),
						message:   Str::new(format_python_error(py, error)),
					}));
					break;
				},
			}
		}
		close_namespace(py, &namespace, installer);
		state.thread_id.store(0, Ordering::Release);
	});
}
fn command_is_stale(state: &WorkerState, command: &Command) -> bool {
	command.cancelled.load(Ordering::Acquire) || command.epoch != state.epoch.load(Ordering::Acquire)
}

fn clear_active(state: &WorkerState, cancelled: &Arc<AtomicBool>) {
	let mut active = state.active.lock();
	if active
		.as_ref()
		.is_some_and(|current| Arc::ptr_eq(&current.cancelled, cancelled))
	{
		active.take();
	}
}

fn send_cancelled(command: &Command) {
	let _ = command
		.events
		.send(Ok(RunEvent::Completed(cancelled_completion())));
}

const fn cancelled_completion() -> RunCompletion {
	RunCompletion {
		status:          CellStatus {
			outcome:     CellOutcome::Cancelled,
			exit_code:   None,
			duration_ms: 0,
			exception:   None,
		},
		result:          None,
		display_outputs: Vec::new(),
	}
}
fn timed_out_completion(mut completion: RunCompletion) -> RunCompletion {
	completion.status = CellStatus {
		outcome:     CellOutcome::Timeout,
		exit_code:   Some(1),
		duration_ms: completion.status.duration_ms,
		exception:   Some(PythonException {
			name:      sf!("TimeoutError"),
			message:   sf!("OMP eval cell timed out"),
			traceback: Vec::new(),
		}),
	};
	completion.result = None;
	completion
}

fn prepare_python(py: Python<'_>) -> PyResult<(Py<PyAny>, Py<PyAny>, Py<PyAny>)> {
	ensure_output_routers(py)?;
	let module = PyModule::from_code(py, BOOTSTRAP, c_str!("<omp-eval>"), c_str!("_omp_eval"))?;
	module.setattr("_OMP_SINK", sink_var(py)?)?;
	Ok((
		module.getattr("_omp_run_cell")?.unbind(),
		module.getattr("_omp_new_namespace")?.unbind(),
		module.getattr("_omp_apply_runtime")?.unbind(),
	))
}

fn ensure_output_routers(py: Python<'_>) -> PyResult<()> {
	sink_var(py)?;
	let (stdout, stderr) = OUTPUT_ROUTER_OBJECTS.get_or_try_init(py, || {
		Ok::<_, PyErr>((
			Py::new(py, OutputRouter {
				channel:  OutputChannel::Stdout,
				registry: Arc::clone(&OPEN_SINKS),
			})?,
			Py::new(py, OutputRouter {
				channel:  OutputChannel::Stderr,
				registry: Arc::clone(&OPEN_SINKS),
			})?,
		))
	})?;
	let sys = PyModule::import(py, "sys")?;
	sys.setattr("stdout", stdout.bind(py))?;
	sys.setattr("stderr", stderr.bind(py))?;
	Ok(())
}

fn new_namespace(
	py: Python<'_>,
	factory: &Py<PyAny>,
	installer: &dyn NamespaceInstaller,
) -> PyResult<Py<PyDict>> {
	let value = factory.bind(py).call0()?;
	let globals = value.cast::<PyDict>()?;
	globals.set_item("__omp_display", Py::new(py, DisplayCollector::new())?)?;
	installer.install(py, globals)?;
	Ok(globals.clone().unbind())
}

fn close_namespace(py: Python<'_>, namespace: &Py<PyDict>, installer: &dyn NamespaceInstaller) {
	let globals = namespace.bind(py);
	if let Ok(Some(runner)) = globals.get_item("__omp_async_runner") {
		let _ = runner.call_method0("close");
	}
	let _ = installer.uninstall(py, globals);
}

fn replace_namespace(
	py: Python<'_>,
	factory: &Py<PyAny>,
	namespace: &Py<PyDict>,
	command: &Command,
	state: &Arc<WorkerState>,
	installer: &dyn NamespaceInstaller,
) -> PyResult<Py<PyDict>> {
	let watchdog =
		installer.begin_cell(py, namespace.bind(py), &command.cell_id, command.request.timeout)?;
	let watchdog_task = spawn_watchdog(&watchdog, command, state);
	let fresh = new_namespace(py, factory, installer);
	if fresh.is_ok() {
		close_namespace(py, namespace, installer);
	}
	watchdog.dispose();
	if let Some(task) = watchdog_task {
		task.abort();
	}
	let ended = installer.end_cell(py, namespace.bind(py), &command.cell_id);
	match (fresh, ended) {
		(Err(error), _) | (Ok(_), Err(error)) => Err(error),
		(Ok(fresh), Ok(())) => Ok(fresh),
	}
}

fn spawn_watchdog(
	watchdog: &TimeoutHandle,
	command: &Command,
	state: &Arc<WorkerState>,
) -> Option<JoinHandle<()>> {
	command.runtime.as_ref().map(|runtime| {
		let watchdog = watchdog.clone();
		let state = Arc::clone(state);
		let cancelled = Arc::clone(&command.cancelled);
		let timed_out = Arc::clone(&command.timed_out);
		runtime.spawn(async move {
			watchdog.expired().await;
			timed_out.store(true, Ordering::Release);
			let _ = state.interrupt_after_grace(&cancelled).await;
		})
	})
}

fn execute_cell(
	py: Python<'_>,
	runner: &Py<PyAny>,
	apply_runtime: &Py<PyAny>,
	namespace: &Py<PyDict>,
	command: &Command,
	state: &Arc<WorkerState>,
	installer: &dyn NamespaceInstaller,
	idle_sigint: &IdleSigint,
) -> PyResult<RunCompletion> {
	let request = &command.request;
	let cell_id = &command.cell_id;
	let _executing_sigint = idle_sigint.executing(Some(state))?;
	let managed_env = PyDict::new(py);
	for (key, value) in &request.runtime.managed_env {
		managed_env.set_item(key.as_str(), value.as_ref().map(Str::as_str))?;
	}
	match request.runtime.cwd.as_deref() {
		Some(cwd) => {
			apply_runtime.bind(py).call1((cwd, &managed_env))?;
		},
		None => {
			apply_runtime.bind(py).call1((py.None(), &managed_env))?;
		},
	}
	let display = namespace
		.bind(py)
		.get_item("__omp_display")?
		.ok_or_else(|| PyRuntimeError::new_err("eval namespace has no __omp_display collector"))?
		.extract::<Py<DisplayCollector>>()?;
	display.borrow(py).clear();
	ensure_output_routers(py)?;
	let watchdog = installer.begin_cell(py, namespace.bind(py), cell_id, request.timeout)?;
	let watchdog_task = spawn_watchdog(&watchdog, command, state);
	let timeout_control = Py::new(py, TimeoutControl::new(watchdog.clone()))?;
	let capture =
		SinkGuard::open(Arc::clone(&OPEN_SINKS), command.session.clone(), command.events.clone());
	let sink = Py::new(py, CellSink { shared: Arc::clone(&capture.shared) })?;
	let execution =
		runner
			.bind(py)
			.call1((request.code.as_str(), namespace.bind(py), timeout_control, sink));
	watchdog.dispose();
	if let Some(task) = watchdog_task {
		task.abort();
	}
	capture.close();
	let ended = installer.end_cell(py, namespace.bind(py), cell_id);
	let value = match (execution, ended) {
		(Err(error), _) => return Err(error),
		(Ok(_), Err(error)) => return Err(error),
		(Ok(value), Ok(())) => value,
	};
	let result = value.cast::<PyDict>()?;
	let outcome_name = get_string(result, "outcome")?;
	let outcome = match outcome_name.as_str() {
		"complete" => CellOutcome::Complete,
		"error" => CellOutcome::Error,
		"cancelled" => CellOutcome::Cancelled,
		other => {
			return Err(PyRuntimeError::new_err(format!(
				"eval runner returned unknown outcome {other:?}"
			)));
		},
	};
	let result_text = get_optional_string(result, "result_text")?;
	let result_json = get_optional_string(result, "result_json")?
		.map(|json| serde_json::from_str::<Value>(&json))
		.transpose()
		.map_err(|error| PyValueError::new_err(error.to_string()))?;
	let cell_value = result_text.map(|text| CellValue { text: Str::new(text), json: result_json });
	let error_name = get_optional_string(result, "error_name")?;
	let exception = if let Some(name) = error_name {
		let message = get_optional_string(result, "error_message")?.unwrap_or_default();
		let traceback = result
			.get_item("error_traceback")?
			.ok_or_else(|| PyKeyError::new_err("error_traceback"))?
			.extract::<Vec<String>>()?
			.into_iter()
			.map(Str::new)
			.collect();
		Some(PythonException { name: Str::new(name), message: Str::new(message), traceback })
	} else {
		None
	};
	let duration_ms = result
		.get_item("duration_ms")?
		.ok_or_else(|| PyKeyError::new_err("duration_ms"))?
		.extract::<u64>()?;

	let (mut display_outputs, displayed_figures) = display.borrow(py).drain(py)?;
	if outcome == CellOutcome::Complete {
		display_outputs.extend(flush_matplotlib_figures(py, &displayed_figures)?);
	}
	Ok(RunCompletion {
		status: CellStatus {
			outcome,
			exit_code: match outcome {
				CellOutcome::Complete => Some(0),
				CellOutcome::Error | CellOutcome::Timeout => Some(1),
				CellOutcome::Cancelled => None,
			},
			duration_ms,
			exception,
		},
		result: cell_value,
		display_outputs,
	})
}

fn get_string(dict: &Bound<'_, PyDict>, key: &str) -> PyResult<String> {
	dict
		.get_item(key)?
		.ok_or_else(|| PyKeyError::new_err(key.to_owned()))?
		.extract()
}

fn get_optional_string(dict: &Bound<'_, PyDict>, key: &str) -> PyResult<Option<String>> {
	let value = dict
		.get_item(key)?
		.ok_or_else(|| PyKeyError::new_err(key.to_owned()))?;
	if value.is_none() {
		Ok(None)
	} else {
		value.extract().map(Some)
	}
}

fn python_to_json(py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<Option<Value>> {
	let json = PyModule::import(py, "json")?;
	let encoded = match json.call_method1("dumps", (value,)) {
		Ok(encoded) => encoded.extract::<String>()?,
		Err(error) if error.is_instance_of::<pyo3::exceptions::PyTypeError>(py) => {
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	serde_json::from_str(&encoded)
		.map(Some)
		.map_err(|error| PyValueError::new_err(error.to_string()))
}

fn fail_worker(commands: &Receiver<Command>, message: Str) {
	while let Ok(command) = commands.try_recv() {
		let _ = command
			.events
			.send(Err(Fault::Resource { operation: sf!("initialize"), message: message.clone() }));
	}
}

fn format_python_error(py: Python<'_>, error: pyo3::PyErr) -> String {
	let formatted = PyModule::import(py, "traceback").and_then(|traceback| {
		traceback
			.call_method1(
				"format_exception",
				(error.get_type(py), error.value(py), error.traceback(py)),
			)?
			.extract::<Vec<String>>()
	});
	formatted.map_or_else(|_| error.to_string(), |lines| lines.concat())
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		path::Path,
		sync::{Arc, LazyLock},
	};

	use parking_lot::RwLock;

	use super::*;

	static ENGINE: LazyLock<Arc<Engine>> =
		LazyLock::new(|| Arc::new(Engine::builder().init().expect("embedded Python boots")));
	const TEST_INTERRUPT_GRACE: Duration = Duration::new(1, omp_core::DurationUnit::Milliseconds);
	/// Every test worker shares one embedded interpreter, so SIGINT disposition
	/// and delivery plus `sys.modules` are process-global. Cell-running tests
	/// hold this shared; tests that mutate that global state hold it exclusively
	/// so their side effects cannot knife concurrently executing cells.
	static PROCESS_GLOBALS: RwLock<()> = RwLock::new(());

	fn runtime() -> EmbeddedPython {
		EmbeddedPython::new(Arc::clone(&ENGINE), TEST_INTERRUPT_GRACE)
			.expect("test interrupt grace is representable")
	}

	#[cfg(unix)]
	fn sigint_handler() -> usize {
		// SAFETY: `current` is writable storage populated by sigaction.
		let mut current: libc::sigaction = unsafe { mem::zeroed() };
		// SAFETY: the null action queries SIGINT without changing it.
		assert_eq!(unsafe { libc::sigaction(libc::SIGINT, std::ptr::null(), &mut current) }, 0,);
		current.sa_sigaction
	}

	#[cfg(unix)]
	#[test]
	fn sigint_disposition_restores_idle_on_every_exit_path() {
		let _globals = PROCESS_GLOBALS.write();
		LazyLock::force(&ENGINE);
		let original = sigint_handler();
		let idle = IdleSigint::install().expect("idle SIGINT installs");
		assert_eq!(sigint_handler(), libc::SIG_IGN);

		{
			let _executing = idle.executing(None).expect("executing SIGINT installs");
			assert_eq!(sigint_handler(), record_active_sigint as *const () as usize);
		}
		assert_eq!(sigint_handler(), libc::SIG_IGN);

		let failed = (|| -> PyResult<()> {
			let _executing = idle.executing(None)?;
			Err(PyRuntimeError::new_err("cell failed"))
		})();
		assert!(failed.is_err());
		assert_eq!(sigint_handler(), libc::SIG_IGN);

		drop(idle);
		assert_eq!(sigint_handler(), original);
	}

	#[test]
	fn configured_interrupt_grace_rejects_platform_timer_overflow() {
		let result = EmbeddedPython::new(
			Arc::clone(&ENGINE),
			Duration::new(u64::MAX, omp_core::DurationUnit::Hours),
		);

		assert!(matches!(result, Err(DurationError::Overflow)));
	}

	async fn run_to_completion(
		runtime: &EmbeddedPython,
		session: &Session,
		code: &str,
		reset: bool,
	) -> (Vec<Update>, RunCompletion) {
		let mut run = runtime
			.run(session, RunRequest {
				code: Str::new(code),
				timeout: Some(StdDuration::from_secs(2)),
				reset,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("cell starts");
		let mut updates = Vec::new();
		loop {
			match run.next_event().await.expect("event") {
				Some(RunEvent::Started { .. }) => {},
				Some(RunEvent::Output(update)) => updates.push(update),
				Some(RunEvent::Completed(done)) => return (updates, done),
				None => panic!("worker ended before completion"),
			}
		}
	}
	async fn completion(run: &mut EmbeddedRun) -> RunCompletion {
		loop {
			match run.next_event().await.expect("event") {
				Some(RunEvent::Started { .. } | RunEvent::Output(_)) => {},
				Some(RunEvent::Completed(done)) => return done,
				None => panic!("worker ended before completion"),
			}
		}
	}

	fn install_barrier(name: &str) {
		ENGINE
			.attach(|py| -> PyResult<()> {
				let sys = PyModule::import(py, "sys")?;
				let modules = sys.getattr("modules")?;
				let threading = PyModule::import(py, "threading")?;
				let barrier = threading.getattr("Barrier")?.call1((2,))?;
				modules.set_item(name, barrier)
			})
			.expect("shared barrier installs");
	}

	#[tokio::test]
	async fn state_persists_then_reset_replaces_namespace() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, first) = run_to_completion(&runtime, &session, "answer = 40", false).await;
		assert_eq!(first.status.outcome, CellOutcome::Complete);
		let (_, second) = run_to_completion(&runtime, &session, "answer + 2", false).await;
		assert_eq!(second.result.expect("REPL result").text, "42");
		let (_, reset) = run_to_completion(&runtime, &session, "'answer' in globals()", true).await;
		assert_eq!(reset.result.expect("REPL result").json, Some(Value::Bool(false)));
	}

	#[tokio::test]
	async fn stdout_stderr_and_result_keep_separate_boundaries() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (updates, done) = run_to_completion(
			&runtime,
			&session,
			"import sys\nprint('out')\nprint('err', file=sys.stderr)\n{'ok': True}",
			false,
		)
		.await;
		assert!(
			updates
				.windows(2)
				.all(|pair| pair[0].sequence < pair[1].sequence)
		);
		let stdout = updates
			.iter()
			.filter(|update| update.channel == OutputChannel::Stdout)
			.flat_map(|update| update.data.iter().copied())
			.collect::<Vec<_>>();
		let stderr = updates
			.iter()
			.filter(|update| update.channel == OutputChannel::Stderr)
			.flat_map(|update| update.data.iter().copied())
			.collect::<Vec<_>>();
		assert_eq!(stdout, b"out\n");
		assert_eq!(stderr, b"err\n");
		assert_eq!(done.result.expect("result").json, Some(serde_json::json!({"ok": true})));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn shell_magic_streams_beyond_legacy_byte_and_line_limits_exactly() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (updates, done) = run_to_completion(
			&runtime,
			&session,
			"%%bash\ni=0\nwhile [ \"$i\" -lt 3001 ]; do\n  printf '%0350d\\n' 0\n  i=$((i + 1))\ndone",
			false,
		)
		.await;
		assert_eq!(done.status.outcome, CellOutcome::Complete);
		assert_eq!(done.result, None);
		assert!(
			updates
				.iter()
				.all(|update| update.data.len() <= OUTPUT_CHUNK_BYTES)
		);
		let stdout = updates
			.into_iter()
			.filter(|update| update.channel == OutputChannel::Stdout)
			.flat_map(|update| update.data.to_vec())
			.collect::<Vec<_>>();
		let mut line = vec![b'0'; 350];
		line.push(b'\n');
		let expected = line.repeat(3_001);
		assert!(expected.len() > 1024 * 1024);
		assert_eq!(stdout, expected);
	}

	#[test]
	fn context_less_pool_thread_print_is_never_routed_to_an_open_cell() {
		let registry = Arc::new(SinkRegistry::default());
		let (events, received) = flume::unbounded();
		let sole = SinkGuard::open(Arc::clone(&registry), Bytes::from_static(b"py-a"), events);

		// A pool thread created outside any cell carries no context sink: even
		// with exactly one open cell (a later, unrelated session), its output
		// has no provenance and must be discarded, not attributed.
		ENGINE
			.attach(|py| -> PyResult<()> {
				let locals = PyDict::new(py);
				locals.set_item(
					"router",
					Py::new(py, OutputRouter {
						channel:  OutputChannel::Stdout,
						registry: Arc::clone(&registry),
					})?,
				)?;
				py.run(
					c_str!(
						r#"
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=1) as pool:
    pool.submit(print, "parallel", file=router).result()
"#
					),
					None,
					Some(&locals),
				)
			})
			.expect("pool print completes");
		sole.close();
		assert!(received.try_recv().is_err(), "context-less output must be dropped");
	}

	#[test]
	fn sealed_sink_refuses_late_writes_and_redirects_only_within_its_session() {
		let registry = Arc::new(SinkRegistry::default());
		let session = Bytes::from_static(b"py-a");
		let (events, received) = flume::unbounded();
		let guard = SinkGuard::open(Arc::clone(&registry), session.clone(), events);
		assert_eq!(guard.shared.write(OutputChannel::Stdout, "before\n"), Some(7));
		assert_eq!(guard.shared.write(OutputChannel::Stderr, "partial"), Some(7));
		guard.close();

		// Writes after sealing are refused, so nothing can trail the terminal
		// event, and the fallback route is gone.
		assert_eq!(guard.shared.write(OutputChannel::Stdout, "late\n"), None);
		assert!(registry.open_for(&session).is_none());
		let outputs = received
			.try_iter()
			.filter_map(|event| match event.expect("capture event") {
				RunEvent::Output(update) => Some(update.data.to_vec()),
				RunEvent::Started { .. } | RunEvent::Completed(_) => None,
			})
			.collect::<Vec<_>>();
		assert_eq!(outputs, vec![b"before\n".to_vec(), b"partial".to_vec()]);

		// A sealed sink's session redirects only to that session's open cell:
		// another session's sole open cell is not a legal target.
		let (other_events, _other_received) = flume::unbounded();
		let other = SinkGuard::open(Arc::clone(&registry), Bytes::from_static(b"py-b"), other_events);
		assert!(registry.open_for(&session).is_none());
		let (next_events, _next_received) = flume::unbounded();
		let next = SinkGuard::open(Arc::clone(&registry), session.clone(), next_events);
		let redirected = registry.open_for(&session).expect("same-session open sink");
		assert!(Arc::ptr_eq(&redirected, &next.shared));
		next.close();
		other.close();
	}

	#[tokio::test]
	async fn independent_sessions_execute_concurrently_without_output_cross_talk() {
		let _globals = PROCESS_GLOBALS.read();
		const BARRIER_MODULE: &str = "_omp_eval_parallel_barrier";
		install_barrier(BARRIER_MODULE);

		let runtime = runtime();
		let left = runtime.open_session().await.expect("left session opens");
		let right = runtime.open_session().await.expect("right session opens");
		let left_code = format!(
			r#"import concurrent.futures, sys
def emit():
    sys.modules[{BARRIER_MODULE:?}].wait(timeout=1)
    sys.stdout.write("left-background\n")
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    pool.submit(emit).result(timeout=1)
print("left")"#
		);
		let right_code = format!(
			r#"import concurrent.futures, sys
def emit():
    sys.modules[{BARRIER_MODULE:?}].wait(timeout=1)
    sys.stdout.write("right-background\n")
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    pool.submit(emit).result(timeout=1)
print("right")"#
		);
		let (left_result, right_result) = tokio::join!(
			run_to_completion(&runtime, &left, &left_code, false),
			run_to_completion(&runtime, &right, &right_code, false),
		);
		let (left_updates, left_done) = left_result;
		let (right_updates, right_done) = right_result;
		assert_eq!(left_done.status.outcome, CellOutcome::Complete);
		assert_eq!(right_done.status.outcome, CellOutcome::Complete);

		let stdout = |updates: Vec<Update>| {
			updates
				.into_iter()
				.filter(|update| update.channel == OutputChannel::Stdout)
				.flat_map(|update| update.data.to_vec())
				.collect::<Vec<_>>()
		};
		assert_eq!(stdout(left_updates), b"left-background\nleft\n");
		assert_eq!(stdout(right_updates), b"right-background\nright\n");
	}

	#[tokio::test]
	async fn sys_stream_reassignment_is_isolated_to_the_owning_worker() {
		let _globals = PROCESS_GLOBALS.read();
		const BARRIER_MODULE: &str = "_omp_eval_stream_barrier";
		install_barrier(BARRIER_MODULE);

		let runtime = runtime();
		let left = runtime.open_session().await.expect("left session opens");
		let right = runtime.open_session().await.expect("right session opens");
		let left_code = format!(
			"import io, sys, time\nsys.stdout = \
			 io.StringIO()\nsys.modules[{BARRIER_MODULE:?}].wait(timeout=1)\ntime.sleep(0.1)\nsys.\
			 stdout.getvalue()"
		);
		let right_code =
			format!("import sys\nsys.modules[{BARRIER_MODULE:?}].wait(timeout=1)\nprint('right')");
		let ((_, left_done), (right_updates, right_done)) = tokio::join!(
			run_to_completion(&runtime, &left, &left_code, false),
			run_to_completion(&runtime, &right, &right_code, false),
		);
		assert_eq!(left_done.result.expect("left capture").json, Some(Value::String(String::new())));
		assert_eq!(right_done.status.outcome, CellOutcome::Complete);
		let right_stdout = right_updates
			.into_iter()
			.filter(|update| update.channel == OutputChannel::Stdout)
			.flat_map(|update| update.data.to_vec())
			.collect::<Vec<_>>();
		assert_eq!(right_stdout, b"right\n");
	}

	#[tokio::test]
	async fn failed_cell_keeps_prior_state_and_structured_traceback() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		run_to_completion(&runtime, &session, "kept = 7", false).await;
		let (_, failed) =
			run_to_completion(&runtime, &session, "raise ValueError('boom')", false).await;
		assert_eq!(failed.status.outcome, CellOutcome::Error);
		let error = failed.status.exception.expect("exception");
		assert_eq!(error.name, "ValueError");
		assert_eq!(error.message, "boom");
		let (_, after) = run_to_completion(&runtime, &session, "kept", false).await;
		assert_eq!(after.result.expect("result").text, "7");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn idle_sigint_is_harmless_and_active_sigint_cancels_the_cell() {
		let _globals = PROCESS_GLOBALS.write();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let mut run = runtime
			.run(&session, RunRequest {
				code:    sf!("print('running', flush=True)\nwhile True: pass"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("active cell starts");
		loop {
			match run.next_event().await.expect("active event") {
				Some(RunEvent::Output(_)) => break,
				Some(RunEvent::Started { .. }) => {},
				Some(RunEvent::Completed(done)) => {
					panic!("cell completed before SIGINT: {:?}", done.status)
				},
				None => panic!("cell ended before SIGINT"),
			}
		}
		// SAFETY: this test process installed the CPython execution disposition
		// before publishing the observed output above.
		assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGINT) }, 0);
		assert_eq!(completion(&mut run).await.status.outcome, CellOutcome::Cancelled);

		// The completion path must restore idle protection before the next cell.
		assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGINT) }, 0);
		let (_, next) = run_to_completion(&runtime, &session, "6 * 7", false).await;
		assert_eq!(next.result.expect("idle SIGINT preserved kernel").json, Some(Value::from(42)));
	}

	#[tokio::test]
	async fn cancel_before_a_queued_cell_becomes_active_is_not_lost() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let mut active = runtime
			.run(&session, RunRequest {
				code:    sf!("while True: pass"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("active cell starts");
		assert!(matches!(active.next_event().await.unwrap(), Some(RunEvent::Started { .. })));

		let mut queued = runtime
			.run(&session, RunRequest {
				code:    sf!("queued_effect = True"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("queued cell accepted");
		queued.cancel().await.expect("queued cell cancels");
		active.cancel().await.expect("active cell interrupts");

		assert_eq!(completion(&mut active).await.status.outcome, CellOutcome::Cancelled);
		assert_eq!(completion(&mut queued).await.status.outcome, CellOutcome::Cancelled);
		let (_, observed) =
			run_to_completion(&runtime, &session, "'queued_effect' in globals()", false).await;
		assert_eq!(
			observed
				.result
				.unwrap_or_else(|| panic!("boolean result: {:?}", observed.status))
				.json,
			Some(Value::Bool(false))
		);
	}

	#[tokio::test]
	async fn reset_interrupts_active_work_invalidates_queued_cells_and_recreates_state() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		run_to_completion(&runtime, &session, "kept = 7", false).await;
		let mut active = runtime
			.run(&session, RunRequest {
				code:    sf!("while True: pass"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("active cell starts");
		assert!(matches!(active.next_event().await.unwrap(), Some(RunEvent::Started { .. })));
		let mut stale = runtime
			.run(&session, RunRequest {
				code:    sf!("stale_effect = True"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("stale cell queues");
		let mut reset = runtime
			.run(&session, RunRequest {
				code:    sf!("('kept' in globals(), 'stale_effect' in globals())"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   true,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("reset cell queues");

		assert_eq!(completion(&mut active).await.status.outcome, CellOutcome::Cancelled);
		assert_eq!(completion(&mut stale).await.status.outcome, CellOutcome::Cancelled);
		let reset = completion(&mut reset).await;
		assert_eq!(reset.result.expect("reset result").json, Some(serde_json::json!([false, false])));
	}

	#[tokio::test]
	async fn timeout_and_dropped_run_leave_the_worker_available_for_the_next_cell() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let mut timed_out = runtime
			.run(&session, RunRequest {
				code:    sf!("while True: pass"),
				timeout: Some(StdDuration::from_millis(25)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("timed cell starts");
		assert_eq!(completion(&mut timed_out).await.status.outcome, CellOutcome::Timeout);

		let mut dropped = runtime
			.run(&session, RunRequest {
				code:    sf!("while True: pass"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("dropped cell starts");
		assert!(matches!(dropped.next_event().await.unwrap(), Some(RunEvent::Started { .. })));
		drop(dropped);

		let (_, next) = run_to_completion(&runtime, &session, "6 * 7", false).await;
		assert_eq!(next.result.expect("next result").text, "42");
	}

	#[tokio::test]
	async fn top_level_await_returns_the_final_expression() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, done) = run_to_completion(
			&runtime,
			&session,
			"import asyncio\nawait asyncio.sleep(0, result=42)",
			false,
		)
		.await;
		assert_eq!(done.status.outcome, CellOutcome::Complete);
		assert_eq!(done.result.expect("await result").json, Some(Value::from(42)));
	}

	#[tokio::test]
	async fn runtime_snapshots_replace_cwd_and_managed_environment() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let original = env::current_dir().expect("current directory");
		let first = tempfile::tempdir().expect("first runtime directory");
		let second = tempfile::tempdir().expect("second runtime directory");
		let snapshot = |cwd: &Path, local_roots: Option<&str>| RuntimeSnapshot {
			cwd:         Some(cwd.to_path_buf()),
			managed_env: [(sf!("OMP_EVAL_LOCAL_ROOTS"), local_roots.map(Str::new))]
				.into_iter()
				.collect(),
		};
		let mut first_run = runtime
			.run(&session, RunRequest {
				code:    sf!("import os\n(os.getcwd(), os.environ.get('OMP_EVAL_LOCAL_ROOTS'))"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: snapshot(first.path(), Some(r#"{"local":"first"}"#)),
			})
			.await
			.expect("first runtime starts");
		let first_done = completion(&mut first_run).await;
		assert_eq!(
			first_done.result.expect("first result").json,
			Some(serde_json::json!([
				first
					.path()
					.canonicalize()
					.expect("canonical first")
					.to_string_lossy(),
				r#"{"local":"first"}"#
			])),
		);

		let mut second_run = runtime
			.run(&session, RunRequest {
				code:    sf!(
					"import os\n(os.getcwd(), os.environ.get('OMP_EVAL_LOCAL_ROOTS') is None)"
				),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: snapshot(second.path(), None),
			})
			.await
			.expect("second runtime starts");
		let second_done = completion(&mut second_run).await;
		assert_eq!(
			second_done.result.expect("second result").json,
			Some(serde_json::json!([
				second
					.path()
					.canonicalize()
					.expect("canonical second")
					.to_string_lossy(),
				true
			])),
		);

		let mut restore = runtime
			.run(&session, RunRequest {
				code:    sf!("None"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: snapshot(&original, None),
			})
			.await
			.expect("restoration starts");
		assert_eq!(completion(&mut restore).await.status.outcome, CellOutcome::Complete);
	}

	#[tokio::test]
	async fn binary_repr_and_raw_mime_bundles_preserve_exact_bytes() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, done) = run_to_completion(
			&runtime,
			&session,
			concat!(
				"class Png:\n",
				"    def _repr_png_(self): return bytes([0, 159, 255])\n",
				"class Jpeg:\n",
				"    def _repr_jpeg_(self): return bytes([1, 128, 254])\n",
				"class Bundle:\n",
				"    def _repr_mimebundle_(self):\n",
				"        return ({'image/png': bytes([2, 129, 253])}, {})\n",
				"__omp_display(Png())\n",
				"__omp_display(Jpeg())\n",
				"__omp_display(Bundle())\n",
				"__omp_display({'image/jpeg': bytearray([3, 130, 252])}, raw=True)",
			),
			false,
		)
		.await;
		let images = done
			.display_outputs
			.into_iter()
			.map(|output| match output {
				DisplayOutput::ImageData { data, mime_type } => (data.to_vec(), mime_type),
				other => panic!("unexpected display output: {other:?}"),
			})
			.collect::<Vec<_>>();
		assert_eq!(images, vec![
			(vec![0, 159, 255], sf!("image/png")),
			(vec![1, 128, 254], sf!("image/jpeg")),
			(vec![2, 129, 253], sf!("image/png")),
			(vec![3, 130, 252], sf!("image/jpeg")),
		]);
	}

	#[tokio::test]
	async fn matplotlib_figures_render_through_agg_without_duplicates() {
		let _globals = PROCESS_GLOBALS.write();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, done) = run_to_completion(
			&runtime,
			&session,
			r#"
import sys, types
matplotlib = types.ModuleType("matplotlib")
matplotlib.__path__ = []
backends = types.ModuleType("matplotlib.backends")
backends.__path__ = []
backend = types.ModuleType("matplotlib.backends.backend_agg")
class Figure:
    pass
Figure.__module__ = "matplotlib.figure"
first = Figure()
first.marker = 1
second = Figure()
second.marker = 2
class FigureCanvasAgg:
    def __init__(self, value):
        self.value = value
    def print_png(self, buffer):
        buffer.write(bytes([137, 80, 78, 71, self.value.marker, 255]))
backend.FigureCanvasAgg = FigureCanvasAgg
pyplot = types.ModuleType("matplotlib.pyplot")
pyplot.get_fignums = lambda: [1, 2]
pyplot.figure = lambda number: first if number == 1 else second
pyplot.close = lambda value: None
sys.modules["matplotlib"] = matplotlib
sys.modules["matplotlib.backends"] = backends
sys.modules["matplotlib.backends.backend_agg"] = backend
sys.modules["matplotlib.pyplot"] = pyplot
__omp_display(first)
"#,
			false,
		)
		.await;
		run_to_completion(
			&runtime,
			&session,
			"import sys\nfor name in ('matplotlib', 'matplotlib.backends', \
			 'matplotlib.backends.backend_agg', 'matplotlib.pyplot'):\n    sys.modules.pop(name, \
			 None)",
			false,
		)
		.await;
		assert_eq!(done.display_outputs, vec![
			DisplayOutput::ImageData {
				data:      CowBytes::owned(Bytes::from_static(b"\x89PNG\x01\xff")),
				mime_type: sf!("image/png"),
			},
			DisplayOutput::ImageData {
				data:      CowBytes::owned(Bytes::from_static(b"\x89PNG\x02\xff")),
				mime_type: sf!("image/png"),
			},
		],);
	}

	#[tokio::test]
	async fn display_collector_preserves_json_and_status_boundaries() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, done) = run_to_completion(
			&runtime,
			&session,
			concat!(
				"__omp_display({'application/json': {'answer': 42}}, raw=True)\n",
				"__omp_display({'application/x-omp-status': {'op': 'phase', 'title': 'load'}}, \
				 raw=True)",
			),
			false,
		)
		.await;
		assert_eq!(done.display_outputs, vec![
			super::super::DisplayOutput::Json { data: serde_json::json!({"answer": 42}) },
			super::super::DisplayOutput::Status {
				event: serde_json::json!({"op": "phase", "title": "load"}),
			},
		],);
	}

	#[tokio::test]
	async fn timeout_pause_excludes_host_wait_and_resume_starts_a_fresh_window() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let mut run = runtime
			.run(&session, RunRequest {
				code:    sf!(concat!(
					"import time\n",
					"__omp_timeout_pause__()\n",
					"time.sleep(0.2)\n",
					"__omp_timeout_resume__()\n",
					"7",
				)),
				timeout: Some(StdDuration::from_millis(100)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("paused cell starts");
		let done = completion(&mut run).await;
		assert_eq!(done.status.outcome, CellOutcome::Complete);
		assert_eq!(done.result.expect("result after host wait").json, Some(Value::from(7)));
	}

	#[tokio::test]
	async fn sessions_have_isolated_persistent_namespaces() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let first = runtime.open_session().await.expect("first session opens");
		let second = runtime.open_session().await.expect("second session opens");
		run_to_completion(&runtime, &first, "private_value = 42", false).await;
		let (_, isolated) =
			run_to_completion(&runtime, &second, "'private_value' in globals()", false).await;
		assert_eq!(isolated.result.expect("isolation result").json, Some(Value::Bool(false)));
		let (_, persisted) = run_to_completion(&runtime, &first, "private_value", false).await;
		assert_eq!(persisted.result.expect("persistent result").json, Some(Value::from(42)));
	}

	#[derive(Debug)]
	struct FailFirstCell(AtomicBool);

	impl NamespaceInstaller for FailFirstCell {
		fn install(&self, _py: Python<'_>, _globals: &Bound<'_, PyDict>) -> PyResult<()> {
			Ok(())
		}

		fn begin_cell(
			&self,
			_py: Python<'_>,
			_globals: &Bound<'_, PyDict>,
			_cell_id: &Bytes,
			timeout: Option<StdDuration>,
		) -> PyResult<TimeoutHandle> {
			if self.0.swap(false, Ordering::AcqRel) {
				Err(PyRuntimeError::new_err("poisoned worker"))
			} else {
				Ok(TimeoutHandle::new(timeout))
			}
		}
	}

	#[tokio::test]
	async fn poisoned_worker_is_recreated_on_the_next_cell() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = EmbeddedPython::with_installer(
			Arc::clone(&ENGINE),
			Arc::new(FailFirstCell(AtomicBool::new(true))),
			TEST_INTERRUPT_GRACE,
		)
		.expect("test interrupt grace is representable");
		let session = runtime.open_session().await.expect("session opens");
		let mut failed = runtime
			.run(&session, RunRequest {
				code:    sf!("1"),
				timeout: Some(StdDuration::from_secs(1)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("first cell accepted");
		assert!(matches!(failed.next_event().await.unwrap(), Some(RunEvent::Started { .. })));
		assert!(matches!(failed.next_event().await, Err(Fault::Resource { .. })));

		let (_, recovered) = run_to_completion(&runtime, &session, "6 * 7", false).await;
		assert_eq!(recovered.result.expect("recovered result").json, Some(Value::from(42)));
	}

	#[tokio::test]
	async fn cancelling_the_reset_cell_does_not_restore_the_old_namespace() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		run_to_completion(&runtime, &session, "old_state = 1", false).await;
		let mut active = runtime
			.run(&session, RunRequest {
				code:    sf!("while True: pass"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   false,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("active cell starts");
		assert!(matches!(active.next_event().await.unwrap(), Some(RunEvent::Started { .. })));
		let mut reset = runtime
			.run(&session, RunRequest {
				code:    sf!("'old_state' in globals()"),
				timeout: Some(StdDuration::from_secs(2)),
				reset:   true,
				runtime: RuntimeSnapshot::default(),
			})
			.await
			.expect("reset accepted");
		reset.cancel().await.expect("reset execution cancels");
		assert_eq!(completion(&mut active).await.status.outcome, CellOutcome::Cancelled);
		assert_eq!(completion(&mut reset).await.status.outcome, CellOutcome::Cancelled);

		let (_, observed) =
			run_to_completion(&runtime, &session, "'old_state' in globals()", false).await;
		assert_eq!(observed.result.expect("state observation").json, Some(Value::Bool(false)));
	}
	#[tokio::test]
	async fn cancelling_one_worker_does_not_interrupt_another_session() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let first_session = runtime.open_session().await.expect("first session opens");
		let second_session = runtime.open_session().await.expect("second session opens");
		let request = || RunRequest {
			code:    sf!("while True: pass"),
			timeout: Some(StdDuration::from_secs(2)),
			reset:   false,
			runtime: RuntimeSnapshot::default(),
		};
		let mut first = runtime
			.run(&first_session, request())
			.await
			.expect("first starts");
		let mut second = runtime
			.run(&second_session, request())
			.await
			.expect("second starts");
		assert!(matches!(first.next_event().await.unwrap(), Some(RunEvent::Started { .. })));
		assert!(matches!(second.next_event().await.unwrap(), Some(RunEvent::Started { .. })));

		first.cancel().await.expect("first cancels");
		assert_eq!(completion(&mut first).await.status.outcome, CellOutcome::Cancelled);
		assert!(
			tokio::time::timeout(StdDuration::from_millis(30), second.next_event())
				.await
				.is_err(),
			"second worker must remain active",
		);
		second.cancel().await.expect("second cancels independently");
		assert_eq!(completion(&mut second).await.status.outcome, CellOutcome::Cancelled);
	}

	#[tokio::test]
	async fn ipython_style_line_magics_preserve_the_namespace() {
		let _globals = PROCESS_GLOBALS.read();
		let runtime = runtime();
		let session = runtime.open_session().await.expect("session opens");
		let (_, env_set) =
			run_to_completion(&runtime, &session, "%env OMP_MAGIC_TEST=present", false).await;
		assert_eq!(env_set.status.outcome, CellOutcome::Complete);
		let (_, pwd) = run_to_completion(&runtime, &session, "%pwd", false).await;
		assert_eq!(pwd.status.outcome, CellOutcome::Complete);
		let (_, observed) =
			run_to_completion(&runtime, &session, "import os\nos.environ['OMP_MAGIC_TEST']", false)
				.await;
		assert_eq!(
			observed.result.expect("environment result").json,
			Some(Value::String("present".to_owned())),
		);
		let (_, reset) = run_to_completion(
			&runtime,
			&session,
			"kept = 7\n%who\n%reset\n'kept' in globals()",
			false,
		)
		.await;
		assert_eq!(reset.result.expect("reset result").json, Some(Value::Bool(false)));
	}
}
