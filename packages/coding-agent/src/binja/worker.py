"""omp Binary Ninja worker: drives one headless BinaryView over an NDJSON socket protocol.

Launched as `worker.py --socket PATH` (Unix socket) or `worker.py --port-file PATH` (loopback TCP;
the bound port is written to PATH). The omp daemon connects, sends `{"token": $OMP_DISASM_WORKER_TOKEN}`
as its first line, then speaks:

Request:   {"id": int, "method": str, "params": dict}
Response:  {"id", "ok": true, "result", "dirty"} | {"id", "ok": false, "error": {"type", "message"}}
Interrupt: SIGINT, or `{"interrupt": id}` where the daemon cannot signal one process

A dropped connection does not close the database: the daemon reconnects after a restart, and a new
authenticated connection replaces the previous one. With no connection for `ORPHAN_S`, or on
SIGTERM, the worker saves, closes and exits at the next request boundary.

The listener is bound and the signal handlers are installed before `binaryninja` is imported, so
the daemon can connect while the import runs. Requests run one at a time on the main thread. An
interrupt raises KeyboardInterrupt in the running handler, at most once per request; unless the
handler turns it into a result, the request ends with an "interrupted" error.

Binary Ninja leaves the signal dispositions alone, so the handlers stay armed. Native calls cannot
be interrupted, which is why every analysis wait goes through `wait_analysis()` and nothing here
calls `update_analysis_and_wait()`; `abort_analysis()` is never called because it leaves the
database permanently under-analyzed.
"""

import _thread
import ast
import collections
import hashlib
import io
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import traceback
from contextlib import contextmanager, redirect_stderr, redirect_stdout


# ---------------------------------------------------------------------------
# Socket protocol
# ---------------------------------------------------------------------------


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
_HELD = "held"
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
        # An interrupt arrived while the handler held interrupts back.
        self._held = False
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
        if stage == _HELD:
            self._held = True
        elif stage == _STARTING or (stage == _IDLE and self._requests):
            # Ahead of its request's handler, which then never starts.
            self._early = True
        # Otherwise it is late: its request already finished.

    def hold(self):
        """Hold interrupts back until `release()`, for a step that must not be cut in half."""
        if self._stage == _RUNNING:
            self._held = False
            self._stage = _HELD

    def release(self):
        """Accept interrupts again; one that arrived since `hold()` is raised here."""
        if self._stage != _HELD:
            return
        self._stage = _RUNNING
        if self._held:
            self._stage = _INTERRUPTED
            raise KeyboardInterrupt

    def finish(self):
        """Stop accepting interrupts for the request at hand: from here on one is too late.

        Returning means no interrupt can be raised any more. So does a KeyboardInterrupt out of
        this call: it is the request's one interrupt.
        """
        self._stage = _FINISHING

    def serve(self, methods, close, dirty):
        """Answer requests on the main thread until `close`, SIGTERM or the orphan timeout; never returns.

        `methods` maps every method except `close` to `handler(params) -> result`; an exception
        becomes an error response. `close(save)` closes whatever is open, saving first when `save`.
        It runs for the `close` request, and with `save` true on SIGTERM and after the orphan
        timeout; it is never interrupted, and the process exits afterwards whether or not it
        raised. `dirty()` says whether there are unsaved changes; every successful response
        reports it.
        """
        self._methods = methods
        self._close = close
        self._dirty = dirty
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
                frame["dirty"] = False if closing else bool(self._dirty())
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
        handler = self._methods.get(request.method)
        if handler is None:
            return False, ValueError(f"unknown method: {request.method}")
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
        """Close the database; returns (ok, None or exception). Not interruptible."""
        try:
            self._close(save)
        except Exception as e:
            traceback.print_exc()
            return False, e
        return True, None


transport = _Transport(sys.argv[1:])

# The listener is bound; the daemon can connect while this import runs.
import binaryninja  # noqa: E402
from binaryninja import BranchType, SectionSemantics, Symbol, SymbolBinding, SymbolType, TypeClass  # noqa: E402

BV = None
NS = {}

_EXEC_FILE = "<binja-exec>"
_OVERVIEW_ENTRY_LIMIT = 50
_DATABASE_PATH = None
# The staged input of a managed database; None for a database opened in place.
_INPUT_PATH = None
_INPUT_DIGESTS = None
# An `exec` ran since the last save: its edits may be ones the dirty flags miss (metadata).
_EXEC_SINCE_SAVE = False


