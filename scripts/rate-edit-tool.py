#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
import textwrap
import threading
import time
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any, TextIO

from rich import box
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python/omp-rpc/src"))

from omp_rpc import (  # noqa: E402
    AgentEndEvent,
    AutoRetryEndEvent,
    AutoRetryStartEvent,
    ExtensionUiRequest,
    MessageEndEvent,
    MessageUpdateEvent,
    RpcClient,
    RpcError,
    RpcNotification,
    RpcProcessExitError,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    ToolExecutionUpdateEvent,
    TurnEndEvent,
    TurnStartEvent,
    assistant_text,
)

MODELS = [
    "openrouter/moonshotai/kimi-k2.5",
    "openrouter/anthropic/claude-haiku-4.5",
    "openrouter/z-ai/glm-4.7",
    "openai-codex/gpt-5.4",
]

ORACLE_MODEL = "openrouter/anthropic/claude-opus-4.6"

PROMPT = textwrap.dedent(
    """\
    You are evaluating the **edit** tool on files in this directory. The `read` tool is available so you can inspect file state before and after edits, but it is not under review — do not report on it.

    {FIXTURE_SURFACE}

    Work in this order:

    1. Map the edit surface. Inspect the edit tool schema. Identify every operation and addressing mode the active variant exposes (substring replace, line-anchored ops, structural selectors, append/prepend, etc.). Note any behavior differences you anticipate across file types.

    2. Exercise every supported edit operation against each fixture. Perform the full range of supported mutations — replacing content, inserting above/below a target, deleting, substring rewrites, append/prepend — using only what the schema actually exposes.

    3. Push into awkward cases. Probe boundary conditions: first/last line of file, indentation-sensitive blocks (Python), nested members (decorators, methods, enum variants, traits and generics). Note whether error messages were clear and actionable when something went wrong.

    4. Verify after edits. Re-read each file after meaningful edits and confirm only the intended lines changed.

    Report concrete findings about the edit tool only:
    - what required workarounds
    - what was impossible
    - which errors were clear vs unclear
    - what was ambiguous or under-documented
    - suggested improvements

    Be specific. Generic success summaries are not useful.
    """
).strip()

FINAL_REVIEW_PROMPT = textwrap.dedent(
    """\
    Your prior turn completed without a final written review in the assistant text.

    Write the final review now as markdown only.
    Do not perform more tool calls.
    Summarize the concrete findings from the work already completed:
    - awkward workflows or required workarounds
    - impossible operations
    - clear vs unclear errors
    - ambiguous or under-documented behavior
    - changes that would improve trustworthiness and usability
    """
).strip()

ORACLE_REVIEW_PROMPT = textwrap.dedent(
    """\
    <context>
    You are the oracle reviewer for a tool-evaluation benchmark.
    You are reading multiple independent reviews of the same edit-tool session.
    Synthesize only what is supported by the supplied reviews.

    This matters. Be specific and conservative.
    </context>

    <instructions>
    1. Deduplicate overlapping observations into one finding.
    2. Separate well-supported findings from weaker signals. When evidence is mixed or thin, lower confidence instead of overstating.
    3. Cite which review models reported each finding and summarize the concrete evidence they observed.
    4. End with practical improvement areas prioritized by expected trust and usability gains.

    Output markdown only with this exact structure:

    # Oracle synthesis

    ## Findings
    - Finding: ...
      - Confidence: High | Medium | Low
      - Evidence: cite the models and the behavior they observed
      - Improvement area: the concrete product or UX change this finding points to

    ## Improvement areas
    1. ...
    2. ...

    If the reviews do not support any concrete finding, say so explicitly under `## Findings`.
    </instructions>

    <data>
    {{REVIEWS}}
    </data>

    <instructions>
    Use only the supplied reviews. Output markdown only.
    </instructions>
    """
).strip()

