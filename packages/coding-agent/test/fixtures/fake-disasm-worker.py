"""Fake disassembler worker for the daemon `disasm` module tests (test/daemon/disasm-module.test.ts).

Speaks the worker socket protocol `src/disasm/supervisor.ts` drives: listens on `--socket PATH`
(or `--port-file PATH`), requires `{"token": $OMP_DISASM_WORKER_TOKEN}` as the first line of every
connection (a newer connection replaces the previous one, as after a daemon restart), then answers
NDJSON `{"id", "method", "params"}` with `{"id", "ok": true, "result", "dirty"}` or
`{"id", "ok": false, "error": {"type", "message"}}`.

Requests run one at a time on the main thread so SIGINT interrupts the running one. Every
observable step is appended as one JSON line to `$FAKE_DISASM_JOURNAL`:
  start / open / save / close {save} / recv {id, method, tag} (reader thread, on arrival) /
  done {id, tag} / interrupted {id, tag}
`exec` params: `sleep` (seconds), `tag`. Without a daemon connection for `$FAKE_DISASM_ORPHAN_S`
(default 60) seconds the worker exits, so a test that dies early never leaks it for long.
"""

import json
import os
import queue
import signal
import socket
import sys
import threading
import time

TOKEN = os.environ.pop("OMP_DISASM_WORKER_TOKEN", "")
JOURNAL = os.environ.get("FAKE_DISASM_JOURNAL", "")
ORPHAN_S = float(os.environ.get("FAKE_DISASM_ORPHAN_S", "60"))

journal_lock = threading.Lock()
conn_lock = threading.Lock()
conn = None
disconnected_at = time.monotonic()
requests = queue.Queue()
state = {"opened": False, "idb": "", "dirty": False}
INFO = {"module": "fake.bin", "format": "ELF64", "arch": "metapc", "bitness": 64}


def record(event, **fields):
    if not JOURNAL:
        return
    line = json.dumps({"event": event, "pid": os.getpid(), **fields}) + "\n"
    with journal_lock:
        with open(JOURNAL, "a", encoding="utf-8") as f:
            f.write(line)


def arg(name):
    argv = sys.argv[1:]
    for i in range(len(argv) - 1):
        if argv[i] == name:
            return argv[i + 1]
    return None


def listen():
    path = arg("--socket")
    if path is not None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(path)
        sock.listen(4)
        return sock
    port_file = arg("--port-file")
    if port_file is not None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(4)
        with open(port_file + ".tmp", "w") as f:
            f.write(str(sock.getsockname()[1]))
        os.replace(port_file + ".tmp", port_file)
        return sock
    raise SystemExit("usage: fake-disasm-worker.py --socket PATH | --port-file PATH")


def send(frame):
    data = (json.dumps(frame) + "\n").encode("utf-8")
    with conn_lock:
        current = conn
    if current is None:
        return
    # A late SIGINT must not truncate a frame.
    if hasattr(signal, "pthread_sigmask"):
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    try:
        current.sendall(data)
    except OSError:
        pass
    finally:
        if hasattr(signal, "pthread_sigmask"):
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})


def read_requests(sock):
    global conn, disconnected_at
    authenticated = False
    try:
        for line in sock.makefile("r", encoding="utf-8", newline="\n"):
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            if not authenticated:
                if not isinstance(frame, dict) or frame.get("token") != TOKEN:
                    break
                authenticated = True
                with conn_lock:
                    previous, conn = conn, sock
                if previous is not None:
                    try:
                        previous.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                continue
            if not isinstance(frame, dict) or "interrupt" in frame:
                continue
            params = frame.get("params") or {}
            record("recv", id=frame.get("id"), method=frame.get("method"), tag=params.get("tag"))
            requests.put(frame)
    except OSError:
        pass
    with conn_lock:
        if conn is sock:
            conn = None
            disconnected_at = time.monotonic()
    sock.close()


def accept(listener):
    while True:
        try:
            sock, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=read_requests, args=(sock,), daemon=True).start()


def reply(req_id, result):
    send({"id": req_id, "ok": True, "result": result, "dirty": state["dirty"]})


def fail(req_id, error_type, message):
    send({"id": req_id, "ok": False, "error": {"type": error_type, "message": message}})


def handle(frame):
    req_id = frame.get("id")
    method = frame.get("method")
    params = frame.get("params") or {}
    if method == "open":
        state["opened"] = True
        state["idb"] = params.get("path", "")
        record("open", path=state["idb"])
        reply(req_id, {"idb": state["idb"], **INFO})
    elif method == "status":
        reply(req_id, {"open": True, "idb": state["idb"], **INFO} if state["opened"] else {"open": False})
    elif method == "exec":
        tag = params.get("tag")
        try:
            time.sleep(float(params.get("sleep", 0)))
        except KeyboardInterrupt:
            record("interrupted", id=req_id, tag=tag)
            fail(req_id, "KeyboardInterrupt", "interrupted")
            return
        record("done", id=req_id, tag=tag)
        reply(req_id, {"pid": os.getpid(), "tag": tag})
    elif method == "save":
        state["dirty"] = False
        record("save")
        reply(req_id, {"saved": True})
    elif method == "close":
        save = bool(params.get("save"))
        record("close", save=save)
        send({"id": req_id, "ok": True, "result": {"closed": True, "saved": save}})
        sys.exit(0)
    elif method in ("rename", "comment", "set_type", "make_function"):
        state["dirty"] = True
        reply(req_id, {"changed": True})
    else:
        fail(req_id, "ValueError", f"unknown method: {method}")


def main():
    signal.signal(signal.SIGINT, signal.default_int_handler)
    listener = listen()
    record("start")
    # Socket threads inherit a blocked SIGINT, so the supervisor's interrupt lands on the main
    # thread and breaks the running request's sleep.
    if hasattr(signal, "pthread_sigmask"):
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    threading.Thread(target=accept, args=(listener,), daemon=True).start()
    if hasattr(signal, "pthread_sigmask"):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})
    while True:
        try:
            try:
                frame = requests.get(timeout=0.2)
            except queue.Empty:
                with conn_lock:
                    orphaned = conn is None and time.monotonic() - disconnected_at > ORPHAN_S
                if orphaned:
                    record("orphaned")
                    sys.exit(0)
                continue
            handle(frame)
        except KeyboardInterrupt:
            # An interrupt that arrived between requests; nothing is running.
            continue


if __name__ == "__main__":
    main()