# ---------------------------------------------------------------------------
# Shared helpers (used by the RPC handlers and preloaded into the exec namespace)
# ---------------------------------------------------------------------------


def _bv():
    if BV is None:
        raise RuntimeError("no Binary Ninja database open")
    return BV


def _text(lines):
    return "\n".join(str(line).expandtabs(4) for line in lines)


def _hex(ea):
    return f"0x{ea:x}"


def _regex(pattern):
    return re.compile(pattern, re.IGNORECASE) if pattern else None


def _wait_analysis(bv):
    # The Python-level wait keeps SIGINT deliverable. An abandoned analysis keeps running and the
    # next wait joins it: the completion event fires even when the view is already idle, because
    # it is registered before `update_analysis()`.
    done = threading.Event()
    binaryninja.AnalysisCompletionEvent(bv, done.set)
    bv.update_analysis()
    while not done.wait(0.05):
        pass


def wait_analysis():
    """Wait until analysis is complete (after bv.reanalyze() or edits); interruptible, unlike bv.update_analysis_and_wait()."""
    _wait_analysis(_bv())


def _symbol_address(bv, name):
    # Binary Ninja orders these by kind: a function before its PLT entry, the import slot last.
    symbols = bv.get_symbols_by_name(name)
    owners = [(symbol, f) for symbol in symbols if (f := bv.get_function_at(symbol.address)) is not None]
    if owners:
        # Several functions of one kind can share a name, one of them only as a second symbol (an
        # export that is also a `j_` thunk): prefer one that is listed under this name.
        best = [f for symbol, f in owners if symbol.type == owners[0][0].type]
        return next((f for f in best if f.name == name), best[0]).start
    if symbols:
        return symbols[0].address
    # Functions Binary Ninja named itself (`sub_401020`) have no symbol.
    for f in bv.get_functions_by_name(name):
        return f.start
    return None


def resolve(t):
    """Resolve a symbol name, "0x" address string or int address to an int address."""
    bv = _bv()
    if isinstance(t, bool):
        raise TypeError(f"invalid target: {t!r}")
    if isinstance(t, int):
        ea = t
    elif isinstance(t, str):
        s = t.strip()
        if s[:2].lower() != "0x":
            for name in (s, "_" + s):
                ea = _symbol_address(bv, name)
                if ea is not None:
                    return ea
            raise LookupError(f"unknown symbol or address: {s}")
        try:
            ea = int(s, 16)
        except ValueError:
            raise LookupError(f"unknown symbol or address: {s}") from None
    else:
        raise TypeError(f"invalid target: {t!r}")
    if not bv.is_valid_offset(ea):
        raise LookupError(f"unknown symbol or address: {_hex(ea)}")
    return ea


def _function_containing(ea):
    bv = _bv()
    f = bv.get_function_at(ea)
    if f is not None:
        return f
    for f in bv.get_functions_containing(ea):
        return f
    return None


def func(t):
    """The binaryninja Function containing the target."""
    ea = resolve(t)
    f = _function_containing(ea)
    if f is None:
        raise LookupError(f"no function at 0x{ea:x}")
    return f


def _name_at(ea):
    bv = _bv()
    symbol = bv.get_symbol_at(ea)
    if symbol is not None:
        return symbol.name
    f = bv.get_function_at(ea)
    return f.name if f is not None else None


def name_of(ea):
    """Name at int address, or its hex address when unnamed."""
    return _name_at(ea) or _hex(ea)


def _func_name(ea):
    f = _function_containing(ea)
    return f.name if f is not None else None


def _func_end(f):
    return max((r.end for r in f.address_ranges), default=f.highest_address + 1)


def _blocks(f):
    return sorted(f.basic_blocks, key=lambda block: block.start)


def _asm_lines(f):
    return [
        f"0x{line.address:x}  {str(line).rstrip()}"
        for block in _blocks(f)
        for line in block.get_disassembly_text()
    ]


def asm(t):
    """Disassembly of the function containing the target."""
    return _text(_asm_lines(func(t)))


def _prototype(f):
    """The function's C prototype with its name, as pseudocode shows it."""
    return f"{f.type.get_string_before_name()} {f.name}{f.type.get_string_after_name()}"


