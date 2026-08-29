"""Remote function execution for the omp-py runtime.

Tag a function with :func:`remote`, connect a :class:`Session` to a worker
running :func:`serve` / :func:`serve_forever`, and call it. Function bodies
ship once, content-addressed by hash; afterwards a call costs a few hundred
bytes plus the arguments. Arguments and results use pickle protocol 5 with
out-of-band buffers, so large contiguous data (``numpy`` arrays, ``bytes``)
crosses the socket without intermediate copies.

::

    import omp_remote

    @omp_remote.remote
    def double(a):
        return a * 2

    omp_remote.connect("/tmp/worker.sock")   # worker: serve_forever(...)
    assert double.remote(21) == 42

Code shipping, per function (override with ``remote(ship=...)``):

- ``"source"`` — default for top-level functions in file-backed,
  package-less modules: ships the defining module's source; the worker
  re-executes it under a synthetic name and picks the function out
  (Modal-style; module import side effects run on the worker).
- ``"pickle"`` — default otherwise (cloudpickle is bundled): by value for
  dynamic functions (closures, lambdas, ``__main__``/REPL definitions), by
  reference for functions from package modules, which the worker must have
  installed.
- ``"code"`` — marshals the code object alone; same-runtime peers only
  (omp-py is pinned, so omp-py to omp-py always qualifies) and the function
  must be self-contained: no closures, no references to module globals.

Workers execute calls on real threads; concurrency follows the attached
CPython runtime's threading semantics.

.. warning:: **Security.** Deserializing and executing shipped code IS
   arbitrary code execution — that is the feature. Only ever connect
   mutually trusted peers. ``authkey`` performs an HMAC-SHA256 handshake
   that authenticates both ends but does NOT encrypt traffic; on untrusted
   networks tunnel the socket (SSH, TLS, WireGuard) and run workers under
   OS-level isolation and resource limits.
"""

from __future__ import annotations

import collections
import errno
import functools
import hashlib
import hmac
import marshal
import os
import pickle
import socket
import stat
import struct
import sys
import threading
import traceback
import types

import cloudpickle as _cloudpickle

__all__ = [
    "RemoteError",
    "RemoteFunction",
    "RemoteTraceback",
    "Session",
    "connect",
    "remote",
    "serve",
    "serve_forever",
]

_MAX_FRAME = 1 << 34  # 16 GiB sanity bound on any single frame
_MAX_HEADER = 64 << 10  # headers are small protocol dictionaries
_MAX_BUFFERS = 1 << 10  # plausible upper bound for pickle-5 OOB buffers
_MAX_CACHED_FNS = 256  # per-connection LRU bound on registered functions


class RemoteTraceback(Exception):
    """Carries the worker-side traceback; chained onto re-raised errors."""


class RemoteError(Exception):
    """Stands in for worker exceptions that cannot cross the wire intact
    (unpicklable on the worker, or unloadable on the client because their
    type only exists in shipped code)."""


# --------------------------------------------------------------------- wire
# A message is a pickled header dict plus N raw buffer frames, all
# length-prefixed. Buffers are written as memoryviews straight from the
# pickler's out-of-band callback: no concatenation, no copies.


def _send(sock, header, payload=None, bufs=()):
    nbufs = len(bufs) + (payload is not None)
    if nbufs > _MAX_BUFFERS:
        raise ValueError(f"too many buffers ({nbufs})")

    hb = pickle.dumps(header)
    if len(hb) > _MAX_HEADER:
        raise ValueError(f"oversized header ({len(hb)} bytes)")

    frames = []
    if payload is not None:
        frames.append(memoryview(payload).cast("B"))
    for b in bufs:
        frames.append(memoryview(b).cast("B"))
    for frame in frames:
        if frame.nbytes > _MAX_FRAME:
            raise ValueError(f"oversized frame ({frame.nbytes} bytes)")

    sock.sendall(struct.pack("<II", len(hb), nbufs))
    sock.sendall(hb)
    for frame in frames:
        sock.sendall(struct.pack("<Q", frame.nbytes))
        sock.sendall(frame)


def _recv_exact(sock, n):
    buf = bytearray(n)
    view = memoryview(buf)
    i = 0
    while i < n:
        k = sock.recv_into(view[i:], n - i)
        if not k:
            raise ConnectionError("peer closed")
        i += k
    return buf


