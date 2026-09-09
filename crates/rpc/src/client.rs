//! Tokio child-process SDK for the `omp rpc` stdio protocol.

use std::{
	collections::{HashMap, HashSet},
	ffi::OsString,
	fmt, io, mem,
	path::PathBuf,
	process::Stdio,
	sync::{
		Arc,
		atomic::{AtomicU8, AtomicU64, Ordering},
	},
	time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	process::{Child, Command},
	sync::{
		Mutex, RwLock,
		broadcast::{self, Receiver},
		oneshot, watch,
	},
	task::JoinHandle,
	time,
};

use crate::{
	framing::{
		FramingError, JsonLineDecoder, MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES, RpcFrameDecoder,
		encode_json_v1, encode_json_v2,
	},
	protocol::{
		Environment, EventCategory, ExtensionUiRequest, ExtensionUiResponse, HostToolCall,
		HostToolCancel, HostToolDefinition, HostToolResult, HostToolUpdate, HostUriCancel,
		HostUriContentType, HostUriOperation, HostUriRequest, HostUriResult, HostUriScheme,
		MAX_HOST_URI_DESCRIPTION_BYTES, MAX_HOST_URI_SCHEME_BYTES, MAX_HOST_URI_SCHEMES,
		NegotiateProtocolParams, NegotiateProtocolResult, NewSessionParams, OAuthProvider,
		PROTOCOL_V1, PROTOCOL_V2, PromptParams, ProtocolVersion, ReadyFrame, RequestId,
		RpcAuthAnswerFrame, RpcAuthMethod, RpcErrorCode, RpcEvent, RpcRequest, RpcResponse,
		SubagentMessages, SubagentSnapshot, SubscriptionLevel, TranscriptCursorError, TranscriptPage,
		TranscriptPageParams,
	},
};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_TERMINATION_GRACE: Duration = Duration::from_secs(1);
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Configuration for spawning an [`RpcClient`].
#[derive(Clone, Debug)]
pub struct RpcClientOptions {
	/// Executable to spawn. Defaults to `omp`.
	pub executable:        OsString,
	/// Child working directory.
	pub cwd:               Option<PathBuf>,
	/// Environment variables added to the inherited environment.
	pub env:               Environment,
	/// Optional provider CLI argument.
	pub provider:          Option<String>,
	/// Optional model CLI argument.
	pub model:             Option<String>,
	/// Optional session directory CLI argument.
	pub session_dir:       Option<PathBuf>,
	/// Additional arguments appended after SDK-owned arguments.
	pub extra_args:        Vec<OsString>,
	/// Time allowed for the startup ready handshake.
	pub ready_timeout:     Duration,
	/// Default command response timeout.
	pub request_timeout:   Duration,
	/// Time allowed for graceful exit before the child is killed.
	pub termination_grace: Duration,
}

impl Default for RpcClientOptions {
	fn default() -> Self {
		Self {
			executable:        "omp".into(),
			cwd:               None,
			env:               Environment::new(),
			provider:          None,
			model:             None,
			session_dir:       None,
			extra_args:        Vec::new(),
			ready_timeout:     DEFAULT_READY_TIMEOUT,
			request_timeout:   DEFAULT_REQUEST_TIMEOUT,
			termination_grace: DEFAULT_TERMINATION_GRACE,
		}
	}
}

/// Failure returned by the child-process SDK.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
	/// The client has already been shut down or its child exited.
	#[error("RPC client is disconnected: {0}")]
	Disconnected(String),
	/// Starting or communicating with the child failed.
	#[error("RPC I/O failed: {0}")]
	Io(#[from] io::Error),
	/// Physical or logical framing failed.
	#[error("RPC framing failed: {0}")]
	Framing(#[from] FramingError),
	/// A protocol envelope could not be serialized or decoded.
	#[error("RPC JSON failed: {0}")]
	Json(#[from] serde_json::Error),
	/// The ready handshake was not received in time.
	#[error("timed out waiting for RPC ready handshake")]
	ReadyTimeout,
	/// The server handshake was incompatible with this SDK.
	#[error("incompatible RPC ready handshake: {0}")]
	IncompatibleHandshake(String),
	/// A command response was not received before its deadline.
	#[error("timed out waiting for RPC command {command}")]
	RequestTimeout {
		/// Command whose response timed out.
		command: String,
	},
	/// The server rejected a command.
	#[error("RPC command {command} failed: {message}")]
	Command {
		/// Rejected command.
		command: String,
		/// Human-readable server diagnostic.
		message: String,
		/// Stable machine-readable reason, when supplied.
		code:    Option<RpcErrorCode>,
	},
	/// A response did not match its request or expected result shape.
	#[error("invalid RPC response: {0}")]
	InvalidResponse(String),
	/// An event subscriber fell behind the bounded event stream.
	#[error("RPC event subscriber lagged by {0} events")]
	EventLagged(u64),
	/// An event collection deadline elapsed.
	#[error("timed out collecting RPC events")]
	EventTimeout,
}

/// Error reported by an embedding host-tool implementation.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct HostToolError {
	/// Text returned to the agent as the tool failure.
	pub message: String,
}

impl HostToolError {
	/// Creates a host-tool failure.
	pub fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

mod host_context {
	use serde_json::Value;
	use tokio::sync::watch::Receiver;

	/// Context passed to a host-tool handler.
	#[derive(Clone, Debug)]
	pub struct HostToolContext {
		/// Model tool-call identifier.
		pub tool_call_id:        String,
		pub(super) cancellation: Receiver<bool>,
		pub(super) updates:      flume::Sender<Value>,
	}

	impl HostToolContext {
		/// Returns whether the server cancelled this invocation.
		pub fn is_cancelled(&self) -> bool {
			*self.cancellation.borrow()
		}

		/// Resolves when the server cancels this invocation.
		pub async fn cancelled(&mut self) {
			if *self.cancellation.borrow() {
				return;
			}
			while self.cancellation.changed().await.is_ok() {
				if *self.cancellation.borrow() {
					return;
				}
			}
		}

		/// Streams an application-native partial result to the server.
		pub fn send_update(&self, partial_result: Value) -> Result<(), flume::SendError<Value>> {
			self.updates.send(partial_result)
		}
	}

	/// Context passed to a host-resource handler.
	#[derive(Clone, Debug)]
	pub struct HostUriContext {
		pub(super) cancellation: Receiver<bool>,
	}

	impl HostUriContext {
		/// Returns whether the server cancelled this operation.
		pub fn is_cancelled(&self) -> bool {
			*self.cancellation.borrow()
		}

		/// Resolves when the server cancels this operation.
		pub async fn cancelled(&mut self) {
			if *self.cancellation.borrow() {
				return;
			}
			while self.cancellation.changed().await.is_ok() {
				if *self.cancellation.borrow() {
					return;
				}
			}
		}
	}
}

pub use host_context::{HostToolContext, HostUriContext};

/// Host-tool implementation stored by the SDK.
///
/// Returning a [`JoinHandle`] avoids an `async_trait` or boxed-future boundary:
/// handlers start their async work with [`tokio::spawn`].
pub trait HostToolHandler: Send + Sync + 'static {
	/// Starts one invocation.
	fn start(
		&self,
		arguments: Map<String, Value>,
		context: HostToolContext,
	) -> JoinHandle<Result<Value, HostToolError>>;
}

impl<F> HostToolHandler for F
where
	F: Fn(Map<String, Value>, HostToolContext) -> JoinHandle<Result<Value, HostToolError>>
		+ Send
		+ Sync
		+ 'static,
{
	fn start(
		&self,
		arguments: Map<String, Value>,
		context: HostToolContext,
	) -> JoinHandle<Result<Value, HostToolError>> {
		self(arguments, context)
	}
}

/// A host-owned tool definition paired with its implementation.
#[derive(Clone)]
pub struct ClientHostTool {
	/// Definition advertised through `set_host_tools`.
	pub definition: HostToolDefinition,
	/// Handler invoked for `host_tool_call` frames.
	pub handler:    Arc<dyn HostToolHandler>,
}

impl fmt::Debug for ClientHostTool {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ClientHostTool")
			.field("definition", &self.definition)
			.finish_non_exhaustive()
	}
}

