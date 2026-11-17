"""omp radare2 worker: drives one r2pipe session over NDJSON stdin/stdout.

Request:  {"id": int, "method": str, "params": dict}
Response: {"id", "ok": true, "result", "dirty"} | {"id", "ok": false, "error": {"type", "message"}}
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
from pathlib import Path

# Diagnostics and user prints must never corrupt the protocol stream.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
try:
    sys.stdin.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

# The broker SIGTERMs the host's process group; the host saves and closes us first.
signal.signal(signal.SIGTERM, signal.SIG_IGN)

import r2pipe  # noqa: E402

R2 = None
_DATABASE_PATH = None
_DIRTY = False
_MODULE = None
NS = {}
_WINDOWS = sys.platform == "win32"
_EXEC_FILE = "<radare2-exec>"
_OVERVIEW_ENTRY_LIMIT = 50


def _program():
    if R2 is None:
        raise RuntimeError("no radare2 project is open in this worker")
    return R2

# ---------------------------------------------------------------------------
# Shared helpers (also preloaded into the exec namespace)
# ---------------------------------------------------------------------------


def _json(r2, text):
    """cmdj with a raw cmd fallback when radare2 emits non-JSON output."""
    try:
        return r2.cmdj(text)
    except Exception:
        return r2.cmd(text)


def _items(value):
    return value if isinstance(value, list) else ([value] if isinstance(value, dict) else [])


def _hex(ea):
    return f"0x{ea:x}"


def _text(lines):
    return "\n".join(str(line).expandtabs(4) for line in lines)


def _regex(pattern):
    return re.compile(pattern, re.IGNORECASE) if pattern else None


def _addr(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("not an address: " + repr(value))
    if isinstance(value, int):
        return value
    token = str(value).strip()
    if token.lower().startswith("0x"):
        return int(token, 16)
    try:
        return int(token, 0)
    except ValueError:
        return int(token, 16)


def resolve(t):
    """Resolve a symbol name, \"0x\" address string or int ea to an int ea."""
    if isinstance(t, bool) or not isinstance(t, (int, str)):
        raise ValueError("invalid target: " + repr(t))
    token = str(t).strip()
    if not token:
        raise ValueError("invalid target: " + repr(t))
    try:
        return _addr(token)
    except (ValueError, TypeError):
        pass
    answer = str(_program().cmd("?v " + token)).strip()
    if answer:
        try:
            return _addr(answer)
        except (ValueError, TypeError):
            pass
    raise ValueError("cannot resolve target: " + repr(t))


def _functions():
    return _items(_json(_program(), "aflj"))


def func(t):
    """The aflj record of the function containing the target."""
    ea = resolve(t)
    for f in _functions():
        start = _addr(f.get("offset", f.get("addr", 0)))
        size = int(f.get("size") or 0)
        if start <= ea < start + size or (not size and start == ea):
            return f
    raise ValueError("no function at " + _hex(ea))


def name_of(ea):
    """Function name at int ea, or its hex address when unnamed."""
    ea = resolve(ea)
    for f in _functions():
        if _addr(f.get("offset", f.get("addr", 0))) == ea:
            return str(f.get("name") or _hex(ea))
    return _hex(ea)


def functions(pattern=None):
    """[(ea, name)] of all functions, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for f in _functions():
        ea = _addr(f.get("offset", f.get("addr", 0)))
        name = str(f.get("name") or _hex(ea))
        if rx is None or rx.search(name):
            out.append((ea, name))
    return out


def imports(pattern=None):
    """[(ea or None, library, name)] of imports, regex-filtered on \"lib!name\"."""
    rx = _regex(pattern)
    out = []
    for item in _items(_json(_program(), "iij")):
        name = str(item.get("name") or "")
        lib = str(item.get("libname") or item.get("library") or "")
        ea = item.get("vaddr")
        try:
            ea = _addr(ea) if ea is not None else None
        except (ValueError, TypeError):
            ea = None
        if rx is None or rx.search(lib + "!" + name) or rx.search(name):
            out.append((ea, lib, name))
    return out