TS_FIXTURE = (
    textwrap.dedent(
        """\
    function sealed(_target: Function): void {}

    function trace(_label: string) {
      return function (
        _target: object,
        _propertyKey: string,
        descriptor: PropertyDescriptor,
      ): PropertyDescriptor {
        return descriptor;
      };
    }

    /** Log severity levels emitted by the demo server. */
    export enum LogLevel {
      Debug = "DEBUG",
      Info = "INFO",
      Warn = "WARN",
      Error = "ERROR",
    }

    /** Shared runtime configuration used by parsing and request handling. */
    export interface Config {
      host: string;
      port: number;
      logLevel: LogLevel;
      tags: Record<string, string>;
    }

    export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }

    /** Parse a small JSON config blob into a typed config object. */
    export function parseConfig(raw: string): Result<Config> {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
          return { ok: false, error: "config must be an object" };
        }
        if (typeof parsed.host !== "string" || typeof parsed.port !== "number") {
          return { ok: false, error: "missing required fields" };
        }

        return {
          ok: true,
          value: {
            host: parsed.host,
            port: parsed.port,
            logLevel: (parsed.logLevel as LogLevel | undefined) ?? LogLevel.Info,
            tags: (parsed.tags as Record<string, string> | undefined) ?? {},
          },
        };
      } catch (error) {
        return { ok: false, error: `parse failed: ${String(error)}` };
      }
    }

    /** Tiny request handler surface with decorators and attached comments. */
    @sealed
    export class Server {
      #config: Config;
      #running = false;
      #history: string[] = [];

      constructor(config: Config) {
        this.#config = config;
      }

      /** Begin serving requests. */
      @trace("start")
      start(): void {
        if (this.#running) {
          throw new Error("already running");
        }

        this.#running = true;
        // Record the first lifecycle transition for later inspection.
        this.#history.push(`started:${this.getAddress()}`);
      }

      stop(): void {
        if (!this.#running) return;
        this.#running = false;
        this.#history.push("stopped");
      }

      isRunning(): boolean {
        return this.#running;
      }

      getAddress(): string {
        return `${this.#config.host}:${this.#config.port}`;
      }

      handleRequest(method: string, path: string): Result<string> {
        if (!this.#running) {
          return { ok: false, error: "server not running" };
        }

        switch (method) {
          case "GET":
            return { ok: true, value: `fetched ${path}` };
          case "POST":
            return { ok: true, value: `created ${path}` };
          case "DELETE":
            return { ok: true, value: `deleted ${path}` };
          default:
            return { ok: false, error: `unknown method: ${method}` };
        }
      }

      history(): string[] {
        return [...this.#history];
      }
    }

    /** Format a timestamped log line. */
    export function formatLog(level: LogLevel, message: string): string {
      const timestamp = new Date().toISOString();
      return `[${timestamp}] [${level}] ${message}`;
    }

    /** Generic fixed-size queue used to test nested members. */
    export class RingBuffer<T> {
      #items: T[] = [];
      #capacity: number;

      constructor(capacity: number) {
        this.#capacity = capacity;
      }

      push(item: T): void {
        if (this.#items.length >= this.#capacity) {
          this.#items.shift();
        }
        this.#items.push(item);
      }

      peek(): T | undefined {
        return this.#items[this.#items.length - 1];
      }

      toArray(): T[] {
        return [...this.#items];
      }
    }
    """
    ).strip()
    + "\n"
)

RUST_FIXTURE = (
    textwrap.dedent(
        """\
    use std::collections::HashMap;
    use std::fmt;

    /// Log severity levels emitted by the demo server.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum LogLevel {
        Debug,
        Info,
        Warn,
        Error,
    }

    impl fmt::Display for LogLevel {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                LogLevel::Debug => write!(f, "DEBUG"),
                LogLevel::Info => write!(f, "INFO"),
                LogLevel::Warn => write!(f, "WARN"),
                LogLevel::Error => write!(f, "ERROR"),
            }
        }
    }

    /// Shared runtime configuration used by parsing and request handling.
    #[derive(Debug, Clone)]
    pub struct Config {
        pub host: String,
        pub port: u16,
        pub log_level: LogLevel,
        pub tags: HashMap<String, String>,
    }

    /// Result of handling a request.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum OpResult {
        Ok(String),
        Err(String),
    }

    /// Parse a `host:port` config string into a structured config.
    #[must_use]
    pub fn parse_config(raw: &str) -> Result<Config, String> {
        let parts: Vec<&str> = raw.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err("expected host:port format".into());
        }

        let port = parts[1]
            .parse::<u16>()
            .map_err(|error| format!("bad port: {}", error))?;

        Ok(Config {
            host: parts[0].to_string(),
            port,
            log_level: LogLevel::Info,
            tags: HashMap::new(),
        })
    }

    /// Request handling surface for trait and impl edits.
    pub trait Handler {
        fn handle(&self, method: &str, path: &str) -> OpResult;
    }

    /// Small in-memory server used as an edit surface.
    #[derive(Debug)]
    pub struct Server {
        config: Config,
        running: bool,
        history: Vec<String>,
    }

    impl Server {
        #[inline]
        pub fn new(config: Config) -> Self {
            Self {
                config,
                running: false,
                history: Vec::new(),
            }
        }

        /// Begin serving requests.
        pub fn start(&mut self) -> Result<(), String> {
            if self.running {
                return Err("already running".into());
            }

            self.running = true;
            // Record the first lifecycle transition for later inspection.
            self.history
                .push(format!("started:{}", self.address()));
            Ok(())
        }

        pub fn stop(&mut self) {
            if !self.running {
                return;
            }

            self.running = false;
            self.history.push("stopped".into());
        }

        #[must_use]
        pub fn is_running(&self) -> bool {
            self.running
        }

        #[must_use]
        pub fn address(&self) -> String {
            format!("{}:{}", self.config.host, self.config.port)
        }

        #[must_use]
        pub fn history(&self) -> &[String] {
            &self.history
        }
    }

    impl Handler for Server {
        fn handle(&self, method: &str, path: &str) -> OpResult {
            if !self.running {
                return OpResult::Err("not running".into());
            }

            match method {
                "GET" => OpResult::Ok(format!("fetched {}", path)),
                "POST" => OpResult::Ok(format!("created {}", path)),
                "DELETE" => OpResult::Ok(format!("deleted {}", path)),
                _ => OpResult::Err(format!("unknown method: {}", method)),
            }
        }
    }

    /// Format a log line with its level prefix.
    #[must_use]
    pub fn format_log(level: LogLevel, message: &str) -> String {
        format!("[{}] {}", level, message)
    }

    /// Fixed-size buffer used to test nested impl members.
    #[allow(dead_code)]
    pub struct RingBuffer {
        items: Vec<String>,
        capacity: usize,
    }

    impl RingBuffer {
        pub fn new(capacity: usize) -> Self {
            Self {
                items: Vec::with_capacity(capacity),
                capacity,
            }
        }

        pub fn push(&mut self, item: String) {
            if self.items.len() >= self.capacity {
                self.items.remove(0);
            }
            self.items.push(item);
        }

        #[must_use]
        pub fn peek(&self) -> Option<&str> {
            self.items.last().map(|item| item.as_str())
        }

        #[must_use]
        pub fn as_slice(&self) -> &[String] {
            &self.items
        }
    }
    """
    ).strip()
    + "\n"
)