impl ClientHostTool {
	/// Pairs a serializable tool definition with a handler.
	pub fn new<H>(definition: HostToolDefinition, handler: H) -> Self
	where
		H: HostToolHandler,
	{
		Self { definition, handler: Arc::new(handler) }
	}
}

/// Result returned by a host-resource handler.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostUriResponse {
	/// Resolved read content or optional error context.
	pub content:      Option<String>,
	/// Resolved content type.
	pub content_type: Option<HostUriContentType>,
	/// Caller-facing resolution notes.
	pub notes:        Vec<String>,
	/// Per-resolution immutable override.
	pub immutable:    Option<bool>,
	/// Whether the operation failed.
	pub is_error:     bool,
	/// Preferred failure description.
	pub error:        Option<String>,
}

impl HostUriResponse {
	/// Creates a successful plain-text read response.
	pub fn text(content: impl Into<String>) -> Self {
		Self {
			content: Some(content.into()),
			content_type: Some(HostUriContentType::new(HostUriContentType::TEXT)),
			..Self::default()
		}
	}

	/// Creates a terminal host-resource failure.
	pub fn error(error: impl Into<String>) -> Self {
		Self { is_error: true, error: Some(error.into()), ..Self::default() }
	}
}

/// Host-resource implementation stored by the SDK.
///
/// The handler owns both read and write dispatch so one registration and one
/// cancellation context fence the complete scheme generation.
pub trait HostUriHandler: Send + Sync + 'static {
	/// Starts one host-resource operation.
	fn start(
		&self,
		operation: HostUriOperation,
		url: String,
		content: Option<String>,
		context: HostUriContext,
	) -> JoinHandle<HostUriResponse>;
}

impl<F> HostUriHandler for F
where
	F: Fn(HostUriOperation, String, Option<String>, HostUriContext) -> JoinHandle<HostUriResponse>
		+ Send
		+ Sync
		+ 'static,
{
	fn start(
		&self,
		operation: HostUriOperation,
		url: String,
		content: Option<String>,
		context: HostUriContext,
	) -> JoinHandle<HostUriResponse> {
		self(operation, url, content, context)
	}
}

/// One host-owned URI scheme paired with its asynchronous handler.
#[derive(Clone)]
pub struct ClientHostUriScheme {
	/// Scheme declaration advertised through `set_host_uri_schemes`.
	pub definition: HostUriScheme,
	/// Handler invoked for read and declared-writable operations.
	pub handler:    Arc<dyn HostUriHandler>,
}

impl fmt::Debug for ClientHostUriScheme {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ClientHostUriScheme")
			.field("definition", &self.definition)
			.finish_non_exhaustive()
	}
}

impl ClientHostUriScheme {
	/// Pairs a scheme declaration with its asynchronous handler.
	pub fn new<H>(definition: HostUriScheme, handler: H) -> Self
	where
		H: HostUriHandler,
	{
		Self { definition, handler: Arc::new(handler) }
	}
}

#[derive(Clone, Default)]
struct HostUriRegistry {
	generation: u64,
	schemes:    HashMap<String, ClientHostUriScheme>,
}

struct HostUriCancellation {
	generation: u64,
	sender:     watch::Sender<bool>,
}

/// Filtered typed subscription over the client's event broadcast.
pub struct EventStream {
	receiver: Receiver<RpcEvent>,
	category: Option<EventCategory>,
}

impl EventStream {
	/// Receives the next matching event.
	pub async fn recv(&mut self) -> Result<RpcEvent, ClientError> {
		use tokio::sync::broadcast::error;

		loop {
			match self.receiver.recv().await {
				Ok(event)
					if self
						.category
						.is_none_or(|category| event.category() == category) =>
				{
					return Ok(event);
				},
				Ok(_) => {},
				Err(error::RecvError::Closed) => {
					return Err(ClientError::Disconnected("event stream closed".into()));
				},
				Err(error::RecvError::Lagged(count)) => {
					return Err(ClientError::EventLagged(count));
				},
			}
		}
	}
}

type PendingSender = oneshot::Sender<Result<RpcResponse, ClientError>>;

struct ClientState {
	writer:             Mutex<Option<flume::Sender<Vec<u8>>>>,
	pending:            Mutex<HashMap<RequestId, PendingSender>>,
	events:             broadcast::Sender<RpcEvent>,
	extension_ui:       broadcast::Sender<ExtensionUiRequest>,
	host_tools:         RwLock<HashMap<String, Arc<dyn HostToolHandler>>>,
	host_cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
	host_uri_schemes:   RwLock<HostUriRegistry>,
	host_uri_active:    Mutex<HashMap<String, HostUriCancellation>>,
	ready:              Mutex<Option<oneshot::Sender<ReadyFrame>>>,
	protocol:           AtomicU8,
	sequence:           AtomicU64,
}