def pseudocode(t):
    """Pseudo C of the function containing the target; falls back to disassembly."""
    f = func(t)
    header = f"// {f.name} @ 0x{f.start:x}-0x{_func_end(f):x}"
    try:
        # Both are generated on demand: a reopened database has neither cached.
        hlil = f.hlil
        pseudo_c = f.pseudo_c
        if hlil is None or pseudo_c is None:
            # Functions over the size or time limits are skipped; the reason says which limit.
            why = f": Binary Ninja skipped analysis ({f.analysis_skip_reason.name})" if f.analysis_skipped else ""
            return _text([header, f"// decompilation unavailable{why}; showing disassembly", *_asm_lines(f)])
        prototype = _prototype(f)
        body = [str(line).rstrip() for line in pseudo_c.get_linear_lines(hlil.root)]
    except Exception as e:
        return _text([header, f"// decompilation failed: {e}; showing disassembly", *_asm_lines(f)])
    return _text([header, prototype, *body])


# A tail jump (`jmp free`, a PLT entry's `jmp [slot]`) is a call instruction to Binary Ninja; IDA and
# Ghidra type the reference as a jump. The decoded branch tells them apart without lifting the function.
_JUMP_BRANCHES = (
    BranchType.UnconditionalBranch,
    BranchType.UnresolvedBranch,
    BranchType.IndirectBranch,
    BranchType.TrueBranch,
    BranchType.FalseBranch,
)


def _is_call(f, ea, arch=None):
    if not f.is_call_instruction(ea, arch):
        return False
    arch = arch or f.arch
    info = arch.get_instruction_info(_bv().read(ea, arch.max_instr_length), ea)
    return info is None or all(branch.type not in _JUMP_BRANCHES for branch in info.branches)


_EXPORTED = (SymbolBinding.GlobalBinding, SymbolBinding.WeakBinding)


def _plumbing(bv, f):
    """(entries, slots, inner) of a function: its PLT entries, its import slots, and the functions whose jump through a slot is plumbing."""
    entries, slots, inner = set(), set(), set()
    for own in bv.get_symbols(f.start, 1):
        if own.type == SymbolType.ImportedFunctionSymbol:
            # A function that only tail-jumps to an import carries the import's name as a second
            # symbol. It calls the import; it is not the import's entry.
            if own.name != f.name:
                continue
            inner.add(f.start)
        elif own.type != SymbolType.FunctionSymbol or own.binding not in _EXPORTED:
            # A PLT entry binds to the exported definition, never to a static function of that name.
            continue
        for other in bv.get_symbols_by_name(own.name, own.namespace):
            if other.type == SymbolType.ImportAddressSymbol:
                slots.add(other.address)
            elif other.type == SymbolType.ImportedFunctionSymbol and other.address != f.start:
                entry = bv.get_function_at(other.address)
                if entry is not None and entry.name == own.name:
                    entries.add(other.address)
    return entries, slots, inner | entries


def _code_refs(bv, ea):
    """Code references to ea in address order; for a function, also those through its PLT entry or import slot."""
    refs = list(bv.get_code_refs(ea))
    # Binary Ninja gives a function, its PLT entry and its import slot one name, so by name only one
    # of the three can be asked about, and a call through the other two would never be found.
    f = bv.get_function_at(ea)
    if f is not None:
        entries, slots, inner = _plumbing(bv, f)
        for entry in entries:
            refs += bv.get_code_refs(entry)
        for slot in slots:
            # A PLT entry's own jump through the slot is not a caller.
            refs += (ref for ref in bv.get_code_refs(slot) if ref.function is None or ref.function.start not in inner)
    # Binary Ninja returns references in no particular order. Functions that share an instruction
    # each reference from it.
    return sorted(refs, key=lambda ref: ref.address)


def xrefs_to(t):
    """Cross-references to the target: [{"from", "type", "func"}], type CALL, CODE or DATA; code references to a function include those through its PLT entry or import slot."""
    bv = _bv()
    ea = resolve(t)
    out = []
    for ref in _code_refs(bv, ea):
        f = ref.function
        call = f is not None and _is_call(f, ref.address, ref.arch)
        out.append({"from": ref.address, "type": "CALL" if call else "CODE", "func": f.name if f is not None else None})
    for source in bv.get_data_refs(ea):
        out.append({"from": source, "type": "DATA", "func": _func_name(source)})
    return sorted(out, key=lambda ref: ref["from"])


