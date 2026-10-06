//! Blocking transport for `omp --mode rpc` over any reader/writer pair.
//!
//! A reader thread decodes stdout lines (reassembling protocol v2 `rpc_chunk`
//! sequences), routes responses to waiting calls by id, feeds prompt
//! collectors, runs host tools and host URIs, and delivers everything else as
//! [`Event`]s. A writer thread owns stdin: callers queue encoded frames and
//! then wait for their response with their deadline, so a peer that stops
//! reading never blocks a caller past its timeout, nor teardown.
//!
//! Once the client is closed (a transport violation, the peer's EOF, a failed
//! write, [`Client::close`], or drop) every pending and later call fails with
//! the closing error, no further server frame is dispatched, queued frames are
//! discarded, and the writer thread drops stdin so the server sees EOF.

use std::{
	collections::{HashMap, HashSet},
	fmt,
	io::{self, BufRead, BufReader, Read, Write},
	panic::{AssertUnwindSafe, catch_unwind},
	process::{Child, Command as Process, Stdio},
	sync::{
		Arc, Mutex, MutexGuard, PoisonError, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
	frame::{FrameDecoder, MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES},
	host_tool::{HostTool, HostToolContext, text_payload},
	host_uri::{HostUri, HostUriContext, uri_scheme},
	turn::PromptTurn,
	wire::{
		AgentMessage, Command, GetMessagesCommand, GetMessagesPageCommand, HostToolResult,
		HostUriOperation, HostUriResult, NegotiateProtocolCommand, PromptCommand, PromptResultEvent,
		ReadyEvent, RpcAgentEvent, RpcInbound, RpcNotification, RpcResponse, RpcServerFrame,
		SetHostToolsCommand, SetHostUriSchemesCommand,
	},
};

/// Default deadline of [`Client::prompt_and_wait`].
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
const PAGE_LIMIT: i64 = 256;
const PAGE_BUSY_ERROR: &str = "Cannot page messages while the session is changing";
const PAGE_STALE_ERROR: &str = "RPC message cursor is stale";
/// How long teardown waits for the process group leader after each signal.
const LEADER_EXIT_TIMEOUT: Duration = Duration::from_secs(1);
/// After SIGKILL, killed members linger until reaped by their (new) parent.
const KILL_SETTLE_TIMEOUT: Duration = Duration::from_secs(1);
/// How long teardown waits for the reader thread once the process is gone.
const READER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Client failure.
#[derive(Debug)]
pub enum Error {
	/// Spawning or talking to the process failed, or teardown could not
	/// confirm that the process group is gone.
	Io(io::Error),
	/// Encoding a frame or decoding a response failed.
	Json(serde_json::Error),
	/// The server answered `success: false`.
	Command { command: String, error: String, code: Option<String> },
	/// No response within the deadline.
	Timeout { command: String },
	/// The server's stdout closed, or the client was closed.
	Closed,
	/// The transport broke its contract (invalid JSON, bad chunk sequence,
	/// failed negotiation).
	Protocol(String),
	/// A definition was rejected before reaching the server (e.g. an empty URI
	/// scheme).
	InvalidArgument(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(error) => write!(f, "io: {error}"),
			Self::Json(error) => write!(f, "json: {error}"),
			Self::Command { command, error, code: Some(code) } => {
				write!(f, "{command} failed ({code}): {error}")
			},
			Self::Command { command, error, code: None } => write!(f, "{command} failed: {error}"),
			Self::Timeout { command } => write!(f, "{command} timed out"),
			Self::Closed => f.write_str("server closed"),
			Self::Protocol(message) => write!(f, "protocol error: {message}"),
			Self::InvalidArgument(message) => write!(f, "invalid argument: {message}"),
		}
	}
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

impl From<serde_json::Error> for Error {
	fn from(error: serde_json::Error) -> Self {
		Self::Json(error)
	}
}

/// A server frame that is not a correlated response, a host tool frame, or a
/// host URI frame (the client serves those itself).
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // Mirrors the generated unions, which are unboxed.
pub enum Event {
	/// Unsolicited frame; unrecognized types arrive as
	/// [`RpcNotification::Unknown`].
	Notification(RpcNotification),
	/// A response whose id matched no pending call.
	UnmatchedResponse(RpcResponse),
	/// A known frame type whose payload failed to decode.
	Undecodable { raw: Value, error: String },
}

/// Construction options.
#[derive(Debug, Clone)]
pub struct ClientOptions {
	/// Host tools registered right after startup (see
	/// [`Client::set_custom_tools`]).
	pub tools:           Vec<HostTool>,
	/// Host URI schemes registered after the tools (see
	/// [`Client::set_host_uris`]).
	pub uris:            Vec<HostUri>,
	/// Deadline for the `ready` frame.
	pub ready_timeout:   Duration,
	/// Deadline for commands that declare none.
	pub default_timeout: Duration,
}

impl Default for ClientOptions {
	fn default() -> Self {
		Self {
			tools:           Vec::new(),
			uris:            Vec::new(),
			ready_timeout:   Duration::from_secs(60),
			default_timeout: Duration::from_secs(30),
		}
	}
}

/// Why the client closed.
#[derive(Clone)]
enum Closure {
	/// The server closed its stdout.
	Eof,
	/// [`Client::close`] or drop.
	Closed,
	Protocol(String),
	/// Writing to the server's stdin failed.
	Write(io::ErrorKind, String),
}

impl Closure {
	fn error(&self) -> Error {
		match self {
			Self::Eof | Self::Closed => Error::Closed,
			Self::Protocol(message) => Error::Protocol(message.clone()),
			Self::Write(kind, message) => Error::Io(io::Error::new(*kind, message.clone())),
		}
	}
}

/// What a prompt collector receives.
#[allow(clippy::large_enum_variant)] // Events dominate the traffic; boxing would add an allocation each.
enum PromptSignal {
	Event(RpcAgentEvent),
	Result(PromptResultEvent),
	Failed(Error),
}

/// Which host request registry a reply belongs to.
#[derive(Clone, Copy)]
pub(crate) enum HostRequestKind {
	Tool,
	Uri,
}

/// Ties a queued frame to a host request: the writer skips the frame when the
/// request was cancelled, checking right before it writes.
pub(crate) struct Guard {
	pub(crate) cancelled: Arc<AtomicBool>,
	/// Set on the final reply: the request's cancellation entry is released
	/// once the reply is written or skipped, so a cancel arriving while it
	/// waits in the queue still suppresses it.
	pub(crate) release:   Option<(HostRequestKind, String)>,
}

/// An encoded frame waiting for the writer thread.
struct Outgoing {
	line:  Vec<u8>,
	guard: Option<Guard>,
}

type ResponseSender = SyncSender<Result<RpcResponse, Error>>;

#[derive(Default)]
struct State {
	/// Queue of the writer thread; `None` once closed.
	outgoing:       Option<Sender<Outgoing>>,
	/// Request id → (command, waiter).
	pending:        HashMap<String, (String, ResponseSender)>,
	/// Prompt request id → collector.
	prompts:        HashMap<String, Sender<PromptSignal>>,
	/// Host tool request id → cancellation flag.
	host_calls:     HashMap<String, Arc<AtomicBool>>,
	/// Host URI request id → cancellation flag.
	uri_requests:   HashMap<String, Arc<AtomicBool>>,
	/// Agent tool call id → host tool name, for renaming `tool_execution_*`
	/// events.
	dispatch_names: HashMap<String, String>,
	ready:          Option<SyncSender<ReadyEvent>>,
	closed:         Option<Closure>,
}

impl State {
	fn requests(&mut self, kind: HostRequestKind) -> &mut HashMap<String, Arc<AtomicBool>> {
		match kind {
			HostRequestKind::Tool => &mut self.host_calls,
			HostRequestKind::Uri => &mut self.uri_requests,
		}
	}
}

/// State shared by the client, its reader and writer threads, and host
/// handler threads.
pub(crate) struct Shared {
	state: Mutex<State>,
	/// `rpc_chunk` frames are accepted (set right before `negotiate_protocol`).
	v2:    AtomicBool,
	tools: Mutex<Vec<HostTool>>,
	uris:  Mutex<Vec<HostUri>>,
}

impl Shared {
	fn state(&self) -> MutexGuard<'_, State> {
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}

	fn is_closed(&self) -> bool {
		self.state().closed.is_some()
	}

	/// Queues `frame` for the writer thread; fails once the client is closed.
	pub(crate) fn enqueue<T: Serialize>(
		&self,
		frame: &T,
		guard: Option<Guard>,
	) -> Result<(), Error> {
		let mut line = serde_json::to_vec(frame)?;
		line.push(b'\n');
		let state = self.state();
		if let Some(closure) = &state.closed {
			return Err(closure.error());
		}
		let outgoing = state.outgoing.as_ref().ok_or(Error::Closed)?;
		outgoing
			.send(Outgoing { line, guard })
			.map_err(|_| Error::Closed)
	}

	/// Registers a host request's cancellation flag; `None` once closed, so
	/// no handler starts after teardown.
	fn register(&self, kind: HostRequestKind, id: &str) -> Option<Arc<AtomicBool>> {
		let mut state = self.state();
		if state.closed.is_some() {
			return None;
		}
		let cancelled = Arc::new(AtomicBool::new(false));
		state
			.requests(kind)
			.insert(id.to_owned(), Arc::clone(&cancelled));
		Some(cancelled)
	}

	fn cancel(&self, kind: HostRequestKind, id: &str) {
		if let Some(cancelled) = self.state().requests(kind).get(id) {
			cancelled.store(true, Ordering::SeqCst);
		}
	}

	fn release(&self, kind: HostRequestKind, id: &str, cancelled: &Arc<AtomicBool>) {
		let mut state = self.state();
		let requests = state.requests(kind);
		if requests
			.get(id)
			.is_some_and(|entry| Arc::ptr_eq(entry, cancelled))
		{
			requests.remove(id);
		}
	}

	/// Closes the client; the first closure wins.
	fn close(&self, closure: Closure) {
		let mut state = self.state();
		if state.closed.is_some() {
			return;
		}
		// Dropping the only sender ends the writer thread, which drops stdin.
		state.outgoing = None;
		for (_, (_, waiter)) in state.pending.drain() {
			let _ = waiter.send(Err(closure.error()));
		}
		for collector in state.prompts.values() {
			let _ = collector.send(PromptSignal::Failed(closure.error()));
		}
		let state = &mut *state;
		for (_, cancelled) in state.host_calls.drain().chain(state.uri_requests.drain()) {
			cancelled.store(true, Ordering::SeqCst);
		}
		state.dispatch_names.clear();
		state.ready = None;
		state.closed = Some(closure);
	}

	fn write_loop(
		shared: &Weak<Self>,
		mut writer: Box<dyn Write + Send>,
		queue: &Receiver<Outgoing>,
	) {
		for frame in queue {
			let Some(shared) = shared.upgrade() else {
				return;
			};
			let cancelled = frame
				.guard
				.as_ref()
				.is_some_and(|guard| guard.cancelled.load(Ordering::SeqCst));
			let written = if cancelled || shared.is_closed() {
				Ok(())
			} else {
				writer.write_all(&frame.line).and_then(|()| writer.flush())
			};
			if let Some(Guard { cancelled, release: Some((kind, id)) }) = &frame.guard {
				shared.release(*kind, id, cancelled);
			}
			if let Err(error) = written {
				let message = format!("Failed to write RPC input: {error}");
				shared.close(Closure::Write(error.kind(), message));
				return;
			}
		}
	}

	fn read_loop<R: BufRead>(self: &Arc<Self>, mut reader: R, events: &Sender<Event>) -> Closure {
		let mut decoder = FrameDecoder::default();
		let mut line = Vec::new();
		loop {
			line.clear();
			match reader.read_until(b'\n', &mut line) {
				Ok(0) => return Closure::Eof,
				Ok(_) => {},
				Err(error) => return Closure::Protocol(format!("Failed to read RPC output: {error}")),
			}
			if self.is_closed() {
				return Closure::Closed;
			}
			let text = line.trim_ascii();
			if text.is_empty() {
				continue;
			}
			let raw: Value = match serde_json::from_slice(text) {
				Ok(raw) => raw,
				Err(error) => {
					return Closure::Protocol(format!("Failed to decode RPC output: {error}"));
				},
			};
			if raw.get("type").and_then(Value::as_str) == Some("rpc_chunk")
				&& !self.v2.load(Ordering::SeqCst)
			{
				return Closure::Protocol("RPC chunk received before protocol negotiation".to_owned());
			}
			match decoder.push(raw) {
				Ok(Some(frame)) => self.dispatch(frame, events),
				Ok(None) => {},
				Err(message) => return Closure::Protocol(message),
			}
		}
	}

	fn dispatch(self: &Arc<Self>, mut frame: Value, events: &Sender<Event>) {
		match frame.get("type").and_then(Value::as_str) {
			Some("host_tool_call") => return self.host_tool_call(frame, events),
			Some("host_uri_request") => return self.host_uri_request(frame),
			Some(kind @ ("host_tool_cancel" | "host_uri_cancel")) => {
				if let Some(target) = frame.get("targetId").and_then(Value::as_str) {
					let kind = if kind == "host_tool_cancel" {
						HostRequestKind::Tool
					} else {
						HostRequestKind::Uri
					};
					self.cancel(kind, target);
					return;
				}
			},
			Some(kind @ ("tool_execution_update" | "tool_execution_end")) => {
				let end = kind == "tool_execution_end";
				self.rename_tool_event(&mut frame, end);
			},
			_ => {},
		}
		let decoded = match RpcServerFrame::deserialize(&frame) {
			Ok(decoded) => decoded,
			Err(error) => {
				let error = error.to_string();
				if frame.get("type").and_then(Value::as_str) == Some("prompt_result")
					&& let Some(id) = frame.get("id").and_then(Value::as_str)
					&& let Some(collector) = self.state().prompts.get(id)
				{
					let message = format!("Failed to parse prompt_result: {error}");
					let _ = collector.send(PromptSignal::Failed(Error::Protocol(message)));
				}
				let _ = events.send(Event::Undecodable { raw: frame, error });
				return;
			},
		};
		let event = match decoded {
			RpcServerFrame::Response(response) => match self.response(response) {
				Some(response) => Event::UnmatchedResponse(response),
				None => return,
			},
			// Host tool and URI frames were consumed above; only malformed ones get here.
			RpcServerFrame::RpcHostRequest(_) => return,
			RpcServerFrame::RpcNotification(notification) => {
				self.notification(&notification);
				Event::Notification(notification)
			},
			RpcServerFrame::Unknown(raw) => Event::Notification(RpcNotification::Unknown(raw)),
		};
		// The host may drop the receiver; keep serving calls.
		let _ = events.send(event);
	}

	/// Delivers a response to its waiter; returns it when nobody waits for it.
	fn response(&self, response: RpcResponse) -> Option<RpcResponse> {
		let mut state = self.state();
		if let Some(id) = &response.id {
			if let Some((_, waiter)) = state.pending.remove(id) {
				let _ = waiter.send(Ok(response));
				return None;
			}
			if !response.success {
				// A prompt that was acknowledged and then failed.
				if let Some(collector) = state.prompts.get(id) {
					let _ = collector.send(PromptSignal::Failed(command_error(response)));
					return None;
				}
			}
		}
		if !response.success {
			// An uncorrelated failure belongs to the only pending call of that command.
			let mut matching = state
				.pending
				.iter()
				.filter(|(_, (command, _))| *command == response.command);
			if let (Some((id, _)), None) = (matching.next(), matching.next()) {
				let id = id.clone();
				if let Some((_, waiter)) = state.pending.remove(&id) {
					let _ = waiter.send(Ok(response));
					return None;
				}
			}
		}
		Some(response)
	}

	fn notification(&self, notification: &RpcNotification) {
		let mut state = self.state();
		match notification {
			RpcNotification::Ready(ready) => {
				if let Some(sender) = state.ready.take() {
					let _ = sender.send(ready.clone());
				}
			},
			RpcNotification::PromptResult(result) => {
				if let Some(collector) = result.id.as_ref().and_then(|id| state.prompts.get(id)) {
					let _ = collector.send(PromptSignal::Result(result.clone()));
				}
			},
			RpcNotification::RpcAgentEvent(event) => {
				for collector in state.prompts.values() {
					let _ = collector.send(PromptSignal::Event(event.clone()));
				}
			},
			_ => {},
		}
	}

	/// With `tools.xdev`, host tools run through `write` to an `xd://` device,
	/// so update/end events name the transport tool; report the host tool
	/// instead. `tool_execution_start` precedes `host_tool_call` and keeps the
	/// transport name.
	fn rename_tool_event(&self, frame: &mut Value, end: bool) {
		let Value::Object(map) = frame else { return };
		let Some(call_id) = map.get("toolCallId").and_then(Value::as_str) else {
			return;
		};
		let mut state = self.state();
		let name = if end {
			state.dispatch_names.remove(call_id)
		} else {
			state.dispatch_names.get(call_id).cloned()
		};
		if let Some(name) = name {
			map.insert("toolName".to_owned(), Value::String(name));
		}
	}

	fn host_tool_call(self: &Arc<Self>, frame: Value, events: &Sender<Event>) {
		let Value::Object(mut map) = frame else {
			return;
		};
		let (
			Some(Value::String(id)),
			Some(Value::String(tool_name)),
			Some(Value::String(tool_call_id)),
		) = (map.remove("id"), map.remove("toolName"), map.remove("toolCallId"))
		else {
			let _ = events.send(Event::Undecodable {
				raw:   Value::Object(map),
				error: "host_tool_call needs string id, toolName, and toolCallId".to_owned(),
			});
			return;
		};
		self
			.state()
			.dispatch_names
			.insert(tool_call_id.clone(), tool_name.clone());
		let Some(Value::Object(arguments)) = map.remove("arguments") else {
			return self.host_tool_error(id, "Host tool arguments must be an object".to_owned(), None);
		};
		let tool = self
			.tools
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.iter()
			.find(|tool| tool.definition().name == tool_name)
			.cloned();
		let Some(tool) = tool else {
			return self.host_tool_error(
				id,
				format!("Host tool \"{tool_name}\" is not registered"),
				None,
			);
		};
		let Some(cancelled) = self.register(HostRequestKind::Tool, &id) else {
			return;
		};
		let context =
			HostToolContext { tool_call_id, request_id: id, cancelled, shared: Arc::clone(self) };
		thread::spawn(move || {
			let outcome = catch_unwind(AssertUnwindSafe(|| tool.run(arguments, &context)));
			let shared = &context.shared;
			let id = context.request_id.clone();
			let guard = Guard {
				cancelled: Arc::clone(&context.cancelled),
				release:   Some((HostRequestKind::Tool, id.clone())),
			};
			match outcome {
				Ok(Ok(output)) => {
					let result = HostToolResult { id, result: output.into_payload(), is_error: None };
					// Fails only once closed, which already cancelled this call.
					let _ = shared.enqueue(&RpcInbound::HostToolResult(result), Some(guard));
				},
				Ok(Err(error)) => shared.host_tool_error(id, error.to_string(), Some(guard)),
				Err(_) => shared.host_tool_error(
					id,
					format!("Host tool \"{}\" panicked", tool.definition().name),
					Some(guard),
				),
			}
		});
	}

	fn host_tool_error(&self, id: String, text: String, guard: Option<Guard>) {
		let result = HostToolResult {
			id,
			result: text_payload(text, Some(Value::Object(Map::new()))),
			is_error: Some(true),
		};
		let _ = self.enqueue(&RpcInbound::HostToolResult(result), guard);
	}

	fn host_uri_request(self: &Arc<Self>, frame: Value) {
		let Value::Object(mut map) = frame else {
			return;
		};
		let (Some(Value::String(id)), Some(Value::String(operation)), Some(Value::String(url))) =
			(map.remove("id"), map.remove("operation"), map.remove("url"))
		else {
			return;
		};
		let operation = match operation.as_str() {
			"read" => HostUriOperation::Read,
			"write" => HostUriOperation::Write,
			other => {
				return self.host_uri_error(
					id,
					format!("Unsupported host URI operation: {other}"),
					None,
				);
			},
		};
		let scheme = uri_scheme(&url);
		let uri = self
			.uris
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.iter()
			.find(|uri| uri.scheme() == scheme)
			.cloned();
		let Some(uri) = uri else {
			let error = format!("Host URI scheme \"{scheme}://\" is not registered");
			return self.host_uri_error(id, error, None);
		};
		if operation == HostUriOperation::Write && !uri.writable() {
			let error =
				format!("Host URI scheme \"{scheme}://\" was not registered with a write handler");
			return self.host_uri_error(id, error, None);
		}
		let content = match map.remove("content") {
			Some(Value::String(content)) => content,
			None | Some(Value::Null) => String::new(),
			Some(other) => other.to_string(),
		};
		let Some(cancelled) = self.register(HostRequestKind::Uri, &id) else {
			return;
		};
		let shared = Arc::clone(self);
		thread::spawn(move || {
			let context = HostUriContext { url, operation, cancelled };
			let outcome = catch_unwind(AssertUnwindSafe(|| match operation {
				HostUriOperation::Read => uri.run_read(&context.url, &context).map(Some),
				HostUriOperation::Write => uri
					.run_write(&context.url, &content, &context)
					.unwrap_or(Ok(()))
					.map(|()| None),
			}));
			let guard = Guard {
				cancelled: Arc::clone(&context.cancelled),
				release:   Some((HostRequestKind::Uri, id.clone())),
			};
			let result = match outcome {
				Ok(Ok(Some(read))) => HostUriResult {
					id,
					content: Some(read.content),
					content_type: read.content_type,
					notes: read.notes,
					immutable: read.immutable,
					is_error: None,
					error: None,
				},
				// A write succeeded.
				Ok(Ok(None)) => HostUriResult {
					id,
					content: None,
					content_type: None,
					notes: None,
					immutable: None,
					is_error: None,
					error: None,
				},
				Ok(Err(error)) => return shared.host_uri_error(id, error.to_string(), Some(guard)),
				Err(_) => {
					let error = format!("Host URI handler for \"{}://\" panicked", uri.scheme());
					return shared.host_uri_error(id, error, Some(guard));
				},
			};
			// Fails only once closed, which already cancelled this request.
			let _ = shared.enqueue(&RpcInbound::HostUriResult(result), Some(guard));
		});
	}

	fn host_uri_error(&self, id: String, error: String, guard: Option<Guard>) {
		let result = HostUriResult {
			id,
			content: None,
			content_type: None,
			notes: None,
			immutable: None,
			is_error: Some(true),
			error: Some(error),
		};
		let _ = self.enqueue(&RpcInbound::HostUriResult(result), guard);
	}
}