def strings(pattern=None):
    """[(ea, text)] of defined strings, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for item in _items(_json(_program(), "izzj")):
        value = str(item.get("string") or "")
        ea = _addr(item.get("vaddr", 0))
        if rx is None or rx.search(value):
            out.append((ea, value))
    return out


def _decompile(command, target):
    r2 = _program()
    text = command + (" @ " + target if target else "")
    try:
        data = r2.cmdj(text)
    except Exception:
        try:
            return str(r2.cmd(text)).strip()
        except Exception:
            return ""
    if isinstance(data, str):
        return data.strip()
    blocks = _items(data.get("blocks")) if isinstance(data, dict) else _items(data)
    if isinstance(data, dict) and isinstance(data.get("code"), str):
        return data["code"].strip()
    lines = []
    for block in blocks:
        if isinstance(block, dict) and isinstance(block.get("code"), str):
            lines.append(block["code"].strip())
    return _text([line for line in lines if line])


def pseudocode(t=None):
    """Decompile the target with pdgj, falling back to pdcj, as text."""
    ea = resolve(t) if t is not None else None
    target = _hex(ea) if ea is not None else None
    text = _decompile("pdgj", target)
    if not text:
        text = _decompile("pdcj", target)
    return text or f"// no decompiler output at {target or 'current position'}"


def _disasm(command, target):
    r2 = _program()
    text = command + (" @ " + target if target else "")
    try:
        data = r2.cmdj(text)
    except Exception:
        try:
            return str(r2.cmd(text)).strip()
        except Exception:
            return ""
    if isinstance(data, str):
        return data.strip()
    lines = []
    if isinstance(data, dict):
        ops = _items(data.get("ops"))
        if not ops:
            return ""
        addr = _addr(data.get("addr", 0))
        lines.append(f"{data.get('name') or target or 'function'} ({_hex(addr)}), {int(data.get('size') or 0)} bytes")
    else:
        ops = _items(data)
    for op in ops:
        if isinstance(op, str):
            lines.append(op)
        elif isinstance(op, dict):
            ea = _addr(op.get("addr", op.get("offset", 0)))
            lines.append(f"  {_hex(ea)}  {op.get('disasm') or op.get('opcode') or ''}")
    return _text(lines)


def asm(t):
    """Disassembly of the function containing the target (pdfj, then pdj)."""
    ea = resolve(t)
    target = _hex(ea)
    text = _disasm("pdfj", target)
    if not text:
        text = _disasm("pdj", target)
    return text or f"; no disassembly at {target}"


def _xrefs(command, target, key):
    ea = resolve(target)
    out = []
    for ref in _items(_json(_program(), command + " @ " + _hex(ea))):
        if not isinstance(ref, dict):
            continue
        owner = ref.get("fcn") or {}
        out.append({
            key: _addr(ref[key]) if ref.get(key) is not None else None,
            "type": str(ref.get("type") or ""),
            "func": str(owner.get("name") or "") if isinstance(owner, dict) else str(owner),
        })
    return out


def xrefs_to(t):
    """Cross-references to the target: [{\"from\", \"type\", \"func\"}]."""
    return _xrefs("axtj", t, "from")


def xrefs_from(t):
    """Cross-references from the target: [{\"to\", \"type\", \"func\"}]."""
    return _xrefs("axfj", t, "to")


def callers(t):
    """Unique names of functions referencing the target."""
    return list(dict.fromkeys(r["func"] for r in xrefs_to(t) if r["func"]))


def callees(t):
    """Unique names of functions called from the target."""
    return list(dict.fromkeys(r["func"] for r in xrefs_from(t) if r["func"]))


def read_bytes(t, size):
    """Raw bytes at the target."""
    ea = resolve(t)
    raw = str(_program().cmd(f"p8 {int(size)} @ {_hex(ea)}")).strip()
    try:
        return bytes.fromhex(raw)
    except ValueError:
        return b""


def hexdump(t, size=64):
    """Classic 16-byte-per-line hex dump at the target."""
    ea = resolve(t)
    return str(_program().cmd(f"px {int(size)} @ {_hex(ea)}")).strip()


def _signature(fn):
    code = fn.__code__
    names = code.co_varnames[:code.co_argcount]
    defaults = fn.__defaults__ or ()
    first_default = len(names) - len(defaults)
    parts = [n if i < first_default else f"{n}={defaults[i - first_default]!r}" for i, n in enumerate(names)]
    return f"({', '.join(parts)})"


def help_radare2():
    """One line per preloaded helper and the available r2 objects."""
    return "\n".join([
        "r2/radare2: r2pipe session; NS is the persistent exec namespace",
        *(f"{h.__name__}{_signature(h)}: {h.__doc__}" for h in _HELPERS),
    ])


_HELPERS = (
    resolve, func, name_of, pseudocode, asm, xrefs_to, xrefs_from, callers,
    callees, functions, strings, imports, hexdump, read_bytes, help_radare2,
)

# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _info():
    data = _json(_program(), "iIj")
    if isinstance(data, list):
        data = data[0] if data else {}
    return data if isinstance(data, dict) else {}


def _view_overview():
    r2 = _program()
    info = _info()
    segments = _items(_json(r2, "iSj"))
    entries = _items(_json(r2, "iej"))
    funcs = _functions()
    lines = [
        f"{_MODULE or 'binary'} — {info.get('bintype') or 'unknown'}, {info.get('arch') or 'unknown'} {int(info.get('bits') or 0)}-bit",
        f"base {_hex(_addr(info.get('baddr', 0)))}",
        f"segments ({len(segments)}):",
    ]
    for segment in segments[:_OVERVIEW_ENTRY_LIMIT]:
        start = _addr(segment.get("vaddr", 0))
        end = start + int(segment.get("size") or 0)
        lines.append(f"  {segment.get('name') or '-'} {_hex(start)}-{_hex(end)} {segment.get('perm') or '-'}")
    if len(segments) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(segments) - _OVERVIEW_ENTRY_LIMIT} more")
    lines.append(f"entry points ({len(entries)}):")
    for entry in entries[:_OVERVIEW_ENTRY_LIMIT]:
        ea = _addr(entry.get("vaddr", 0))
        lines.append(f"  {_hex(ea)} {name_of(ea)}")
    if len(entries) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(entries) - _OVERVIEW_ENTRY_LIMIT} more (:exports)")
    exports = len(_items(_json(r2, "iEj")))
    lines.append(
        f"counts: {len(funcs)} functions, {len(imports())} imports, "
        f"{exports} exports, {len(strings())} strings"
    )
    lines.append(f"functions ({len(funcs)}):")
    for f in funcs[:_OVERVIEW_ENTRY_LIMIT]:
        ea = _addr(f.get("offset", f.get("addr", 0)))
        lines.append(f"  {_hex(ea)}  {int(f.get('size') or 0):>6}  {f.get('name') or _hex(ea)}")
    if len(funcs) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(funcs) - _OVERVIEW_ENTRY_LIMIT} more")
    return _text(lines)


