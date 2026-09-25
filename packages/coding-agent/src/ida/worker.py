"""omp IDA worker: drives one idalib database over an NDJSON stdin/stdout protocol.

Request:  {"id": int, "method": str, "params": dict}
Response: {"id", "ok": true, "result"} | {"id", "ok": false, "error": {"type", "message"}}
"""

import ast
import io
import json
import os
import re
import signal
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

# Keep a private handle on the real stdout for protocol frames, then point fd 1 at stderr so
# kernel messages and stray prints can never corrupt the NDJSON stream.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
try:
    sys.stdin.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

import idapro  # noqa: E402,F401  (loads libidalib before any ida_* module)


def _arm_sigint():
    # idalib resets SIGINT to SIG_DFL on load and again on kernel (re)initialisation (database
    # open, auto-analysis, Hex-Rays init, first decompile). Re-assert Python's handler so the
    # supervisor's timeout/abort SIGINT raises KeyboardInterrupt instead of killing the worker.
    if signal.getsignal(signal.SIGINT) is not signal.default_int_handler:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    # The broker stops the host's whole process group; the host saves and closes this worker,
    # so a group SIGTERM must not kill it mid-save.
    if signal.getsignal(signal.SIGTERM) is not signal.SIG_IGN:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)


_arm_sigint()
import ida_domain  # noqa: E402
import ida_auto  # noqa: E402
import ida_bytes  # noqa: E402
import ida_funcs  # noqa: E402
import ida_hexrays  # noqa: E402
import ida_idaapi  # noqa: E402
import ida_idp  # noqa: E402
import ida_lines  # noqa: E402
import ida_loader  # noqa: E402
import ida_nalt  # noqa: E402
import ida_name  # noqa: E402
import ida_segment  # noqa: E402
import ida_typeinf  # noqa: E402
import ida_ua  # noqa: E402
import ida_xref  # noqa: E402
import idautils  # noqa: E402
from ida_domain import Database  # noqa: E402
from ida_domain.database import IdaCommandOptions  # noqa: E402
from ida_domain.xrefs import XrefType  # noqa: E402

DB = None
NS = {}

_EXEC_FILE = "<ida-exec>"
_OVERVIEW_ENTRY_LIMIT = 50
_NS_MODULES = (
    ida_bytes,
    ida_funcs,
    ida_name,
    ida_typeinf,
    ida_hexrays,
    ida_segment,
    ida_xref,
    ida_ua,
    ida_nalt,
    ida_auto,
    ida_lines,
    ida_loader,
    idautils,
)


# ---------------------------------------------------------------------------
# Shared helpers (used by the RPC handlers and preloaded into the exec namespace)
# ---------------------------------------------------------------------------


def _db():
    if DB is None:
        raise RuntimeError("no IDA database open")
    return DB


def _text(lines):
    return "\n".join(str(line).expandtabs(4) for line in lines)


def _hex(ea):
    return f"0x{ea:x}"


def _regex(pattern):
    return re.compile(pattern, re.IGNORECASE) if pattern else None


def _in_range(ea):
    db = _db()
    return db.minimum_ea <= ea < db.maximum_ea


def resolve(t):
    """Resolve a symbol name, "0x" address string or int ea to an ea."""
    _db()
    if isinstance(t, bool):
        raise TypeError(f"invalid target: {t!r}")
    if isinstance(t, int):
        if not _in_range(t):
            raise LookupError(f"unknown symbol or address: 0x{t:x}")
        return t
    if not isinstance(t, str):
        raise TypeError(f"invalid target: {t!r}")
    s = t.strip()
    if s[:2].lower() == "0x":
        try:
            ea = int(s, 16)
        except ValueError:
            raise LookupError(f"unknown symbol or address: {s}") from None
        if not _in_range(ea):
            raise LookupError(f"unknown symbol or address: {s}")
        return ea
    ea = ida_name.get_name_ea(ida_idaapi.BADADDR, s)
    if ea == ida_idaapi.BADADDR:
        ea = ida_name.get_name_ea(ida_idaapi.BADADDR, "_" + s)
    if ea == ida_idaapi.BADADDR:
        raise LookupError(f"unknown symbol or address: {s}")
    return ea