def _recv(sock):
    hlen, nbufs = struct.unpack("<II", _recv_exact(sock, 8))
    if hlen > _MAX_HEADER:
        raise ConnectionError(f"oversized header ({hlen} bytes)")
    if nbufs > _MAX_BUFFERS:
        raise ConnectionError(f"too many buffers ({nbufs})")

    header = pickle.loads(_recv_exact(sock, hlen))
    bufs = []
    for _ in range(nbufs):
        (blen,) = struct.unpack("<Q", _recv_exact(sock, 8))
        if blen > _MAX_FRAME:
            raise ConnectionError(f"oversized frame ({blen} bytes)")
        bufs.append(_recv_exact(sock, blen))
    return header, bufs


def _dumps_oob(obj):
    """Pickle with protocol 5; large buffers come back out-of-band."""
    oob = []
    payload = _cloudpickle.dumps(obj, protocol=5, buffer_callback=lambda b: oob.append(b.raw()))
    return payload, oob


def _validate_authkey(authkey, *, required):
    if authkey is None:
        if required:
            raise ValueError("authkey is required for non-AF_UNIX sockets")
        return
    if not isinstance(authkey, bytes):
        raise TypeError("authkey must be bytes")
    if not authkey:
        raise ValueError("authkey must not be empty")


def _authenticate(sock, authkey, *, server):
    """Mutual HMAC-SHA256 challenge-response. Authenticates, never encrypts."""
    _validate_authkey(authkey, required=True)

    def challenge():
        nonce = os.urandom(32)
        sock.sendall(nonce)
        reply = _recv_exact(sock, 32)
        if not hmac.compare_digest(hmac.digest(authkey, nonce, "sha256"), reply):
            raise ConnectionError("authentication failed")

    def respond():
        nonce = _recv_exact(sock, 32)
        sock.sendall(hmac.digest(authkey, bytes(nonce), "sha256"))

    if server:
        challenge()
        respond()
    else:
        respond()
        challenge()


# ------------------------------------------------------------ code shipping


def _source_qualname_resolvable(fn):
    """Whether source execution can recover ``fn`` by attribute traversal."""
    return all(part.isidentifier() for part in fn.__qualname__.split("."))


def _default_ship(fn):
    """Picks the shipping mode: ``"source"`` for top-level functions in
    file-backed, package-less modules (the worker cannot be assumed to have
    them, and cloudpickle would pickle them by reference); ``"pickle"``
    otherwise — by value for dynamic functions (closures, lambdas,
    ``__main__``/REPL), by reference for package modules, which the worker
    must have installed."""
    if (
        "." in fn.__module__
        or "<locals>" in fn.__qualname__
        or not _source_qualname_resolvable(fn)
    ):
        return "pickle"
    mod = sys.modules.get(fn.__module__)
    file = getattr(mod, "__file__", None)
    if file and os.path.isfile(file):
        return "source"
    return "pickle"


def _pack_function(fn, ship):
    """Builds the code bundle for ``fn`` and returns its cache key and payload.

    The full SHA-256 hex digest is the function's identity in the wire
    protocol and per-connection caches. It provides no integrity guarantee
    and must never be treated as an authentication or trust boundary.
    """
    if ship is None:
        ship = _default_ship(fn)
    if ship == "pickle":
        bundle = {"mode": "pickle", "data": _cloudpickle.dumps(fn)}
    elif ship == "source":
        mod = sys.modules.get(fn.__module__)
        file = getattr(mod, "__file__", None)
        if (
            not (file and os.path.isfile(file))
            or "<locals>" in fn.__qualname__
            or not _source_qualname_resolvable(fn)
        ):
            raise RuntimeError(
                f"ship='source' needs {fn.__qualname__} at top level of a "
                "module with a source file"
            )
        with open(file, "rb") as fh:
            source = fh.read()
        bundle = {
            "mode": "source",
            "source": source,
            "modname": fn.__module__,
            "qualname": fn.__qualname__,
        }
    elif ship == "code":
        if fn.__closure__:
            raise RuntimeError(
                f"ship='code' cannot carry closures ({fn.__qualname__}); "
                "use the default cloudpickle mode"
            )
        bundle = {
            "mode": "code",
            "code": marshal.dumps(fn.__code__),
            "name": fn.__name__,
            "defaults": fn.__defaults__,
            "kwdefaults": fn.__kwdefaults__,
        }
    else:
        raise ValueError(f"unknown ship mode {ship!r}")
    payload = pickle.dumps(bundle, protocol=5)
    return hashlib.sha256(payload).hexdigest(), payload


