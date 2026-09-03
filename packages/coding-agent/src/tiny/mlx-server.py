# MLX tiny-model worker: one process per local model, owning that model's
# socket and speaking the same JSON-lines protocol as the ONNX worker
# (`title-protocol.ts`). Started by `title-client.ts` from the mlx-lm venv;
# serves every omp process on the machine; exits on its own once idle.
#
# Requests (one object per line):
#   {"type": "ping", "id"}                        -> pong (with the launch tag)
#   {"type": "load", "id"}                        -> progress* then loaded | error
#   {"type": "chat", "id", "messages", "prefill"?, "stop"?, "maxNewTokens"}
#                                                 -> text | error
#   {"type": "shutdown", "id"}                    -> process exits
# Responses:
#   {"type": "pong", "id", "tag"}
#   {"type": "progress", "id", "event": {modelKey, status, file?, progress?, loaded?, total?, ...}}
#   {"type": "loaded", "id"}
#   {"type": "text", "id", "text"}
#   {"type": "error", "id", "error"}
#
# Weights are fetched straight from the Hub `resolve` endpoint into `--dir` so
# per-byte progress can be reported; mlx-lm then loads that directory.

import argparse
import fcntl
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
from fnmatch import fnmatch

HF_ENDPOINT = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
HF_TOKEN = os.environ.get("HF_TOKEN")
DOWNLOAD_PATTERNS = (
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "tokenizer.model",
    "special_tokens_map.json",
    "added_tokens.json",
    "chat_template.jinja",
    "chat_template.json",
    "vocab.json",
    "merges.txt",
    "*.safetensors",
    "*.safetensors.index.json",
    "*.tiktoken",
)
COMPLETE_MARKER = ".omp-complete.json"
PROGRESS_INTERVAL_S = 0.1
CHUNK_BYTES = 1 << 20
IDLE_POLL_S = 5.0


def log(message):
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


# ── Hub download ───────────────────────────────────────────────────


def _request(url):
    headers = {"User-Agent": "omp-tiny-mlx"}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    return urllib.request.Request(url, headers=headers)


def list_repo_files(repo):
    with urllib.request.urlopen(_request(f"{HF_ENDPOINT}/api/models/{repo}/tree/main?recursive=true")) as res:
        entries = json.load(res)
    files = []
    for entry in entries:
        if entry.get("type") != "file":
            continue
        name = entry["path"]
        if any(fnmatch(name, pattern) for pattern in DOWNLOAD_PATTERNS):
            files.append((name, int(entry.get("size") or 0)))
    if not any(name.endswith(".safetensors") for name, _ in files):
        raise RuntimeError(f"{repo} has no safetensors weights on the Hub")
    return files


def _is_complete(model_dir, files):
    try:
        with open(os.path.join(model_dir, COMPLETE_MARKER), encoding="utf-8") as fh:
            marker = json.load(fh)
    except (OSError, ValueError):
        return False
    if marker.get("files") != [name for name, _ in files]:
        return False
    return all(os.path.isfile(os.path.join(model_dir, name)) for name, _ in files)