def func(t):
    """Return the ida_funcs.func_t containing the target."""
    if isinstance(t, ida_funcs.func_t):
        return t
    ea = resolve(t)
    f = ida_funcs.get_func(ea)
    if f is None:
        raise LookupError(f"no function at 0x{ea:x}")
    return f


resolve_func = func


def name_of(ea):
    """Name at ea, or its hex address when unnamed."""
    return ida_name.get_name(ea) or _hex(ea)


def _func_name(ea):
    return ida_funcs.get_func_name(ea) or None


def _asm_lines(f):
    return [
        f"0x{ea:x}  {ida_lines.tag_remove(ida_lines.generate_disasm_line(ea, 0) or '')}"
        for ea in idautils.FuncItems(f.start_ea)
    ]


def asm(t):
    """Disassembly of the function containing the target."""
    return _text(_asm_lines(func(t)))


def pseudocode(t):
    """Hex-Rays pseudocode of the function; falls back to disassembly."""
    f = func(t)
    header = f"// {ida_funcs.get_func_name(f.start_ea)} @ 0x{f.start_ea:x}-0x{f.end_ea:x}"
    try:
        body = _db().pseudocode.decompile(f).to_text()
    except Exception as e:
        _arm_sigint()
        return _text([header, f"// decompilation failed: {e}; showing disassembly", *_asm_lines(f)])
    _arm_sigint()
    return _text([header, *body])


# Ordinary-flow xrefs are filtered here: ida_domain 0.5.0's XrefsFlags.NOFLOW alone maps to XREF_ALL.
def _xrefs_to(ea):
    return (x for x in _db().xrefs.to_ea(ea) if x.type != XrefType.ORDINARY_FLOW)


def _xrefs_from(t):
    ea = resolve(t)
    f = ida_funcs.get_func(ea)
    sources = idautils.FuncItems(f.start_ea) if f is not None and f.start_ea == ea else (ea,)
    db = _db()
    for src in sources:
        yield from (x for x in db.xrefs.from_ea(src) if x.type != XrefType.ORDINARY_FLOW)


def xrefs_to(t):
    """Cross-references to the target: [{"from", "type", "func"}]."""
    return [
        {"from": x.from_ea, "type": x.type.name, "func": _func_name(x.from_ea)}
        for x in _xrefs_to(resolve(t))
    ]


def xrefs_from(t):
    """Cross-references from the target (whole body for a function start): [{"to", "type", "func"}]."""
    return [{"to": x.to_ea, "type": x.type.name, "func": _func_name(x.to_ea)} for x in _xrefs_from(t)]


def _unique(names):
    return list(dict.fromkeys(n for n in names if n))


def callers(t):
    """Unique names of functions with code references to the target."""
    return _unique(_func_name(x.from_ea) for x in _xrefs_to(resolve(t)) if x.is_code)


def _callee_name(x, own):
    if x.is_code:
        target = ida_funcs.get_func(x.to_ea)
        if target is None:
            return name_of(x.to_ea) if x.is_call else None
        if target.start_ea == own.start_ea or (not x.is_call and target.start_ea != x.to_ea):
            return None
        return ida_funcs.get_func_name(target.start_ea)
    # Indirect calls through import pointers (e.g. PE `call [__imp_X]`) only carry a data xref.
    insn = ida_ua.insn_t()
    if ida_ua.decode_insn(insn, x.from_ea) and ida_idp.is_call_insn(insn):
        return name_of(x.to_ea)
    return None


def callees(t):
    """Unique names of functions called (or tail-jumped to) from the function body."""
    f = func(t)
    return _unique(_callee_name(x, f) for x in _xrefs_from(f.start_ea))


def _funcs():
    return _db().functions.get_all()


def functions(pattern=None):
    """[(ea, name)] of all functions, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for f in _funcs():
        name = ida_funcs.get_func_name(f.start_ea)
        if rx is None or rx.search(name):
            out.append((f.start_ea, name))
    return out


def strings(pattern=None):
    """[(ea, text)] of all strings, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for item in _db().strings.get_all():
        raw = ida_bytes.get_strlit_contents(item.address, item.length, item.internal_type) or b""
        s = raw.decode("utf-8", "replace")
        if rx is None or rx.search(s):
            out.append((item.address, s))
    return out