PYTHON_FIXTURE = (
    textwrap.dedent(
        """\
    from __future__ import annotations

    from dataclasses import dataclass, field
    from pathlib import Path
    from typing import Iterable


    def traced(label: str):
        def decorator(fn):
            def wrapper(*args, **kwargs):
                return fn(*args, **kwargs)

            wrapper.__name__ = fn.__name__
            wrapper.__doc__ = fn.__doc__
            return wrapper

        return decorator


    @dataclass(slots=True)
    class Config:
        host: str
        port: int
        tags: dict[str, str] = field(default_factory=dict)


    class Server:
        # Small indentation-sensitive server surface for edit tests.
        def __init__(self, config: Config) -> None:
            self._config = config
            self._history: list[str] = []
            self._running = False

        @traced("start")
        def start(self) -> None:
            if self._running:
                raise RuntimeError("already running")
            self._running = True
            self._history.append(f"started:{self.address}")

        def stop(self) -> None:
            if not self._running:
                return
            self._running = False
            self._history.append("stopped")

        @property
        def address(self) -> str:
            return f"{self._config.host}:{self._config.port}"

        def handle(self, method: str, path: str) -> str:
            if not self._running:
                raise RuntimeError("server not running")

            match method:
                case "GET":
                    return f"fetched {path}"
                case "POST":
                    return f"created {path}"
                case _:
                    raise ValueError(f"unknown method: {method}")

        def history(self) -> list[str]:
            return list(self._history)


    def parse_config(raw: str) -> Config:
        host, port = raw.split(":", 1)
        return Config(host=host.strip(), port=int(port))


    def write_report(lines: Iterable[str], target: Path) -> None:
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    """
    ).strip()
    + "\n"
)

REFERENCE_FILES = {
    "PROMPT.md": PROMPT + "\n",
    "main.ts": TS_FIXTURE,
    "main.rs": RUST_FIXTURE,
    "main.py": PYTHON_FIXTURE,
}

FIXTURES: tuple[tuple[str, str], ...] = (
    ("typescript", "main.ts"),
    ("rust", "main.rs"),
    ("python", "main.py"),
)

FIXTURE_DESCRIPTIONS: dict[str, str] = {
    "typescript": "TypeScript/AST",
    "rust": "Rust/AST",
    "python": "indentation-sensitive",
}

WORKSPACE_FILES = {
    "main.ts": TS_FIXTURE,
    "main.rs": RUST_FIXTURE,
    "main.py": PYTHON_FIXTURE,
}


def build_fixture_prompt() -> str:
    lines = [
        f"- `{fixture_file}` ({FIXTURE_DESCRIPTIONS.get(language, language)})"
        for language, fixture_file in FIXTURES
    ]
    surface = "Test surface (exercise every file in this workspace):\n" + "\n".join(
        lines
    )
    return (
        PROMPT.format(FIXTURE_SURFACE=surface)
        + "\n\nExercise every fixture in one session; do not skip any file type."
    )


@dataclass
class ModelResult:
    model: str
    fixture: str
    status: str
    started_at: float
    finished_at: float
    workspace: str
    jsonl_path: str
    review_path: str
    turns: int
    tool_calls: int
    thinking_chars: int
    text_chars: int
    token_input: int | None
    token_output: int | None
    token_total: int | None
    error: str | None
    session_state: dict[str, Any] | None


@dataclass
class ModelProgress:
    model: str
    label: str
    status: str = "pending"
    turns: int = 0
    tool_calls: int = 0
    thinking_chars: int = 0
    text_chars: int = 0
    token_input: int | None = None
    token_output: int | None = None
    token_total: int | None = None
    last_activity: str = "waiting"
    last_thinking: str | None = None
    last_text: str | None = None
    duration_seconds: float | None = None
    error: str | None = None


TOOL_WHITELIST = ("read", "edit")
MODEL_LABEL_WIDTH = 30
STATUS_WIDTH = 7
TOKENS_WIDTH = 9
ACTIVITY_WIDTH_FLOOR = 24
THINKING_SNIPPET_LIMIT = 80
TEXT_SNIPPET_LIMIT = 64


def shorten_model_name(model: str) -> str:
    if model.startswith("openrouter/"):
        return model.removeprefix("openrouter/")
    return model


def collapse_whitespace(value: str) -> str:
    return " ".join(value.split())


def truncate_text(value: str | None, width: int) -> str:
    if width <= 0:
        return ""
    text = collapse_whitespace(value or "")
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "…"


def format_count(value: int | None) -> str:
    if value is None:
        return "-"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def extract_usage_tokens(
    message: dict[str, Any],
) -> tuple[int | None, int | None, int | None]:
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None, None, None
    token_input = usage.get("input")
    token_output = usage.get("output")
    token_total = usage.get("totalTokens")
    if (
        not isinstance(token_total, int)
        and isinstance(token_input, int)
        and isinstance(token_output, int)
    ):
        token_total = token_input + token_output
    return (
        token_input if isinstance(token_input, int) else None,
        token_output if isinstance(token_output, int) else None,
        token_total if isinstance(token_total, int) else None,
    )