def _instructions(f):
    """(address, architecture) of every instruction; blocks of one function can differ, as ARM and Thumb do."""
    for block in _blocks(f):
        ea = block.start
        for _, length in block:
            yield ea, block.arch
            ea += length


def xrefs_from(t):
    """Cross-references from the target (whole body for a function start): [{"to", "type", "func"}]."""
    bv = _bv()
    ea = resolve(t)
    f = bv.get_function_at(ea)
    if f is not None:
        sources = [(source, f, arch) for source, arch in _instructions(f)]
    else:
        owner = _function_containing(ea)
        blocks = _blocks(owner) if owner is not None else ()
        sources = [(ea, owner, next((block.arch for block in blocks if block.start <= ea < block.end), None))]
    out = []
    for source, owner, arch in sources:
        if owner is not None:
            targets = bv.get_code_refs_from(source, owner, arch)
            kind = "CALL" if targets and _is_call(owner, source, arch) else "CODE"
            for target in targets:
                out.append({"to": target, "type": kind, "func": _func_name(target)})
        for target in bv.get_data_refs_from(source):
            out.append({"to": target, "type": "DATA", "func": _func_name(target)})
    return out


def _unique(names):
    return list(dict.fromkeys(name for name in names if name))


def callers(t):
    """Unique names of functions with code references to the target; for a function, also through its PLT entry or import slot."""
    return _unique(ref.function.name for ref in _code_refs(_bv(), resolve(t)) if ref.function is not None)


def _callee_address(bv, ea):
    # A pointer to a Thumb function has bit 0 set; a call through it lands on the function start.
    if ea & 1 and bv.get_function_at(ea) is None:
        target = bv.get_function_at(ea - 1)
        if target is not None and target.arch.name.startswith("thumb"):
            return ea - 1
    return ea


def callees(t):
    """Unique names of functions and imports called from the function body."""
    bv = _bv()
    # `Function.callees` drops imports called through a pointer; the addresses keep them. They also keep
    # targets outside the image, such as the 0 a jump through an unfilled GOT slot reads.
    return _unique(
        name_of(_callee_address(bv, ea)) for ea in func(t).callee_addresses if bv.is_valid_offset(ea)
    )


def _funcs():
    return sorted(_bv().functions, key=lambda f: f.start)


def functions(pattern=None):
    """[(ea, name)] of all functions, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    return [(f.start, f.name) for f in _funcs() if rx is None or rx.search(f.name)]


def _strings():
    # Binary Ninja also reports printable byte runs inside instructions as strings (`AWAVAUATUSH` is
    # six pushes). IDA and Ghidra list neither.
    bv = _bv()
    return [item for item in bv.strings if not bv.get_basic_blocks_at(item.start)]


def strings(pattern=None):
    """[(ea, text)] of all strings outside code, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for item in _strings():
        value = item.value
        if rx is None or rx.search(value):
            out.append((item.start, value))
    return out


# Most to least specific: one import shows up as several of these.
_IMPORT_TYPES = (
    SymbolType.ImportAddressSymbol,
    SymbolType.ImportedFunctionSymbol,
    SymbolType.ImportedDataSymbol,
    SymbolType.ExternalSymbol,
)
# Namespaces Binary Ninja assigns itself; anything else names the module an import comes from.
_BUILTIN_NAMESPACES = ("BNINTERNALNAMESPACE", "BNEXTERNALNAMESPACE")


def imports(pattern=None):
    """[(ea, module, name)] of all imports, regex-filtered on "module!name"; module is "" when the format records none."""
    bv = _bv()
    rx = _regex(pattern)
    # An ELF import with a symbol version has a second extern symbol, `name@VERSION`. Elsewhere `@` is
    # part of the name (MSVC decoration).
    versioned = bv.view_type == "ELF"

    def bare(name):
        return name.split("@", 1)[0] if versioned else name

    # Only a name with an extern symbol is an import: the PLT and GOT entries of a library's own
    # functions carry the import symbol types too.
    external = {bare(symbol.name) for symbol in bv.get_symbols_of_type(SymbolType.ExternalSymbol)}
    found = {}
    named = set()
    for kind in _IMPORT_TYPES:
        for symbol in bv.get_symbols_of_type(kind):
            name = bare(symbol.name)
            if name not in external:
                continue
            module = str(symbol.namespace or "")
            if module in _BUILTIN_NAMESPACES:
                module = ""
            # The extern-section copy of an import that is already listed under its module.
            if not module and kind == SymbolType.ExternalSymbol and name in named:
                continue
            found.setdefault((module, name), symbol.address)
        named.update(name for _, name in found)
    out = [(ea, module, name) for (module, name), ea in found.items() if rx is None or rx.search(f"{module}!{name}")]
    return sorted(out)