def imports(pattern=None):
    """[(ea, module, name)] of all imports, regex-filtered on "module!name"."""
    rx = _regex(pattern)
    out = []
    for imp in _db().imports.get_all_imports():
        name = imp.name or f"#{imp.ordinal}"
        if rx is None or rx.search(f"{imp.module_name}!{name}"):
            out.append((imp.address, imp.module_name, name))
    return out


def read_bytes(t, size):
    """Raw bytes at the target."""
    return ida_bytes.get_bytes(resolve(t), int(size)) or b""


def hexdump(t, size=64):
    """Classic 16-bytes-per-line hex dump at the target."""
    ea = resolve(t)
    data = ida_bytes.get_bytes(ea, int(size)) or b""
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off : off + 16]
        hexpart = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"0x{ea + off:x}  {hexpart:<47}  |{ascii_part}|")
    return _text(lines)


def rename(t, name):
    """Rename the target; returns {"ea", "old", "new"}."""
    ea = resolve(t)
    old = ida_name.get_name(ea)
    if not ida_name.set_name(ea, name, ida_name.SN_CHECK | ida_name.SN_NOWARN):
        raise ValueError(f"rename failed at 0x{ea:x}")
    return {"ea": _hex(ea), "old": old, "new": ida_name.get_name(ea)}


def comment(t, text, repeatable=False):
    """Set a (repeatable) comment at the target, and the function comment at a function start."""
    ea = resolve(t)
    rpt = bool(repeatable)
    if not ida_bytes.set_cmt(ea, text, rpt):
        raise ValueError(f"comment failed at 0x{ea:x}")
    f = ida_funcs.get_func(ea)
    if f is not None and f.start_ea == ea:
        ida_funcs.set_func_cmt(f, text, rpt)
    return {"ea": _hex(ea)}


def set_type(t, decl):
    """Apply a C declaration to the target; returns {"ea", "type"}."""
    ea = resolve(t)
    d = decl.strip()
    if not d.endswith(";"):
        d += ";"
    tif = ida_typeinf.tinfo_t()
    parsed = ida_typeinf.parse_decl(tif, None, d, ida_typeinf.PT_SIL)
    if parsed is None or parsed is False:
        raise ValueError(f"cannot parse declaration: {decl}")
    if not ida_typeinf.apply_tinfo(ea, tif, ida_typeinf.TINFO_DEFINITE):
        raise ValueError(f"cannot apply type at 0x{ea:x}")
    hexrays = ida_hexrays.init_hexrays_plugin()
    _arm_sigint()
    if hexrays:
        ida_hexrays.mark_cfunc_dirty(ea)
    return {"ea": _hex(ea), "type": str(tif)}


def make_function(t):
    """Create a function at the target; returns {"ea", "name"}."""
    ea = resolve(t)
    if not ida_funcs.add_func(ea):
        raise ValueError(f"cannot create function at 0x{ea:x}")
    ida_auto.auto_wait()
    _arm_sigint()
    return {"ea": _hex(ea), "name": ida_funcs.get_func_name(ea)}


def help_ida():
    """One line per preloaded helper."""
    return "\n".join(
        [
            "db: ida_domain Database; modules: ida_domain, " + ", ".join(m.__name__ for m in _NS_MODULES),
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
    help_ida,
)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _perm(seg):
    return "".join(c if seg.perm & bit else "-" for c, bit in (("r", 4), ("w", 2), ("x", 1)))


# Neutral names for processor modules whose ids leak the backend.
_ARCH_NAMES = {"metapc": "x86"}


def _view_overview():
    db = _db()
    segs = list(db.segments.get_all())
    entries = list(db.entries.get_all())
    funcs = list(_funcs())
    n_imports = sum(1 for _ in db.imports.get_all_imports())
    n_strings = sum(1 for _ in db.strings.get_all())
    lines = [
        f"{db.module} — {db.format}, {_ARCH_NAMES.get(db.architecture, db.architecture)} {db.bitness}-bit",
        f"base 0x{db.base_address:x} entry 0x{db.start_ip:x} range 0x{db.minimum_ea:x}-0x{db.maximum_ea:x}",
        f"md5 {db.md5} sha256 {db.sha256}",
        f"segments ({len(segs)}):",
    ]
    for s in segs:
        lines.append(
            f"  {ida_segment.get_segm_name(s)} 0x{s.start_ea:x}-0x{s.end_ea:x} {_perm(s)} {ida_segment.get_segm_class(s)}"
        )
    lines.append(f"entry points ({len(entries)}):")
    for e in entries[:_OVERVIEW_ENTRY_LIMIT]:
        lines.append(f"  0x{e.address:x} {e.name}")
    if len(entries) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(entries) - _OVERVIEW_ENTRY_LIMIT} more (:exports)")
    lines.append(f"counts: {len(funcs)} functions, {n_imports} imports, {len(entries)} exports, {n_strings} strings")
    lines.append(f"functions ({len(funcs)}):")
    for f in funcs:
        lines.append(f"  0x{f.start_ea:x}  {f.size():>6}  {ida_funcs.get_func_name(f.start_ea)}")
    return _text(lines)


