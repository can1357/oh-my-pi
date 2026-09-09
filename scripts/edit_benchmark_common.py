#!/usr/bin/env python3
"""
Shared helpers for edit benchmark scripts.
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python/omp-rpc/src"))

from omp_rpc import (
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    RpcClient,
    ToolExecutionStartEvent,
)  # noqa: E402

MODELS = [
    "openrouter/moonshotai/kimi-k2.5",
    "openrouter/anthropic/claude-haiku-4.5",
    "openrouter/google/gemini-3.1-flash-lite-preview",
    "openrouter/z-ai/glm-4.7-20251222:nitro",
    # "openrouter/anthropic/claude-sonnet-4.6",
    # "openrouter/google/gemini-3-flash-preview",
    # "openrouter/z-ai/glm-5-turbo",
    # "openrouter/minimax/minimax-m2.7",
]

INITIAL_CONTENT = """\
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub max_connections: usize,
    pub timeout_ms: u64,
}

impl Config {
    pub fn new(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
            max_connections: 100,
            timeout_ms: 5000,
        }
    }

    pub fn is_local(&self) -> bool {
        self.host == "localhost" || self.host == "127.0.0.1"
    }
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Active,
    Inactive,
    Error(String),
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Status::Active => write!(f, "active"),
            Status::Inactive => write!(f, "inactive"),
            Status::Error(msg) => write!(f, "error: {}", msg),
        }
    }
}

pub struct ConnectionPool {
    config: Config,
    connections: Vec<Connection>,
    status: Status,
}

struct Connection {
    id: u64,
    active: bool,
}

impl ConnectionPool {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            connections: Vec::new(),
            status: Status::Inactive,
        }
    }

    pub fn connect(&mut self) -> Result<(), String> {
        if self.connections.len() >= self.config.max_connections {
            return Err("connection pool is full".to_string());
        }

        let id = self.connections.len() as u64;
        self.connections.push(Connection { id, active: true });
        self.status = Status::Active;
        Ok(())
    }

    pub fn disconnect(&mut self, id: u64) -> Result<(), String> {
        let conn = self
            .connections
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("connection {} not found", id))?;
        conn.active = false;

        if self.connections.iter().all(|c| !c.active) {
            self.status = Status::Inactive;
        }
        Ok(())
    }

    pub fn active_count(&self) -> usize {
        self.connections.iter().filter(|c| c.active).count()
    }

    pub fn status(&self) -> &Status {
        &self.status
    }
}

pub fn parse_address(addr: &str) -> Result<(String, u16), String> {
    let parts: Vec<&str> = addr.split(':').collect();
    if parts.len() != 2 {
        return Err("invalid address format".to_string());
    }
    let host = parts[0].to_string();
    let port = parts[1]
        .parse::<u16>()
        .map_err(|e| format!("invalid port: {}", e))?;
    Ok((host, port))
}

pub fn create_pool_from_address(addr: &str) -> Result<ConnectionPool, String> {
    let (host, port) = parse_address(addr)?;
    let config = Config::new(&host, port);
    Ok(ConnectionPool::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = Config::new("localhost", 8080);
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 8080);
        assert_eq!(config.max_connections, 100);
    }

    #[test]
    fn test_config_is_local() {
        let local = Config::new("localhost", 8080);
        assert!(local.is_local());

        let remote = Config::new("example.com", 443);
        assert!(!remote.is_local());
    }

    #[test]
    fn test_connection_pool() {
        let config = Config::new("localhost", 5432);
        let mut pool = ConnectionPool::new(config);
        assert_eq!(pool.active_count(), 0);

        pool.connect().unwrap();
        assert_eq!(pool.active_count(), 1);
        assert_eq!(pool.status(), &Status::Active);

        pool.disconnect(0).unwrap();
        assert_eq!(pool.active_count(), 0);
        assert_eq!(pool.status(), &Status::Inactive);
    }

    #[test]
    fn test_parse_address() {
        let (host, port) = parse_address("localhost:8080").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, 8080);

        assert!(parse_address("invalid").is_err());
    }
}
"""

EXPECTED_CONTENT = """\
use std::collections::HashMap;
use std::fmt;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub max_connections: usize,
    pub timeout_ms: u64,
    pub retry_attempts: u32,
}