def _exports():
    """[(ea, name)] of exported function and data symbols, plus the program entry when no export names it."""
    bv = _bv()
    out = []
    for kind in (SymbolType.FunctionSymbol, SymbolType.DataSymbol):
        for symbol in bv.get_symbols_of_type(kind):
            if symbol.binding in _EXPORTED:
                out.append((symbol.address, symbol.name))
    # A PE executable exports nothing, yet its entry is an entry point: IDA and Ghidra both list it.
    entry = bv.entry_point
    if bv.get_function_at(entry) is not None and all(ea != entry for ea, _ in out):
        out.append((entry, name_of(entry)))
    return sorted(out)


def read_bytes(t, size):
    """Raw bytes at the target."""
    return _bv().read(resolve(t), int(size))


def hexdump(t, size=64):
    """Classic 16-bytes-per-line hex dump at the target."""
    ea = resolve(t)
    data = read_bytes(ea, size)
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off : off + 16]
        hexpart = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"0x{ea + off:x}  {hexpart:<47}  |{ascii_part}|")
    return _text(lines)


def rename(t, name):
    """Rename the target; returns {"ea", "old", "new"}."""
    bv = _bv()
    ea = resolve(t)
    old = _name_at(ea) or ""
    f = bv.get_function_at(ea)
    if f is not None:
        f.name = name
    else:
        bv.define_user_symbol(Symbol(SymbolType.DataSymbol, ea, name))
    return {"ea": _hex(ea), "old": old, "new": name_of(ea)}


def comment(t, text, repeatable=False):
    """Set a comment at the target (the function's own address comment inside a function), and the function comment at a function start; `repeatable` has no Binary Ninja equivalent and is ignored."""
    bv = _bv()
    ea = resolve(t)
    owner = _function_containing(ea)
    if owner is not None:
        owner.set_comment_at(ea, text)
        if owner.start == ea:
            owner.comment = text
    else:
        bv.set_comment_at(ea, text)
    return {"ea": _hex(ea)}


def set_type(t, decl):
    """Apply a C function prototype at a function start, or a data type elsewhere; returns {"ea", "type"} with the applied prototype (name included) or type."""
    bv = _bv()
    ea = resolve(t)
    try:
        ty, _ = bv.parse_type_string(decl.strip().rstrip(";"))
    except SyntaxError as e:
        raise ValueError(f"cannot parse declaration: {decl}: {e}") from None
    f = bv.get_function_at(ea)
    if f is not None:
        # Binary Ninja silently ignores a non-function type assigned to a function.
        if ty.type_class != TypeClass.FunctionTypeClass:
            raise ValueError(f"0x{ea:x} is a function start: expected a function prototype, got {ty}")
        f.type = ty
        # The prototype takes effect when analysis picks it up.
        _wait_analysis(bv)
        return {"ea": _hex(ea), "type": _prototype(f)}
    if bv.define_user_data_var(ea, ty) is None:
        raise ValueError(f"cannot apply type at 0x{ea:x}")
    _wait_analysis(bv)
    return {"ea": _hex(ea), "type": str(ty)}


def make_function(t):
    """Create a function at the target; returns {"ea", "name"}."""
    bv = _bv()
    ea = resolve(t)
    if bv.create_user_function(ea) is None:
        raise ValueError(f"cannot create function at 0x{ea:x}")
    _wait_analysis(bv)
    f = bv.get_function_at(ea)
    if f is None:
        raise ValueError(f"cannot create function at 0x{ea:x}")
    return {"ea": _hex(ea), "name": f.name}


def help_binja():
    """One line per preloaded helper."""
    return "\n".join(
        [
            "bv: binaryninja BinaryView of the open database; binaryninja: the API module",
            "a failing exec undoes its own undo-recorded edits; never call bv.abort_analysis() (it leaves the database under-analyzed for good)",
            *(f"{h.__name__}{_signature(h)}: {h.__doc__}" for h in _HELPERS),
        ]
    )