impl ClientState {
	async fn send_value(&self, value: &Value) -> Result<(), ClientError> {
		let frames = if self.protocol.load(Ordering::Acquire) == PROTOCOL_V2 {
			let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
			encode_json_v2(value, &format!("sdk_{sequence}"))?
		} else {
			vec![encode_json_v1(value, &HashSet::new())]
		};
		let sender = self
			.writer
			.lock()
			.await
			.clone()
			.ok_or_else(|| ClientError::Disconnected("stdin is closed".into()))?;
		for frame in frames {
			sender
				.send_async(frame)
				.await
				.map_err(|_| ClientError::Disconnected("stdin writer stopped".into()))?;
		}
		Ok(())
	}

	async fn dispatch(self: &Arc<Self>, value: Value) -> Result<(), ClientError> {
		if value.get("type").and_then(Value::as_str) == Some("ready") {
			let ready: ReadyFrame = serde_json::from_value(value)?;
			let sender = self.ready.lock().await.take();
			if let Some(sender) = sender {
				let _ = sender.send(ready);
			}
			return Ok(());
		}
		if value.get("type").and_then(Value::as_str) == Some("response") {
			let response: RpcResponse = serde_json::from_value(value)?;
			if let Some(id) = response.id.clone()
				&& let Some(sender) = self.pending.lock().await.remove(&id)
			{
				let _ = sender.send(Ok(response));
			}
			return Ok(());
		}
		match value.get("type").and_then(Value::as_str) {
			Some("host_tool_call") => {
				let call: HostToolCall = serde_json::from_value(value)?;
				self.start_host_tool(call).await;
				return Ok(());
			},
			Some("host_tool_cancel") => {
				let cancel: HostToolCancel = serde_json::from_value(value)?;
				if let Some(sender) = self.host_cancellations.lock().await.get(&cancel.target_id) {
					let _ = sender.send(true);
				}
				return Ok(());
			},
			Some("host_uri_request") => {
				let request: HostUriRequest = serde_json::from_value(value)?;
				self.start_host_uri(request).await;
				return Ok(());
			},
			Some("host_uri_cancel") => {
				let cancel: HostUriCancel = serde_json::from_value(value)?;
				if let Some(active) = self.host_uri_active.lock().await.get(&cancel.target_id)
					&& active.generation == cancel.generation
				{
					let _ = active.sender.send(true);
				}
				return Ok(());
			},
			Some("extension_ui_request") => {
				let request = serde_json::from_value(value)?;
				let _ = self.extension_ui.send(request);
				return Ok(());
			},
			_ => {},
		}
		let event: RpcEvent = serde_json::from_value(value)?;
		let _ = self.events.send(event);
		Ok(())
	}

	async fn start_host_tool(self: &Arc<Self>, call: HostToolCall) {
		let handler = self.host_tools.read().await.get(&call.tool_name).cloned();
		let Some(handler) = handler else {
			let result = HostToolResult {
				kind:     "host_tool_result".into(),
				id:       call.id,
				result:   json!({"content":[{"type":"text","text":format!("Host tool {:?} is not registered", call.tool_name)}]}),
				is_error: true,
			};
			let state = Arc::clone(self);
			let _task = tokio::spawn(async move {
				if let Ok(value) = serde_json::to_value(result) {
					let _ = state.send_value(&value).await;
				}
			});
			return;
		};
		let (cancel_tx, cancel_rx) = watch::channel(false);
		let (updates_tx, updates_rx) = flume::unbounded();
		self
			.host_cancellations
			.lock()
			.await
			.insert(call.id.clone(), cancel_tx);
		let context = HostToolContext {
			tool_call_id: call.tool_call_id,
			cancellation: cancel_rx,
			updates:      updates_tx,
		};
		let task = handler.start(call.arguments, context);
		let invocation_id = call.id;
		let state = Arc::clone(self);
		let _task = tokio::spawn(async move {
			let update_state = Arc::clone(&state);
			let update_id = invocation_id.clone();
			let update_task = tokio::spawn(async move {
				while let Ok(partial_result) = updates_rx.recv_async().await {
					let update = HostToolUpdate {
						kind: "host_tool_update".into(),
						id: update_id.clone(),
						partial_result,
					};
					if let Ok(value) = serde_json::to_value(update) {
						let _ = update_state.send_value(&value).await;
					}
				}
			});
			let result = match task.await {
				Ok(result) => result,
				Err(error) => Err(HostToolError::new(format!("host tool task failed: {error}"))),
			};
			update_task.abort();
			let cancelled = state
				.host_cancellations
				.lock()
				.await
				.remove(&invocation_id)
				.is_none_or(|sender| *sender.borrow());
			if cancelled {
				return;
			}
			let (result, is_error) = match result {
				Ok(result) => (result, false),
				Err(error) => (json!({"content":[{"type":"text","text":error.message}]}), true),
			};
			let frame =
				HostToolResult { kind: "host_tool_result".into(), id: invocation_id, result, is_error };
			if let Ok(value) = serde_json::to_value(frame) {
				let _ = state.send_value(&value).await;
			}
		});
	}

	async fn start_host_uri(self: &Arc<Self>, request: HostUriRequest) {
		let scheme = request
			.url
			.split_once(':')
			.map(|(scheme, _)| scheme)
			.unwrap_or_default();
		let handler = {
			let registry = self.host_uri_schemes.read().await;
			if registry.generation == request.generation {
				registry
					.schemes
					.get(scheme)
					.filter(|registered| {
						request.operation == HostUriOperation::Read || registered.definition.writable
					})
					.map(|registered| Arc::clone(&registered.handler))
			} else {
				None
			}
		};
		let Some(handler) = handler else {
			let frame = HostUriResult {
				kind:         "host_uri_result".into(),
				id:           request.id,
				generation:   request.generation,
				content:      None,
				content_type: None,
				notes:        Vec::new(),
				immutable:    None,
				is_error:     true,
				error:        Some("host URI request belongs to a stale or unavailable route".into()),
			};
			if let Ok(value) = serde_json::to_value(frame) {
				let _ = self.send_value(&value).await;
			}
			return;
		};

		let (cancel_tx, cancel_rx) = watch::channel(false);
		self
			.host_uri_active
			.lock()
			.await
			.insert(request.id.clone(), HostUriCancellation {
				generation: request.generation,
				sender:     cancel_tx,
			});
		let task = handler.start(request.operation, request.url, request.content, HostUriContext {
			cancellation: cancel_rx,
		});
		let state = Arc::clone(self);
		let request_id = request.id;
		let generation = request.generation;
		let _task = tokio::spawn(async move {
			let response = match task.await {
				Ok(response) => response,
				Err(_) => HostUriResponse::error("host URI handler task failed"),
			};
			let cancelled = state
				.host_uri_active
				.lock()
				.await
				.remove(&request_id)
				.is_none_or(|active| *active.sender.borrow());
			let current_generation = state.host_uri_schemes.read().await.generation;
			if cancelled || current_generation != generation {
				return;
			}
			let frame = HostUriResult {
				kind: "host_uri_result".into(),
				id: request_id,
				generation,
				content: response.content,
				content_type: response.content_type,
				notes: response.notes,
				immutable: response.immutable,
				is_error: response.is_error,
				error: response.error,
			};
			if let Ok(value) = serde_json::to_value(frame) {
				let _ = state.send_value(&value).await;
			}
		});
	}