impl Config {
    pub fn new(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
            max_connections: 100,
            timeout_ms: 5000,
            retry_attempts: 3,
        }
    }

    pub fn with_max_connections(mut self, max: usize) -> Self {
        self.max_connections = max;
        self
    }

    pub fn is_local(&self) -> bool {
        self.host == "localhost" || self.host == "127.0.0.1"
    }
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{} (max: {})", self.host, self.port, self.max_connections)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Active,
    Inactive,
    Draining,
    Error(String),
}

impl Status {
    pub fn is_available(&self) -> bool {
        matches!(self, Status::Active)
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Status::Active => write!(f, "active"),
            Status::Inactive => write!(f, "inactive"),
            Status::Draining => write!(f, "draining"),
            Status::Error(msg) => write!(f, "error: {}", msg),
        }
    }
}

pub struct ConnectionPool {
    config: Config,
    connections: Vec<Connection>,
    status: Status,
    stats: PoolStats,
}

struct Connection {
    id: u64,
    active: bool,
    created_at: Instant,
}

#[derive(Default)]
struct PoolStats {
    total_connections: u64,
    failed_connections: u64,
}

impl ConnectionPool {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            connections: Vec::new(),
            status: Status::Inactive,
            stats: PoolStats::default(),
        }
    }

    pub fn connect(&mut self) -> Result<u64, String> {
        if self.connections.len() >= self.config.max_connections {
            self.stats.failed_connections += 1;
            return Err("connection pool is full".to_string());
        }

        let id = self.stats.total_connections;
        self.stats.total_connections += 1;
        self.connections.push(Connection {
            id,
            active: true,
            created_at: Instant::now(),
        });
        self.status = Status::Active;
        Ok(id)
    }

    pub fn disconnect(&mut self, id: u64) -> Result<(), String> {
        let conn = self
            .connections
            .iter_mut()
            .find(|c| c.id == id && c.active)
            .ok_or_else(|| format!("active connection {} not found", id))?;
        conn.active = false;

        if self.connections.iter().all(|c| !c.active) {
            self.status = Status::Inactive;
        }
        Ok(())
    }

    pub fn drain(&mut self) {
        self.status = Status::Draining;
        for conn in &mut self.connections {
            conn.active = false;
        }
        self.status = Status::Inactive;
    }

    pub fn active_count(&self) -> usize {
        self.connections.iter().filter(|c| c.active).count()
    }

    pub fn total_created(&self) -> u64 {
        self.stats.total_connections
    }

    pub fn status(&self) -> &Status {
        &self.status
    }
}

pub fn parse_address(addr: &str) -> Result<(String, u16), String> {
    let parts: Vec<&str> = addr.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("invalid address format: {}", addr));
    }
    let host = parts[0].to_string();
    if host.is_empty() {
        return Err("host cannot be empty".to_string());
    }
    let port = parts[1]
        .parse::<u16>()
        .map_err(|e| format!("invalid port: {}", e))?;
    Ok((host, port))
}

pub fn create_pool_from_address(addr: &str) -> Result<ConnectionPool, String> {
    let (host, port) = parse_address(addr)?;
    let config = Config::new(&host, port);
    Ok(ConnectionPool::new(config))
}