def _view_imports():
    lines = []
    for ea, lib, name in imports():
        where = _hex(ea) if ea is not None else "-"
        label = lib + "!" + name if lib else name
        lines.append(f"{where}  {label}")
    return _text(lines)


def _view_exports():
    lines = []
    for item in _items(_json(_program(), "iEj")):
        ea = _addr(item.get("vaddr", item.get("offset", 0)))
        lines.append(f"{_hex(ea)}  {item.get('name') or name_of(ea)}")
    return _text(lines)


def _view_strings():
    return _text(f"{_hex(ea)}  {json.dumps(value, ensure_ascii=False)}" for ea, value in strings())


def _view_xrefs(target):
    ea = resolve(target)
    refs = xrefs_to(ea)
    lines = [f"xrefs to {name_of(ea)} ({_hex(ea)}): {len(refs)}"]
    for ref in refs:
        lines.append(f"{_hex(ref['from'])}  {ref['type']}  in {ref['func'] or '-'}")
    return _text(lines)


def _view_pseudocode(target):
    return pseudocode(target)


def _view_asm(target):
    return asm(target)


_PLAIN_VIEWS = {
    "overview": _view_overview,
    "imports": _view_imports,
    "exports": _view_exports,
    "strings": _view_strings,
}
_TARGET_VIEWS = {
    "pseudocode": _view_pseudocode,
    "asm": _view_asm,
    "xrefs": _view_xrefs,
}


