"""QA rig: scripted mock model + real `omp print` drives.

Drives the production ``target/debug/omp`` binary "e2e-ish": a scripted
OpenAI-SSE mock stands in for the LLM, everything else (catalog, inference
spine, agent loop, envd, tools, journal, sessions) is production code.

Used by ``cases/`` (the durable spec suite), ``drive.py`` (one-shot CLI),
and ``mock_model.py`` (standalone mock server). Stdlib only.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OMP_BINARY = REPO_ROOT / "target/debug/omp"

MODELS_TOML = """[providers.mock]
baseUrl = "http://127.0.0.1:{port}/v1"
auth = "none"

[providers.mock.models.mock]
name = "Mock Model"
api = "openai-completions"
contextWindow = 128000
maxTokens = 8192
supportsTools = true
supportsStreaming = true
"""
# Keep drives deterministic and fast: default retry policy walks a 10-step
# exponential ladder (minutes) on provider 5xx before surfacing the error.
CONFIG_TOML = """[retry]
max_retries = 1
base_delay_ms = 50
max_delay_ms = 200
"""


@dataclass(frozen=True, slots=True)
class ToolCall:
	"""One assistant tool call in a scripted reply."""

	name: str
	arguments: dict[str, object] | None = None
	arguments_raw: str | None = None

	def __post_init__(self):
		if not self.name:
			raise ValueError("tool call has no name")
		if self.arguments is not None and self.arguments_raw is not None:
			raise ValueError("tool call cannot have both parsed and raw arguments")


@dataclass(frozen=True, slots=True)
class Reply:
	"""One assistant turn, containing text, tool calls, or both."""

	text: str | None = None
	tool_calls: tuple[ToolCall, ...] = ()



def call(
	tool: str,
	arguments: dict[str, object] | None = None,
	/,
	**fields: object,
) -> Reply:
	"""Builds one reply containing one tool call."""
	if arguments is not None and fields:
		raise TypeError("pass either an arguments mapping or keyword fields, not both")
	if arguments is not None and not isinstance(arguments, dict):
		raise TypeError("tool arguments must be a dict")
	return Reply(
		tool_calls=(
			ToolCall(name=tool, arguments=dict(arguments) if arguments is not None else dict(fields)),
		)
	)


def raw_call(tool: str, raw_arguments: str, /) -> Reply:
	"""Builds one tool call with a deliberately malformed argument document."""
	if not isinstance(raw_arguments, str):
		raise TypeError("raw tool arguments must be a string")
	return Reply(tool_calls=(ToolCall(name=tool, arguments_raw=raw_arguments),))



def _reply(value: Reply | str) -> Reply:
	if isinstance(value, Reply):
		return value
	if isinstance(value, str):
		return Reply(text=value)
	raise TypeError(f"mock reply must be Reply or str, got {type(value).__name__}")


class MockModel:
	"""Scripted OpenAI chat-completions server.

	Requests beyond the reply queue answer HTTP 500 unless ``loop`` is set.
	``GET /state`` returns served count plus captured request bodies, and
	``POST /reset`` re-arms the queue.
	"""

	def __init__(self, *replies: Reply | str, loop: bool = False):
		if not replies:
			raise ValueError("mock has no replies")
		self.replies = tuple(_reply(reply) for reply in replies)
		self.loop = loop
		self.served = 0
		self.captures: list[dict] = []
		self.lock = threading.Lock()
		self._closed = False
		mock = self

		class Handler(BaseHTTPRequestHandler):
			protocol_version = "HTTP/1.1"

			def log_message(self, *args):  # noqa: D102 — silence per-request noise
				pass

			def do_GET(self):
				if self.path == "/state":
					with mock.lock:
						remaining = -1 if mock.loop else max(len(mock.replies) - mock.served, 0)
						body = json.dumps(
							{"served": mock.served, "remaining": remaining, "captures": mock.captures}
						).encode()
					self._respond(200, "application/json", body)
				else:
					self._respond(404, "text/plain", b"mock-model: unknown route")

			def do_POST(self):
				raw = self._read_body()
				if self.path == "/reset":
					with mock.lock:
						mock.served = 0
						mock.captures = []
					self._respond(200, "application/json", b'{"ok":true}')
					return
				if not self.path.endswith("/chat/completions"):
					self._respond(404, "text/plain", b"mock-model: unknown route")
					return
				try:
					body = json.loads(raw)
				except json.JSONDecodeError:
					body = {}
				with mock.lock:
					mock.captures.append(body)
					if mock.served < len(mock.replies):
						reply = mock.replies[mock.served]
					elif mock.loop:
						reply = mock.replies[mock.served % len(mock.replies)]
					else:
						reply = None
					mock.served += 1
					ordinal = mock.served
				if reply is None:
					self._respond(
						500,
						"application/json",
						b'{"error":{"message":"mock scenario exhausted","type":"mock_exhausted"}}',
					)
					return
				if body.get("stream") is False:
					self._respond(
						200,
						"application/json",
						json.dumps(mock._completion(reply, ordinal, body)).encode(),
					)
					return
				payload = b"".join(
					b"data: " + event + b"\n\n" for event in mock._sse_events(reply, ordinal, body)
				)
				self._respond(200, "text/event-stream", payload)

			def _read_body(self) -> bytes:
				if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
					body = bytearray()
					while True:
						size = int(self.rfile.readline().strip().split(b";")[0] or b"0", 16)
						if size == 0:
							while self.rfile.readline().strip():
								pass
							break
						body += self.rfile.read(size)
						self.rfile.readline()
					return bytes(body)
				length = int(self.headers.get("content-length", 0))
				return self.rfile.read(length) if length else b"{}"

			def _respond(self, status: int, content_type: str, body: bytes):
				self.send_response(status)
				self.send_header("content-type", content_type)
				self.send_header("content-length", str(len(body)))
				self.end_headers()
				self.wfile.write(body)

		self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
		self.port = self.server.server_address[1]
		self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
		self.thread.start()

	def __enter__(self) -> MockModel:
		return self

	def __exit__(self, exc_type, exc_value, traceback):
		self.close()

	def close(self):
		"""Stops the server thread."""
		if self._closed:
			return
		self._closed = True
		self.server.shutdown()
		self.server.server_close()
		self.thread.join()

	def state(self) -> dict:
		"""Served count and captured request bodies."""
		with self.lock:
			return {"served": self.served, "captures": list(self.captures)}

	@staticmethod
	def _tool_call_wire(tool_call: ToolCall, ordinal: int, index: int) -> dict:
		arguments = (
			tool_call.arguments_raw
			if tool_call.arguments_raw is not None
			else json.dumps(tool_call.arguments or {})
		)
		return {
			"id": f"call_{ordinal}_{index}",
			"type": "function",
			"function": {"name": tool_call.name, "arguments": arguments},
		}

	def _completion(self, reply: Reply, ordinal: int, body: dict) -> dict:
		calls = [
			self._tool_call_wire(tool_call, ordinal, index)
			for index, tool_call in enumerate(reply.tool_calls)
		]
		message: dict = {"role": "assistant", "content": reply.text or (None if calls else "")}
		if calls:
			message["tool_calls"] = calls
		return {
			"id": f"chatcmpl-mock-{ordinal}",
			"object": "chat.completion",
			"created": int(time.time()),
			"model": body.get("model", "mock"),
			"choices": [
				{
					"index": 0,
					"message": message,
					"finish_reason": "tool_calls" if calls else "stop",
				}
			],
			"usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
		}

	def _sse_events(self, reply: Reply, ordinal: int, body: dict) -> list[bytes]:
		chat_id = f"chatcmpl-mock-{ordinal}"
		model = body.get("model", "mock")

		def chunk(delta: dict | None, finish: str | None, extra: dict | None = None) -> bytes:
			envelope = {
				"id": chat_id,
				"object": "chat.completion.chunk",
				"created": int(time.time()),
				"model": model,
				"choices": []
				if delta is None and finish is None
				else [{"index": 0, "delta": delta or {}, "finish_reason": finish}],
			}
			if extra:
				envelope.update(extra)
			return json.dumps(envelope).encode()

		events = [chunk({"role": "assistant", "content": ""}, None)]
		if reply.text:
			for start in range(0, len(reply.text), 24):
				events.append(chunk({"content": reply.text[start : start + 24]}, None))
		for index, tool_call in enumerate(reply.tool_calls):
			wire = self._tool_call_wire(tool_call, ordinal, index)
			arguments = wire["function"]["arguments"]
			pieces = [arguments[start : start + 32] for start in range(0, len(arguments), 32)] or [""]
			events.append(
				chunk(
					{
						"tool_calls": [
							{
								"index": index,
								"id": wire["id"],
								"type": "function",
								"function": {"name": tool_call.name, "arguments": pieces[0]},
							}
						]
					},
					None,
				)
			)
			for piece in pieces[1:]:
				events.append(
					chunk({"tool_calls": [{"index": index, "function": {"arguments": piece}}]}, None)
				)
		finish = "tool_calls" if reply.tool_calls else "stop"
		events.append(chunk(None, finish))
		if body.get("stream_options", {}).get("include_usage"):
			events.append(
				chunk(
					None,
					None,
					{"usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}},
				)
			)
		events.append(b"[DONE]")
		return events


@dataclass
class DriveResult:
	"""Outcome of one bounded `omp print` drive."""

	events: list[dict] = field(default_factory=list)
	stdout: str = ""
	stderr: str = ""
	exit_code: int | None = None
	timed_out: bool = False
	mock: dict | None = None
	project: Path | None = None
	data_dir: Path | None = None

	def of_type(self, kind: str) -> list[dict]:
		"""All NDJSON events with ``type == kind``."""
		return [event for event in self.events if event.get("type") == kind]

	def assistant_events(self) -> list[dict]:
		"""``message_update.assistantMessageEvent`` payloads in order."""
		return [
			event["assistantMessageEvent"]
			for event in self.of_type("message_update")
			if event.get("assistantMessageEvent")
		]


def drive(
	*replies: Reply | str,
	prompt: str = "go",
	loop: bool = False,
	extensions: tuple[Path, ...] | list[Path] = (),
	args: list[str] | None = None,
	timeout: float = 30.0,
	keep: bool = False,
	project: Path | None = None,
	data_dir: Path | None = None,
	env: dict[str, str] | None = None,
	dead_endpoint: bool = False,
) -> DriveResult:
	"""Runs one isolated, hard-bounded ``omp print --mode json`` drive.

	``dead_endpoint`` points the provider at a closed port instead of a live
	mock. ``project``/``data_dir`` allow multi-run reuse (resume tests);
	callers passing them own their cleanup.
	"""
	mock = None if dead_endpoint else MockModel(*replies, loop=loop)
	port = 9 if mock is None else mock.port
	own_data = data_dir is None
	own_project = project is None
	data_dir = data_dir or Path(tempfile.mkdtemp(prefix="omp-qa-data-"))
	project = project or Path(tempfile.mkdtemp(prefix="omp-qa-proj-"))
	project.mkdir(parents=True, exist_ok=True)
	(data_dir / "models.toml").write_text(MODELS_TOML.format(port=port))
	(data_dir / "config.toml").write_text(CONFIG_TOML)

	extension_args = [
		item
		for directory in extensions
		for item in ("--plugin-dir", str(directory))
	]
	process = subprocess.Popen(
		[
			str(OMP_BINARY),
			"print",
			"--mode",
			"json",
			"--yolo",
			"--model",
			"mock",
			*(args or []),
			*extension_args,
			prompt,
		],
		cwd=project,
		env={**os.environ, "OMP_DATA_DIR": str(data_dir), **(env or {})},
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		stdin=subprocess.DEVNULL,
		text=True,
		start_new_session=True,
	)
	result = DriveResult(project=project, data_dir=data_dir)
	try:
		result.stdout, result.stderr = process.communicate(timeout=timeout)
		result.exit_code = process.returncode
	except subprocess.TimeoutExpired:
		result.timed_out = True
		try:
			os.killpg(process.pid, signal.SIGKILL)
		except ProcessLookupError:
			pass
		result.stdout, result.stderr = process.communicate()
	if mock is not None:
		result.mock = mock.state()
		mock.close()
	for line in result.stdout.splitlines():
		line = line.strip()
		if line.startswith("{"):
			try:
				result.events.append(json.loads(line))
			except json.JSONDecodeError:
				pass
	if not keep:
		if own_data:
			shutil.rmtree(data_dir, ignore_errors=True)
		if own_project:
			shutil.rmtree(project, ignore_errors=True)
	return result


FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "extensions"


@contextmanager
def extension_fixture(
	name: str,
	*,
	params: dict[str, object] | None = None,
) -> Iterator[Path]:
	"""Yields an isolated copy of a checked-in production-shaped extension."""
	source = (FIXTURE_ROOT / name).resolve()
	try:
		source.relative_to(FIXTURE_ROOT.resolve())
	except ValueError as error:
		raise FileNotFoundError(f"extension fixture does not exist: {name}") from error
	if not source.is_dir():
		raise FileNotFoundError(f"extension fixture does not exist: {name}")
	with tempfile.TemporaryDirectory(prefix="omp-qa-ext-") as temporary_root:
		directory = Path(temporary_root) / source.name
		shutil.copytree(source, directory)
		if params is not None:
			src = directory / "src"
			packages = sorted(
				path
				for path in src.iterdir()
				if path.is_dir() and (path / "__init__.py").is_file()
			) if src.is_dir() else []
			if len(packages) != 1:
				raise ValueError(
					f"parameterized extension fixture must contain exactly one package: {name}"
				)
			encoded = json.dumps(params, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
			(packages[0] / "_qa_params.py").write_text(
				f"import json\n\nPARAMS = json.loads({encoded!r})\n"
			)
		yield directory


def introspect(symbols: list[str], timeout: float = 90.0) -> dict[str, str]:
	"""Resolves ``module.attr`` paths inside the real extension runtime."""
	with extension_fixture("introspect", params={"symbols": symbols}) as directory:
		project = Path(tempfile.mkdtemp(prefix="omp-qa-proj-"))
		try:
			result = drive(
				call("hello", name="probe"),
				"done",
				prompt="introspect",
				extensions=[directory],
				project=project,
				timeout=timeout,
			)
			for event in result.of_type("turn_end"):
				for tool in event.get("toolResults", []):
					for part in tool.get("content", []):
						text = part.get("text", "")
						if text.startswith("{"):
							return json.loads(text)
			raise RuntimeError(
				f"introspection drive produced no report (exit={result.exit_code}, "
				f"timed_out={result.timed_out}, stderr tail: {result.stderr[-300:]!r})"
			)
		finally:
			shutil.rmtree(project, ignore_errors=True)