class ProgressPrinter:
    def __init__(
        self,
        runs: list[tuple[str, str]],
        *,
        stream: TextIO | None = None,
        interactive: bool | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._stream = sys.stdout if stream is None else stream
        self._interactive = (
            self._stream.isatty() if interactive is None else interactive
        )
        self._console = Console(
            file=self._stream, force_terminal=self._interactive, soft_wrap=False
        )
        self._model_order = [run_id for run_id, _ in runs]
        self._states = {
            run_id: ModelProgress(model=run_id, label=label) for run_id, label in runs
        }
        self._fixtures_dir: str | None = None
        self._results_dir: str | None = None
        self._closed = False
        self._final_message: str | None = None
        self._live: Live | None = None
        if self._interactive:
            self._live = Live(
                self._build_renderable_locked(),
                console=self._console,
                auto_refresh=False,
                transient=False,
            )
            self._live.start()

    def configure(self, *, fixtures_dir: Path, results_dir: Path) -> None:
        with self._lock:
            self._fixtures_dir = str(fixtures_dir)
            self._results_dir = str(results_dir)
            self._refresh_locked()

    def mark_starting(self, model: str) -> None:
        self._mutate_model(model, status="boot", last_activity="starting rpc")

    def mark_ready(self, model: str) -> None:
        self._mutate_model(model, status="ready", last_activity="rpc ready")

    def mark_prompt_submitted(self, model: str) -> None:
        self._mutate_model(model, status="run", last_activity="prompt submitted")

    def mark_turn_start(self, model: str, turns: int) -> None:
        self._mutate_model(model, status="run", turns=turns)

    def mark_turn_end(self, model: str, turns: int) -> None:
        self._mutate_model(model, turns=turns)

    def note_tool_start(
        self, model: str, tool_name: str, intent: str | None, tool_calls: int
    ) -> None:
        with self._lock:
            progress = self._states[model]
            progress.status = "run"
            progress.tool_calls = tool_calls
            detail = truncate_text(intent, 36)
            progress.last_activity = f"{tool_name} · {detail}" if detail else tool_name
            self._refresh_locked()

    def note_tool_end(self, model: str, tool_name: str, is_error: bool | None) -> None:
        if is_error:
            self._mutate_model(model, last_activity=f"{tool_name} failed")

    def note_thinking(self, model: str, delta: str, total_chars: int) -> None:
        with self._lock:
            progress = self._states[model]
            progress.status = "think"
            progress.thinking_chars = total_chars
            progress.last_thinking = truncate_text(delta, THINKING_SNIPPET_LIMIT)
            progress.last_activity = progress.last_thinking or "thinking"
            self._refresh_locked()

    def note_text(self, model: str, delta: str, total_chars: int) -> None:
        with self._lock:
            progress = self._states[model]
            progress.status = "run"
            progress.text_chars = total_chars
            progress.last_text = truncate_text(delta, TEXT_SNIPPET_LIMIT)
            progress.last_activity = progress.last_text or "drafting"
            self._refresh_locked()

    def note_usage(
        self,
        model: str,
        token_input: int | None,
        token_output: int | None,
        token_total: int | None,
    ) -> None:
        self._mutate_model(
            model,
            token_input=token_input,
            token_output=token_output,
            token_total=token_total,
        )

    def mark_completed(self, model: str, duration_seconds: float) -> None:
        self._mutate_model(
            model,
            status="done",
            duration_seconds=duration_seconds,
            last_activity="completed",
        )

    def mark_failed(self, model: str, error: str) -> None:
        self._mutate_model(
            model, status="failed", error=error, last_activity=truncate_text(error, 72)
        )

    def finish(self, message: str) -> None:
        with self._lock:
            if self._closed:
                return
            self._final_message = message
            if self._live is not None:
                self._live.update(self._build_renderable_locked(), refresh=True)
                self._live.stop()
            else:
                self._console.print(self._build_renderable_locked())
            self._closed = True

    def _mutate_model(self, model: str, **changes: Any) -> None:
        with self._lock:
            progress = self._states[model]
            for key, value in changes.items():
                setattr(progress, key, value)
            self._refresh_locked()

    def _refresh_locked(self) -> None:
        if self._live is None:
            return
        self._live.update(self._build_renderable_locked(), refresh=True)

    def _build_renderable_locked(self) -> Group:
        done = sum(1 for state in self._states.values() if state.status == "done")
        failed = sum(1 for state in self._states.values() if state.status == "failed")
        active = sum(
            1
            for state in self._states.values()
            if state.status not in {"pending", "done", "failed"}
        )

        summary = Text()
        summary.append(f"done {done}/{len(self._states)}", style="bold green")
        summary.append("  •  ", style="dim")
        summary.append(f"active {active}", style="bold cyan")
        summary.append("  •  ", style="dim")
        summary.append(f"failed {failed}", style="bold red" if failed else "green")

        results_line = Text()
        results_line.append("results ", style="bold")
        results_line.append(self._results_dir or "-", style="cyan")

        config_line = Text()
        config_line.append("fixtures ", style="bold")
        config_line.append(self._fixtures_dir or "-", style="cyan")
        config_line.append("  •  ", style="dim")
        config_line.append("tools ", style="bold")
        config_line.append("|".join(TOOL_WHITELIST), style="magenta")

        header = Panel(
            Group(summary, results_line, config_line),
            title="rate-edit-tool",
            border_style="cyan",
            box=box.ROUNDED,
        )

        table = Table(box=box.SIMPLE_HEAVY, expand=True, show_lines=False)
        table.add_column("Model", style="bold", width=34, min_width=34, max_width=34)
        table.add_column("State", no_wrap=True, width=7)
        table.add_column("Turns", justify="right", no_wrap=True, width=5)
        table.add_column("Tools", justify="right", no_wrap=True, width=5)
        table.add_column("Tokens", justify="right", no_wrap=True, width=8)

        for model in self._model_order:
            state = self._states[model]
            table.add_row(
                self._model_text(state),
                self._status_text(state.status),
                str(state.turns),
                str(state.tool_calls),
                format_count(state.token_total),
            )

        if self._final_message:
            footer = Panel(
                self._final_message,
                border_style="green" if failed == 0 else "red",
                box=box.ROUNDED,
            )
            return Group(header, table, footer)
        return Group(header, table)

    @staticmethod
    def _status_text(status: str) -> Text:
        styles = {
            "pending": "dim",
            "boot": "yellow",
            "ready": "blue",
            "run": "cyan",
            "think": "magenta",
            "done": "green",
            "failed": "bold red",
        }
        return Text(status, style=styles.get(status, "white"))

    @staticmethod
    def _model_text(state: ModelProgress) -> Text:
        text = Text(truncate_text(state.label, 34), style="bold")
        activity = (
            state.error
            if state.status == "failed" and state.error
            else state.last_activity
        )
        if activity and activity not in {"waiting", "completed"}:
            text.append("\n")
            text.append(truncate_text(activity, 34), style="dim")
        return text


def slugify(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)


def materialize_workspace(target_dir: Path) -> None:
    for name, content in WORKSPACE_FILES.items():
        (target_dir / name).write_text(content)


def sync_reference_fixtures(fixtures_dir: Path) -> None:
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    keep = set(REFERENCE_FILES)
    for child in fixtures_dir.iterdir():
        if child.name not in keep:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    for name, content in REFERENCE_FILES.items():
        (fixtures_dir / name).write_text(content)


def resolve_omp_bin(raw: str | None) -> str:
    if raw:
        return raw
    found = shutil.which("omp")
    if not found:
        raise SystemExit("Could not find `omp` on PATH. Set --omp-bin or OMP_BIN.")
    return found


def serialize_notification(notification: Any) -> dict[str, Any]:
    if is_dataclass(notification):
        return asdict(notification)
    if isinstance(notification, dict):
        return dict(notification)
    data = getattr(notification, "__dict__", None)
    if isinstance(data, dict):
        return dict(data)
    return {"value": repr(notification)}


class ModelRunRecorder:
    def __init__(
        self,
        run_id: str,
        model: str,
        fixture: str,
        printer: ProgressPrinter,
        jsonl_path: Path,
    ) -> None:
        self.run_id = run_id
        self.model = model
        self.fixture = fixture
        self.printer = printer
        self.jsonl_path = jsonl_path
        self.turns = 0
        self.tool_calls = 0
        self.thinking_chars = 0
        self.text_chars = 0
        self.token_input: int | None = None
        self.token_output: int | None = None
        self.token_total: int | None = None
        self.review_sections: list[str] = []
        self.agent_ended = False
        self.auto_retry_active = False
        self.auto_retry_delay_ms = 0
        self.last_event_at = time.monotonic()
        self._consumed_assistant_messages = 0
        self._event_lock = threading.Lock()

    def _touch(self) -> None:
        self.last_event_at = time.monotonic()

    def record_notification(self, notification: RpcNotification) -> None:
        self._touch()
        self._append_jsonl(serialize_notification(notification))

    def record_ui(self, request: ExtensionUiRequest) -> None:
        self._touch()
        if request.method in {"notify", "setStatus", "setTitle", "set_editor_text"}:
            return
        if request.method == "setWidget" and request.widget_key == "autoresearch":
            return

    def record_turn_start(self, _event: TurnStartEvent) -> None:
        self._touch()
        self.turns += 1
        self.printer.mark_turn_start(self.run_id, self.turns)

    def record_turn_end(self, _event: TurnEndEvent) -> None:
        self._touch()
        self.printer.mark_turn_end(self.run_id, self.turns)

    def record_tool_execution_start(self, event: ToolExecutionStartEvent) -> None:
        self._touch()
        self.tool_calls += 1
        self.printer.note_tool_start(
            self.run_id, event.tool_name, event.intent, self.tool_calls
        )

    def record_tool_execution_update(self, _event: ToolExecutionUpdateEvent) -> None:
        self._touch()
        return

    def record_tool_execution_end(self, event: ToolExecutionEndEvent) -> None:
        self._touch()
        self.printer.note_tool_end(self.run_id, event.tool_name, event.is_error)

    def record_auto_retry_start(self, event: AutoRetryStartEvent) -> None:
        self._touch()
        self.auto_retry_active = True
        self.auto_retry_delay_ms = event.delay_ms

    def record_auto_retry_end(self, _event: AutoRetryEndEvent) -> None:
        self._touch()
        self.auto_retry_active = False
        self.auto_retry_delay_ms = 0

    def record_message_end(self, event: MessageEndEvent) -> None:
        self._touch()
        message = event.message
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return
        text = assistant_text(message)
        if not isinstance(text, str) or not text.strip():
            return
        self.review_sections.append(text.strip())
        self._consumed_assistant_messages += 1

        token_input, token_output, token_total = extract_usage_tokens(message)
        if token_total is not None and (
            self.token_total is None or token_total >= self.token_total
        ):
            self.token_input = token_input
            self.token_output = token_output
            self.token_total = token_total
            self.printer.note_usage(self.run_id, token_input, token_output, token_total)

    def record_agent_end(self, event: AgentEndEvent) -> None:
        self._touch()
        self.agent_ended = True
        assistant_count = 0
        for message in event.messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            text = assistant_text(message)
            if (
                assistant_count >= self._consumed_assistant_messages
                and isinstance(text, str)
                and text.strip()
            ):
                self.review_sections.append(text.strip())
            assistant_count += 1

        self._consumed_assistant_messages = assistant_count

        for message in reversed(event.messages):
            if isinstance(message, dict) and message.get("role") == "assistant":
                token_input, token_output, token_total = extract_usage_tokens(message)
                self.token_input = token_input
                self.token_output = token_output
                self.token_total = token_total
                self.printer.note_usage(
                    self.run_id, token_input, token_output, token_total
                )
                break

    def record_message_update(self, event: MessageUpdateEvent) -> None:
        self._touch()
        assistant_event = event.assistant_message_event
        partial = assistant_event.get("partial")
        if isinstance(partial, dict):
            token_input, token_output, token_total = extract_usage_tokens(partial)
            if token_total is not None and (
                self.token_total is None or token_total >= self.token_total
            ):
                self.token_input = token_input
                self.token_output = token_output
                self.token_total = token_total
                self.printer.note_usage(
                    self.run_id, token_input, token_output, token_total
                )

        delta_type = assistant_event.get("type")
        delta = assistant_event.get("delta")
        if not isinstance(delta, str):
            return
        if delta_type == "thinking_delta":
            self.thinking_chars += len(delta)
            self.printer.note_thinking(self.run_id, delta, self.thinking_chars)
        elif delta_type == "text_delta":
            self.text_chars += len(delta)
            self.printer.note_text(self.run_id, delta, self.text_chars)

    def build_review_markdown(self) -> str:
        if not self.review_sections:
            return ""
        return "\n\n-----------\n\n".join(self.review_sections)

    def is_effectively_complete(self, *, quiet_seconds: float) -> bool:
        return (
            len(self.review_sections) > 0
            and not self.auto_retry_active
            and (time.monotonic() - self.last_event_at) >= quiet_seconds
        )

    def _append_jsonl(self, payload: dict[str, Any]) -> None:
        with self._event_lock:
            with self.jsonl_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload) + "\n")


