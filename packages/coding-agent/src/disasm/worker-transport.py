"""omp disassembler worker, transport part: the NDJSON socket protocol every backend worker speaks.

Not run alone. A backend's staged worker script is this text, a newline, then the backend's engine
text, so the listener is bound and the signal handlers are installed before the engine's slow
import starts and the daemon can connect at once.

Launched as `worker.py --socket PATH` (Unix socket) or `worker.py --port-file PATH` (loopback TCP;
the bound port is written to PATH). The omp daemon connects, sends `{"token": $OMP_DISASM_WORKER_TOKEN}`
as its first line, then speaks:

Request:   {"id": int, "method": str, "params": dict}
Response:  {"id", "ok": true, "result", "dirty"} | {"id", "ok": false, "error": {"type", "message"}}
Interrupt: SIGINT, or `{"interrupt": id}` where the daemon cannot signal one process or the engine
           needs more than a Python exception to stop

A dropped connection does not close the database: the daemon reconnects after a restart, and a new
authenticated connection replaces the previous one. With no connection for `ORPHAN_S`, or on
SIGTERM, the worker saves, closes and exits at the next request boundary.

The engine part must end by calling `transport.serve(methods, close, ...)`, which never returns:

  methods           {name: handler(params) -> result} for every method except `close`. Handlers run
                    one at a time on the main thread. An exception becomes an error response. An
                    interrupt raises KeyboardInterrupt in the handler, at most once per request;
                    unless the handler turns it into a result, the request ends with an
                    "interrupted" error.
  close(save)       Close whatever is open (possibly nothing), saving first when `save`. Called for
                    the `close` request, and with `save` true on SIGTERM and after the orphan
                    timeout. It is never interrupted, and the process exits afterwards whether or
                    not it raised.
  dirty()           Optional. Whether there are unsaved changes; reported as `dirty` on every
                    successful response. None, or no hook, leaves the field out.
  before_request()  Optional. Runs on the main thread before every request and before the final
                    close: the place to re-arm or clear per-request engine state.
  on_interrupt()    Optional. Runs on the connection's reader thread when an interrupt frame names
                    the running request, before the interrupt reaches the main thread: the place
                    to cancel work a Python exception cannot stop.

The transport owns the SIGINT and SIGTERM handlers. An engine whose native library resets signal
dispositions calls `transport.arm_signals()` again afterwards, and from `before_request`.
"""

import _thread
import collections
import json
import os
import signal
import socket
import sys
import threading
import time
import traceback


def _listen(args):
    """Bind the protocol listener named by the command line."""
    if len(args) == 2 and args[0] == "--socket":
        try:
            os.unlink(args[1])
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(args[1])
        sock.listen(4)
        return sock
    if len(args) == 2 and args[0] == "--port-file":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(4)
        tmp = args[1] + ".tmp"
        with open(tmp, "w") as f:
            f.write(str(sock.getsockname()[1]))
        os.replace(tmp, args[1])
        return sock
    raise SystemExit("usage: worker.py --socket PATH | --port-file PATH")


def _error(e):
    message = "interrupted" if isinstance(e, KeyboardInterrupt) else str(e) or type(e).__name__
    return {"type": type(e).__name__, "message": message}


def _encode(frame):
    # A lone surrogate (bytes decoded from a binary) cannot be UTF-8; as `\udcXX` it is still valid JSON.
    return (json.dumps(frame, ensure_ascii=False, default=str) + "\n").encode("utf-8", "backslashreplace")


class _Request:
    """One request frame as the reader thread received it."""

    __slots__ = ("id", "method", "params", "problem")

    def __init__(self, frame):
        self.id = None
        self.method = None
        self.params = {}
        # The exception to answer a malformed frame with.
        self.problem = None
        if isinstance(frame, dict):
            self.id = frame.get("id")
            self.method = frame.get("method")
            params = frame.get("params")
            if isinstance(params, dict):
                self.params = params
        else:
            self.problem = frame if isinstance(frame, Exception) else ValueError("request must be a JSON object")


