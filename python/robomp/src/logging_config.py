"""Logging configuration for roboomp — JSON to file, pretty ANSI to stdout."""

from __future__ import annotations

import json
import logging
import logging.handlers
import sys
import time
from pathlib import Path
from typing import Any

_RESERVED = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
        "taskName",
    }
)

# ── ANSI helpers ──────────────────────────────────────────────────────────────

_RST = "\033[0m"
_DIM = "\033[2m"

_LEVEL_COLOR: dict[str, str] = {
    "DEBUG": "\033[34m",  # blue
    "INFO": "\033[32m",  # green
    "WARNING": "\033[33m",  # yellow
    "ERROR": "\033[31m",  # red
    "CRITICAL": "\033[1;31m",  # bold red
}

# Fields that uvicorn injects and that are not useful in pretty output.
_PRETTY_SKIP = _RESERVED | {"color_message", "color_levelname"}


class PrettyFormatter(logging.Formatter):
    """Human-readable single-line formatter with ANSI colour.

    Output shape:
        HH:MM:SS  LEVEL     logger.name           message  key=val key2=val2
    """

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        ts = time.strftime("%H:%M:%S", time.gmtime(record.created))
        color = _LEVEL_COLOR.get(record.levelname, "")
        level = f"{color}{record.levelname:<8}{_RST}"
        # Strip the package prefix to save width; keeps uvicorn.*, httpx, etc.
        name = record.name.removeprefix("robomp.")
        logger_col = f"{_DIM}{name:<22}{_RST}"
        msg = record.getMessage()

        extras: list[str] = []
        for key, val in record.__dict__.items():
            if key in _PRETTY_SKIP or key.startswith("_"):
                continue
            extras.append(f"{key}={val}")

        line = f"{_DIM}{ts}{_RST}  {level}  {logger_col}  {msg}"
        if extras:
            line += f"  {_DIM}{' '.join(extras)}{_RST}"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        if record.stack_info:
            line += "\n" + self.formatStack(record.stack_info)
        return line


# ── JSON formatter (kept for file handler) ────────────────────────────────────


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            try:
                json.dumps(value, default=str)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        return json.dumps(payload, default=str)


# ── Setup ─────────────────────────────────────────────────────────────────────

# Dashboard polls these endpoints every couple seconds; mute them in access logs.
_ACCESS_MUTE_PATHS = ("/api/status", "/api/logs", "/healthz", "/readyz")


class _MuteDashboardPolling(logging.Filter):
    """Drop uvicorn.access lines for high-frequency dashboard polling."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        args = record.args
        # uvicorn.access format: '%s - "%s %s HTTP/%s" %d'
        # args = (client_addr, method, full_path, http_version, status_code)
        if isinstance(args, tuple) and len(args) >= 3:
            method, path = args[1], args[2]
            if method == "GET" and isinstance(path, str):
                base = path.split("?", 1)[0]
                if base in _ACCESS_MUTE_PATHS:
                    return False
        return True


_INITIALIZED = False


def configure_logging(log_dir: Path | None = None, level: int = logging.INFO) -> None:
    """Idempotently configure logging: pretty ANSI to stdout, JSON to file."""
    global _INITIALIZED
    if _INITIALIZED:
        return
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(PrettyFormatter())
    root.addHandler(stream)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_dir / "robomp.log.jsonl",
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(JsonFormatter())
        root.addHandler(file_handler)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").addFilter(_MuteDashboardPolling())
    _INITIALIZED = True


def reset_logging_for_tests() -> None:
    global _INITIALIZED
    _INITIALIZED = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