def _view_imports():
    return _text(f"0x{ea:x}  {module}!{name}" for ea, module, name in imports())


def _view_exports():
    lines = []
    for e in _db().entries.get_all():
        line = f"0x{e.address:x}  {e.name}  (ordinal {e.ordinal})"
        if e.forwarder_name:
            line += f" -> {e.forwarder_name}"
        lines.append(line)
    return _text(lines)


def _view_strings():
    return _text(f"0x{ea:x}  {json.dumps(s, ensure_ascii=False)}" for ea, s in strings())


def _view_xrefs(target):
    ea = resolve(target)
    refs = xrefs_to(ea)
    lines = [f"xrefs to {name_of(ea)} (0x{ea:x}): {len(refs)}"]
    for x in refs:
        lines.append(f"0x{x['from']:x}  {x['type']}  in {x['func'] or '-'}")
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


def _idb_path():
    return ida_loader.get_path(ida_loader.PATH_TYPE_IDB)


# Set by the IDB/Hex-Rays hooks below on any user-visible mutation; cleared by a save. Reported
# on every successful response so the supervisor knows when an idle autosave is needed.
_DIRTY = False
_IDB_HOOKS = None
_HEXRAYS_HOOKS = None


def _mark_dirty():
    global _DIRTY
    _DIRTY = True


def _dirty_hooks(base, events):
    def _on_event(self, *args):
        _mark_dirty()
        return 0

    return type(f"_Dirty{base.__name__}", (base,), {name: _on_event for name in events})


_DirtyIdbHooks = _dirty_hooks(
    ida_idp.IDB_Hooks,
    (
        "renamed",
        "cmt_changed",
        "extra_cmt_changed",
        "range_cmt_changed",
        "ti_changed",
        "func_added",
        "deleting_func",
        "func_updated",
        "set_func_start",
        "set_func_end",
        "byte_patched",
        "op_type_changed",
        "make_code",
        "make_data",
        "destroyed_items",
        "local_types_changed",
        "segm_added",
        "deleting_segm",
        "frame_udm_renamed",
        "lt_udm_renamed",
        "callee_addr_changed",
        "sgr_changed",
    ),
)

_DirtyHexraysHooks = _dirty_hooks(
    ida_hexrays.Hexrays_Hooks,
    ("lvar_name_changed", "lvar_type_changed", "lvar_cmt_changed", "lvar_mapping_changed", "cmt_changed"),
)


def _open_db(path, opts):
    db = Database.open(path, opts, save_on_close=False)
    _arm_sigint()
    return db


def _rpc_open(params):
    global DB, _DIRTY, _IDB_HOOKS, _HEXRAYS_HOOKS
    if DB is not None:
        raise RuntimeError("a database is already open in this worker")
    path = params["path"]
    new = bool(params.get("new"))
    if new:
        db = _open_db(path, IdaCommandOptions(auto_analysis=True, new_database=True, output_database=path + ".i64"))
    else:
        db = _open_db(path, IdaCommandOptions(auto_analysis=True, new_database=False))
    DB = db
    ida_auto.auto_wait()
    _arm_sigint()
    _IDB_HOOKS = _DirtyIdbHooks()
    _IDB_HOOKS.hook()
    if ida_hexrays.init_hexrays_plugin():
        _HEXRAYS_HOOKS = _DirtyHexraysHooks()
        _HEXRAYS_HOOKS.hook()
    _arm_sigint()
    # A freshly analyzed database has never been written; the first idle autosave persists it.
    _DIRTY = new
    NS.clear()
    NS.update({"__name__": "__ida_exec__", "__builtins__": __builtins__, "db": DB, "ida_domain": ida_domain})
    NS.update({m.__name__: m for m in _NS_MODULES})
    NS.update({h.__name__: h for h in _HELPERS})
    return {
        "idb": _idb_path(),
        "module": DB.module,
        "format": DB.format,
        "arch": DB.architecture,
        "bitness": DB.bitness,
    }