def _load_function(payload, code_hash):
    """Worker side: materializes a callable from a shipped bundle."""
    bundle = pickle.loads(payload)
    mode = bundle["mode"]
    if mode == "pickle":
        fn = _cloudpickle.loads(bundle["data"])
    elif mode == "source":
        name = f"_omp_remote_{code_hash}"
        mod = sys.modules.get(name)
        if mod is None:
            mod = types.ModuleType(name)
            mod.__dict__["__omp_remote_origin__"] = bundle["modname"]
            sys.modules[name] = mod
            code = compile(bundle["source"], f"<remote {bundle['modname']}>", "exec")
            exec(code, mod.__dict__)
        obj = mod
        for part in bundle["qualname"].split("."):
            obj = getattr(obj, part)
        fn = obj
    elif mode == "code":
        code = marshal.loads(bundle["code"])
        namespace = {"__builtins__": __builtins__}
        fn = types.FunctionType(code, namespace, bundle["name"], bundle["defaults"])
        fn.__kwdefaults__ = bundle["kwdefaults"]
    else:
        raise ValueError(f"unknown bundle mode {mode!r}")
    return fn.fn if isinstance(fn, RemoteFunction) else fn


# ------------------------------------------------------------------- client

_default_session = None


class RemoteFunction:
    """Wrapper produced by :func:`remote`; still callable locally."""

    def __init__(self, fn, ship=None):
        self.fn = fn
        self._ship = ship
        self._packed = None  # (hash, payload), built on first remote call
        functools.update_wrapper(self, fn)

    def __call__(self, *args, **kwargs):
        return self.fn(*args, **kwargs)

    def _pack(self):
        if self._packed is None:
            self._packed = _pack_function(self.fn, self._ship)
        return self._packed

    def remote(self, *args, **kwargs):
        """Executes on the module-default session (see :func:`connect`)."""
        if _default_session is None:
            raise RuntimeError("no default session; call omp_remote.connect() first")
        return _default_session.call(self, *args, **kwargs)


def remote(fn=None, *, ship=None):
    """Marks a function for remote execution.

    ``ship`` overrides the code-shipping mode (``"pickle"``, ``"source"``,
    ``"code"``); the default picks per function (module docstring).
    """
    if fn is None:
        return lambda f: RemoteFunction(f, ship)
    return RemoteFunction(fn, ship)


class Session:
    """A connection to one worker. Thread-safe; calls are serialized."""

    def __init__(self, sock, authkey=None):
        _validate_authkey(authkey, required=sock.family != socket.AF_UNIX)
        if authkey is not None:
            _authenticate(sock, authkey, server=False)
        self._sock = sock
        self._lock = threading.Lock()

    def call(self, rf, /, *args, **kwargs):
        """Runs `rf` remotely; raises the worker's exception on failure,
        chained onto a :class:`RemoteTraceback` with the remote stack. A
        :class:`RemoteError` stands in when the exception type cannot be
        reconstructed on this side (e.g. defined in shipped code)."""
        if not isinstance(rf, RemoteFunction):
            rf = RemoteFunction(rf)
        code_hash, code_payload = rf._pack()
        payload, oob = _dumps_oob((args, kwargs))
        with self._lock:
            _send(self._sock, {"op": "call", "hash": code_hash}, payload, oob)
            header, frames = _recv(self._sock)
            if header["op"] == "need_code":
                # Cache miss: worker holds the buffered call; ship the body
                # once (args are NOT resent) and read the real reply.
                _send(self._sock, {"op": "register", "hash": code_hash}, code_payload)
                header, frames = _recv(self._sock)
        if header["op"] == "error":
            try:
                exc = pickle.loads(frames[0])
            except Exception:
                # The type may be unloadable here — e.g. defined in a
                # source-shipped synthetic module that only the worker has.
                exc = RemoteError(header["exc"])
            raise exc from RemoteTraceback(header["traceback"])
        return pickle.loads(frames[0], buffers=frames[1:])

    def close(self):
        self._sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def connect(address, authkey=None):
    """Connects to a worker and installs the session as module default.

    ``address`` is a filesystem path (``AF_UNIX``) or a ``(host, port)``
    tuple (``AF_INET``, ``TCP_NODELAY``). Non-``AF_UNIX`` connections require
    an explicit, non-empty bytes ``authkey``. Returns the :class:`Session`.
    """
    global _default_session
    is_unix = not isinstance(address, tuple)
    _validate_authkey(authkey, required=not is_unix)
    if is_unix:
        sock = socket.socket(socket.AF_UNIX)
        sock.connect(address)
    else:
        sock = socket.create_connection(address)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    try:
        _default_session = Session(sock, authkey)
    except BaseException:
        sock.close()
        raise
    return _default_session