fn command_error(response: RpcResponse) -> Error {
	Error::Command {
		command: response.command,
		error:   response.error.unwrap_or_default(),
		code:    response.code,
	}
}

/// Removes a prompt collector when the wait ends, however it ends.
struct Collector<'a> {
	shared: &'a Shared,
	id:     &'a str,
}

impl Drop for Collector<'_> {
	fn drop(&mut self) {
		self.shared.state().prompts.remove(self.id);
	}
}

/// A connected `omp --mode rpc` server.
pub struct Client {
	shared:           Arc<Shared>,
	/// The spawned server; its process group is torn down on close.
	child:            Option<Child>,
	reader:           Option<JoinHandle<()>>,
	next_id:          AtomicU64,
	ready:            ReadyEvent,
	protocol_version: u32,
	default_timeout:  Duration,
	/// Serializes each host tool / URI replacement with its registration
	/// round trip, so the server and the dispatch registry agree.
	registration:     Mutex<()>,
}

/// Builds the command frame `{"id", "type", ...params}`.
pub fn encode_command<C: Command>(id: &str, command: &C) -> Result<Value, serde_json::Error> {
	let mut frame = serde_json::to_value(command)?;
	let Value::Object(map) = &mut frame else {
		return Err(serde::ser::Error::custom("command parameters must serialize to an object"));
	};
	map.insert("id".to_owned(), Value::String(id.to_owned()));
	map.insert("type".to_owned(), Value::String(C::NAME.to_owned()));
	Ok(frame)
}

