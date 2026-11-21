# MLX tiny-model worker: one process per local model, a child of the omp
# daemon's `infer` module (launched from the mlx-lm venv with the command
# `title-client.ts` hands the daemon). Speaks the same JSON-lines protocol as
# the ONNX worker (`title-protocol.ts`) over stdin/stdout, one request at a
# time; logs go to stderr. Exits when stdin closes.
#
# Requests (one object per line on stdin):
#   {"type": "ping", "id"}                        -> pong
#   {"type": "load", "id"}                        -> progress* then loaded | error
#   {"type": "chat", "id", "messages", "prefill"?, "stop"?, "maxNewTokens"}
#                                                 -> text | error
# Responses (one object per line on stdout):
#   {"type": "pong", "id"}
#   {"type": "progress", "id", "event": {modelKey, status, file?, progress?, loaded?, total?, ...}}
#   {"type": "loaded", "id"}
#   {"type": "text", "id", "text"}
#   {"type": "error", "id", "error"}
#
# Weights are fetched straight from the Hub `resolve` endpoint into `--dir` so
# per-byte progress can be reported; mlx-lm then loads that directory.

import argparse
import json
import os
import sys
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
                    # Running total across the repo, tagged with the current file.
                    "status": "progress_total",
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


# ── Stdio loop ─────────────────────────────────────────────────────


def _claim_stdout():
    """Keep fd 1 for protocol lines: library prints, warnings, and native
    writes to fd 1 land on stderr; replies go to a private dup of the pipe."""
    sys.stdout.flush()
    channel = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return channel


PROTOCOL_OUT = _claim_stdout()


def emit(obj):
    PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    PROTOCOL_OUT.flush()


def handle(model, req):
    kind = req.get("type")
    request_id = req.get("id")
    if kind == "ping":
        emit({"type": "pong", "id": request_id})
        return
    if kind == "load":
        model.ensure(emit, request_id)
        model.send_ready(emit, request_id)
        emit({"type": "loaded", "id": request_id})
        return
    if kind == "chat":
        emit({"type": "text", "id": request_id, "text": model.chat(emit, req)})
        return
    raise ValueError(f"unknown request type: {kind!r}")


def serve(model):
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            log(f"malformed request line: {line[:200]!r}")
            continue
        try:
            handle(model, req)
        except Exception:  # noqa: BLE001 - every failure is reported to the client
            emit({"type": "error", "id": req.get("id"), "error": traceback.format_exc()})
    log("stdin closed; exiting")
    os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-key", required=True)
    parser.add_argument("--repo", required=True, help="Hub repo holding the MLX weights")
    parser.add_argument("--dir", required=True, help="local weights directory")
    args = parser.parse_args()
    serve(Model(args.model_key, args.repo, args.dir))


if __name__ == "__main__":
    main()
