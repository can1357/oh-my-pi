"""Status dashboard helpers: log tail + the static SPA served at `/`.

The HTML/JS/CSS live under `src/static/`, produced by the Vite build in
`web/`. This module just locates the bundle, substitutes the per-instance
config sentinel, and exposes a small API to the FastAPI app.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

# Tail at most this many bytes from the end of the log file. Caps work for any
# `limit`, even pathologically large ones, on a multi-MB rotating file.
_TAIL_MAX_BYTES = 2 * 1024 * 1024

# Sentinel literally embedded in the built `index.html`; replaced per-request
# with a JSON config blob so the SPA can pick up the replay token.
_CONFIG_SENTINEL = "__ROBOMP_CONFIG__"

_STATIC_DIR = Path(__file__).resolve().parent / "static"
_INDEX_PATH = _STATIC_DIR / "index.html"


def tail_jsonl(path: Path, *, limit: int) -> list[dict[str, Any]]:
    """Return up to `limit` JSON log records from the tail of `path` (oldest first).

    Lines that fail to parse are returned as `{"level": "RAW", "msg": <line>}`
    so a malformed final line never blanks the whole view.
    """
    if limit <= 0 or not path.exists():
        return []

    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size == 0:
        return []

    read_size = min(size, _TAIL_MAX_BYTES)
    with path.open("rb") as fh:
        fh.seek(size - read_size)
        chunk = fh.read(read_size)

    # If we started mid-line, drop the partial leading line.
    if read_size < size:
        nl = chunk.find(b"\n")
        if nl == -1:
            return []
        chunk = chunk[nl + 1 :]

    lines = chunk.splitlines()
    out: list[dict[str, Any]] = []
    for raw in lines[-limit:]:
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out.append(obj)
                continue
        except json.JSONDecodeError:
            pass
        out.append({"level": "RAW", "logger": "raw", "msg": line.decode("utf-8", errors="replace")})
    return out


class DashboardBundleMissing(RuntimeError):
    """Raised when the built frontend bundle is unavailable.

    The dev workflow is `bun run web:build` (one-shot Bun + Vite build); the
    Docker image bakes the bundle in via the `web-builder` stage. Tests use a
    placeholder `index.html` written into the static dir by `conftest.py`,
    so this never fires in CI.
    """


def static_dir() -> Path:
    """Filesystem path the FastAPI app mounts at `/static`.

    Creates the directory lazily so a fresh checkout (or a runtime container
    that hasn't shipped the bundle yet) can still construct the app —
    `_load_index_template()` raises `DashboardBundleMissing` separately when
    the `index.html` itself is missing. Without this mkdir,
    `StaticFiles(directory=...)` would raise at app construction time and
    block every other route.
    """
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)
    return _STATIC_DIR


@cache
def _load_index_template() -> str:
    try:
        text = _INDEX_PATH.read_text(encoding="utf-8")
    except FileNotFoundError as exc:  # pragma: no cover — repo ships the stub
        raise DashboardBundleMissing(f"frontend bundle missing at {_INDEX_PATH}; run `bun run web:build`") from exc
    if _CONFIG_SENTINEL not in text:
        raise DashboardBundleMissing(
            f"frontend bundle at {_INDEX_PATH} is missing the {_CONFIG_SENTINEL} sentinel; "
            "rebuild with `bun run web:build`"
        )
    return text


def reset_index_cache() -> None:
    """Drop the cached template. Called by tests that swap the static dir."""
    _load_index_template.cache_clear()


def render_index(replay_token: str | None) -> str:
    """Render the dashboard HTML with the server's replay token baked in.

    The token lands inside a `<script type="application/json">` block that the
    page parses at startup and attaches to every privileged fetch. The user
    never sees or types it; the only credential to manage is the env var on
    the server itself.
    """
    config = {
        "replayEnabled": bool(replay_token),
        "replayToken": replay_token or "",
    }
    # `</` would otherwise let an attacker-controlled token break out of the
    # script element; escape it the standard way.
    payload = json.dumps(config, separators=(",", ":")).replace("</", "<\\/")
    return _load_index_template().replace(_CONFIG_SENTINEL, payload)


__all__ = [
    "DashboardBundleMissing",
    "render_index",
    "reset_index_cache",
    "static_dir",
    "tail_jsonl",
]