def _signature(fn):
    code = fn.__code__
    names = code.co_varnames[: code.co_argcount]
    defaults = fn.__defaults__ or ()
    first_default = len(names) - len(defaults)
    parts = [n if i < first_default else f"{n}={defaults[i - first_default]!r}" for i, n in enumerate(names)]
    return f"({', '.join(parts)})"


_HELPERS = (
    resolve,
    func,
    pseudocode,
    asm,
    xrefs_to,
    xrefs_from,
    callers,
    callees,
    functions,
    strings,
    imports,
    name_of,
    hexdump,
    read_bytes,
    rename,
    comment,
    set_type,
    make_function,
    wait_analysis,
    help_binja,
)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _module():
    bv = _bv()
    return os.path.basename(bv.file.original_filename or bv.file.filename)


def _arch():
    arch = _bv().arch
    return arch.name if arch is not None else "unknown"


def _digests(data_or_path):
    md5 = hashlib.md5()
    sha256 = hashlib.sha256()
    if isinstance(data_or_path, bytes):
        md5.update(data_or_path)
        sha256.update(data_or_path)
    else:
        with open(data_or_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                md5.update(chunk)
                sha256.update(chunk)
    return md5.hexdigest(), sha256.hexdigest()


def _original_contents(bv):
    """Bytes of the file the database was created from: its root snapshot, which later patches leave alone."""
    database = bv.file.database
    snapshot = database.current_snapshot if database is not None else None
    while snapshot is not None and snapshot.first_parent is not None:
        snapshot = snapshot.first_parent
    if snapshot is None or not snapshot.has_contents:
        return None
    return bytes(snapshot.file_contents)


def _digest_line():
    global _INPUT_DIGESTS
    if _INPUT_DIGESTS is None:
        if _INPUT_PATH is not None:
            # The staged input never changes, so its digests stay those of the analyzed file even
            # after bytes are patched in the database.
            _INPUT_DIGESTS = _digests(_INPUT_PATH)
        else:
            # A database opened in place has no input file beside it, but it keeps the bytes it
            # was created from: report the analyzed file's digests, as IDA does for an .i64.
            original = _original_contents(_bv())
            if original is not None:
                _INPUT_DIGESTS = _digests(original)
    if _INPUT_DIGESTS is not None:
        md5, sha256 = _INPUT_DIGESTS
        return f"md5 {md5} sha256 {sha256}"
    # No original recorded: hash the bytes the database holds now, and say so.
    bv = _bv()
    raw = bv.file.raw or bv
    md5, sha256 = _digests(raw.read(0, raw.length))
    return f"md5 {md5} sha256 {sha256} (current contents)"


_SECTION_CLASSES = {
    SectionSemantics.ReadOnlyCodeSectionSemantics: "CODE",
    SectionSemantics.ReadOnlyDataSectionSemantics: "CONST",
    SectionSemantics.ReadWriteDataSectionSemantics: "DATA",
    SectionSemantics.ExternalSectionSemantics: "XTRN",
}


def _perm(segment):
    if segment is None:
        return "---"
    return "".join(
        c if enabled else "-"
        for c, enabled in (("r", segment.readable), ("w", segment.writable), ("x", segment.executable))
    )


def _regions():
    """(name, start, end, perm, class) per section, or per segment when the view has no sections."""
    bv = _bv()
    sections = sorted(bv.sections.values(), key=lambda s: (s.start, s.name))
    if sections:
        return [
            (s.name, s.start, s.end, _perm(bv.get_segment_at(s.start)), _SECTION_CLASSES.get(s.semantics, ""))
            for s in sections
        ]
    return [
        (f"seg{i}", s.start, s.end, _perm(s), "CODE" if s.executable else "DATA")
        for i, s in enumerate(sorted(bv.segments, key=lambda s: s.start))
    ]


def _view_overview():
    bv = _bv()
    regions = _regions()
    entries = _exports()
    funcs = _funcs()
    lines = [
        f"{_module()} — {bv.view_type}, {_arch()} {bv.address_size * 8}-bit",
        f"base 0x{bv.start:x} entry 0x{bv.entry_point:x} range 0x{bv.start:x}-0x{bv.end:x}",
        _digest_line(),
        f"segments ({len(regions)}):",
    ]
    for name, start, end, perm, sclass in regions:
        lines.append(f"  {name} 0x{start:x}-0x{end:x} {perm} {sclass}")
    lines.append(f"entry points ({len(entries)}):")
    for ea, name in entries[:_OVERVIEW_ENTRY_LIMIT]:
        lines.append(f"  0x{ea:x} {name}")
    if len(entries) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(entries) - _OVERVIEW_ENTRY_LIMIT} more (:exports)")
    lines.append(
        f"counts: {len(funcs)} functions, {len(imports())} imports, {len(entries)} exports, {len(_strings())} strings"
    )
    lines.append(f"functions ({len(funcs)}):")
    for f in funcs:
        lines.append(f"  0x{f.start:x}  {f.total_bytes:>6}  {f.name}")
    return _text(lines)