def _rpc_view(params):
    kind = params.get("kind") or "overview"
    if kind in _PLAIN_VIEWS:
        return {"text": _PLAIN_VIEWS[kind]()}
    if kind in _TARGET_VIEWS:
        target = params.get("target")
        if target is None or (isinstance(target, str) and not target.strip()):
            raise ValueError(f"view {kind} needs a target")
        return {"text": _TARGET_VIEWS[kind](target)}
    raise ValueError(f"unknown view: {kind}")


def _rpc_exec(params):
    code = params.get("code") or ""
    buf = io.StringIO()
    value = None
    error = None
    try:
        tree = ast.parse(code, _EXEC_FILE, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        _arm_sigint()
        with redirect_stdout(buf), redirect_stderr(buf):
            if tree.body:
                exec(compile(tree, _EXEC_FILE, "exec"), NS)
            if last is not None:
                v = eval(compile(last, _EXEC_FILE, "eval"), NS)
                if v is not None:
                    value = repr(v)
    except KeyboardInterrupt:
        error = "KeyboardInterrupt: interrupted (timeout or cancel)"
    except BaseException:
        error = traceback.format_exc()
    return {"output": buf.getvalue(), "value": value, "error": error}


def _rpc_rename(params):
    return rename(params["target"], params["name"])


def _rpc_comment(params):
    return comment(params["target"], params["text"], params.get("repeatable", False))


def _rpc_set_type(params):
    return set_type(params["target"], params["decl"])


def _rpc_make_function(params):
    return make_function(params["target"])


def _rpc_save(params):
    global _DIRTY
    _db()
    p = _idb_path()
    if not ida_loader.save_database(p, 0):
        raise RuntimeError("save failed")
    _DIRTY = False
    return {"idb": p}


_METHODS = {
    "open": _rpc_open,
    "view": _rpc_view,
    "exec": _rpc_exec,
    "rename": _rpc_rename,
    "comment": _rpc_comment,
    "set_type": _rpc_set_type,
    "make_function": _rpc_make_function,
    "save": _rpc_save,
}


# ---------------------------------------------------------------------------
# Protocol loop
# ---------------------------------------------------------------------------


def _error(e):
    message = "interrupted" if isinstance(e, KeyboardInterrupt) else str(e) or type(e).__name__
    return {"type": type(e).__name__, "message": message}


def _send(frame):
    data = json.dumps(frame, ensure_ascii=False, default=str) + "\n"
    # Defer SIGINT while writing so a late interrupt cannot truncate a frame; it is
    # delivered after unblocking and swallowed by the idle loop.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    try:
        _proto.write(data)
        _proto.flush()
    finally:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})


def _close_and_exit(save):
    global DB
    code = 0
    if DB is not None:
        try:
            DB.close(save=save)
        except Exception:
            traceback.print_exc()
            code = 1
        DB = None
    _proto.flush()
    sys.exit(code)


def _handle(line):
    _arm_sigint()
    req_id = None
    try:
        req = json.loads(line)
        if not isinstance(req, dict):
            raise ValueError("request must be a JSON object")
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if method == "close":
            save = bool(params.get("save"))
            try:
                if DB is not None:
                    DB.close(save=save)
            except Exception as e:
                _send({"id": req_id, "ok": False, "error": _error(e)})
                traceback.print_exc()
                sys.exit(1)
            _send({"id": req_id, "ok": True, "result": {"closed": True, "saved": save}})
            sys.exit(0)
        handler = _METHODS.get(method)
        if handler is None:
            raise ValueError(f"unknown method: {method}")
        result = handler(params)
    except SystemExit:
        raise
    except BaseException as e:
        _send({"id": req_id, "ok": False, "error": _error(e)})
        return
    _send({"id": req_id, "ok": True, "result": result, "dirty": _DIRTY})


def main():
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            if line.strip():
                _handle(line)
        except KeyboardInterrupt:
            continue
    _close_and_exit(True)


if __name__ == "__main__":
    main()