	async fn fail_all(&self, reason: impl Into<String>) {
		let reason = reason.into();
		self.ready.lock().await.take();
		let pending = mem::take(&mut *self.pending.lock().await);
		for (_, sender) in pending {
			let _ = sender.send(Err(ClientError::Disconnected(reason.clone())));
		}
		let cancellations = mem::take(&mut *self.host_cancellations.lock().await);
		for (_, cancellation) in cancellations {
			let _ = cancellation.send(true);
		}
		let uri_cancellations = mem::take(&mut *self.host_uri_active.lock().await);
		for (_, cancellation) in uri_cancellations {
			let _ = cancellation.sender.send(true);
		}
		*self.host_uri_schemes.write().await = HostUriRegistry::default();
	}
}

/// Programmatic child-process client for `omp rpc`.
pub struct RpcClient {
	state:                 Arc<ClientState>,
	child:                 Mutex<Option<Child>>,
	stderr:                Arc<Mutex<Vec<u8>>>,
	request_ids:           AtomicU64,
	host_uri_generation:   AtomicU64,
	host_uri_registration: Mutex<()>,
	request_timeout:       Duration,
	termination_grace:     Duration,
	reader_task:           JoinHandle<()>,
	writer_task:           JoinHandle<()>,
	stderr_task:           JoinHandle<()>,
}

