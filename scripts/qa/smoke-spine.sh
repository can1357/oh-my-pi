#!/usr/bin/env bash
# Gate P3: journal-first print, tool dispatch, CLI resume, and live-host render parity.
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${OMP_BIN:-$root/target/debug/omp}"
scratch_root="${OMP_SMOKE_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$scratch_root"
work="$(mktemp -d "$scratch_root/omp-smoke-spine.XXXXXX")"
trap 'rm -rf "$work"' EXIT

project="$work/project"
sessions="$work/sessions"
export HOME="$work/home"
export OMP_CONFIG_DIR="$work/config"
export OMP_DATA_DIR="$work/data"
export OMP_STATE_DIR="$work/state"
export OMP_CACHE_DIR="$work/cache"
mkdir -p "$project" "$sessions" "$HOME" "$OMP_CONFIG_DIR" \
	"$OMP_DATA_DIR" "$OMP_STATE_DIR" "$OMP_CACHE_DIR"
printf 'hello from fixture\n' > "$project/note.txt"
[ -n "${ANTHROPIC_API_KEY:-}" ] || { printf 'FAIL ANTHROPIC_API_KEY is unset\n' >&2; exit 1; }
auth=(--api-key "$ANTHROPIC_API_KEY")
model=anthropic/claude-sonnet-4-5
session="$sessions/spine.oms"

pong="$(cd "$project" && "$bin" print --no-ext --no-session --no-tools --project . \
	--model "$model" "${auth[@]}" 'Reply with exactly the word pong')" || exit $?
[ "$(printf '%s' "$pong" | tr -d '[:space:][:punct:]' | tr '[:upper:]' '[:lower:]')" = pong ] || {
	printf 'FAIL pong\n%s\n' "$pong" >&2
	exit 1
}
printf 'pong: %s\n' "$pong"

first="$(cd "$project" && "$bin" print --no-ext --project . \
	--session-dir "$sessions" --session "$session" \
	--model "$model" "${auth[@]}" \
	'Use the read tool to read note.txt and reply with only its contents.')" || exit $?
printf '%s\n' "$first" | grep -q 'hello from fixture' || {
	printf 'FAIL tool turn\n%s\n' "$first" >&2
	exit 1
}
[ -f "$session" ] || { printf 'FAIL no session journal at %s\n' "$session" >&2; exit 1; }
grep -q '^event: tool.call@1$' "$session" || exit 1
grep -q '^event: tool.result@1$' "$session" || exit 1
frames="$(grep -c '^event:' "$session")"
causes="$(grep -c '^by:' "$session")"
[ "$causes" -eq "$((frames - 1))" ] || {
	printf 'FAIL causal frames: %s causes for %s frames\n' "$causes" "$frames" >&2
	exit 1
}
printf 'tool: %s\n' "$first"

# Resume the journal in the actual terminal host. The helper owns a real PTY,
# drives the production debug socket, waits for the second turn to settle, and
# returns only the painted transcript rows (located from the hardware caret in
# the empty editor chrome). An 80-row viewport makes window_top=0 a literal
# gate, so no historical block can be hidden by scrolling.
live="$({ python3 - "$bin" "$project" "$sessions" "$model" "$ANTHROPIC_API_KEY" "$work/live-debug.sock" <<'PY'
import fcntl
import json
import os
import pty
import socket
import struct
import subprocess
import sys
import termios
import threading
import time

binary, project, sessions, model, api_key, debug_path = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 80, 100, 0, 0))
env = os.environ.copy()
env.update({
    "TERM": "xterm-256color",
    "NO_COLOR": "1",
    "OMP_TTY": os.ttyname(slave),
    "OMP_TUI_DEBUG": debug_path,
})
stderr_path = os.path.join(os.path.dirname(debug_path), "live-stderr.log")
stderr = open(stderr_path, "wb")
proc = subprocess.Popen([
    binary, "chat", "--no-ext", "--project", ".",
    "--session-dir", sessions, "-c", "--model", model, "--api-key", api_key,
    "What did note.txt contain? Reply with only its contents.",
], cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr)
raw = bytearray()
stop = threading.Event()