def run_model_sync(
    *,
    model: str,
    omp_bin: str,
    results_dir: Path,
    workspace_root: Path,
    timeout: float,
    printer: ProgressPrinter,
) -> ModelResult:
    started_at = time.time()
    model_slug = slugify(model)
    run_id = model
    workspace = workspace_root / model_slug
    workspace.mkdir(parents=True, exist_ok=True)
    materialize_workspace(workspace)

    review_slug = slugify(shorten_model_name(model))
    review_path = results_dir / f"review_{review_slug}.md"
    jsonl_path = (
        Path(tempfile.gettempdir())
        / f"rate-edit-tool-{results_dir.name}-{model_slug}.jsonl"
    )
    jsonl_path.unlink(missing_ok=True)
    jsonl_path.touch()
    recorder = ModelRunRecorder(
        run_id=run_id,
        model=model,
        fixture="all",
        printer=printer,
        jsonl_path=jsonl_path,
    )

    printer.mark_starting(run_id)
    error_message: str | None = None
    session_state: dict[str, Any] | None = None

    try:
        with RpcClient(
            executable=omp_bin,
            model=model,
            cwd=workspace,
            thinking="high",
            tools=TOOL_WHITELIST,
            no_skills=True,
            no_rules=True,
            no_session=True,
            startup_timeout=30.0,
            request_timeout=30.0,
        ) as client:
            client.on_notification(recorder.record_notification)
            client.on_turn_start(recorder.record_turn_start)
            client.on_turn_end(recorder.record_turn_end)
            client.on_tool_execution_start(recorder.record_tool_execution_start)
            client.on_tool_execution_update(recorder.record_tool_execution_update)
            client.on_tool_execution_end(recorder.record_tool_execution_end)
            client.on_auto_retry_start(recorder.record_auto_retry_start)
            client.on_auto_retry_end(recorder.record_auto_retry_end)
            client.on_agent_end(recorder.record_agent_end)
            client.on_message_update(recorder.record_message_update)
            client.on_message_end(recorder.record_message_end)
            client.on_ui_request(recorder.record_ui)
            client.install_headless_ui()

            printer.mark_ready(run_id)

            deadline = time.monotonic() + timeout

            def wait_for_settle() -> None:
                last_timeout: RpcError | None = None
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        if last_timeout is not None:
                            raise last_timeout
                        raise RpcError("Timed out waiting for agent to settle")

                    try:
                        client.wait_for_idle(timeout=min(remaining, 60.0))
                        if recorder.auto_retry_active:
                            time.sleep(
                                min(
                                    max(recorder.auto_retry_delay_ms / 1000.0, 0.2), 2.0
                                )
                            )
                            continue
                        if recorder.agent_ended:
                            grace = min(0.5, max(deadline - time.monotonic(), 0.0))
                            if grace > 0:
                                time.sleep(grace)
                            if recorder.auto_retry_active:
                                time.sleep(
                                    min(
                                        max(recorder.auto_retry_delay_ms / 1000.0, 0.2),
                                        2.0,
                                    )
                                )
                                continue
                            return
                        if recorder.is_effectively_complete(quiet_seconds=2.0):
                            return
                        time.sleep(0.2)
                    except RpcError as error:
                        if "Timed out waiting for agent_end" not in str(error):
                            raise
                        last_timeout = error
                        if recorder.is_effectively_complete(quiet_seconds=2.0):
                            return

            printer.mark_prompt_submitted(run_id)
            client.prompt(build_fixture_prompt())
            wait_for_settle()
            review_markdown = recorder.build_review_markdown()
            if not review_markdown.strip():
                printer.mark_prompt_submitted(run_id)
                client.prompt(FINAL_REVIEW_PROMPT)
                wait_for_settle()
                review_markdown = recorder.build_review_markdown()
            if not review_markdown.strip():
                raise RpcError("Agent completed without final review text after retry")

            stats = client.get_session_stats()
            if (
                recorder.token_total is None or recorder.token_total <= 0
            ) and stats.tokens.total > 0:
                recorder.token_input = stats.tokens.input
                recorder.token_output = stats.tokens.output
                recorder.token_total = stats.tokens.total
                printer.note_usage(
                    run_id,
                    recorder.token_input,
                    recorder.token_output,
                    recorder.token_total,
                )
            review_path.write_text(review_markdown)
            provider, model_id = model.split("/", 1)
            session_state = {
                "model": {"provider": provider, "id": model_id},
                "thinkingLevel": "high",
            }
            status = "ok"
    except Exception as error:  # noqa: BLE001
        error_message = (
            f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
        )
        printer.mark_failed(run_id, error_message)
        status = "failed"

    finished_at = time.time()
    duration_seconds = round(finished_at - started_at, 3)

    if status == "ok":
        printer.mark_completed(run_id, duration_seconds)

    return ModelResult(
        model=model,
        fixture="all",
        status=status,
        started_at=started_at,
        finished_at=finished_at,
        workspace=str(workspace),
        jsonl_path=str(jsonl_path),
        review_path=str(review_path),
        turns=recorder.turns,
        tool_calls=recorder.tool_calls,
        thinking_chars=recorder.thinking_chars,
        text_chars=recorder.text_chars,
        token_input=recorder.token_input,
        token_output=recorder.token_output,
        token_total=recorder.token_total,
        error=error_message,
        session_state=session_state,
    )