# ------------------------------------------------------------------- worker


def serve(sock, authkey=None):
    """Serves one connected socket until the peer disconnects or sends
    ``shutdown``. Function bodies are cached per connection in a bounded
    LRU keyed by full digest; an evicted function transparently re-registers
    through the ``need_code`` round trip."""
    _validate_authkey(authkey, required=sock.family != socket.AF_UNIX)
    if authkey is not None:
        _authenticate(sock, authkey, server=True)
    fns = collections.OrderedDict()  # LRU: full code hash -> callable
    pending = None  # buffered (hash, frames) awaiting code registration
    while True:
        try:
            header, frames = _recv(sock)
        except ConnectionError:
            return
        op = header["op"]
        if op == "register":
            try:
                fn = _load_function(frames[0], header["hash"])
            except BaseException as exc:  # noqa: BLE001 — reply, never hang the peer
                _send_error(sock, exc)
                pending = None
                continue
            fns[header["hash"]] = fn
            fns.move_to_end(header["hash"])
            while len(fns) > _MAX_CACHED_FNS:
                fns.popitem(last=False)
            if pending and pending[0] == header["hash"]:
                _execute(sock, fn, pending[1])
                pending = None
        elif op == "call":
            fn = fns.get(header["hash"])
            if fn is None:
                pending = (header["hash"], frames)
                _send(sock, {"op": "need_code"})
            else:
                fns.move_to_end(header["hash"])
                _execute(sock, fn, frames)
        elif op == "shutdown":
            return
        else:
            raise ValueError(f"unknown op {op!r}")


def _execute(sock, fn, frames):
    try:
        args, kwargs = pickle.loads(frames[0], buffers=frames[1:])
        payload, oob = _dumps_oob(fn(*args, **kwargs))
        _send(sock, {"op": "result"}, payload, oob)
    except BaseException as exc:  # noqa: BLE001 — every failure crosses the wire
        _send_error(sock, exc)


def _send_error(sock, exc):
    """Ships `exc` to the peer: pickled when possible, with a summary and
    the formatted traceback for the client-side fallback."""
    summary = f"{type(exc).__name__}: {exc}"
    tb = traceback.format_exc()
    try:
        data = _cloudpickle.dumps(exc)
    except Exception:
        data = pickle.dumps(RemoteError(summary))
    _send(sock, {"op": "error", "exc": summary, "traceback": tb}, data)


def _filesystem_unix_path(address):
    path = os.fspath(address)
    if path.startswith(b"\0" if isinstance(path, bytes) else "\0"):
        return None
    return path


def _remove_stale_unix_socket(path):
    try:
        original = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(original.st_mode):
        raise FileExistsError(errno.EEXIST, "refusing to replace non-socket path", path)
    if original.st_uid != os.geteuid():
        raise PermissionError(errno.EPERM, "refusing to replace unowned socket", path)

    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.connect(path)
    except ConnectionRefusedError:
        pass
    except FileNotFoundError:
        return
    except OSError as exc:
        raise OSError(
            errno.EADDRINUSE,
            "refusing to replace Unix socket whose staleness cannot be proven",
            path,
        ) from exc
    else:
        raise OSError(errno.EADDRINUSE, "Unix socket is already listening", path)
    finally:
        probe.close()

    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return
    if (
        current.st_dev != original.st_dev
        or current.st_ino != original.st_ino
        or current.st_uid != original.st_uid
        or not stat.S_ISSOCK(current.st_mode)
    ):
        raise FileExistsError(
            errno.EEXIST,
            "refusing to replace Unix socket path changed during cleanup",
            path,
        )
    os.unlink(path)


def serve_forever(address, authkey=None):
    """Accept loop: one daemon thread per connection, each running
    :func:`serve`. Concurrency follows the attached CPython runtime. Never
    returns."""
    is_unix = not isinstance(address, tuple)
    _validate_authkey(authkey, required=not is_unix)
    if is_unix:
        path = _filesystem_unix_path(address)
        if path is not None:
            _remove_stale_unix_socket(path)
        srv = socket.socket(socket.AF_UNIX)
        try:
            srv.bind(address)
            if path is not None:
                os.chmod(path, 0o600)
            srv.listen()
        except BaseException:
            srv.close()
            raise
    else:
        srv = socket.create_server(address)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve, args=(conn, authkey), daemon=True).start()