pub fn create_pool_with_options(
    addr: &str,
    max_connections: usize,
) -> Result<ConnectionPool, String> {
    let (host, port) = parse_address(addr)?;
    let config = Config::new(&host, port).with_max_connections(max_connections);
    Ok(ConnectionPool::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = Config::new("localhost", 8080);
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 8080);
        assert_eq!(config.max_connections, 100);
        assert_eq!(config.retry_attempts, 3);
    }

    #[test]
    fn test_config_builder() {
        let config = Config::new("localhost", 8080).with_max_connections(50);
        assert_eq!(config.max_connections, 50);
    }

    #[test]
    fn test_config_is_local() {
        let local = Config::new("localhost", 8080);
        assert!(local.is_local());

        let remote = Config::new("example.com", 443);
        assert!(!remote.is_local());
    }

    #[test]
    fn test_connection_pool() {
        let config = Config::new("localhost", 5432);
        let mut pool = ConnectionPool::new(config);
        assert_eq!(pool.active_count(), 0);
        assert_eq!(pool.total_created(), 0);

        let id = pool.connect().unwrap();
        assert_eq!(pool.active_count(), 1);
        assert_eq!(pool.total_created(), 1);
        assert_eq!(pool.status(), &Status::Active);

        pool.disconnect(id).unwrap();
        assert_eq!(pool.active_count(), 0);
        assert_eq!(pool.status(), &Status::Inactive);
    }

    #[test]
    fn test_pool_drain() {
        let config = Config::new("localhost", 5432);
        let mut pool = ConnectionPool::new(config);
        pool.connect().unwrap();
        pool.connect().unwrap();
        assert_eq!(pool.active_count(), 2);

        pool.drain();
        assert_eq!(pool.active_count(), 0);
        assert_eq!(pool.status(), &Status::Inactive);
    }

    #[test]
    fn test_parse_address() {
        let (host, port) = parse_address("localhost:8080").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, 8080);

        assert!(parse_address("invalid").is_err());
        assert!(parse_address(":8080").is_err());
    }

    #[test]
    fn test_status_is_available() {
        assert!(Status::Active.is_available());
        assert!(!Status::Inactive.is_available());
        assert!(!Status::Draining.is_available());
    }
}
"""


def _compute_edit_diff() -> str:
    initial_lines = INITIAL_CONTENT.splitlines(keepends=True)
    expected_lines = EXPECTED_CONTENT.splitlines(keepends=True)
    diff = difflib.unified_diff(initial_lines, expected_lines, n=3)
    # Skip the --- and +++ header lines, keep only @@ hunks
    diff_lines = list(diff)
    return "".join(diff_lines[2:]) if len(diff_lines) > 2 else ""


EDIT_DIFF = _compute_edit_diff()

FEEDBACK_PROMPT = """\
STOP. The editing task is complete. Do NOT make any more edits or tool calls.

This is a survey. Answer these 6 questions about your experience using the editing tool (2-3 sentences each):