def build_oracle_review_prompt(sources: list[tuple[str, str, str]]) -> str:
    review_sections: list[str] = []
    for model, fixture, review_path in sorted(sources):
        review_text = Path(review_path).read_text(encoding="utf-8").strip()
        if not review_text:
            continue
        review_sections.append(
            textwrap.dedent(
                f"""\
                <review>
                <model>{model}</model>
                <fixture>{fixture}</fixture>
                <path>{review_path}</path>

                {review_text}
                </review>
                """
            ).strip()
        )

    if not review_sections:
        raise ValueError("No review content available for oracle synthesis")

    review_payload = "\n\n".join(review_sections)
    return ORACLE_REVIEW_PROMPT.replace("{{REVIEWS}}", review_payload)


def oracle_sources_from_results(
    results: list[ModelResult],
) -> list[tuple[str, str, str]]:
    return [(r.model, r.fixture, r.review_path) for r in results if r.review_path]


def oracle_sources_from_dir(results_dir: Path) -> list[tuple[str, str, str]]:
    known_fixtures = {fixture for fixture, _ in FIXTURES}
    sources: list[tuple[str, str, str]] = []
    for path in sorted(results_dir.glob("review_*.md")):
        stem = path.stem.removeprefix("review_")
        fixture = "all"
        model = stem.replace("_", "/", 1)
        for candidate in known_fixtures:
            if stem.endswith(f"_{candidate}"):
                fixture = candidate
                model = stem[: -len(candidate) - 1].replace("_", "/", 1)
                break
        sources.append((model, fixture, str(path)))
    return sources