def _view_imports():
    # ELF records no module per import: print the bare name rather than `!name`.
    return _text(f"0x{ea:x}  {module}!{name}" if module else f"0x{ea:x}  {name}" for ea, module, name in imports())


def _view_exports():
    return _text(f"0x{ea:x}  {name}" for ea, name in _exports())


def _view_strings():
    return _text(f"0x{ea:x}  {json.dumps(s, ensure_ascii=False)}" for ea, s in strings())


def _view_xrefs(target):
    ea = resolve(target)
    refs = xrefs_to(ea)
    lines = [f"xrefs to {name_of(ea)} (0x{ea:x}): {len(refs)}"]
    for ref in refs:
        lines.append(f"0x{ref['from']:x}  {ref['type']}  in {ref['func'] or '-'}")
    return _text(lines)


_TARGET_VIEWS = {"pseudocode": pseudocode, "asm": asm, "xrefs": _view_xrefs}
_PLAIN_VIEWS = {
    "overview": _view_overview,
    "imports": _view_imports,
    "exports": _view_exports,
    "strings": _view_strings,
}


# ---------------------------------------------------------------------------
# RPC methods
# ---------------------------------------------------------------------------


def _load(path):
    # The default `load` blocks in the native, uninterruptible analysis wait.
    try:
        bv = binaryninja.load(path, update_analysis=False)
    except Exception as e:
        raise RuntimeError(f"Binary Ninja cannot open {path}: {e}") from None
    if bv is None:
        raise RuntimeError(f"Binary Ninja cannot open {path}")
    return bv


def _create_database(binary, database):
    """Analyze `binary` and publish the result as `database`."""
    # The store treats any `.bndb` as a finished database, so the file only takes that name once
    # it is complete.
    part = database + ".part"
    bv = _load(binary)
    try:
        try:
            _wait_analysis(bv)
            if not bv.create_database(part):
                raise RuntimeError(f"cannot create database {database}")
        finally:
            bv.file.close()
        os.replace(part, database)
    except BaseException:
        try:
            os.unlink(part)
        except OSError:
            pass
        raise


def _rpc_open(params):
    global BV, _DATABASE_PATH, _INPUT_PATH, _INPUT_DIGESTS, _EXEC_SINCE_SAVE
    if BV is not None:
        raise RuntimeError("a database is already open in this worker")
    path = params["path"]
    database = path
    if params.get("new"):
        database = path + ".bndb"
        _create_database(path, database)
    bv = _load(database)
    try:
        # `load` also opens a file that merely carries the extension, as a plain binary.
        if not bv.file.has_database:
            raise ValueError(f"{database} is not a Binary Ninja database")
        _wait_analysis(bv)
    except BaseException:
        bv.file.close()
        raise
    binary = params.get("binary")
    BV = bv
    _DATABASE_PATH = database
    # An in-place open passes the database itself as the binary.
    _INPUT_PATH = binary if binary and binary != database else None
    _INPUT_DIGESTS = None
    _EXEC_SINCE_SAVE = False
    NS.clear()
    NS.update({"__name__": "__binja_exec__", "__builtins__": __builtins__, "bv": bv, "binaryninja": binaryninja})
    NS.update({h.__name__: h for h in _HELPERS})
    return _open_info()


def _open_info():
    bv = _bv()
    return {
        "idb": _DATABASE_PATH,
        "module": _module(),
        "format": bv.view_type,
        "arch": _arch(),
        "bitness": bv.address_size * 8,
    }


def _rpc_status(params):
    # Queued behind any running request, so a reconnecting daemon sees the finished open. It does
    # not wait for analysis: it must answer with nothing open and right after re-adoption.
    if BV is None:
        return {"open": False}
    return {"open": True, **_open_info()}