1. Tool input schema: Was the input schema intuitive? What confused you?
2. Tool description: Was the description clear enough? What was missing?
3. Tool behaviour: What would make the tool easier to use?
4. Tool results & errors: Were error messages helpful? What could improve?
5. Bugs: Did anything behave unexpectedly?
6. Other thoughts: Anything else?
"""

DEFAULT_MAX_TURNS = 5
MAX_TOOL_CALLS_PER_PROMPT = 6
_PRINT_LOCK = threading.Lock()


@dataclass(frozen=True)
class BenchmarkSpec:
    description: str
    workspace_prefix: str
    tools: tuple[str, ...]
    env: dict[str, str]
    initial_prompt: str
    retry_instruction: str


@dataclass
class BenchmarkResult:
    model: str
    success: bool
    turns_used: int
    prompt_attempts: int
    edit_calls: int
    token_input: int
    token_output: int
    feedback: str
    error: str | None = None


class VerbosePrinter:
    def __init__(self, model: str):
        self._label = model.removeprefix("openrouter/")
        self._open_kind: str | None = None
        self._seen_block_lengths: dict[tuple[str, int], int] = {}

    def _prefix(self, kind: str) -> str:
        return f"[{self._label}] {kind}> "

    def flush(self) -> None:
        with _PRINT_LOCK:
            if self._open_kind is None:
                return
            sys.stderr.write("\n")
            sys.stderr.flush()
            self._open_kind = None

    def emit_delta(
        self, kind: str, delta: str, content_index: int | None = None
    ) -> None:
        if not delta:
            return

        if content_index is not None:
            key = (kind, content_index)
            self._seen_block_lengths[key] = self._seen_block_lengths.get(key, 0) + len(
                delta
            )

        with _PRINT_LOCK:
            if self._open_kind != kind:
                if self._open_kind is not None:
                    sys.stderr.write("\n")
                sys.stderr.write(self._prefix(kind))
                self._open_kind = kind

            parts = delta.splitlines(keepends=True)
            for index, part in enumerate(parts):
                if index > 0:
                    sys.stderr.write(self._prefix(kind))
                sys.stderr.write(part)

            if delta.endswith("\n"):
                self._open_kind = None

            sys.stderr.flush()

    def emit_tool_call(self, tool_name: str, args: Any) -> None:
        rendered_args = json.dumps(
            args, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        with _PRINT_LOCK:
            if self._open_kind is not None:
                sys.stderr.write("\n")
                self._open_kind = None
            sys.stderr.write(f"{self._prefix('tool')}{tool_name} {rendered_args}\n")
            sys.stderr.flush()

    def reset_message(self) -> None:
        self.flush()
        self._seen_block_lengths.clear()

    def emit_missing_from_message(self, message: dict[str, Any]) -> None:
        content = message.get("content")
        if not isinstance(content, list):
            return

        for content_index, block in enumerate(content):
            if not isinstance(block, dict):
                continue

            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                kind = "text"
            elif block_type == "thinking":
                text = block.get("thinking")
                kind = "thinking"
            else:
                continue

            if not isinstance(text, str) or not text:
                continue

            key = (kind, content_index)
            seen = self._seen_block_lengths.get(key, 0)
            if seen < len(text):
                self.emit_delta(kind, text[seen:], content_index)

    def emit_redacted_thinking_notice(self, message: dict[str, Any]) -> None:
        content = message.get("content")
        if not isinstance(content, list):
            return

        has_redacted = any(
            isinstance(block, dict) and block.get("type") == "redactedThinking"
            for block in content
        )
        if not has_redacted:
            return

        with _PRINT_LOCK:
            if self._open_kind is not None:
                sys.stderr.write("\n")
                self._open_kind = None
            sys.stderr.write(f"{self._prefix('thinking')}[redacted by provider]\n")
            sys.stderr.flush()


def resolve_repo_omp_bin() -> str | None:
    cli_path = REPO_ROOT / "packages/coding-agent" / "src/cli.ts"
    if not cli_path.exists():
        return None
    return str(cli_path)


def resolve_omp_bin(raw: str | None) -> str:
    if raw:
        return raw
    repo_bin = resolve_repo_omp_bin()
    if repo_bin:
        return repo_bin
    found = shutil.which("omp")
    if not found:
        raise SystemExit(
            "Could not find `omp` on PATH and could not resolve the repo CLI. Set --omp-bin or OMP_BIN."
        )
    return found


def build_retry_prompt(spec: BenchmarkSpec, current_content: str) -> str:
    return (
        "Previous attempt did not produce the expected result. "
        "The file has been reset to its original state — start fresh.\n\n"
        f"Current content:\n```\n{current_content}```\n\n"
        f"Expected:\n```\n{EXPECTED_CONTENT}```\n\n"
        f"{spec.retry_instruction}"
    )


def install_verbose_logging(
    client: RpcClient,
    model: str,
    mode: str | None,
    thinking: str | None,
) -> Callable[[], None] | None:
    if mode is None:
        return None

    printer = VerbosePrinter(model)
    include_messages = mode == "verbose"

    if include_messages and thinking is None:
        with _PRINT_LOCK:
            sys.stderr.write(
                f"[{model.removeprefix('openrouter/')}] verbose> "
                "no thinking level requested; pass --thinking low|medium|high|xhigh|max if the provider exposes reasoning.\n"
            )
            sys.stderr.flush()

    def handle_message_start(event: MessageStartEvent) -> None:
        if not include_messages:
            return
        if event.message.get("role") == "assistant":
            printer.reset_message()

    def handle_message_update(event: MessageUpdateEvent) -> None:
        if not include_messages:
            return
        if event.message.get("role") != "assistant":
            return
        message_event = event.assistant_message_event
        event_type = message_event["type"]
        if event_type == "text_delta":
            printer.emit_delta(
                "text", message_event["delta"], message_event["contentIndex"]
            )
        elif event_type == "thinking_delta":
            printer.emit_delta(
                "thinking", message_event["delta"], message_event["contentIndex"]
            )

    def handle_message_end(event: MessageEndEvent) -> None:
        if not include_messages:
            return
        if event.message.get("role") == "assistant":
            printer.emit_missing_from_message(event.message)
            printer.emit_redacted_thinking_notice(event.message)
        printer.flush()
        printer.reset_message()

    def handle_tool_start(event: ToolExecutionStartEvent) -> None:
        printer.emit_tool_call(event.tool_name, event.args)

    removers = [
        client.on_message_start(handle_message_start),
        client.on_message_update(handle_message_update),
        client.on_message_end(handle_message_end),
        client.on_tool_execution_start(handle_tool_start),
    ]

    def cleanup() -> None:
        for remove in reversed(removers):
            remove()
        printer.flush()

    return cleanup


def run_benchmark_for_model(
    *,
    spec: BenchmarkSpec,
    model: str,
    omp_bin: str,
    workspace: Path,
    timeout: float,
    log_mode: str | None,
    thinking: str | None,
    max_turns: int,
) -> BenchmarkResult:
    """Run a single edit benchmark for one model."""
    test_file = workspace / "test.rs"
    test_file.write_text(INITIAL_CONTENT)

    prompt_attempts = 0
    token_input = 0
    token_output = 0
    turns_used = 0
    edit_tool_calls = 0
    success = False
    feedback = ""
    error_msg: str | None = None
    counting_edit_turns = True

    try:
        with RpcClient(
            executable=omp_bin,
            model=model,
            cwd=workspace,
            env={**spec.env},
            thinking=thinking,
            tools=spec.tools,
            no_skills=True,
            no_rules=True,
            no_session=True,
            startup_timeout=30.0,
            request_timeout=120.0,
        ) as client:
            client.install_headless_ui()
            verbose_cleanup = install_verbose_logging(client, model, log_mode, thinking)

            def handle_tool_count(event: ToolExecutionStartEvent) -> None:
                nonlocal edit_tool_calls, turns_used
                if counting_edit_turns:
                    turns_used += 1
                if event.tool_name == "edit":
                    edit_tool_calls += 1

            tool_count_remover = client.on_tool_execution_start(handle_tool_count)

            try:
                for turn in range(1, max_turns + 1):
                    prompt_attempts = turn

                    if turn == 1:
                        client.prompt(spec.initial_prompt)
                    else:
                        # Reset file to initial state on retry so the model starts fresh
                        # instead of trying to fix a potentially corrupted file.
                        test_file.write_text(INITIAL_CONTENT)
                        client.prompt(build_retry_prompt(spec, INITIAL_CONTENT))

                    try:
                        client.wait_for_idle(timeout=timeout)
                    except Exception:
                        # Prompt timed out or errored — abort the agent then retry.
                        try:
                            client.abort()
                            time.sleep(1)
                            client.wait_for_idle(timeout=10)
                        except Exception:
                            pass
                        continue

                    current_content = test_file.read_text()
                    if current_content.strip() == EXPECTED_CONTENT.strip():
                        success = True
                        break

                stats = client.get_session_stats()
                token_input = stats.tokens.input
                token_output = stats.tokens.output

                counting_edit_turns = False
                client.prompt(FEEDBACK_PROMPT)
                client.wait_for_idle(timeout=timeout)
                feedback = client.get_last_assistant_text() or ""

                stats = client.get_session_stats()
                token_input = stats.tokens.input
                token_output = stats.tokens.output
            finally:
                tool_count_remover()
                if verbose_cleanup is not None:
                    verbose_cleanup()
    except Exception as exc:
        error_msg = f"{type(exc).__name__}: {exc}"

    return BenchmarkResult(
        model=model,
        success=success,
        turns_used=turns_used,
        prompt_attempts=prompt_attempts,
        edit_calls=edit_tool_calls,
        token_input=token_input,
        token_output=token_output,
        feedback=feedback.strip(),
        error=error_msg,
    )


async def run_all(
    spec: BenchmarkSpec, args: argparse.Namespace
) -> dict[str, dict[str, Any]]:
    omp_bin = resolve_omp_bin(args.omp_bin)

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    workspace_root = (
        Path(tempfile.gettempdir()) / f"{spec.workspace_prefix}-{timestamp}"
    )
    workspace_root.mkdir(parents=True, exist_ok=True)

    selected_models = args.models or MODELS

    tasks = []
    for model in selected_models:
        model_slug = model.replace("/", "_")
        workspace = workspace_root / model_slug
        workspace.mkdir(parents=True, exist_ok=True)
        print(f"Starting benchmark for {model}...", file=sys.stderr)
        tasks.append(
            asyncio.to_thread(
                run_benchmark_for_model,
                spec=spec,
                model=model,
                omp_bin=omp_bin,
                workspace=workspace,
                timeout=args.timeout,
                log_mode="verbose"
                if args.verbose
                else ("print" if args.print else None),
                thinking=args.thinking,
                max_turns=args.max_turns,
            )
        )

    benchmark_results = await asyncio.gather(*tasks, return_exceptions=True)

    results: dict[str, dict[str, Any]] = {}
    for model, result in zip(selected_models, benchmark_results):
        if isinstance(result, Exception):
            results[model] = {
                "tokens_in": 0,
                "tokens_out": 0,
                "model_feedback": "",
                "success": False,
                "turns_used": 0,
                "prompt_attempts": 0,
                "edit_calls": 0,
                "error": f"{type(result).__name__}: {result}",
            }
            print(f"  {model}: error - {result}", file=sys.stderr)
            continue

        results[model] = {
            "tokens_in": result.token_input,
            "tokens_out": result.token_output,
            "model_feedback": result.feedback,
            "success": result.success,
            "turns_used": result.turns_used,
            "edit_calls": result.edit_calls,
            "prompt_attempts": result.prompt_attempts,
            "error": result.error,
        }
        status = "success" if result.success else "failed"
        print(f"  {model}: {status} in {result.turns_used} turns", file=sys.stderr)

    return results


def parse_args(description: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--omp-bin",
        default=os.environ.get("OMP_BIN"),
        help="Executable to launch. Defaults to the repo checkout CLI, then falls back to `omp` on PATH.",
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, help="Per-turn timeout in seconds."
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=DEFAULT_MAX_TURNS,
        help=f"Maximum edit/retry turns before the benchmark gives up (default: {DEFAULT_MAX_TURNS}).",
    )
    parser.add_argument(
        "--model",
        dest="models",
        action="append",
        help="Repeat to limit execution to specific models.",
    )
    logging_group = parser.add_mutually_exclusive_group()
    logging_group.add_argument(
        "--print",
        action="store_true",
        help="Print tool calls to stderr while the benchmark runs.",
    )
    logging_group.add_argument(
        "--verbose",
        action="store_true",
        help="Print assistant text, thinking, and tool calls to stderr while the benchmark runs.",
    )
    parser.add_argument(
        "--thinking",
        choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        default="medium",
        help="Request a specific thinking level for models that support reasoning (default: medium).",
    )
    return parser.parse_args()


def run_benchmark_main(spec: BenchmarkSpec) -> int:
    args = parse_args(spec.description)
    results = asyncio.run(run_all(spec, args))
    print(json.dumps(results, indent=2))
    return 0