def format_combined_reviews(sources: list[tuple[str, str, str]]) -> str:
    sections: list[str] = []
    for model, _fixture, review_path in sorted(sources):
        review_text = Path(review_path).read_text(encoding="utf-8").strip()
        if not review_text:
            continue
        bar = "=" * 13
        header = f"{bar} {model} {bar}"
        sections.append(f"{header}\n\n{review_text}")
    return "\n\n".join(sections)


def run_oracle_review_sync(
    *,
    model: str,
    omp_bin: str,
    sources: list[tuple[str, str, str]],
    results_dir: Path,
    timeout: float,
) -> str:
    prompt = build_oracle_review_prompt(sources)
    prompt_path = results_dir / "oracle_prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")

    with RpcClient(
        executable=omp_bin,
        model=model,
        cwd=results_dir,
        thinking="high",
        tools=(),
        no_skills=True,
        no_rules=True,
        no_session=True,
        startup_timeout=30.0,
        request_timeout=30.0,
    ) as client:
        client.install_headless_ui()
        client.prompt_and_wait(prompt, timeout=timeout)
        review_markdown = client.get_last_assistant_text()

    if not isinstance(review_markdown, str) or not review_markdown.strip():
        raise RpcError("Oracle model completed without synthesis text")

    synthesis = review_markdown.strip()
    (results_dir / "oracle_synthesis.md").write_text(synthesis + "\n", encoding="utf-8")
    return synthesis


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run OpenRouter fixture evaluations through omp RPC mode."
    )
    parser.add_argument("--omp-bin", default=os.environ.get("OMP_BIN"))
    parser.add_argument("--fixtures-dir", default=os.path.expanduser("~/tmp/fixtures"))
    parser.add_argument("--results-dir")
    parser.add_argument(
        "--timeout", type=float, default=900.0, help="Per run timeout in seconds."
    )
    parser.add_argument(
        "--model",
        dest="models",
        action="append",
        help="Repeat to limit execution to specific models.",
    )
    parser.add_argument(
        "--oracle-model",
        default=ORACLE_MODEL,
        help="Model used to synthesize findings across all reviews.",
    )
    parser.add_argument(
        "--oracle",
        action="store_true",
        help="Synthesize findings across reviews using --oracle-model (default: skip synthesis and emit combined reviews).",
    )
    parser.add_argument(
        "--rerun-oracle",
        dest="rerun_oracle",
        help="Skip fixture runs and only synthesize against review_*.md files in this existing results dir.",
    )
    parser.add_argument(
        "--rerun",
        dest="rerun",
        help="Skip fixture runs and emit combined reviews from review_*.md files in this existing results dir.",
    )
    return parser.parse_args()