def drain():
    while not stop.is_set():
        try:
            chunk = os.read(master, 16384)
        except OSError:
            return
        if not chunk:
            return
        raw.extend(chunk)

thread = threading.Thread(target=drain, daemon=True)
thread.start()
# Complete the ordinary primary-device-attributes probe without weakening the
# real PTY path used for every subsequent paint and injected event.
try:
    os.write(master, b"\x1b[?62c")
except OSError:
    pass

def fail(message):
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=5)
    stop.set()
    stderr.flush()
    stderr.close()
    detail = open(stderr_path, "rb").read().decode("utf-8", "replace")
    raise RuntimeError(f"{message}\nstatus={proc.returncode}\nstderr={detail}\npty={bytes(raw)!r}")

deadline = time.monotonic() + 180
client = None
while time.monotonic() < deadline:
    if proc.poll() is not None:
        fail("OMP exited before its debug socket became ready")
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(debug_path)
        break
    except OSError:
        if client is not None:
            client.close()
        client = None
        time.sleep(0.02)
if client is None:
    fail("debug socket did not become ready")
wire = client.makefile("rwb", buffering=0)

def request(op, **fields):
    payload = {"op": op, **fields}
    try:
        wire.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        line = wire.readline()
        if not line:
            fail(f"debug socket closed during {op}")
        response = json.loads(line)
    except Exception as error:
        fail(f"debug {op} transport failed: {error}")
    if response.get("ok") is not True:
        fail(f"debug {op} failed: {response}")
    return response

paint = None
while time.monotonic() < deadline:
    values = request("values").get("values", {})
    text = request("text")
    joined = "\n".join(text.get("lines", []))
    if (not values.get("turn_active", True)
            and "Use the read tool to read note.txt" in joined
            and "What did note.txt contain?" in joined
            and "Read note.txt" in joined
            and joined.count("hello from fixture") >= 2):
        paint = text
        break
    if proc.poll() is not None:
        fail("OMP exited before the resumed turn settled")
    time.sleep(0.05)
if paint is None:
    fail("resumed live transcript did not settle before the deadline")
info = request("info")
if info.get("window_top") != 0:
    fail(f"live transcript scrolled unexpectedly: {info}")
height = info.get("height")
cursor = info.get("cursor")
lines = paint.get("lines", [])
if not isinstance(height, int) or height < 3 or height > len(lines):
    fail(f"invalid painted document geometry: {info}, lines={len(lines)}")
if not isinstance(cursor, list) or len(cursor) != 2 or not isinstance(cursor[0], int):
    fail(f"live host did not publish its editor caret: {info}")
prompt_row = cursor[0]
document = lines[:height]
if prompt_row < 2 or prompt_row >= len(document) or "╰─ Ask anything" not in document[prompt_row]:
    fail(f"caret did not identify the idle composer prompt: {info}, row={document[prompt_row]!r}")
# The empty composer's caret identifies its prompt row. Its status and gap are
# the preceding two rows; everything before those rows is the complete painted
# transcript, with no content-dependent row-count guess.
transcript = document[:prompt_row - 2]
request("keys", keys="ctrl+c ctrl+c")
try:
    status = proc.wait(timeout=30)
except subprocess.TimeoutExpired:
    fail("resumed OMP did not quit through injected Ctrl-C")
if status != 0:
    fail(f"resumed OMP quit with status {status}")
stop.set()
client.close()
os.close(master)
os.close(slave)
stderr.close()
for line in transcript:
    print(line.rstrip())
PY
} 2>&1)" || {
	printf 'FAIL live host capture\n%s\n' "$live" >&2
	exit 1
}

rendered="$(cd "$project" && "$bin" render --plain --width 100 "$session")" || exit $?
normalize() {
	sed -e 's/\r$//' -e 's/[[:blank:]]*$//'
}
live="$(printf '%s\n' "$live" | normalize)"
rendered="$(printf '%s\n' "$rendered" | normalize)"
[ "$rendered" = "$live" ] || {
	printf 'FAIL render differs from live PTY transcript\n--- live ---\n%s\n--- render ---\n%s\n' \
		"$live" "$rendered" >&2
	exit 1
}
printf 'resume: live PTY host completed the second turn\n'
printf 'render: matches complete live transcript blocks\n'