def download_repo(emit, request_id, model_key, repo, model_dir):
    files = list_repo_files(repo)
    if _is_complete(model_dir, files):
        return
    total = sum(size for _, size in files)
    loaded = 0
    last_emit = 0.0

    def progress(name, force=False):
        nonlocal last_emit
        now = time.monotonic()
        if not force and now - last_emit < PROGRESS_INTERVAL_S:
            return
        last_emit = now
        emit(
            {
                "type": "progress",
                "id": request_id,
                "event": {
                    "modelKey": model_key,
                    "status": "progress",
                    "file": name,
                    "progress": (loaded / total * 100.0) if total else 0.0,
                    "loaded": loaded,
                    "total": total,
                },
            }
        )

    emit({"type": "progress", "id": request_id, "event": {"modelKey": model_key, "status": "download", "name": repo}})
    for name, size in files:
        target = os.path.join(model_dir, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if os.path.isfile(target) and os.path.getsize(target) == size:
            loaded += size
            progress(name)
            continue
        part = f"{target}.part"
        with urllib.request.urlopen(_request(f"{HF_ENDPOINT}/{repo}/resolve/main/{name}")) as res, open(part, "wb") as out:
            while True:
                chunk = res.read(CHUNK_BYTES)
                if not chunk:
                    break
                out.write(chunk)
                loaded += len(chunk)
                progress(name)
        os.replace(part, target)
        progress(name, force=True)
    with open(os.path.join(model_dir, COMPLETE_MARKER), "w", encoding="utf-8") as fh:
        json.dump({"repo": repo, "files": [name for name, _ in files]}, fh)
    emit({"type": "progress", "id": request_id, "event": {"modelKey": model_key, "status": "done", "name": repo}})


# ── Model ──────────────────────────────────────────────────────────


class Model:
    def __init__(self, model_key, repo, model_dir):
        self.model_key = model_key
        self.repo = repo
        self.model_dir = model_dir
        self.loaded = None

    def ensure(self, emit, request_id):
        if self.loaded is None:
            download_repo(emit, request_id, self.model_key, self.repo, self.model_dir)
            from mlx_lm import load

            started = time.monotonic()
            self.loaded = load(self.model_dir)
            log(f"loaded {self.repo} in {time.monotonic() - started:.1f}s")
        return self.loaded

    def send_ready(self, emit, request_id):
        emit(
            {
                "type": "progress",
                "id": request_id,
                "event": {
                    "modelKey": self.model_key,
                    "status": "ready",
                    "task": "text-generation",
                    "model": self.repo,
                },
            }
        )

    def chat(self, emit, req):
        model, tokenizer = self.ensure(emit, req["id"])
        from mlx_lm import stream_generate

        prompt = tokenizer.apply_chat_template(
            req["messages"],
            add_generation_prompt=True,
            tokenize=False,
            enable_thinking=False,
        )
        prefill = req.get("prefill")
        if prefill:
            prompt += prefill
        stop = req.get("stop")
        text = ""
        for response in stream_generate(model, tokenizer, prompt, max_tokens=int(req["maxNewTokens"])):
            text += response.text
            if stop and stop in text:
                break
        import mlx.core as mx

        mx.clear_cache()
        return text


# ── Socket server ──────────────────────────────────────────────────


class Server:
    """Owns one endpoint; requests from every connection are serialized through one lock."""

    def __init__(self, model, tag, idle_seconds):
        self.model = model
        self.tag = tag
        self.idle_seconds = idle_seconds
        self.lock = threading.Lock()
        self.activity_lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.in_flight = 0
        self.socket_path = None

    def _touch(self, delta):
        with self.activity_lock:
            self.in_flight += delta
            self.last_activity = time.monotonic()

    def _exit(self, reason):
        log(f"{reason}; exiting")
        try:
            os.unlink(self.socket_path)
        except OSError:
            pass
        os._exit(0)

    def _idle_watchdog(self):
        while True:
            time.sleep(IDLE_POLL_S)
            with self.activity_lock:
                idle = self.in_flight == 0 and time.monotonic() - self.last_activity >= self.idle_seconds
            if idle:
                self._exit(f"idle for {self.idle_seconds:.0f}s")

    def handle(self, emit, req):
        kind = req.get("type")
        request_id = req.get("id")
        if kind == "ping":
            emit({"type": "pong", "id": request_id, "tag": self.tag})
            return
        if kind == "shutdown":
            self._exit("shutdown requested")
        if kind not in ("load", "chat"):
            raise ValueError(f"unknown request type: {kind!r}")
        self._touch(+1)
        try:
            with self.lock:
                if kind == "load":
                    self.model.ensure(emit, request_id)
                    self.model.send_ready(emit, request_id)
                    result = {"type": "loaded", "id": request_id}
                else:
                    result = {"type": "text", "id": request_id, "text": self.model.chat(emit, req)}
        finally:
            self._touch(-1)
        emit(result)

    def serve_connection(self, conn):
        write_lock = threading.Lock()

        def emit(obj):
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
            with write_lock:
                conn.sendall(data)

        try:
            with conn, conn.makefile("rb") as reader:
                for raw in reader:
                    line = raw.strip()
                    if not line:
                        continue
                    req = json.loads(line)
                    try:
                        self.handle(emit, req)
                    except Exception:  # noqa: BLE001 - every failure is reported to the client
                        emit({"type": "error", "id": req.get("id"), "error": traceback.format_exc()})
        except (BrokenPipeError, ConnectionResetError, OSError):
            # Client went away mid-request; nothing left to report to.
            pass

    def _bind(self, socket_path):
        """Clear a stale socket file (dead predecessor) but defer to a live one (a concurrent spawn that won)."""
        # Same lock file `worker-server.ts` takes (`withFileLock` appends `.lock`).
        lock_fd = os.open(f"{socket_path}.bind.lock", os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            if os.path.exists(socket_path):
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    probe.connect(socket_path)
                    probe.close()
                    raise RuntimeError(f"tiny worker already listening on {socket_path}")
                except (ConnectionRefusedError, FileNotFoundError):
                    os.unlink(socket_path)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(socket_path)
            os.chmod(socket_path, 0o600)
            server.listen(16)
            return server
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    def serve(self, socket_path):
        self.socket_path = socket_path
        server = self._bind(socket_path)
        threading.Thread(target=self._idle_watchdog, daemon=True).start()
        sys.stdout.write(f"omp tiny worker listening on {socket_path}\n")
        sys.stdout.flush()
        while True:
            conn, _ = server.accept()
            threading.Thread(target=self.serve_connection, args=(conn,), daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--tag", required=True, help="launch identity echoed by ping so stale workers get replaced")
    parser.add_argument("--model-key", required=True)
    parser.add_argument("--repo", required=True, help="Hub repo holding the MLX weights")
    parser.add_argument("--dir", required=True, help="local weights directory")
    parser.add_argument("--idle-seconds", type=float, required=True, help="exit after this long without a request")
    args = parser.parse_args()
    Server(Model(args.model_key, args.repo, args.dir), args.tag, args.idle_seconds).serve(args.socket)


if __name__ == "__main__":
    main()