async def run_all(args: argparse.Namespace) -> int:
    omp_bin = resolve_omp_bin(args.omp_bin)

    if args.rerun or args.rerun_oracle:
        rerun_path = args.rerun_oracle or args.rerun
        results_dir = Path(rerun_path).expanduser()
        if not results_dir.is_dir():
            print(f"Results dir not found: {results_dir}", file=sys.stderr)
            return 1
        sources = oracle_sources_from_dir(results_dir)
        if not sources:
            print(f"No review_*.md files found in {results_dir}", file=sys.stderr)
            return 1
        if args.rerun_oracle:
            try:
                synthesis = await asyncio.to_thread(
                    run_oracle_review_sync,
                    model=args.oracle_model,
                    omp_bin=omp_bin,
                    sources=sources,
                    results_dir=results_dir,
                    timeout=args.timeout,
                )
            except (RpcError, RpcProcessExitError) as exc:
                err = f"{type(exc).__name__}: {exc}"
                (results_dir / "oracle_error.txt").write_text(
                    err + "\n", encoding="utf-8"
                )
                print(f"Oracle synthesis FAILED: {err}", file=sys.stderr)
                print(f"Saved error to {results_dir}/oracle_error.txt", file=sys.stderr)
                return 2
            print(synthesis)
            return 0
        combined = format_combined_reviews(sources)
        (results_dir / "combined_reviews.md").write_text(
            combined + "\n", encoding="utf-8"
        )
        print(combined)
        return 0

    fixtures_dir = Path(args.fixtures_dir).expanduser()
    sync_reference_fixtures(fixtures_dir)

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    tmp_root = Path(tempfile.gettempdir())
    results_dir = (
        Path(args.results_dir)
        if args.results_dir
        else tmp_root / f"omp-fixture-runs-{timestamp}"
    )
    results_dir.mkdir(parents=True, exist_ok=True)
    workspace_root = tmp_root / f"rate-edit-tool-workspaces-{timestamp}"
    workspace_root.mkdir(parents=True, exist_ok=True)

    selected_models = args.models or MODELS
    run_specs = [(model, shorten_model_name(model)) for model in selected_models]
    printer = ProgressPrinter(run_specs)
    printer.configure(fixtures_dir=fixtures_dir, results_dir=results_dir)

    tasks = [
        asyncio.to_thread(
            run_model_sync,
            model=model,
            omp_bin=omp_bin,
            results_dir=results_dir,
            workspace_root=workspace_root,
            timeout=args.timeout,
            printer=printer,
        )
        for model in selected_models
    ]
    results = await asyncio.gather(*tasks)

    failures = sum(1 for result in results if result.status != "ok")
    if failures:
        printer.finish(f"{failures}/{len(results)} run(s) failed")
        return 1

    sources = oracle_sources_from_results(results)
    combined = format_combined_reviews(sources)
    (results_dir / "combined_reviews.md").write_text(combined + "\n", encoding="utf-8")

    if not args.oracle:
        printer.finish(
            f"{len(results)} review file(s) saved to {results_dir}.\n"
            f"Combined reviews saved to {results_dir}/combined_reviews.md."
        )
        print(combined)
        return 0

    try:
        oracle_synthesis = await asyncio.to_thread(
            run_oracle_review_sync,
            model=args.oracle_model,
            omp_bin=omp_bin,
            sources=sources,
            results_dir=results_dir,
            timeout=args.timeout,
        )
    except (RpcError, RpcProcessExitError) as exc:
        err = f"{type(exc).__name__}: {exc}"
        (results_dir / "oracle_error.txt").write_text(err + "\n", encoding="utf-8")
        printer.finish(
            f"{len(results)} review file(s) saved to {results_dir}.\n"
            f"Oracle synthesis FAILED ({err}).\n"
            f"Re-run the synthesis against existing reviews with:\n"
            f"  python scripts/rate-edit-tool.py --rerun-oracle {results_dir}"
        )
        return 2

    printer.finish(
        f"{len(results)} review file(s) completed. Oracle synthesis saved to {results_dir}/oracle_synthesis.md:\n\n{oracle_synthesis}"
    )
    return 0


def main() -> int:
    args = parse_args()
    return asyncio.run(run_all(args))


if __name__ == "__main__":
    raise SystemExit(main())