impl RpcClient {
	/// Spawns `omp rpc`, waits for `ready`, and negotiates protocol v2 when
	/// advertised.
	#[tracing::instrument(level = "debug", skip_all, fields(rpc.service = "stdio", rpc.method = "connect"))]
	pub async fn spawn(options: RpcClientOptions) -> Result<Self, ClientError> {
		let mut command = Command::new(&options.executable);
		command.arg("rpc");
		if let Some(provider) = &options.provider {
			command.arg("--provider").arg(provider);
		}
		if let Some(model) = &options.model {
			command.arg("--model").arg(model);
		}
		if let Some(session_dir) = &options.session_dir {
			command.arg("--session-dir").arg(session_dir);
		}
		command
			.args(&options.extra_args)
			.envs(&options.env)
			.env("OMP_NOTIFICATIONS", "off")
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);
		if let Some(cwd) = &options.cwd {
			command.current_dir(cwd);
		}
		let mut child = command.spawn()?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| ClientError::Disconnected("child stdin was not piped".into()))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| ClientError::Disconnected("child stdout was not piped".into()))?;
		let stderr_pipe = child
			.stderr
			.take()
			.ok_or_else(|| ClientError::Disconnected("child stderr was not piped".into()))?;
		let (writer_tx, writer_rx) = flume::unbounded();
		let (event_tx, _) = broadcast::channel(1024);
		let (extension_ui_tx, _) = broadcast::channel(64);
		let (ready_tx, ready_rx) = oneshot::channel();
		let state = Arc::new(ClientState {
			writer:             Mutex::new(Some(writer_tx)),
			pending:            Mutex::new(HashMap::new()),
			events:             event_tx,
			extension_ui:       extension_ui_tx,
			host_tools:         RwLock::new(HashMap::new()),
			host_cancellations: Mutex::new(HashMap::new()),
			host_uri_schemes:   RwLock::new(HostUriRegistry::default()),
			host_uri_active:    Mutex::new(HashMap::new()),
			ready:              Mutex::new(Some(ready_tx)),
			protocol:           AtomicU8::new(PROTOCOL_V1),
			sequence:           AtomicU64::new(1),
		});
		let writer_state = Arc::clone(&state);
		let writer_task = tokio::spawn(async move {
			let mut stdin = stdin;
			while let Ok(frame) = writer_rx.recv_async().await {
				if let Err(error) = stdin.write_all(&frame).await {
					tracing::warn!(%error, "RPC transport write failed");
					writer_state
						.fail_all(format!("stdin write failed: {error}"))
						.await;
					return;
				}
				if let Err(error) = stdin.flush().await {
					tracing::warn!(%error, "RPC transport flush failed");
					writer_state
						.fail_all(format!("stdin flush failed: {error}"))
						.await;
					return;
				}
			}
			let _ = stdin.shutdown().await;
		});
		let reader_state = Arc::clone(&state);
		let reader_task = tokio::spawn(async move {
			let mut stdout = stdout;
			let mut bytes = [0_u8; 16 * 1024];
			let mut physical = JsonLineDecoder::new();
			let mut logical = RpcFrameDecoder::new();
			loop {
				let count = match stdout.read(&mut bytes).await {
					Ok(0) => {
						reader_state.fail_all("stdout closed").await;
						return;
					},
					Ok(count) => count,
					Err(error) => {
						tracing::warn!(%error, "RPC transport read failed");
						reader_state
							.fail_all(format!("stdout read failed: {error}"))
							.await;
						return;
					},
				};
				let batch = physical.push(&bytes[..count]);
				for frame in batch.frames {
					match logical.push_frame(&frame) {
						Ok(Some(value)) => {
							if let Err(error) = reader_state.dispatch(value).await {
								tracing::warn!(%error, "RPC response dispatch failed");
								reader_state.fail_all(error.to_string()).await;
								return;
							}
						},
						Ok(None) => {},
						Err(error) => {
							tracing::warn!(%error, "RPC frame decoding failed");
							reader_state.fail_all(error.to_string()).await;
							return;
						},
					}
				}
			}
		});
		let stderr = Arc::new(Mutex::new(Vec::new()));
		let stderr_buffer = Arc::clone(&stderr);
		let stderr_task = tokio::spawn(async move {
			let mut stderr_pipe = stderr_pipe;
			let mut bytes = [0_u8; 4096];
			while let Ok(count) = stderr_pipe.read(&mut bytes).await {
				if count == 0 {
					break;
				}
				let mut buffer = stderr_buffer.lock().await;
				buffer.extend_from_slice(&bytes[..count]);
				if buffer.len() > MAX_STDERR_BYTES {
					let remove = buffer.len() - MAX_STDERR_BYTES;
					buffer.drain(..remove);
				}
			}
		});
		let client = Self {
			state,
			child: Mutex::new(Some(child)),
			stderr,
			request_ids: AtomicU64::new(1),
			host_uri_generation: AtomicU64::new(0),
			host_uri_registration: Mutex::new(()),
			request_timeout: options.request_timeout,
			termination_grace: options.termination_grace,
			reader_task,
			writer_task,
			stderr_task,
		};
		let ready = match time::timeout(options.ready_timeout, ready_rx).await {
			Ok(Ok(ready)) => ready,
			Ok(Err(_)) => {
				tracing::warn!("RPC child exited before ready handshake");
				client.shutdown().await?;
				return Err(ClientError::Disconnected("child exited before ready".into()));
			},
			Err(_) => {
				tracing::warn!("RPC ready handshake timed out");
				client.shutdown().await?;
				return Err(ClientError::ReadyTimeout);
			},
		};
		if let Err(error) = Self::validate_ready(&ready) {
			tracing::warn!(%error, "RPC ready handshake rejected");
			let _ = client.shutdown().await;
			return Err(error);
		}
		if ready.supports(ProtocolVersion::V2) {
			let negotiated: NegotiateProtocolResult = match client
				.request("negotiate_protocol", &NegotiateProtocolParams {
					protocol_version: ProtocolVersion::V2,
				})
				.await
			{
				Ok(negotiated) => negotiated,
				Err(error) => {
					tracing::warn!(%error, "RPC protocol negotiation failed");
					let _ = client.shutdown().await;
					return Err(error);
				},
			};
			if negotiated.protocol_version != ProtocolVersion::V2 {
				let error =
					ClientError::IncompatibleHandshake("server did not activate protocol v2".into());
				tracing::warn!(%error, "RPC protocol negotiation rejected");
				let _ = client.shutdown().await;
				return Err(error);
			}
			client.state.protocol.store(PROTOCOL_V2, Ordering::Release);
		}
		tracing::debug!(protocol = client.protocol_version().0, "RPC channel handshake completed");
		Ok(client)
	}

	fn validate_ready(ready: &ReadyFrame) -> Result<(), ClientError> {
		if ready.kind != "ready" || ready.protocol_version != ProtocolVersion::V1 {
			return Err(ClientError::IncompatibleHandshake(
				"expected initial protocol v1 ready frame".into(),
			));
		}
		if ready.max_frame_bytes != MAX_FRAME_BYTES
			|| ready.max_reassembled_frame_bytes != MAX_REASSEMBLED_BYTES
		{
			return Err(ClientError::IncompatibleHandshake(
				"server and SDK framing limits differ".into(),
			));
		}
		Ok(())
	}

	/// Returns the currently active protocol.
	pub fn protocol_version(&self) -> ProtocolVersion {
		ProtocolVersion(self.state.protocol.load(Ordering::Acquire))
	}

	/// Sends any command and deserializes its successful `data` payload.
	pub async fn request<P, R>(&self, command: &str, params: &P) -> Result<R, ClientError>
	where
		P: Serialize + Sync + ?Sized,
		R: DeserializeOwned,
	{
		self
			.request_with_timeout(command, params, self.request_timeout)
			.await
	}

	/// Generic request escape hatch with an explicit response deadline.
	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "stdio", rpc.method = %command)
	)]
	pub async fn request_with_timeout<P, R>(
		&self,
		command: &str,
		params: &P,
		timeout: Duration,
	) -> Result<R, ClientError>
	where
		P: Serialize + Sync + ?Sized,
		R: DeserializeOwned,
	{
		let id =
			RequestId::new(format!("req_{}", self.request_ids.fetch_add(1, Ordering::Relaxed) + 1));
		let request = RpcRequest::from_params(Some(id.clone()), command, params)?;
		let value = serde_json::to_value(request)?;
		let (sender, receiver) = oneshot::channel();
		self.state.pending.lock().await.insert(id.clone(), sender);
		if let Err(error) = self.state.send_value(&value).await {
			self.state.pending.lock().await.remove(&id);
			return Err(error);
		}
		let response = match time::timeout(timeout, receiver).await {
			Ok(Ok(response)) => response?,
			Ok(Err(_)) => return Err(ClientError::Disconnected("response dispatcher stopped".into())),
			Err(_) => {
				self.state.pending.lock().await.remove(&id);
				return Err(ClientError::RequestTimeout { command: command.into() });
			},
		};
		if response.command != command {
			return Err(ClientError::InvalidResponse(format!(
				"request {id} expected {command}, received {}",
				response.command
			)));
		}
		if !response.success {
			return Err(ClientError::Command {
				command: response.command,
				message: response
					.error
					.unwrap_or_else(|| "command failed without an error message".into()),
				code:    response.code,
			});
		}
		serde_json::from_value(response.data.unwrap_or(Value::Null)).map_err(ClientError::from)
	}

	/// Sends a prompt and returns when it has been accepted.
	pub async fn prompt(
		&self,
		message: impl Into<String>,
		images: Vec<Value>,
	) -> Result<Value, ClientError> {
		self
			.request("prompt", &PromptParams {
				message: message.into(),
				images,
				streaming_behavior: None,
			})
			.await
	}

	/// Sends a steering message during the active turn.
	pub async fn steer(
		&self,
		message: impl Into<String>,
		images: Vec<Value>,
	) -> Result<Value, ClientError> {
		self
			.request("steer", &PromptParams {
				message: message.into(),
				images,
				streaming_behavior: None,
			})
			.await
	}

	/// Queues a message after the active turn.
	pub async fn follow_up(
		&self,
		message: impl Into<String>,
		images: Vec<Value>,
	) -> Result<Value, ClientError> {
		self
			.request("follow_up", &PromptParams {
				message: message.into(),
				images,
				streaming_behavior: None,
			})
			.await
	}

	/// Aborts the active operation.
	pub async fn abort(&self) -> Result<Value, ClientError> {
		self.request("abort", &()).await
	}

	/// Aborts and immediately starts a new prompt.
	pub async fn abort_and_prompt(
		&self,
		message: impl Into<String>,
		images: Vec<Value>,
	) -> Result<Value, ClientError> {
		self
			.request("abort_and_prompt", &PromptParams {
				message: message.into(),
				images,
				streaming_behavior: None,
			})
			.await
	}

	/// Starts a new session, optionally tracking its parent session.
	pub async fn new_session(&self, parent_session: Option<String>) -> Result<Value, ClientError> {
		self
			.request("new_session", &NewSessionParams { parent_session })
			.await
	}

	/// Returns current application-owned session state.
	pub async fn get_state(&self) -> Result<Value, ClientError> {
		self.request("get_state", &()).await
	}

	/// Enables or disables fast mode.
	pub async fn set_fast_mode(&self, enabled: bool) -> Result<Value, ClientError> {
		self
			.request("set_fast_mode", &json!({"enabled":enabled}))
			.await
	}

	/// Returns the current slash-command roster.
	pub async fn get_available_commands(&self) -> Result<Value, ClientError> {
		self.request("get_available_commands", &()).await
	}

	/// Replaces the todo phases.
	pub async fn set_todos(&self, phases: Vec<Value>) -> Result<Value, ClientError> {
		self.request("set_todos", &json!({"phases":phases})).await
	}

	/// Selects a model by provider and model identifier.
	pub async fn set_model(&self, provider: &str, model_id: &str) -> Result<Value, ClientError> {
		self
			.request("set_model", &json!({"provider":provider,"modelId":model_id}))
			.await
	}

	/// Cycles to the next configured model.
	pub async fn cycle_model(&self) -> Result<Value, ClientError> {
		self.request("cycle_model", &()).await
	}

	/// Returns available models.
	pub async fn get_available_models(&self) -> Result<Value, ClientError> {
		self.request("get_available_models", &()).await
	}

	/// Sets the application-defined thinking level.
	pub async fn set_thinking_level(&self, level: &str) -> Result<Value, ClientError> {
		self
			.request("set_thinking_level", &json!({"level":level}))
			.await
	}

	/// Cycles the thinking level.
	pub async fn cycle_thinking_level(&self) -> Result<Value, ClientError> {
		self.request("cycle_thinking_level", &()).await
	}

	/// Selects steering queue behavior.
	pub async fn set_steering_mode(&self, mode: &str) -> Result<Value, ClientError> {
		self
			.request("set_steering_mode", &json!({"mode":mode}))
			.await
	}

	/// Selects follow-up queue behavior.
	pub async fn set_follow_up_mode(&self, mode: &str) -> Result<Value, ClientError> {
		self
			.request("set_follow_up_mode", &json!({"mode":mode}))
			.await
	}

	/// Selects immediate or wait interrupt behavior.
	pub async fn set_interrupt_mode(&self, mode: &str) -> Result<Value, ClientError> {
		self
			.request("set_interrupt_mode", &json!({"mode":mode}))
			.await
	}

	/// Compacts session context.
	pub async fn compact(&self, custom_instructions: Option<String>) -> Result<Value, ClientError> {
		self
			.request("compact", &json!({"customInstructions":custom_instructions}))
			.await
	}

	/// Configures automatic compaction.
	pub async fn set_auto_compaction(&self, enabled: bool) -> Result<Value, ClientError> {
		self
			.request("set_auto_compaction", &json!({"enabled":enabled}))
			.await
	}

	/// Configures automatic retries.
	pub async fn set_auto_retry(&self, enabled: bool) -> Result<Value, ClientError> {
		self
			.request("set_auto_retry", &json!({"enabled":enabled}))
			.await
	}

	/// Aborts an in-progress retry delay.
	pub async fn abort_retry(&self) -> Result<Value, ClientError> {
		self.request("abort_retry", &()).await
	}

	/// Runs a headless shell command.
	pub async fn bash(&self, command: &str) -> Result<Value, ClientError> {
		self.request("bash", &json!({"command":command})).await
	}

	/// Aborts the active headless shell command.
	pub async fn abort_bash(&self) -> Result<Value, ClientError> {
		self.request("abort_bash", &()).await
	}

	/// Returns session statistics.
	pub async fn get_session_stats(&self) -> Result<Value, ClientError> {
		self.request("get_session_stats", &()).await
	}

	/// Exports the current session to HTML.
	pub async fn export_html(&self, output_path: Option<PathBuf>) -> Result<Value, ClientError> {
		self
			.request("export_html", &json!({"outputPath":output_path}))
			.await
	}

	/// Switches to another session file.
	pub async fn switch_session(&self, session_path: &str) -> Result<Value, ClientError> {
		self
			.request("switch_session", &json!({"sessionPath":session_path}))
			.await
	}

	/// Branches from a transcript entry.
	pub async fn branch(&self, entry_id: &str) -> Result<Value, ClientError> {
		self.request("branch", &json!({"entryId":entry_id})).await
	}

	/// Returns messages eligible as branch points.
	pub async fn get_branch_messages(&self) -> Result<Value, ClientError> {
		self.request("get_branch_messages", &()).await
	}

	/// Returns the last assistant text, if present.
	pub async fn get_last_assistant_text(&self) -> Result<Option<String>, ClientError> {
		#[derive(serde::Deserialize)]
		struct ResultBody {
			text: Option<String>,
		}
		Ok(self
			.request::<_, ResultBody>("get_last_assistant_text", &())
			.await?
			.text)
	}

	/// Renames the current session.
	pub async fn set_session_name(&self, name: &str) -> Result<Value, ClientError> {
		self
			.request("set_session_name", &json!({"name":name}))
			.await
	}

	/// Hands session context to a new session.
	pub async fn handoff(&self, custom_instructions: Option<String>) -> Result<Value, ClientError> {
		self
			.request("handoff", &json!({"customInstructions":custom_instructions}))
			.await
	}

	/// Fetches one stable transcript page.
	pub async fn get_messages_page(
		&self,
		params: TranscriptPageParams,
	) -> Result<TranscriptPage, ClientError> {
		self.request("get_messages_page", &params).await
	}

	/// Drains stable transcript pages, falling back to `get_messages` on cursor
	/// races.
	pub async fn drain_messages(&self) -> Result<Vec<Value>, ClientError> {
		if self.protocol_version() == ProtocolVersion::V2 {
			match self.drain_message_pages().await {
				Ok(messages) => return Ok(messages),
				Err(ClientError::Command { code: Some(code), .. })
					if TranscriptCursorError::from_code(&code).is_some() => {},
				Err(error) => return Err(error),
			}
		}
		#[derive(serde::Deserialize)]
		struct Messages {
			messages: Vec<Value>,
		}
		Ok(self
			.request::<_, Messages>("get_messages", &())
			.await?
			.messages)
	}

	async fn drain_message_pages(&self) -> Result<Vec<Value>, ClientError> {
		let mut messages = Vec::new();
		let mut cursor = None;
		let mut expected_total = None;
		let mut seen = HashSet::new();
		loop {
			let page = self
				.get_messages_page(TranscriptPageParams { cursor, limit: Some(256) })
				.await?;
			if expected_total.is_some_and(|total| total != page.total_messages) {
				return Err(ClientError::InvalidResponse(
					"transcript total changed between pages".into(),
				));
			}
			expected_total = Some(page.total_messages);
			messages.extend(page.messages);
			let Some(next) = page.next_cursor else {
				break;
			};
			if !seen.insert(next.clone()) {
				return Err(ClientError::InvalidResponse("transcript cursor repeated".into()));
			}
			cursor = Some(next);
		}
		if messages.len() != expected_total.unwrap_or(0) {
			return Err(ClientError::InvalidResponse(
				"transcript ended before advertised total".into(),
			));
		}
		Ok(messages)
	}

	/// Returns OAuth login providers.
	pub async fn get_login_providers(&self) -> Result<Vec<OAuthProvider>, ClientError> {
		#[derive(serde::Deserialize)]
		struct Providers {
			providers: Vec<OAuthProvider>,
		}
		Ok(self
			.request::<_, Providers>("get_login_providers", &())
			.await?
			.providers)
	}

	/// Starts the provider's default typed authentication flow.
	pub async fn login(&self, provider_id: &str) -> Result<Value, ClientError> {
		self.login_with_method(provider_id, None).await
	}

	/// Starts a typed authentication flow.
	pub async fn login_with_method(
		&self,
		provider_id: &str,
		method: Option<RpcAuthMethod>,
	) -> Result<Value, ClientError> {
		self
			.request_with_timeout(
				"login",
				&json!({"providerId":provider_id,"method":method}),
				Duration::from_secs(600),
			)
			.await
	}

	/// Responds to an extension UI request.
	pub async fn respond_extension_ui(
		&self,
		response: ExtensionUiResponse,
	) -> Result<(), ClientError> {
		self
			.state
			.send_value(&serde_json::to_value(response)?)
			.await
	}

	/// Replaces host-owned tools and advertises their definitions to the server.
	pub async fn set_host_tools(
		&self,
		tools: Vec<ClientHostTool>,
	) -> Result<Vec<String>, ClientError> {
		let definitions: Vec<_> = tools.iter().map(|tool| tool.definition.clone()).collect();
		{
			let mut handlers = self.state.host_tools.write().await;
			handlers.clear();
			for tool in tools {
				handlers.insert(tool.definition.name, tool.handler);
			}
		}
		#[derive(serde::Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct ToolNames {
			tool_names: Vec<String>,
		}
		Ok(self
			.request::<_, ToolNames>("set_host_tools", &json!({"tools":definitions}))
			.await?
			.tool_names)
	}

	/// Replaces every host-owned URI scheme as one generation.
	pub async fn set_host_uri_schemes(
		&self,
		schemes: Vec<ClientHostUriScheme>,
	) -> Result<Vec<String>, ClientError> {
		let _registration = self.host_uri_registration.lock().await;
		if schemes.len() > MAX_HOST_URI_SCHEMES {
			return Err(ClientError::InvalidResponse(format!(
				"at most {MAX_HOST_URI_SCHEMES} host URI schemes may be registered"
			)));
		}
		let generation = self
			.host_uri_generation
			.try_update(Ordering::AcqRel, Ordering::Acquire, |current| current.checked_add(1))
			.map(|previous| previous + 1)
			.map_err(|_| {
				ClientError::InvalidResponse("host URI generation space is exhausted".into())
			})?;
		let mut registered = HashMap::with_capacity(schemes.len());
		for mut scheme in schemes {
			let normalized = scheme.definition.scheme.trim().to_ascii_lowercase();
			let mut bytes = normalized.bytes();
			if normalized.is_empty()
				|| normalized.len() > MAX_HOST_URI_SCHEME_BYTES
				|| !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
				|| !bytes.all(|byte| {
					byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"+.-".contains(&byte)
				}) {
				return Err(ClientError::InvalidResponse(
					"host URI schemes must match ^[a-z][a-z0-9+.-]*$".into(),
				));
			}
			if scheme
				.definition
				.description
				.as_ref()
				.is_some_and(|description| description.len() > MAX_HOST_URI_DESCRIPTION_BYTES)
			{
				return Err(ClientError::InvalidResponse(
					"host URI scheme description exceeds the protocol limit".into(),
				));
			}
			scheme.definition.scheme = normalized.clone();
			if registered.insert(normalized, scheme).is_some() {
				return Err(ClientError::InvalidResponse(
					"host URI schemes must be unique after normalization".into(),
				));
			}
		}
		let definitions = registered
			.values()
			.map(|registered| registered.definition.clone())
			.collect::<Vec<_>>();
		let previous = {
			let mut registry = self.state.host_uri_schemes.write().await;
			mem::replace(&mut *registry, HostUriRegistry { generation, schemes: registered })
		};

		#[derive(serde::Deserialize)]
		struct RegisteredSchemes {
			generation: u64,
			schemes:    Vec<String>,
		}
		let response = self
			.request::<_, RegisteredSchemes>(
				"set_host_uri_schemes",
				&json!({"generation":generation,"schemes":definitions}),
			)
			.await;
		match response {
			Ok(response) if response.generation == generation => Ok(response.schemes),
			Ok(response) => {
				let mut registry = self.state.host_uri_schemes.write().await;
				if registry.generation == generation {
					*registry = previous;
				}
				Err(ClientError::InvalidResponse(format!(
					"host URI generation mismatch: requested {generation}, received {}",
					response.generation
				)))
			},
			Err(error) => {
				let mut registry = self.state.host_uri_schemes.write().await;
				if registry.generation == generation {
					*registry = previous;
				}
				Err(error)
			},
		}
	}

	/// Sends typed input to an active authentication exchange.
	pub async fn respond_auth(&self, response: RpcAuthAnswerFrame) -> Result<(), ClientError> {
		self
			.state
			.send_value(&serde_json::to_value(response)?)
			.await
	}

	/// Configures subagent lifecycle/progress/event publication.
	pub async fn set_subagent_subscription(
		&self,
		level: SubscriptionLevel,
	) -> Result<SubscriptionLevel, ClientError> {
		#[derive(serde::Deserialize)]
		struct Level {
			level: SubscriptionLevel,
		}
		Ok(self
			.request::<_, Level>("set_subagent_subscription", &json!({"level":level}))
			.await?
			.level)
	}

	/// Returns the server's current in-memory subagent snapshot.
	pub async fn get_subagents(&self) -> Result<Vec<SubagentSnapshot>, ClientError> {
		#[derive(serde::Deserialize)]
		struct Subagents {
			subagents: Vec<SubagentSnapshot>,
		}
		Ok(self
			.request::<_, Subagents>("get_subagents", &())
			.await?
			.subagents)
	}

	/// Incrementally reads one tracked subagent transcript.
	pub async fn get_subagent_messages(
		&self,
		subagent_id: Option<&str>,
		session_file: Option<&str>,
		from_byte: Option<u64>,
	) -> Result<SubagentMessages, ClientError> {
		self
			.request(
				"get_subagent_messages",
				&json!({"subagentId":subagent_id,"sessionFile":session_file,"fromByte":from_byte}),
			)
			.await
	}

	/// Subscribes to all event frames.
	pub fn events(&self) -> EventStream {
		EventStream { receiver: self.state.events.subscribe(), category: None }
	}

	/// Subscribes to one typed event category.
	pub fn events_by_category(&self, category: EventCategory) -> EventStream {
		EventStream { receiver: self.state.events.subscribe(), category: Some(category) }
	}

	/// Subscribes to extension UI requests, including the OAuth `open_url` seam.
	pub fn extension_ui_requests(&self) -> Receiver<ExtensionUiRequest> {
		self.state.extension_ui.subscribe()
	}

	/// Collects events through the terminal `agent_end` frame.
	pub async fn collect_events(&self, timeout: Duration) -> Result<Vec<RpcEvent>, ClientError> {
		let mut events = self.events();
		let collect = async {
			let mut collected = Vec::new();
			loop {
				let event = events.recv().await?;
				let terminal = event.kind == "agent_end";
				collected.push(event);
				if terminal {
					return Ok(collected);
				}
			}
		};
		match time::timeout(timeout, collect).await {
			Ok(result) => result,
			Err(_) => Err(ClientError::EventTimeout),
		}
	}

	/// Subscribes before sending a prompt, then collects through `agent_end`.
	pub async fn prompt_and_wait(
		&self,
		message: impl Into<String>,
		images: Vec<Value>,
		timeout: Duration,
	) -> Result<Vec<RpcEvent>, ClientError> {
		let mut events = self.events();
		self.prompt(message, images).await?;
		let collect = async {
			let mut collected = Vec::new();
			loop {
				let event = events.recv().await?;
				let terminal = event.kind == "agent_end";
				collected.push(event);
				if terminal {
					return Ok(collected);
				}
			}
		};
		match time::timeout(timeout, collect).await {
			Ok(result) => result,
			Err(_) => Err(ClientError::EventTimeout),
		}
	}

	/// Returns the bounded tail of child stderr captured by the SDK.
	pub async fn stderr(&self) -> String {
		String::from_utf8_lossy(&self.stderr.lock().await).into_owned()
	}

	/// Closes stdin, waits for graceful child exit, then kills it after the
	/// configured grace.
	pub async fn shutdown(&self) -> Result<(), ClientError> {
		self.state.writer.lock().await.take();
		self.state.fail_all("client shut down").await;
		let child = self.child.lock().await.take();
		let Some(mut child) = child else {
			return Ok(());
		};
		if let Ok(status) = time::timeout(self.termination_grace, child.wait()).await {
			status?;
		} else {
			child.start_kill()?;
			child.wait().await?;
		}
		self.reader_task.abort();
		self.writer_task.abort();
		self.stderr_task.abort();
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn in_memory_state() -> Arc<ClientState> {
		let (writer, _) = flume::unbounded();
		let (events, _) = broadcast::channel(8);
		let (extension_ui, _) = broadcast::channel(8);
		Arc::new(ClientState {
			writer: Mutex::new(Some(writer)),
			pending: Mutex::new(HashMap::new()),
			events,
			extension_ui,
			host_tools: RwLock::new(HashMap::new()),
			host_cancellations: Mutex::new(HashMap::new()),
			host_uri_schemes: RwLock::new(HostUriRegistry::default()),
			host_uri_active: Mutex::new(HashMap::new()),
			ready: Mutex::new(None),
			protocol: AtomicU8::new(PROTOCOL_V2),
			sequence: AtomicU64::new(1),
		})
	}

	#[tokio::test]
	async fn chunked_response_is_reassembled_and_correlated() {
		let state = in_memory_state();
		let id = RequestId::new("req_7");
		let (sender, receiver) = oneshot::channel();
		state.pending.lock().await.insert(id.clone(), sender);
		let response = RpcResponse::success(
			Some(id),
			"get_messages",
			json!({"messages":["x".repeat(MAX_FRAME_BYTES + 17)]}),
		)
		.unwrap();
		let physical_frames =
			encode_json_v2(&serde_json::to_value(response).unwrap(), "response_7").unwrap();
		assert!(physical_frames.len() > 1);

		let mut content_length = JsonLineDecoder::new();
		let mut logical = RpcFrameDecoder::new();
		for framed in physical_frames {
			for bytes in framed.chunks(7919) {
				for payload in content_length.push(bytes).frames {
					if let Some(value) = logical.push_frame(&payload).unwrap() {
						state.dispatch(value).await.unwrap();
					}
				}
			}
		}
		let correlated = receiver.await.unwrap().unwrap();
		assert_eq!(correlated.command, "get_messages");
		assert_eq!(
			correlated.data.unwrap()["messages"][0]
				.as_str()
				.unwrap()
				.len(),
			MAX_FRAME_BYTES + 17
		);
		assert!(state.pending.lock().await.is_empty());
	}

	#[tokio::test]
	async fn interleaved_event_does_not_consume_pending_response() {
		let state = in_memory_state();
		let mut events = state.events.subscribe();
		let id = RequestId::new("req_9");
		let (sender, receiver) = oneshot::channel();
		state.pending.lock().await.insert(id.clone(), sender);
		state
			.dispatch(json!({"type":"message_update","delta":"hello"}))
			.await
			.unwrap();
		state
			.dispatch(
				serde_json::to_value(
					RpcResponse::success(Some(id), "get_state", json!({"idle":true})).unwrap(),
				)
				.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(events.recv().await.unwrap().kind, "message_update");
		assert_eq!(receiver.await.unwrap().unwrap().command, "get_state");
	}
}