impl Client {
	/// Spawns `process` with piped stdin/stdout and connects to it (see
	/// [`Client::from_io`]).
	///
	/// On Unix the server leads its own process group, so teardown
	/// ([`Client::close`] or drop) also reaches the processes it spawned.
	pub fn spawn(
		mut process: Process,
		options: ClientOptions,
	) -> Result<(Self, Receiver<Event>), Error> {
		#[cfg(unix)]
		std::os::unix::process::CommandExt::process_group(&mut process, 0);
		let mut child = process
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()?;
		let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
			let _ = terminate(&mut child);
			return Err(Error::Closed);
		};
		Self::connect(stdout, stdin, options, Some(child))
	}

	/// Connects over the server's stdout (`reader`) and stdin (`writer`).
	///
	/// Waits for `ready`, negotiates protocol v2 when the server advertises it
	/// with the standard limits, then registers `options.tools` and
	/// `options.uris`. Returns the client and the receiver of every frame that
	/// is not a correlated response or a host tool/URI frame (`ready`
	/// included).
	///
	/// A generic reader cannot be interrupted: after the client closes, its
	/// reader thread stops dispatching and exits once the peer closes its
	/// output.
	pub fn from_io<R, W>(
		reader: R,
		writer: W,
		options: ClientOptions,
	) -> Result<(Self, Receiver<Event>), Error>
	where
		R: Read + Send + 'static,
		W: Write + Send + 'static,
	{
		Self::connect(reader, writer, options, None)
	}

	fn connect<R, W>(
		reader: R,
		writer: W,
		options: ClientOptions,
		child: Option<Child>,
	) -> Result<(Self, Receiver<Event>), Error>
	where
		R: Read + Send + 'static,
		W: Write + Send + 'static,
	{
		let (ready_tx, ready_rx) = mpsc::sync_channel(1);
		let (outgoing, queue) = mpsc::channel();
		let shared = Arc::new(Shared {
			state: Mutex::new(State {
				outgoing: Some(outgoing),
				ready: Some(ready_tx),
				..State::default()
			}),
			v2:    AtomicBool::new(false),
			tools: Mutex::new(Vec::new()),
			uris:  Mutex::new(Vec::new()),
		});
		let writer_shared = Arc::downgrade(&shared);
		let writer: Box<dyn Write + Send> = Box::new(writer);
		// Detached: a write blocked on a peer that never reads must not hold up
		// teardown; the thread ends when the write fails or the queue closes.
		thread::spawn(move || Shared::write_loop(&writer_shared, writer, &queue));
		let (events, receiver) = mpsc::channel();
		let reader_shared = Arc::clone(&shared);
		let reader = thread::spawn(move || {
			let closure = reader_shared.read_loop(BufReader::with_capacity(1 << 16, reader), &events);
			reader_shared.close(closure);
		});
		let mut client = Self {
			ready: ReadyEvent {
				protocol_version:            None,
				supported_protocol_versions: None,
				max_frame_bytes:             None,
				max_reassembled_frame_bytes: None,
			},
			shared,
			child,
			reader: Some(reader),
			next_id: AtomicU64::new(1),
			protocol_version: 1,
			default_timeout: options.default_timeout,
			registration: Mutex::new(()),
		};
		// From here on an early return drops `client`, which tears everything down.
		client.ready = match ready_rx.recv_timeout(options.ready_timeout) {
			Ok(ready) => ready,
			Err(RecvTimeoutError::Timeout) => {
				return Err(Error::Timeout { command: "ready".to_owned() });
			},
			Err(RecvTimeoutError::Disconnected) => {
				return Err(
					client
						.shared
						.state()
						.closed
						.as_ref()
						.map_or(Error::Closed, Closure::error),
				);
			},
		};
		let ready = &client.ready;
		if ready
			.supported_protocol_versions
			.as_ref()
			.is_some_and(|versions| versions.contains(&2))
			&& ready.max_frame_bytes == Some(MAX_FRAME_BYTES)
			&& ready.max_reassembled_frame_bytes == Some(MAX_REASSEMBLED_BYTES)
		{
			// Chunks may follow the negotiation response immediately.
			client.shared.v2.store(true, Ordering::SeqCst);
			let negotiated = client.call(&NegotiateProtocolCommand { protocol_version: 2 })?;
			if negotiated.protocol_version != 2 {
				return Err(Error::Protocol("RPC protocol v2 negotiation failed".to_owned()));
			}
			client.protocol_version = 2;
		}
		if !options.tools.is_empty() {
			client.set_custom_tools(options.tools)?;
		}
		if !options.uris.is_empty() {
			client.set_host_uris(options.uris)?;
		}
		Ok((client, receiver))
	}

	/// Process id of the spawned server (on Unix also its process group id);
	/// `None` for [`Client::from_io`] or once closed.
	pub fn pid(&self) -> Option<u32> {
		self.child.as_ref().map(Child::id)
	}

	/// The server's `ready` frame.
	pub fn ready(&self) -> &ReadyEvent {
		&self.ready
	}

	/// Negotiated protocol version: 2 when the server supports lossless
	/// chunking, else 1.
	pub fn protocol_version(&self) -> u32 {
		self.protocol_version
	}

	/// Replaces the deadline used by commands that declare none.
	pub fn set_default_timeout(&mut self, timeout: Duration) {
		self.default_timeout = timeout;
	}

	fn next_id(&self) -> String {
		format!("req_{}", self.next_id.fetch_add(1, Ordering::Relaxed))
	}

	/// Sends `command` and waits for its response. The deadline covers both
	/// the write and the response.
	pub fn call<C: Command>(&self, command: &C) -> Result<C::Output, Error> {
		let id = self.next_id();
		let timeout = C::TIMEOUT_MS.map_or(self.default_timeout, Duration::from_millis);
		let response = self.request(&id, C::NAME, &encode_command(&id, command)?, timeout)?;
		Ok(C::decode(response.data)?)
	}

	/// Queues `frame` and waits for its successful response.
	fn request(
		&self,
		id: &str,
		command: &str,
		frame: &Value,
		timeout: Duration,
	) -> Result<RpcResponse, Error> {
		let (tx, rx) = mpsc::sync_channel(1);
		self
			.shared
			.state()
			.pending
			.insert(id.to_owned(), (command.to_owned(), tx));
		if let Err(error) = self.shared.enqueue(frame, None) {
			self.shared.state().pending.remove(id);
			return Err(error);
		}
		let response = match rx.recv_timeout(timeout) {
			Ok(response) => response?,
			Err(RecvTimeoutError::Timeout) => {
				self.shared.state().pending.remove(id);
				return Err(Error::Timeout { command: command.to_owned() });
			},
			Err(RecvTimeoutError::Disconnected) => return Err(Error::Closed),
		};
		if !response.success {
			return Err(command_error(response));
		}
		Ok(response)
	}

	/// Queues a host frame (an extension UI response); returns once queued,
	/// without waiting for the write. Fails once the client is closed.
	pub fn send(&self, frame: &RpcInbound) -> Result<(), Error> {
		self.shared.enqueue(frame, None)
	}

	/// Replaces the host tools (`set_host_tools`); returns the names the server
	/// registered.
	pub fn set_custom_tools(&self, tools: Vec<HostTool>) -> Result<Vec<String>, Error> {
		let _registration = self
			.registration
			.lock()
			.unwrap_or_else(PoisonError::into_inner);
		let definitions = tools.iter().map(|tool| tool.definition().clone()).collect();
		*self
			.shared
			.tools
			.lock()
			.unwrap_or_else(PoisonError::into_inner) = tools;
		self.call(&SetHostToolsCommand { tools: definitions })
	}

	/// Replaces the host URI schemes (`set_host_uri_schemes`); returns the
	/// schemes the server registered.
	pub fn set_host_uris(&self, uris: Vec<HostUri>) -> Result<Vec<String>, Error> {
		let _registration = self
			.registration
			.lock()
			.unwrap_or_else(PoisonError::into_inner);
		let schemes = uris.iter().map(HostUri::definition).collect();
		*self
			.shared
			.uris
			.lock()
			.unwrap_or_else(PoisonError::into_inner) = uris;
		self.call(&SetHostUriSchemesCommand { schemes })
	}

	/// Submits `prompt` and waits (up to `timeout`) for its own `prompt_result`.
	///
	/// Waits are independent: each collects every session event that arrives
	/// while it runs and ends only on the `prompt_result` carrying its request
	/// id, so concurrent waits from several threads are allowed. Events still
	/// reach the event receiver.
	pub fn prompt_and_wait(
		&self,
		prompt: &PromptCommand,
		timeout: Duration,
	) -> Result<PromptTurn, Error> {
		let deadline = Instant::now() + timeout;
		let id = self.next_id();
		let frame = encode_command(&id, prompt)?;
		let (tx, rx) = mpsc::channel();
		// Registered before writing: the result may arrive before the acknowledgement.
		self.shared.state().prompts.insert(id.clone(), tx);
		let _collector = Collector { shared: &self.shared, id: &id };
		let response = self.request(&id, PromptCommand::NAME, &frame, timeout)?;
		let ack = PromptCommand::decode(response.data)?;
		let mut events = Vec::new();
		if ack.agent_invoked == Some(false) {
			for signal in rx.try_iter() {
				if let PromptSignal::Event(event) = signal {
					events.push(event);
				}
			}
			return PromptTurn::build(events, None);
		}
		loop {
			let left = deadline.saturating_duration_since(Instant::now());
			match rx.recv_timeout(left) {
				Ok(PromptSignal::Event(event)) => events.push(event),
				Ok(PromptSignal::Result(result)) => return PromptTurn::build(events, Some(result)),
				Ok(PromptSignal::Failed(error)) => return Err(error),
				Err(RecvTimeoutError::Timeout) => {
					return Err(Error::Timeout { command: PromptCommand::NAME.to_owned() });
				},
				Err(RecvTimeoutError::Disconnected) => return Err(Error::Closed),
			}
		}
	}

	/// Every message of the session. With protocol v2 it drains
	/// `get_messages_page`, falling back to `get_messages` when the session
	/// changes mid-way; with v1 it sends `get_messages`.
	pub fn get_messages(&self) -> Result<Vec<AgentMessage>, Error> {
		if self.protocol_version == 2 {
			match self.get_message_pages() {
				Err(Error::Command { command, error, code })
					if command == GetMessagesPageCommand::NAME
						&& (matches!(code.as_deref(), Some("session_busy" | "stale_cursor"))
							|| error == PAGE_BUSY_ERROR
							|| error == PAGE_STALE_ERROR) => {},
				result => return result,
			}
		}
		self.call(&GetMessagesCommand {})
	}

	fn get_message_pages(&self) -> Result<Vec<AgentMessage>, Error> {
		let mut messages = Vec::new();
		let mut seen = HashSet::new();
		let mut total = None;
		let mut cursor = None;
		loop {
			let page = self
				.call(&GetMessagesPageCommand { cursor: cursor.take(), limit: Some(PAGE_LIMIT) })?;
			if total.is_some_and(|total| total != page.total_messages) {
				return Err(Error::Protocol(
					"RPC message pagination returned an inconsistent total".to_owned(),
				));
			}
			total = Some(page.total_messages);
			messages.extend(page.messages);
			let Some(next) = page.next_cursor else { break };
			if !seen.insert(next.clone()) {
				return Err(Error::Protocol("RPC message pagination repeated a cursor".to_owned()));
			}
			cursor = Some(next);
		}
		if total != Some(messages.len() as i64) {
			return Err(Error::Protocol(
				"RPC message pagination ended before the advertised total".to_owned(),
			));
		}
		Ok(messages)
	}

	/// Closes the client and tears the server down: cancels host work, closes
	/// stdin, then signals the server's process group SIGTERM and, if the
	/// leader is still alive after a second, SIGKILL. Returns an error when
	/// teardown cannot confirm the leader was reaped and the group is empty.
	/// Dropping the client runs the same teardown and ignores the outcome.
	pub fn close(mut self) -> Result<(), Error> {
		self.shutdown()
	}

	fn shutdown(&mut self) -> Result<(), Error> {
		self.shared.close(Closure::Closed);
		let Some(mut child) = self.child.take() else {
			// `from_io`: the reader exits once the peer closes its output.
			return Ok(());
		};
		let outcome = terminate(&mut child);
		// The server is gone, so its stdout reaches EOF; a surviving process
		// that inherited stdout may keep it open, so do not wait forever.
		if let Some(reader) = self.reader.take() {
			let deadline = Instant::now() + READER_JOIN_TIMEOUT;
			while !reader.is_finished() && Instant::now() < deadline {
				thread::sleep(POLL_INTERVAL);
			}
			if reader.is_finished() {
				let _ = reader.join();
			}
		}
		outcome
	}
}