def _rpc_view(params):
    wait_analysis()
    kind = params.get("kind") or "overview"
    if kind in _PLAIN_VIEWS:
        return {"text": _PLAIN_VIEWS[kind]()}
    if kind in _TARGET_VIEWS:
        target = params.get("target")
        if target is None or (isinstance(target, str) and not target.strip()):
            raise ValueError(f"view {kind} needs a target")
        return {"text": _TARGET_VIEWS[kind](target)}
    raise ValueError(f"unknown view: {kind}")


@contextmanager
def _undo_span():
    """Commit the undo-recorded edits of the body, or revert them when it raises or is interrupted.

    A request either fails with its edits reverted or succeeds with them committed: an interrupt
    cannot land between the last edit and the commit, nor leave the span open. The span ends the
    part of a request that an interrupt can stop, so it is a handler's last step.

    Auto-level changes, metadata and a function's `has_user_type` flag are outside undo and stay.
    """
    bv = _bv()
    span = None
    try:
        # An interrupt between the native call and the assignment would leave a span nothing closes.
        transport.hold()
        span = bv.begin_undo_actions()
        transport.release()
        yield
        # The last moment an interrupt stops the request: raised in this call it still reverts,
        # after it the edits are committed and the request succeeds.
        transport.finish()
        bv.commit_undo_actions(span)
    except BaseException:
        if span is not None:
            try:
                transport.finish()
            except KeyboardInterrupt:
                # The request's one interrupt, on the way in: nothing cuts the revert short now.
                pass
            bv.revert_undo_actions(span)
        raise


def _rpc_exec(params):
    global _EXEC_SINCE_SAVE
    _bv()
    _EXEC_SINCE_SAVE = True
    code = params.get("code") or ""
    buf = io.StringIO()
    value = None
    error = None
    try:
        # The helpers open no span of their own, so nothing nests. The wait sits inside the error
        # boundary: an interrupt during analysis comes back as `error`.
        with _undo_span():
            wait_analysis()
            tree = ast.parse(code, _EXEC_FILE, "exec")
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body.pop().value)
            with redirect_stdout(buf), redirect_stderr(buf):
                if tree.body:
                    exec(compile(tree, _EXEC_FILE, "exec"), NS)
                if last is not None:
                    v = eval(compile(last, _EXEC_FILE, "eval"), NS)
                    if v is not None:
                        value = repr(v)
    except KeyboardInterrupt:
        value = None
        error = "KeyboardInterrupt: interrupted (timeout or cancel)"
    except BaseException:
        value = None
        error = traceback.format_exc()
    return {"output": buf.getvalue(), "value": value, "error": error}


def _mutation(apply):
    """RPC handler for one mutation: a failure reverts it and answers with an RPC error."""

    def handler(params):
        wait_analysis()
        with _undo_span():
            return apply(params)

    return handler


def _rpc_save(params):
    global _EXEC_SINCE_SAVE
    if not _bv().save_auto_snapshot():
        raise RuntimeError(f"cannot save {_DATABASE_PATH}")
    _EXEC_SINCE_SAVE = False
    return {"idb": _DATABASE_PATH}


def _close(save):
    global BV
    bv, BV = BV, None
    NS.clear()
    if bv is None:
        return
    try:
        # An unchanged database is left as it is, as the Ghidra worker leaves an unchanged
        # program: every snapshot rewrites and grows the file. The dirty flags cover edits;
        # metadata set from `exec` raises neither, so any `exec` since the last save counts.
        changed = _EXEC_SINCE_SAVE or bv.file.modified or bv.file.analysis_changed
        if save and changed and not bv.save_auto_snapshot():
            raise RuntimeError(f"cannot save {_DATABASE_PATH}")
    finally:
        bv.file.close()


def _dirty():
    return BV is not None and bool(BV.file.modified or BV.file.analysis_changed)


_METHODS = {
    "open": _rpc_open,
    "status": _rpc_status,
    "view": _rpc_view,
    "exec": _rpc_exec,
    "rename": _mutation(lambda params: rename(params["target"], params["name"])),
    "comment": _mutation(lambda params: comment(params["target"], params["text"], params.get("repeatable", False))),
    "set_type": _mutation(lambda params: set_type(params["target"], params["decl"])),
    "make_function": _mutation(lambda params: make_function(params["target"])),
    "save": _rpc_save,
}


if __name__ == "__main__":
    transport.serve(_METHODS, _close, dirty=_dirty)