def _rpc_open(params):
    global R2, _DATABASE_PATH, _DIRTY, _MODULE
    if R2 is not None:
        raise RuntimeError("a project is already open in this worker")
    project_dir = os.path.abspath(params["project"])
    binary = os.path.abspath(params["binary"])
    is_new = bool(params.get("new"))
    settings = [
        "scr.color=0",
        "scr.utf8=false",
        "scr.interactive=false",
        "dir.projects=" + project_dir,
        "prj.files=false",
    ]
    if is_new:
        r2 = r2pipe.open(binary, flags=["-N"])
    else:
        r2 = r2pipe.open("-", flags=["-e", "dir.projects=" + project_dir, "-p", "omp"])
    for setting in settings:
        r2.cmd("e " + setting)
    r2.cmd("aa")
    if is_new:
        r2.cmd("Ps omp")
    marker = os.path.join(project_dir, "omp.r2")
    Path(marker).touch()
    R2 = r2
    _DATABASE_PATH = marker
    _DIRTY = False
    NS.clear()
    NS.update({
        "__name__": "__radare2_exec__", "__builtins__": __builtins__,
        "r2": r2, "radare2": r2,
        **{helper.__name__: helper for helper in _HELPERS},
    })
    info = r2.cmdj("iIj") or {}
    if isinstance(info, list):
        info = info[0] if info else {}
    if not isinstance(info, dict):
        info = {}
    _MODULE = str(info.get("name") or os.path.basename(binary))
    return {
        "idb": marker,
        "module": _MODULE,
        "format": str(info.get("bintype") or "unknown"),
        "arch": str(info.get("arch") or "unknown"),
        "bitness": int(info.get("bits") or 0),
    }


def _rpc_save(params):
    global _DIRTY
    _program().cmd("Ps omp")
    Path(_DATABASE_PATH).touch()
    _DIRTY = False
    return {"idb": _DATABASE_PATH}


def _rpc_view(params):
    _program()
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
    _program()
    code = params.get("code") or ""
    buf = io.StringIO()
    value = None
    error = None
    try:
        tree = ast.parse(code, _EXEC_FILE, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with redirect_stdout(buf), redirect_stderr(buf):
            if tree.body:
                exec(compile(tree, _EXEC_FILE, "exec"), NS)
            if last is not None:
                result = eval(compile(last, _EXEC_FILE, "eval"), NS)
                if result is not None:
                    value = repr(result)
    except KeyboardInterrupt:
        error = "KeyboardInterrupt: interrupted (timeout or cancel)"
    except BaseException:
        error = traceback.format_exc()
    return {"output": buf.getvalue(), "value": value, "error": error}


_METHODS = {"open": _rpc_open, "view": _rpc_view, "exec": _rpc_exec, "save": _rpc_save}


def _error(exc):
    message = "interrupted" if isinstance(exc, KeyboardInterrupt) else str(exc) or type(exc).__name__
    return {"type": type(exc).__name__, "message": message}


def _send(frame):
    data = json.dumps(frame, ensure_ascii=False, default=str) + "\n"
    if _WINDOWS:
        _proto.write(data)
        _proto.flush()
        return
    # Defer SIGINT while writing so a late interrupt cannot truncate a frame.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    try:
        _proto.write(data)
        _proto.flush()
    finally:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})


def _close(save):
    global R2, _DIRTY
    r2 = R2
    R2 = None
    if r2 is None:
        return
    try:
        if save:
            r2.cmd("Ps omp")
    finally:
        r2.quit()
        _DIRTY = False
        NS.clear()


def _handle(line):
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
                _close(save)
            except Exception as exc:
                _send({"id": req_id, "ok": False, "error": _error(exc)})
                traceback.print_exc()
                sys.exit(1)
            _send({"id": req_id, "ok": True, "result": {"closed": True, "saved": save}, "dirty": False})
            sys.exit(0)
        handler = _METHODS.get(method)
        if handler is None:
            raise ValueError("unknown method: " + str(method))
        result = handler(params)
        _send({"id": req_id, "ok": True, "result": result, "dirty": _DIRTY})
    except SystemExit:
        raise
    except BaseException as exc:
        _send({"id": req_id, "ok": False, "error": _error(exc)})


def main():
    for line in sys.stdin:
        if line.strip():
            _handle(line)
    _close(True)


if __name__ == "__main__":
    main()
