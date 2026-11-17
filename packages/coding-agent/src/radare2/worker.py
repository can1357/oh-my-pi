"""omp radare2 worker: drives one r2pipe session over NDJSON stdin/stdout.

Request:  {"id": int, "method": str, "params": dict}
Response: {"id", "ok": true, "result", "dirty"} | {"id", "ok": false, "error": {"type", "message"}}
"""

import json
import os
import signal
import sys
import traceback
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
NS = {}
_WINDOWS = sys.platform == "win32"


def _program():
    if R2 is None:
        raise RuntimeError("no radare2 project is open in this worker")
    return R2


def _rpc_open(params):
    global R2, _DATABASE_PATH, _DIRTY
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
        r2 = r2pipe.open("-", flags=["-p", "omp"])
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
    })
    info_list = r2.cmdj("iIj") or []
    info = info_list[0] if isinstance(info_list, list) and info_list else info_list
    if not isinstance(info, dict):
        info = {}
    bininfo = info.get("bin") if isinstance(info.get("bin"), dict) else {}
    return {
        "idb": marker,
        "module": str(info.get("name") or os.path.basename(binary)),
        "format": str(bininfo.get("class") or bininfo.get("bintype") or "unknown"),
        "arch": str(bininfo.get("arch") or "unknown"),
        "bitness": int(bininfo.get("bits") or 0),
    }


def _rpc_save(params):
    global _DIRTY
    _program().cmd("Ps omp")
    Path(_DATABASE_PATH).touch()
    _DIRTY = False
    return {"idb": _DATABASE_PATH}


_METHODS = {"open": _rpc_open, "save": _rpc_save}


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