# Where the main thread is with the request at hand; decides what an interrupt does.
_IDLE = "idle"
_STARTING = "starting"
_RUNNING = "running"
_INTERRUPTED = "interrupted"
_FINISHING = "finishing"


class _Transport:
    # How long the worker keeps its database open with no daemon connected before it saves and exits.
    ORPHAN_S = 600.0

    def __init__(self, args):
        self._token = os.environ.pop("OMP_DISASM_WORKER_TOKEN", "")
        self._listener = _listen(args)
        # Set by SIGTERM: the main loop saves and exits once the running request (if any) finishes.
        self._terminate = False
        self._requests = collections.deque()
        self._arrived = threading.Event()
        self._stage = _IDLE
        # An interrupt arrived for the request at hand before its handler started.
        self._early = False
        # Guards the three fields below, shared with the reader threads' interrupt frames.
        self._running_lock = threading.Lock()
        self._running_id = None
        self._interrupt_scheduled = False
        self._cancelled_id = None
        self._conn_lock = threading.Lock()
        self._conn = None
        self._disconnected_at = time.monotonic()
        self._methods = {}
        self._close = None
        self._dirty = None
        self._before_request = None
        self._on_interrupt = None
        self.arm_signals()

    def arm_signals(self):
        """Install the SIGINT and SIGTERM handlers."""
        signal.signal(signal.SIGINT, self._on_sigint)
        signal.signal(signal.SIGTERM, self._on_sigterm)

    def _on_sigterm(self, signum, frame):
        # SIGTERM must not kill the worker mid-request or mid-save: it only raises a flag.
        self._terminate = True

    def _on_sigint(self, signum, frame):
        """An interrupt from the daemon: SIGINT, or an interrupt frame replayed by `_interrupt`.

        KeyboardInterrupt is raised only while a handler runs and only once per request, so it can
        neither cut a response short nor reach the next request, and the transport's own steps
        need no guarding.
        """
        stage = self._stage
        if stage == _RUNNING:
            self._stage = _INTERRUPTED
            raise KeyboardInterrupt
        if stage == _STARTING or (stage == _IDLE and self._requests):
            # Ahead of its request's handler, which then never starts.
            self._early = True
        # Otherwise it is late: its request already finished.

    def serve(self, methods, close, dirty=None, before_request=None, on_interrupt=None):
        """Answer requests on the main thread until `close`, SIGTERM or the orphan timeout; never returns."""
        self._methods = methods
        self._close = close
        self._dirty = dirty
        self._before_request = before_request
        self._on_interrupt = on_interrupt
        threading.Thread(target=self._accept_connections, name="omp-disasm-accept", daemon=True).start()
        while not self._terminate:
            if self._requests:
                self._answer()
                continue
            self._arrived.clear()
            if self._requests or self._arrived.wait(1.0):
                continue
            with self._conn_lock:
                orphaned = self._conn is None and time.monotonic() - self._disconnected_at > self.ORPHAN_S
            if orphaned:
                break
        ok, value = self._run_close(True)
        sys.exit(0 if ok else 1)

    def _accept_connections(self):
        """Serve one daemon connection at a time; a new connection replaces the previous one."""
        while True:
            try:
                conn, _ = self._listener.accept()
            except OSError:
                traceback.print_exc()
                return
            threading.Thread(target=self._read_requests, args=(conn,), name="omp-disasm-conn", daemon=True).start()

    def _read_requests(self, conn):
        authenticated = False
        try:
            for line in conn.makefile("r", encoding="utf-8", newline="\n"):
                try:
                    frame = json.loads(line)
                except ValueError as e:
                    frame = e
                if not authenticated:
                    if not isinstance(frame, dict) or frame.get("token") != self._token:
                        break
                    authenticated = True
                    with self._conn_lock:
                        previous, self._conn = self._conn, conn
                    if previous is not None:
                        try:
                            previous.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    continue
                if isinstance(frame, dict) and "interrupt" in frame:
                    self._interrupt(frame["interrupt"])
                    continue
                if line.strip():
                    self._requests.append(_Request(frame))
                    self._arrived.set()
        except (OSError, ValueError):
            pass
        with self._conn_lock:
            if self._conn is conn:
                self._conn = None
                self._disconnected_at = time.monotonic()
        conn.close()

    def _interrupt(self, req_id):
        """Interrupt request `req_id` on behalf of an interrupt frame (reader thread)."""
        with self._running_lock:
            if self._running_id is None or self._running_id != req_id:
                # Still queued, or already answered; an answered id never matches again.
                self._cancelled_id = req_id
                return
            if self._interrupt_scheduled:
                return
            self._interrupt_scheduled = True
            try:
                if self._on_interrupt is not None:
                    self._on_interrupt()
            except Exception:
                traceback.print_exc()
            finally:
                # Runs `_on_sigint` in the main thread. The main thread takes this lock before it
                # leaves the request, so the interrupt is consumed before the next one starts.
                _thread.interrupt_main()

    def _send(self, frame):
        data = _encode(frame)
        with self._conn_lock:
            conn = self._conn
        if conn is None:
            # The daemon is gone; after it reconnects it asks `status` instead.
            return
        try:
            conn.sendall(data)
        except OSError:
            traceback.print_exc()

    def _answer(self):
        """Run the request at the head of the queue and write its response."""
        # Set before the request leaves the queue: an interrupt from here on is meant for it.
        self._stage = _STARTING
        request = self._requests.popleft()
        with self._running_lock:
            self._running_id = request.id
            self._interrupt_scheduled = False
            if request.id is not None and self._cancelled_id == request.id:
                self._early = True
        closing = request.problem is None and request.method == "close"
        if request.problem is not None:
            ok, value = False, request.problem
        elif closing:
            save = bool(request.params.get("save"))
            ok, value = self._run_close(save)
            if ok:
                value = {"closed": True, "saved": save}
        else:
            ok, value = self._run(request)
        self._stage = _FINISHING
        with self._running_lock:
            self._running_id = None
        if ok:
            frame = {"id": request.id, "ok": True, "result": value}
            try:
                # Nothing is open after `close`.
                dirty = False if closing else self._dirty() if self._dirty is not None else None
                if dirty is not None:
                    frame["dirty"] = bool(dirty)
                self._send(frame)
            except Exception as e:
                # A failing `dirty` hook, or a result JSON cannot carry.
                traceback.print_exc()
                ok, value = False, e
        if not ok:
            self._send({"id": request.id, "ok": False, "error": _error(value)})
        if closing:
            sys.exit(0 if ok else 1)
        self._early = False
        self._stage = _IDLE

    def _run(self, request):
        """Run the request's handler; returns (ok, result or exception)."""
        try:
            if self._before_request is not None:
                self._before_request()
            handler = self._methods.get(request.method)
            if handler is None:
                raise ValueError(f"unknown method: {request.method}")
        except Exception as e:
            return False, e
        try:
            self._stage = _RUNNING
            if self._early:
                self._stage = _INTERRUPTED
                raise KeyboardInterrupt
            try:
                outcome = True, handler(request.params)
            except Exception as e:
                outcome = False, e
            # Past this line `_on_sigint` no longer raises.
            self._stage = _FINISHING
        except KeyboardInterrupt as e:
            outcome = False, e
        return outcome

    def _run_close(self, save):
        """Close the engine's database; returns (ok, None or exception). Not interruptible."""
        try:
            if self._before_request is not None:
                self._before_request()
            self._close(save)
        except Exception as e:
            traceback.print_exc()
            return False, e
        return True, None


transport = _Transport(sys.argv[1:])