impl Drop for Client {
	fn drop(&mut self) {
		let _ = self.shutdown();
	}
}

/// Polls the leader for up to `timeout`; true once it was reaped.
fn leader_exited(child: &mut Child, timeout: Duration) -> Result<bool, Error> {
	let deadline = Instant::now() + timeout;
	loop {
		if child.try_wait()?.is_some() {
			return Ok(true);
		}
		if Instant::now() >= deadline {
			return Ok(false);
		}
		thread::sleep(POLL_INTERVAL);
	}
}

/// Terminates the server and every process in its group (Unix), escalating
/// SIGTERM → SIGKILL; mirrors the Python client's `_terminate_process_group`.
#[cfg(unix)]
fn terminate(child: &mut Child) -> Result<(), Error> {
	// Spawned with `process_group(0)`: the group id is the leader's pid, and
	// stays valid while any member lives, even after the leader is reaped.
	let pgid = libc::pid_t::try_from(child.id()).map_err(io::Error::other)?;
	let signal_group = |signal| {
		// SAFETY: `kill` has no memory-safety preconditions. ESRCH (group
		// already empty) is expected; the probes below report the outcome.
		unsafe { libc::kill(-pgid, signal) };
	};
	let group_gone = || {
		// SAFETY: as above; signal 0 only probes for a live member.
		let probe = unsafe { libc::kill(-pgid, 0) };
		probe == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
	};
	if leader_exited(child, Duration::ZERO)? && group_gone() {
		return Ok(());
	}
	signal_group(libc::SIGTERM);
	if leader_exited(child, LEADER_EXIT_TIMEOUT)? && group_gone() {
		return Ok(());
	}
	signal_group(libc::SIGKILL);
	if !leader_exited(child, LEADER_EXIT_TIMEOUT)? {
		return Err(io::Error::other("RPC server survived SIGKILL").into());
	}
	let deadline = Instant::now() + KILL_SETTLE_TIMEOUT;
	while !group_gone() {
		if Instant::now() >= deadline {
			return Err(io::Error::other("RPC server process group survived SIGKILL").into());
		}
		thread::sleep(POLL_INTERVAL);
	}
	Ok(())
}

/// Terminates the server (no process groups off Unix).
#[cfg(not(unix))]
fn terminate(child: &mut Child) -> Result<(), Error> {
	if child.try_wait()?.is_some() {
		return Ok(());
	}
	let _ = child.kill();
	if leader_exited(child, LEADER_EXIT_TIMEOUT)? {
		Ok(())
	} else {
		Err(io::Error::other("RPC server survived kill").into())
	}
}
