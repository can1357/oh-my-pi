//! Bounded child-process JSON-RPC transport and production LSP binding startup.

use std::{
	collections::{BTreeMap, HashMap, VecDeque},
	env, fs,
	future::Future,
	io, mem,
	path::{Path, PathBuf},
	pin::Pin,
	process,
	process::Stdio,
	str,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use flume::Sender;
use omp_core::{Str, sf};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, value::RawValue};
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
	process::{Child, Command},
	sync::{
		OwnedSemaphorePermit, Semaphore, oneshot,
		watch::{self, Receiver},
	},
	task::JoinHandle,
	time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	Environment, LanguageId,
	lsp::{LspError, LspServer, LspTransport, LspTransportError},
	lsp_apply_edit,
	lsp_binary::{BinaryPlatform, LspBinaryError, resolve_lsp_binary},
	lsp_registry::{
		LspBindingHandle, LspBindingId, LspBindingSpec, LspRegistry, LspRegistryError, LspSelector,
	},
};

const DEFAULT_MAX_HEADER_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_WRITER_QUEUE_CAPACITY: usize = 64;
const DEFAULT_INITIALIZE_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_INBOUND_QUEUE_CAPACITY: usize = 64;
const DEFAULT_MAX_PENDING_REQUESTS: usize = 128;
const DEFAULT_SHUTDOWN_TIMEOUT_MS: u64 = 3_000;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_INITIALIZE_TIMEOUT_MS: u64 = 120_000;
const MAX_QUEUE_CAPACITY: usize = 4_096;
const MAX_PENDING_REQUESTS: usize = 4_096;
const MAX_SHUTDOWN_TIMEOUT_MS: u64 = 60_000;
const JSON_RPC_VERSION: &str = "2.0";

mod channel_receiver {
	use flume::Receiver;

	pub(super) struct ChannelReceiver<T>(Receiver<T>);

	impl<T> ChannelReceiver<T> {
		pub(super) const fn new(receiver: Receiver<T>) -> Self {
			Self(receiver)
		}

		pub(super) async fn recv(&self) -> Option<T> {
			self.0.recv_async().await.ok()
		}
	}
}

use channel_receiver::ChannelReceiver;

/// Serializable selector for a process-backed LSP binding.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct LspProcessSelectorConfig {
	/// LSP language identifiers accepted by this binding. Empty matches all.
	pub languages:     Vec<Str>,
	/// URI schemes accepted by this binding. Empty matches all.
	pub schemes:       Vec<Str>,
	/// URI-path glob patterns accepted by this binding. Empty matches all.
	pub path_patterns: Vec<Str>,
}

/// Explicit memory and cardinality limits for one child transport.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct LspTransportSettings {
	/// Maximum bytes permitted before the terminating blank header line.
	/// Defaults to 8 KiB and is capped at 64 KiB.
	pub max_header_bytes:       usize,
	/// Maximum JSON payload size for both inbound and outbound messages.
	/// Defaults to 16 MiB and is capped at 64 MiB.
	pub max_message_bytes:      usize,
	/// Maximum messages waiting for the single serialized writer. Defaults to
	/// 64 and is capped at 4096.
	pub writer_queue_capacity:  usize,
	/// Maximum inbound requests or notifications awaiting dispatch. Defaults
	/// to 64 and is capped at 4096.
	pub inbound_queue_capacity: usize,
	/// Initialize-handshake deadline in milliseconds. Defaults to 10 seconds
	/// and is capped at 120 seconds.
	pub initialize_timeout_ms:  u64,
	/// Maximum outbound requests awaiting responses. Defaults to 128 and is
	/// capped at 4096.
	pub max_pending_requests:   usize,
	/// Graceful-shutdown deadline in milliseconds. Defaults to 3 seconds and is
	/// capped at 60 seconds.
	pub shutdown_timeout_ms:    u64,
}

impl Default for LspTransportSettings {
	fn default() -> Self {
		Self {
			max_header_bytes:       DEFAULT_MAX_HEADER_BYTES,
			max_message_bytes:      DEFAULT_MAX_MESSAGE_BYTES,
			writer_queue_capacity:  DEFAULT_WRITER_QUEUE_CAPACITY,
			initialize_timeout_ms:  DEFAULT_INITIALIZE_TIMEOUT_MS,
			inbound_queue_capacity: DEFAULT_INBOUND_QUEUE_CAPACITY,
			max_pending_requests:   DEFAULT_MAX_PENDING_REQUESTS,
			shutdown_timeout_ms:    DEFAULT_SHUTDOWN_TIMEOUT_MS,
		}
	}
}

impl LspTransportSettings {
	fn validate(&self) -> Result<(), LspProcessError> {
		validate_limit("max_header_bytes", self.max_header_bytes, MAX_HEADER_BYTES)?;
		validate_limit("max_message_bytes", self.max_message_bytes, MAX_MESSAGE_BYTES)?;
		validate_limit("writer_queue_capacity", self.writer_queue_capacity, MAX_QUEUE_CAPACITY)?;
		validate_limit("inbound_queue_capacity", self.inbound_queue_capacity, MAX_QUEUE_CAPACITY)?;
		validate_limit("max_pending_requests", self.max_pending_requests, MAX_PENDING_REQUESTS)?;
		if self.initialize_timeout_ms == 0 || self.initialize_timeout_ms > MAX_INITIALIZE_TIMEOUT_MS {
			return Err(LspProcessError::InvalidTimeout {
				setting: "initialize_timeout_ms",
				max:     MAX_INITIALIZE_TIMEOUT_MS,
			});
		}
		if self.shutdown_timeout_ms == 0 || self.shutdown_timeout_ms > MAX_SHUTDOWN_TIMEOUT_MS {
			return Err(LspProcessError::InvalidTimeout {
				setting: "shutdown_timeout_ms",
				max:     MAX_SHUTDOWN_TIMEOUT_MS,
			});
		}
		Ok(())
	}
}

/// Complete declaration for one executable-backed language-server binding.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspProcessConfig {
	/// Unique binding name exposed through the document protocol.
	pub name:                   Str,
	/// Selection priority. Higher values are selected first.
	#[serde(default)]
	pub priority:               i32,
	/// Language, URI-scheme, and URI-path restrictions.
	#[serde(default)]
	pub selector:               LspProcessSelectorConfig,
	/// Executable path or program name resolved by the child environment.
	pub executable:             PathBuf,
	/// Ordered command-line arguments passed without shell interpretation.
	#[serde(default)]
	pub args:                   Vec<Str>,
	/// Environment entries added or replaced for the child.
	#[serde(default)]
	pub env:                    BTreeMap<Str, Str>,
	/// Optional exact JSON value supplied as `initializationOptions`.
	#[serde(default)]
	pub initialization_options: Option<Value>,
	/// Settings sent after initialization.
	#[serde(default)]
	pub settings:               Option<Value>,
	/// Ancestor project-root markers.
	#[serde(default)]
	pub root_markers:           Vec<Str>,
	/// Whether this binding is a linter/checker.
	#[serde(default)]
	pub is_linter:              bool,
	/// Optional inactivity shutdown bound.
	#[serde(default)]
	pub idle_timeout_ms:        Option<u64>,
	/// Workspace readiness bound.
	#[serde(default = "default_readiness_timeout_ms")]
	pub readiness_timeout_ms:   u64,
	/// Bounded transport and shutdown settings.
	#[serde(default)]
	pub transport:              LspTransportSettings,
}

impl LspProcessConfig {
	fn binding_spec(&self) -> Result<LspBindingSpec, LspProcessError> {
		if self.name.is_empty() {
			return Err(LspProcessError::InvalidConfig {
				reason: sf!("binding name must not be empty"),
			});
		}
		if self.executable.as_os_str().is_empty() {
			return Err(LspProcessError::InvalidConfig {
				reason: sf!("executable must not be empty"),
			});
		}
		self.transport.validate()?;
		let languages = self
			.selector
			.languages
			.iter()
			.map(|language| {
				LanguageId::new(language)
					.map_err(|_| LspProcessError::InvalidLanguage { language: language.clone() })
			})
			.collect::<Result<Vec<_>, LspProcessError>>()?;
		let selector = LspSelector::new(
			languages,
			self.selector.schemes.clone(),
			self.selector.path_patterns.clone(),
		)?;
		let settings_json = serde_json::to_vec(&serde_json::json!({
			"settings": self.settings.as_ref().cloned().unwrap_or_else(|| serde_json::json!({})),
		}))
		.map(Bytes::from)
		.map_err(|source| LspProcessError::SerializeConfig { source })?;
		Ok(LspBindingSpec::new(self.name.as_str(), self.priority, selector)?
			.with_linter(self.is_linter)
			.with_root_markers(self.root_markers.clone())
			.with_lifecycle(
				self.idle_timeout_ms.map(Duration::from_millis),
				Duration::from_millis(self.readiness_timeout_ms),
			)
			.with_settings_json(settings_json))
	}
}

const fn default_readiness_timeout_ms() -> u64 {
	5_000
}

/// Failure while loading, starting, operating, or stopping a process binding.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum LspProcessError {
	/// A configuration file could not be read.
	#[error("cannot read LSP configuration {}: {source}", path.display())]
	ReadConfig {
		/// Configuration path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A configuration file did not contain the documented JSON shape.
	#[error("invalid LSP configuration {}: {source}", path.display())]
	ParseConfig {
		/// Configuration path.
		path:   PathBuf,
		/// JSON decoding failure.
		#[source]
		source: serde_json::Error,
	},
	/// A configured value violates a strict transport or binding invariant.
	#[error("invalid LSP process configuration: {reason}")]
	InvalidConfig {
		/// Validation diagnostic.
		reason: Str,
	},
	/// A configured language identifier was invalid.
	#[error("invalid LSP language identifier {language}")]
	InvalidLanguage {
		/// The rejected language identifier.
		language: Str,
	},
	/// A configured timeout is zero or exceeds its strict upper bound.
	#[error("{setting} must be between 1 and {max}")]
	InvalidTimeout {
		/// Configuration field containing the invalid timeout.
		setting: &'static str,
		/// Largest accepted timeout in milliseconds.
		max:     u64,
	},
	/// Executable planning failed inside Environment-owned path authority.
	#[error(transparent)]
	Binary(#[from] LspBinaryError),
	/// Post-initialize settings could not be encoded.
	#[error("cannot encode LSP settings: {source}")]
	SerializeConfig {
		/// JSON serialization failure.
		#[source]
		source: serde_json::Error,
	},
	/// The child did not complete initialize before the configured deadline.
	#[error("LSP initialize request timed out")]
	InitializeTimeout,
	/// The child could not be spawned or controlled.
	#[error("LSP process I/O failed: {0}")]
	Io(#[from] io::Error),
	/// The LSP transport failed.
	#[error(transparent)]
	Transport(#[from] LspTransportError),
	/// Initialize capabilities or server state were invalid.
	#[error(transparent)]
	Lsp(#[from] LspError),
	/// The binding registry rejected a lifecycle operation.
	#[error(transparent)]
	Registry(#[from] LspRegistryError),
	/// A registry shutdown phase did not honor cancellation before its deadline.
	#[error("LSP shutdown phase timed out: {phase}")]
	ShutdownTimeout {
		/// Phase that exceeded its deadline.
		phase: &'static str,
	},
}

/// Loads one process declaration from each supplied JSON file, in path order.
pub fn load_lsp_process_configs(
	paths: impl IntoIterator<Item = impl AsRef<Path>>,
) -> Result<Vec<LspProcessConfig>, LspProcessError> {
	paths
		.into_iter()
		.map(|path| {
			let path = path.as_ref();
			let bytes = fs::read(path)
				.map_err(|source| LspProcessError::ReadConfig { path: path.to_owned(), source })?;
			let config = serde_json::from_slice::<LspProcessConfig>(&bytes)
				.map_err(|source| LspProcessError::ParseConfig { path: path.to_owned(), source })?;
			config.binding_spec()?;
			Ok(config)
		})
		.collect()
}

/// A running child process installed in an [`LspRegistry`].
pub struct LspProcess {
	registry:         LspRegistry,
	binding_id:       LspBindingId,
	transport:        Arc<ProcessTransport>,
	child:            Option<Child>,
	reader_task:      JoinHandle<()>,
	writer_task:      JoinHandle<()>,
	inbound_task:     JoinHandle<()>,
	shutdown_timeout: Duration,
}

impl LspProcess {
	/// Starts, initializes, installs, and activates one process binding.
	#[tracing::instrument(
		name = "lsp_server_spawn",
		level = "debug",
		skip_all,
		fields(server = %config.name)
	)]
	pub async fn start(
		config: LspProcessConfig,
		environment: &Environment,
		cancel: CancellationToken,
	) -> Result<Self, LspProcessError> {
		let spec = config.binding_spec()?;
		let local_roots = environment
			.root_uri()
			.to_file_path()
			.ok()
			.into_iter()
			.collect::<Vec<_>>();
		let platform = if cfg!(windows) {
			BinaryPlatform::Windows
		} else {
			BinaryPlatform::Posix
		};
		let resolved = resolve_lsp_binary(
			config.executable.to_string_lossy().as_ref(),
			&config.args,
			&local_roots,
			env::var_os("PATH").as_deref(),
			process::id(),
			platform,
		)?;
		let mut command = Command::new(&resolved.executable);
		command
			.args(resolved.args.iter().map(Str::as_str))
			.envs(
				config
					.env
					.iter()
					.map(|(key, value)| (key.as_str(), value.as_str())),
			)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit())
			.kill_on_drop(true);
		let mut child = command.spawn()?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| LspProcessError::InvalidConfig {
				reason: sf!("spawned child has no standard input"),
			})?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| LspProcessError::InvalidConfig {
				reason: sf!("spawned child has no standard output"),
			})?;
		let (binding_tx, binding_rx) = watch::channel(None);
		let (transport, inbound, reader_task, writer_task) =
			ProcessTransport::start(stdout, stdin, &config.transport);
		let inbound_task = spawn_inbound_dispatch(
			transport.clone(),
			inbound,
			binding_rx,
			environment.clone(),
			environment.lsp().clone(),
			environment.root_uri().clone(),
			workspace_name(environment.root_uri()),
			config.transport.inbound_queue_capacity,
		);
		let startup = async {
			let initialize_params = initialize_params(environment, config.initialization_options)?;
			let initialize_cancel = cancel.child_token();
			let initialize =
				transport.request("initialize", initialize_params, initialize_cancel.clone());
			tokio::pin!(initialize);
			let result = tokio::select! {
				biased;
				result = &mut initialize => result?,
				() = sleep(Duration::from_millis(config.transport.initialize_timeout_ms)) => {
					initialize_cancel.cancel();
					let _ = (&mut initialize).await;
					return Err(LspProcessError::InitializeTimeout);
				},
			};

			let capabilities = extract_capabilities(&result)?;
			let server = LspServer::new(transport.clone(), capabilities)?;
			let settings_json = spec.settings_json().clone();
			let binding_id = environment
				.lsp()
				.add_binding(spec, server, cancel.child_token())
				.await?;
			let binding_handle = match environment.lsp().binding_handle(binding_id) {
				Ok(handle) => handle,
				Err(error) => {
					let _ = environment
						.lsp()
						.remove_binding(binding_id, CancellationToken::new())
						.await;
					return Err(error.into());
				},
			};
			if binding_tx.send(Some(binding_handle)).is_err() {
				let _ = environment
					.lsp()
					.remove_binding(binding_id, CancellationToken::new())
					.await;
				return Err(LspProcessError::Transport(LspTransportError::Closed {
					message: sf!("inbound dispatcher stopped during startup"),
				}));
			}
			if let Err(error) = transport
				.notify("initialized", Bytes::from_static(b"{}"), cancel.child_token())
				.await
			{
				let _ = environment
					.lsp()
					.remove_binding(binding_id, CancellationToken::new())
					.await;
				return Err(error.into());
			}
			if config.settings.is_some() {
				if let Err(error) = transport
					.notify("workspace/didChangeConfiguration", settings_json, cancel.child_token())
					.await
					.map_err(LspProcessError::from)
				{
					let _ = environment
						.lsp()
						.remove_binding(binding_id, CancellationToken::new())
						.await;
					return Err(error);
				}
			}
			Ok::<_, LspProcessError>(binding_id)
		}
		.await;
		match startup {
			Ok(binding_id) => Ok(Self {
				registry: environment.lsp().clone(),
				binding_id,
				transport,
				child: Some(child),
				reader_task,
				writer_task,
				inbound_task,
				shutdown_timeout: Duration::from_millis(config.transport.shutdown_timeout_ms),
			}),
			Err(error) => {
				transport.close("LSP startup failed");
				reader_task.abort();
				writer_task.abort();
				inbound_task.abort();
				let _ = child.kill().await;
				let _ = child.wait().await;
				Err(error)
			},
		}
	}

	/// Returns the installed registry identity.
	pub const fn binding_id(&self) -> LspBindingId {
		self.binding_id
	}

	/// Removes the binding, requests graceful shutdown, and kills a wedged
	/// child.
	pub async fn shutdown(mut self) -> Result<(), LspProcessError> {
		let registry_cancel = CancellationToken::new();
		let removal = self
			.registry
			.remove_binding(self.binding_id, registry_cancel.clone());
		tokio::pin!(removal);
		let registry_result = tokio::select! {
			result = &mut removal => result.map_err(LspProcessError::from),
			() = sleep(self.shutdown_timeout) => {
				registry_cancel.cancel();
				match timeout(self.shutdown_timeout, &mut removal).await {
					Ok(result) => result.map_err(LspProcessError::from),
					Err(_) => Err(LspProcessError::ShutdownTimeout {
						phase: "registry binding removal",
					}),
				}
			},
		};

		let request_cancel = CancellationToken::new();
		let request =
			self
				.transport
				.request("shutdown", Bytes::from_static(b"null"), request_cancel.clone());
		tokio::pin!(request);
		tokio::select! {
			_ = &mut request => {},
			() = sleep(self.shutdown_timeout) => {
				request_cancel.cancel();
				let _ = (&mut request).await;
			},
		}

		let exit_cancel = CancellationToken::new();
		let exit = self
			.transport
			.notify("exit", Bytes::from_static(b"null"), exit_cancel.clone());
		tokio::pin!(exit);
		tokio::select! {
			_ = &mut exit => {},
			() = sleep(self.shutdown_timeout) => {
				exit_cancel.cancel();
				let _ = (&mut exit).await;
			},
		}

		let child_result = if let Some(mut child) = self.child.take() {
			match timeout(self.shutdown_timeout, child.wait()).await {
				Ok(result) => result.map(|_| ()),
				Err(_) => match child.kill().await {
					Ok(()) => child.wait().await.map(|_| ()),
					Err(error) => Err(error),
				},
			}
		} else {
			Ok(())
		};
		self.transport.close("LSP process stopped");
		self.reader_task.abort();
		self.writer_task.abort();
		self.inbound_task.abort();
		child_result?;
		registry_result
	}
}

impl Drop for LspProcess {
	fn drop(&mut self) {
		self.transport.close("LSP process handle dropped");
		self.reader_task.abort();
		self.writer_task.abort();
		self.inbound_task.abort();
		if let Some(child) = &mut self.child {
			let _ = child.start_kill();
		}
	}
}

struct ProcessTransport {
	writer:            Sender<WriteCommand>,
	cancel_writer:     Sender<WriteCommand>,
	state:             Mutex<TransportState>,
	pending_slots:     Arc<Semaphore>,
	next_id:           AtomicU64,
	max_message_bytes: usize,
}

struct TransportState {
	closed:  Option<LspTransportError>,
	pending: HashMap<u64, PendingRequest>,
	inbound: HashMap<Bytes, CancellationToken>,
}

struct PendingRequest {
	response: oneshot::Sender<Result<Bytes, LspTransportError>>,
	_permit:  OwnedSemaphorePermit,
}

struct WriteCommand {
	payload: Bytes,
	written: oneshot::Sender<Result<(), LspTransportError>>,
	_permit: Option<OwnedSemaphorePermit>,
}

struct InboundMessage {
	id:           Option<Bytes>,
	method:       Str,
	params:       Bytes,
	cancellation: CancellationToken,
}

struct BoundedJson {
	bytes:    Vec<u8>,
	limit:    usize,
	exceeded: bool,
}

impl io::Write for BoundedJson {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
			self.exceeded = true;
			return Err(io::Error::other("serialized JSON exceeds configured limit"));
		}
		let required = self.bytes.len() + bytes.len();
		if required > self.bytes.capacity() {
			self.bytes.reserve_exact(required - self.bytes.capacity());
		}
		self.bytes.extend_from_slice(bytes);
		Ok(bytes.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

impl ProcessTransport {
	fn start<R, W>(
		reader: R,
		writer: W,
		settings: &LspTransportSettings,
	) -> (Arc<Self>, ChannelReceiver<InboundMessage>, JoinHandle<()>, JoinHandle<()>)
	where
		R: AsyncRead + Unpin + Send + 'static,
		W: AsyncWrite + Unpin + Send + 'static,
	{
		let (writer_tx, writer_rx) = flume::bounded(settings.writer_queue_capacity);
		let (cancel_tx, cancel_rx) = flume::bounded(settings.max_pending_requests);
		let (inbound_tx, inbound_rx) = flume::bounded(settings.inbound_queue_capacity);
		let transport = Arc::new(Self {
			writer:            writer_tx,
			cancel_writer:     cancel_tx,
			state:             Mutex::new(TransportState {
				closed:  None,
				pending: HashMap::new(),
				inbound: HashMap::new(),
			}),
			pending_slots:     Arc::new(Semaphore::new(settings.max_pending_requests)),
			next_id:           AtomicU64::new(1),
			max_message_bytes: settings.max_message_bytes,
		});
		let writer_transport = transport.clone();
		let writer_task = tokio::spawn(writer_loop(
			writer,
			ChannelReceiver::new(writer_rx),
			ChannelReceiver::new(cancel_rx),
			writer_transport,
		));
		let reader_transport = transport.clone();
		let max_header_bytes = settings.max_header_bytes;
		let max_message_bytes = settings.max_message_bytes;
		let reader_task = tokio::spawn(async move {
			reader_loop(
				reader,
				inbound_tx,
				reader_transport.clone(),
				max_header_bytes,
				max_message_bytes,
			)
			.await;
		});
		(transport, ChannelReceiver::new(inbound_rx), reader_task, writer_task)
	}

	fn close(&self, message: &str) {
		self.fail_all(LspTransportError::Closed { message: Str::new(message) });
	}

	fn fail_all(&self, error: LspTransportError) {
		let (pending, inbound) = {
			let mut state = self.state.lock();
			if state.closed.is_none() {
				state.closed = Some(error.clone());
			}
			(mem::take(&mut state.pending), mem::take(&mut state.inbound))
		};
		for (_, pending) in pending {
			let _ = pending.response.send(Err(error.clone()));
		}
		for (_, cancellation) in inbound {
			cancellation.cancel();
		}
	}

	fn resolve(&self, id: u64, result: Result<Bytes, LspTransportError>) {
		let pending = self.state.lock().pending.remove(&id);
		if let Some(pending) = pending {
			let _ = pending.response.send(result);
		}
	}

	fn register_inbound(&self, id: &Bytes) -> Result<CancellationToken, RpcError> {
		let mut state = self.state.lock();
		if state.closed.is_some() {
			return Err(RpcError::invalid_params("LSP transport is closed"));
		}
		if state.inbound.contains_key(id) {
			return Err(RpcError::invalid_params("duplicate inbound request id"));
		}
		let cancellation = CancellationToken::new();
		state.inbound.insert(id.clone(), cancellation.clone());
		Ok(cancellation)
	}

	fn finish_inbound(&self, id: &Bytes) {
		self.state.lock().inbound.remove(id);
	}

	fn cancel_inbound(&self, id: &Bytes) {
		if let Some(cancellation) = self.state.lock().inbound.get(id) {
			cancellation.cancel();
		}
	}

	async fn send_payload(
		&self,
		payload: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspTransportError> {
		if payload.len() > self.max_message_bytes {
			return Err(LspTransportError::InvalidResponse {
				message: Str::new("outbound JSON-RPC message exceeds configured limit"),
			});
		}
		let closed = self.state.lock().closed.clone();
		if let Some(error) = closed {
			return Err(error);
		}
		let (written_tx, written_rx) = oneshot::channel();
		let command = WriteCommand { payload, written: written_tx, _permit: None };
		tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(LspTransportError::Cancelled),
			result = self.writer.send_async(command) => {
				if result.is_err() {
					return Err(self.closed_error("LSP writer stopped"));
				}
			},
		}
		tokio::select! {
			biased;
			() = cancel.cancelled() => Err(LspTransportError::Cancelled),
			result = written_rx => result.unwrap_or_else(|_| Err(self.closed_error("LSP writer stopped"))),
		}
	}

	fn closed_error(&self, fallback: &'static str) -> LspTransportError {
		self
			.state
			.lock()
			.closed
			.clone()
			.unwrap_or_else(|| LspTransportError::Closed { message: sf!(fallback) })
	}

	fn serialize_bounded(&self, value: &impl Serialize) -> Result<Bytes, LspTransportError> {
		let mut output = BoundedJson {
			bytes:    Vec::with_capacity(self.max_message_bytes.min(8 * 1024)),
			limit:    self.max_message_bytes,
			exceeded: false,
		};
		if let Err(error) = serde_json::to_writer(&mut output, value) {
			return Err(if output.exceeded {
				LspTransportError::InvalidResponse {
					message: sf!("outbound JSON-RPC message exceeds configured limit"),
				}
			} else {
				invalid_response(error)
			});
		}
		Ok(Bytes::from(output.bytes))
	}

	async fn send_response(
		&self,
		id: &Bytes,
		result: Result<Bytes, RpcError>,
	) -> Result<(), LspTransportError> {
		let id = raw_from_bytes(id)?;
		let payload = match result {
			Ok(result) => {
				let result = raw_from_bytes(&result)?;
				self.serialize_bounded(&SuccessResponse { jsonrpc: JSON_RPC_VERSION, id, result })
			},
			Err(error) => self.serialize_bounded(&ErrorResponse {
				jsonrpc: JSON_RPC_VERSION,
				id,
				error: RpcErrorBody { code: error.code, message: error.message.as_str() },
			}),
		}?;
		self.send_payload(payload, CancellationToken::new()).await
	}
}

#[async_trait]
impl LspTransport for ProcessTransport {
	async fn request(
		&self,
		method: &str,
		params: Bytes,
		cancel: CancellationToken,
	) -> Result<Bytes, LspTransportError> {
		let params = raw_from_bytes(&params)?;
		let permit = tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(LspTransportError::Cancelled),
			permit = self.pending_slots.clone().acquire_owned() => permit.map_err(|_| self.closed_error("LSP transport closed"))?,
		};
		let id = self
			.next_id
			.try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
			.map_err(|_| LspTransportError::Closed {
				message: sf!("LSP request identifier space exhausted"),
			})?;
		let payload = self.serialize_bounded(&RequestEnvelope {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method,
			params,
		})?;
		let (response_tx, response_rx) = oneshot::channel();
		{
			let mut state = self.state.lock();
			if let Some(error) = &state.closed {
				return Err(error.clone());
			}
			state
				.pending
				.insert(id, PendingRequest { response: response_tx, _permit: permit });
		}
		if let Err(error) = self.send_payload(payload, cancel.clone()).await {
			let pending = self.state.lock().pending.remove(&id);
			if matches!(error, LspTransportError::Cancelled) {
				self.send_cancel(id, pending.map(|pending| pending._permit));
			}
			return Err(error);
		}
		tokio::select! {
			biased;
			response = response_rx => response.unwrap_or_else(|_| Err(self.closed_error("LSP response channel closed"))),
			() = cancel.cancelled() => {
				let pending = self.state.lock().pending.remove(&id);
				self.send_cancel(id, pending.map(|pending| pending._permit));
				Err(LspTransportError::Cancelled)
			},
		}
	}

	async fn notify(
		&self,
		method: &str,
		params: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspTransportError> {
		let params = raw_from_bytes(&params)?;
		let payload = self.serialize_bounded(&NotificationEnvelope {
			jsonrpc: JSON_RPC_VERSION,
			method,
			params,
		})?;
		self.send_payload(payload, cancel).await
	}
}

impl ProcessTransport {
	fn send_cancel(&self, id: u64, permit: Option<OwnedSemaphorePermit>) {
		let params = format!("{{\"id\":{id}}}");
		let Ok(params) = serde_json::from_str::<&RawValue>(&params) else {
			return;
		};
		let Ok(payload) = self.serialize_bounded(&NotificationEnvelope {
			jsonrpc: JSON_RPC_VERSION,
			method: "$/cancelRequest",
			params,
		}) else {
			return;
		};
		let (written, _) = oneshot::channel();
		let _ = self
			.cancel_writer
			.try_send(WriteCommand { payload, written, _permit: permit });
	}
}

#[derive(Serialize)]
struct RequestEnvelope<'a> {
	jsonrpc: &'static str,
	id:      u64,
	method:  &'a str,
	params:  &'a RawValue,
}

#[derive(Serialize)]
struct NotificationEnvelope<'a> {
	jsonrpc: &'static str,
	method:  &'a str,
	params:  &'a RawValue,
}

#[derive(Serialize)]
struct SuccessResponse<'a> {
	jsonrpc: &'static str,
	id:      &'a RawValue,
	result:  &'a RawValue,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
	jsonrpc: &'static str,
	id:      &'a RawValue,
	error:   RpcErrorBody<'a>,
}

#[derive(Serialize)]
struct RpcErrorBody<'a> {
	code:    i32,
	message: &'a str,
}

struct RpcError {
	code:    i32,
	message: Str,
}

impl RpcError {
	fn method_not_found(method: &str) -> Self {
		Self { code: -32601, message: sf!("method not found: {method}") }
	}

	fn invalid_params(message: impl AsRef<str>) -> Self {
		Self { code: -32602, message: Str::new(message.as_ref()) }
	}
}

async fn writer_loop<W>(
	mut writer: W,
	commands: ChannelReceiver<WriteCommand>,
	cancellations: ChannelReceiver<WriteCommand>,
	transport: Arc<ProcessTransport>,
) where
	W: AsyncWrite + Unpin,
{
	loop {
		let command = tokio::select! {
			biased;
			command = cancellations.recv() => command,
			command = commands.recv() => command,
		};
		let Some(command) = command else {
			break;
		};
		let result = write_frame(&mut writer, &command.payload)
			.await
			.map_err(|source| LspTransportError::Io {
				operation: "cannot write LSP frame",
				source:    Arc::new(source),
			});
		let failed = result.is_err();
		let failure = result.as_ref().err().cloned();
		let _ = command.written.send(result);
		if failed {
			transport.fail_all(failure.expect("failed write has an error"));
			break;
		}
	}
}

async fn reader_loop<R>(
	mut reader: R,
	inbound: Sender<InboundMessage>,
	transport: Arc<ProcessTransport>,
	max_header_bytes: usize,
	max_message_bytes: usize,
) where
	R: AsyncRead + Unpin,
{
	loop {
		let payload = match read_frame(&mut reader, max_header_bytes, max_message_bytes).await {
			Ok(payload) => payload,
			Err(source) => {
				transport.fail_all(match source {
					LspFrameError::Eof => {
						LspTransportError::Closed { message: sf!("LSP standard output reached EOF") }
					},
					source => LspTransportError::Frame { source: Arc::new(source) },
				});
				break;
			},
		};
		let fields = match parse_fields(&payload) {
			Ok(fields) => fields,
			Err(error) => {
				transport.fail_all(error);
				break;
			},
		};
		let version = fields
			.get("jsonrpc")
			.and_then(|version| serde_json::from_str::<String>(version.get()).ok());
		if version.as_deref() != Some(JSON_RPC_VERSION) {
			transport.fail_all(LspTransportError::InvalidResponse {
				message: sf!("JSON-RPC message must declare version 2.0"),
			});
			break;
		}
		if let Some(method) = fields.get("method") {
			let method = match serde_json::from_str::<String>(method.get()) {
				Ok(method) => Str::new(method),
				Err(error) => {
					transport.fail_all(invalid_response(error));
					break;
				},
			};
			let id = fields
				.get("id")
				.map(|id| Bytes::copy_from_slice(id.get().as_bytes()));
			let params = fields.get("params").map_or_else(
				|| Bytes::from_static(b"null"),
				|params| Bytes::copy_from_slice(params.get().as_bytes()),
			);
			if method == "$/cancelRequest" && id.is_none() {
				if let Ok(cancel) = parse_fields(&params)
					&& let Some(id) = cancel.get("id")
				{
					transport.cancel_inbound(&Bytes::copy_from_slice(id.get().as_bytes()));
				}
				continue;
			}
			let cancellation = match id.as_ref() {
				Some(id) => match transport.register_inbound(id) {
					Ok(cancellation) => cancellation,
					Err(error) => {
						if transport.send_response(id, Err(error)).await.is_err() {
							break;
						}
						continue;
					},
				},
				None => CancellationToken::new(),
			};
			if inbound
				.send_async(InboundMessage { id, method, params, cancellation })
				.await
				.is_err()
			{
				transport.close("LSP inbound dispatcher stopped");
				break;
			}
			continue;
		}
		let Some(id) = fields.get("id") else {
			transport.close("JSON-RPC message has neither method nor response id");
			break;
		};
		let id = match serde_json::from_str::<u64>(id.get()) {
			Ok(id) => id,
			Err(error) => {
				transport.fail_all(invalid_response(error));
				break;
			},
		};
		let result = match (fields.get("result"), fields.get("error")) {
			(Some(result), None) => Ok(Bytes::copy_from_slice(result.get().as_bytes())),
			(None, Some(error)) => match parse_rpc_error(error) {
				Ok(error) => Err(error),
				Err(error) => {
					transport.fail_all(error);
					break;
				},
			},
			_ => {
				transport.fail_all(LspTransportError::InvalidResponse {
					message: sf!("response must contain exactly one of result or error"),
				});
				break;
			},
		};
		transport.resolve(id, result);
	}
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin>(
	writer: &mut W,
	payload: &[u8],
) -> io::Result<()> {
	let header = format!("Content-Length: {}\r\n\r\n", payload.len());
	writer.write_all(header.as_bytes()).await?;
	writer.write_all(payload).await?;
	writer.flush().await
}

/// A failure while decoding one Content-Length-framed LSP message.
#[derive(Debug, thiserror::Error)]
pub enum LspFrameError {
	/// Standard output ended before the next frame began.
	#[error("LSP standard output reached EOF")]
	Eof,
	/// Standard output ended partway through a frame header.
	#[error("EOF inside LSP frame header")]
	HeaderEof,
	/// The frame header exceeded its configured byte limit.
	#[error("LSP frame header exceeds configured limit")]
	HeaderTooLarge,
	/// Reading the frame header failed.
	#[error("cannot read LSP frame header")]
	ReadHeader {
		/// The underlying I/O failure.
		#[source]
		source: io::Error,
	},
	/// The frame header was not UTF-8.
	#[error("LSP frame header is not ASCII-compatible UTF-8")]
	HeaderUtf8,
	/// The frame header contained non-ASCII bytes.
	#[error("LSP frame header contains non-ASCII bytes")]
	HeaderNonAscii,
	/// A frame header field was malformed.
	#[error("malformed LSP frame header field")]
	MalformedHeader,
	/// The frame contained multiple Content-Length headers.
	#[error("duplicate Content-Length header")]
	DuplicateContentLength,
	/// The Content-Length value was empty or contained non-digits.
	#[error("invalid Content-Length header")]
	InvalidContentLength,
	/// The Content-Length value overflowed this platform.
	#[error("Content-Length overflows this platform")]
	ContentLengthOverflow,
	/// The frame did not contain a Content-Length header.
	#[error("LSP frame is missing Content-Length")]
	MissingContentLength,
	/// The frame payload exceeded its configured byte limit.
	#[error("LSP frame payload exceeds configured limit")]
	PayloadTooLarge,
	/// Reading the complete frame payload failed.
	#[error("cannot read complete LSP frame payload")]
	ReadPayload {
		/// The underlying I/O failure.
		#[source]
		source: io::Error,
	},
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(
	reader: &mut R,
	max_header_bytes: usize,
	max_message_bytes: usize,
) -> Result<Bytes, LspFrameError> {
	let mut scanned = Vec::with_capacity(max_header_bytes.min(1024));
	let mut discarded = 0_usize;
	let mut header_start = None;
	let mut byte = [0_u8; 1];
	loop {
		match reader.read(&mut byte).await {
			Ok(0) if scanned.is_empty() => return Err(LspFrameError::Eof),
			Ok(0) => return Err(LspFrameError::HeaderEof),
			Ok(_) => scanned.push(byte[0]),
			Err(source) => return Err(LspFrameError::ReadHeader { source }),
		}
		if header_start.is_none() {
			header_start = find_content_length_start(&scanned);
		}
		if let Some(start) = header_start {
			if scanned.len().saturating_sub(start) > max_header_bytes {
				return Err(LspFrameError::HeaderTooLarge);
			}
			if scanned[start..].ends_with(b"\r\n\r\n") {
				scanned.drain(..start);
				break;
			}
		} else {
			let retain = b"content-length:".len().saturating_sub(1);
			if scanned.len() > retain {
				let remove = scanned.len() - retain;
				scanned.drain(..remove);
				discarded = discarded.saturating_add(remove);
				if discarded > max_header_bytes {
					return Err(LspFrameError::HeaderTooLarge);
				}
			}
		}
	}
	let header = scanned;
	let header_text = str::from_utf8(&header).map_err(|_| LspFrameError::HeaderUtf8)?;
	if !header.is_ascii() {
		return Err(LspFrameError::HeaderNonAscii);
	}
	let mut content_length = None;
	for line in header_text[..header_text.len() - 4].split("\r\n") {
		let (name, value) = line.split_once(':').ok_or(LspFrameError::MalformedHeader)?;
		if name.eq_ignore_ascii_case("Content-Length") {
			if content_length.is_some() {
				return Err(LspFrameError::DuplicateContentLength);
			}
			let value = value.trim();
			if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
				return Err(LspFrameError::InvalidContentLength);
			}
			content_length = Some(
				value
					.parse::<usize>()
					.map_err(|_| LspFrameError::ContentLengthOverflow)?,
			);
		}
	}
	let content_length = content_length.ok_or(LspFrameError::MissingContentLength)?;
	if content_length > max_message_bytes {
		return Err(LspFrameError::PayloadTooLarge);
	}
	let mut payload = vec![0; content_length];
	reader
		.read_exact(&mut payload)
		.await
		.map_err(|source| LspFrameError::ReadPayload { source })?;
	Ok(Bytes::from(payload))
}

fn find_content_length_start(bytes: &[u8]) -> Option<usize> {
	const PREFIX: &[u8] = b"content-length:";
	if bytes.len() < PREFIX.len() {
		return None;
	}
	(0..=bytes.len() - PREFIX.len()).find(|&start| {
		(start == 0 || bytes[start - 1] == b'\n')
			&& bytes[start..start + PREFIX.len()].eq_ignore_ascii_case(PREFIX)
	})
}

fn parse_fields(payload: &[u8]) -> Result<HashMap<String, Box<RawValue>>, LspTransportError> {
	serde_json::from_slice(payload).map_err(invalid_response)
}

fn parse_rpc_error(error: &RawValue) -> Result<LspTransportError, LspTransportError> {
	let fields = parse_fields(error.get().as_bytes())?;
	let code = fields
		.get("code")
		.ok_or_else(|| LspTransportError::InvalidResponse {
			message: sf!("JSON-RPC error is missing code"),
		})
		.and_then(|code| serde_json::from_str::<i32>(code.get()).map_err(invalid_response))?;
	let message = fields
		.get("message")
		.ok_or_else(|| LspTransportError::InvalidResponse {
			message: sf!("JSON-RPC error is missing message"),
		})
		.and_then(|message| {
			serde_json::from_str::<String>(message.get()).map_err(invalid_response)
		})?;
	let data = fields
		.get("data")
		.map(|data| Bytes::copy_from_slice(data.get().as_bytes()));
	Ok(LspTransportError::JsonRpc { code, message: Str::new(message), data })
}

fn raw_from_bytes(bytes: &[u8]) -> Result<&RawValue, LspTransportError> {
	serde_json::from_slice(bytes).map_err(invalid_response)
}

fn invalid_response(source: serde_json::Error) -> LspTransportError {
	LspTransportError::InvalidJson { source: Arc::new(source) }
}

fn validate_limit(name: &str, value: usize, maximum: usize) -> Result<(), LspProcessError> {
	if value == 0 || value > maximum {
		return Err(LspProcessError::InvalidConfig {
			reason: sf!("{name} must be between 1 and {maximum}"),
		});
	}
	Ok(())
}

fn initialize_params(
	environment: &Environment,
	initialization_options: Option<Value>,
) -> Result<Bytes, LspProcessError> {
	let root_uri = environment.root_uri();
	let mut params = Map::new();
	params.insert("processId".to_owned(), Value::from(process::id()));
	params.insert("clientInfo".to_owned(), serde_json::json!({ "name": "omp-envd" }));
	params.insert("rootUri".to_owned(), Value::String(root_uri.as_str().to_owned()));
	params.insert(
		"capabilities".to_owned(),
		serde_json::json!({
			"general": { "positionEncodings": ["utf-8", "utf-16", "utf-32"] },
			"workspace": {
				"applyEdit": true,
				"configuration": true,
				"workspaceFolders": true,
				"didChangeConfiguration": { "dynamicRegistration": true },
				"workspaceEdit": {
					"documentChanges": true,
					"resourceOperations": ["create", "rename", "delete"],
					"failureHandling": "abort"
				}
			},
			"textDocument": {
				"synchronization": { "dynamicRegistration": true, "willSave": true, "willSaveWaitUntil": true, "didSave": true },
				"completion": { "dynamicRegistration": true },
				"hover": { "dynamicRegistration": true },
				"signatureHelp": { "dynamicRegistration": true },
				"definition": { "dynamicRegistration": true },
				"references": { "dynamicRegistration": true },
				"documentSymbol": { "dynamicRegistration": true },
				"codeAction": { "dynamicRegistration": true },
				"formatting": { "dynamicRegistration": true },
				"rangeFormatting": { "dynamicRegistration": true },
				"rename": { "dynamicRegistration": true },
				"publishDiagnostics": {}
			}
		}),
	);
	params.insert(
		"workspaceFolders".to_owned(),
		serde_json::json!([{ "uri": root_uri.as_str(), "name": workspace_name(root_uri) }]),
	);
	if let Some(options) = initialization_options {
		params.insert("initializationOptions".to_owned(), options);
	}
	serde_json::to_vec(&Value::Object(params))
		.map(Bytes::from)
		.map_err(|error| LspProcessError::Transport(invalid_response(error)))
}

fn extract_capabilities(result: &[u8]) -> Result<Bytes, LspProcessError> {
	let fields = parse_fields(result)?;
	let capabilities = fields.get("capabilities").ok_or_else(|| {
		LspProcessError::Transport(LspTransportError::InvalidResponse {
			message: sf!("initialize result is missing capabilities"),
		})
	})?;
	Ok(Bytes::copy_from_slice(capabilities.get().as_bytes()))
}

fn workspace_name(root_uri: &Url) -> Str {
	root_uri
		.to_file_path()
		.ok()
		.and_then(|path| {
			path
				.file_name()
				.map(|name| name.to_string_lossy().into_owned())
		})
		.filter(|name| !name.is_empty())
		.map_or_else(|| sf!("workspace"), Str::new)
}

/// Deferred work that must begin only after a server-request response write
/// has completed or definitively failed.
pub type LspPostResponse = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Result of an inbound server request plus optional post-response work.
///
/// The process dispatcher runs `post_response` after the bounded writer
/// acknowledges the response. It also runs the hook when that write fails so
/// already-committed state can still reconcile other bindings.
pub struct InboundDispatch {
	response:      Result<Bytes, RpcError>,
	post_response: Option<LspPostResponse>,
}

impl InboundDispatch {
	/// Creates a successful immediate response from exact raw JSON result bytes.
	pub fn success(result_json: Bytes) -> Self {
		Self { response: Ok(result_json), post_response: None }
	}

	/// Creates a successful response followed by deferred reconciliation work.
	pub fn success_then(result_json: Bytes, post_response: LspPostResponse) -> Self {
		Self { response: Ok(result_json), post_response: Some(post_response) }
	}
}

fn spawn_inbound_dispatch(
	transport: Arc<ProcessTransport>,
	inbound: ChannelReceiver<InboundMessage>,
	mut binding: Receiver<Option<LspBindingHandle>>,
	environment: Environment,
	registry: LspRegistry,
	root_uri: Url,
	root_name: Str,
	deferred_limit: usize,
) -> JoinHandle<()> {
	tokio::spawn(async move {
		let mut deferred = VecDeque::with_capacity(deferred_limit);
		loop {
			let message = loop {
				if binding.borrow().is_some()
					&& let Some(message) = deferred.pop_front()
				{
					break message;
				}
				if deferred.len() == deferred_limit {
					transport.close("pre-initialize notification queue is full");
					return;
				}
				let next = if deferred.is_empty() {
					inbound.recv().await
				} else {
					tokio::select! {
						changed = binding.changed() => {
							if changed.is_err() {
								return;
							}
							continue;
						},
						message = inbound.recv() => message,
					}
				};
				let Some(message) = next else {
					return;
				};
				if message.id.is_none() && binding.borrow().is_none() {
					deferred.push_back(message);
					continue;
				}
				break message;
			};
			let InboundDispatch { response, post_response } = dispatch_inbound(
				&message,
				&mut binding,
				&registry,
				&environment,
				&root_uri,
				&root_name,
			)
			.await;
			let send_failed = if let Some(id) = &message.id {
				transport.send_response(id, response).await.is_err()
			} else {
				false
			};
			if let Some(post_response) = post_response {
				post_response.await;
			}
			if let Some(id) = &message.id {
				transport.finish_inbound(id);
			}
			if send_failed {
				break;
			}
		}
	})
}

async fn dispatch_inbound(
	message: &InboundMessage,
	binding: &mut Receiver<Option<LspBindingHandle>>,
	registry: &LspRegistry,
	environment: &Environment,
	root_uri: &Url,
	root_name: &str,
) -> InboundDispatch {
	if message.id.is_some() && message.method == "workspace/applyEdit" {
		let Some(handle) = await_binding(binding).await else {
			return InboundDispatch {
				response:      Err(RpcError::invalid_params(
					"binding stopped before workspace edit dispatch",
				)),
				post_response: None,
			};
		};
		return lsp_apply_edit::apply_workspace_edit(
			environment.clone(),
			handle,
			message.params.clone(),
			message.cancellation.clone(),
		)
		.await;
	}
	let response =
		dispatch_response(message, binding, registry, root_uri, root_name, &message.cancellation)
			.await;
	InboundDispatch { response, post_response: None }
}

async fn dispatch_response(
	message: &InboundMessage,
	binding: &mut Receiver<Option<LspBindingHandle>>,
	registry: &LspRegistry,
	root_uri: &Url,
	root_name: &str,
	cancellation: &CancellationToken,
) -> Result<Bytes, RpcError> {
	let method = message.method.as_str();
	if message.id.is_none() {
		let handle = await_binding(binding)
			.await
			.ok_or_else(|| RpcError::invalid_params("binding stopped before notification dispatch"))?;
		registry
			.publish_inbound_event(handle, method, message.params.clone())
			.map_err(|error| RpcError::invalid_params(error.to_string()))?;
		return Ok(Bytes::from_static(b"null"));
	}
	match method {
		"client/registerCapability" => {
			let handle = (*binding.borrow())
				.ok_or_else(|| RpcError::invalid_params("binding is not ready for registration"))?;
			registry
				.register_capabilities(handle, message.params.clone(), cancellation.child_token())
				.await
				.map_err(|error| RpcError::invalid_params(error.to_string()))?;
			Ok(Bytes::from_static(b"null"))
		},
		"client/unregisterCapability" => {
			let handle = (*binding.borrow())
				.ok_or_else(|| RpcError::invalid_params("binding is not ready for unregistration"))?;
			registry
				.unregister_capabilities(handle, message.params.clone(), cancellation.child_token())
				.await
				.map_err(|error| RpcError::invalid_params(error.to_string()))?;
			Ok(Bytes::from_static(b"null"))
		},
		"workspace/configuration" => configuration_response(&message.params),
		"workspace/workspaceFolders" => serde_json::to_vec(&serde_json::json!([{
			"uri": root_uri.as_str(),
			"name": root_name,
		}]))
		.map(Bytes::from)
		.map_err(|error| RpcError::invalid_params(error.to_string())),
		"window/workDoneProgress/create"
		| "workspace/semanticTokens/refresh"
		| "workspace/codeLens/refresh"
		| "workspace/inlayHint/refresh"
		| "workspace/diagnostic/refresh"
		| "workspace/foldingRange/refresh"
		| "workspace/inlineValue/refresh" => Ok(Bytes::from_static(b"null")),
		"window/showMessageRequest" => Ok(Bytes::from_static(b"null")),
		"window/showDocument" => Ok(Bytes::from_static(b"{\"success\":false}")),
		_ => Err(RpcError::method_not_found(method)),
	}
}

async fn await_binding(
	binding: &mut Receiver<Option<LspBindingHandle>>,
) -> Option<LspBindingHandle> {
	loop {
		let current = *binding.borrow();
		if let Some(binding) = current {
			return Some(binding);
		}
		if binding.changed().await.is_err() {
			return None;
		}
	}
}

fn configuration_response(params: &[u8]) -> Result<Bytes, RpcError> {
	let value: Value = serde_json::from_slice(params)
		.map_err(|error| RpcError::invalid_params(error.to_string()))?;
	let count = value
		.get("items")
		.and_then(Value::as_array)
		.ok_or_else(|| RpcError::invalid_params("workspace/configuration requires an items array"))?
		.len();
	serde_json::to_vec(&vec![Value::Null; count])
		.map(Bytes::from)
		.map_err(|error| RpcError::invalid_params(error.to_string()))
}

#[cfg(test)]
mod tests {
	use tokio::io::{duplex, split};

	use super::*;

	fn settings() -> LspTransportSettings {
		LspTransportSettings {
			max_header_bytes:       1024,
			max_message_bytes:      4096,
			writer_queue_capacity:  4,
			inbound_queue_capacity: 4,
			max_pending_requests:   4,
			initialize_timeout_ms:  100,
			shutdown_timeout_ms:    100,
		}
	}

	#[tokio::test]
	async fn resynchronizes_after_bounded_stray_stdout() {
		let (mut writer, mut reader) = duplex(1024);
		tokio::spawn(async move {
			writer
				.write_all(b"server banner\r\nnot protocol\r\nContent-Length: 2\r\n\r\n{}")
				.await
				.unwrap();
		});
		let payload = read_frame(&mut reader, 256, 256).await.unwrap();
		assert_eq!(payload, Bytes::from_static(b"{}"));
	}

	#[tokio::test]
	async fn frames_content_length_without_overread() {
		let (mut client, mut server) = duplex(1024);
		let writer = tokio::spawn(async move {
			client
				.write_all(b"Content-Length: 7\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{\"a\":1}tail")
				.await
				.expect("write frame");
		});
		let payload = read_frame(&mut server, 256, 32).await.expect("read frame");
		assert_eq!(payload, Bytes::from_static(b"{\"a\":1}"));
		let mut tail = [0; 4];
		server.read_exact(&mut tail).await.expect("read tail");
		assert_eq!(&tail, b"tail");
		writer.await.expect("writer task");
	}

	#[tokio::test]
	async fn correlates_response_and_preserves_exact_result() {
		let (client, server) = duplex(4096);
		let (client_read, client_write) = split(client);
		let (mut server_read, mut server_write) = split(server);
		let (transport, _inbound, reader, writer) =
			ProcessTransport::start(client_read, client_write, &settings());
		let request_transport = transport.clone();
		let request = tokio::spawn(async move {
			request_transport
				.request("example", Bytes::from_static(b"{ \"x\" : 1 }"), CancellationToken::new())
				.await
				.expect("request result")
		});
		let outbound = read_frame(&mut server_read, 1024, 4096)
			.await
			.expect("request frame");
		let fields = parse_fields(&outbound).expect("request object");
		let id = fields.get("id").expect("request id").get();
		let response =
			format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{ \"answer\" : [1, 2] }} }}");
		write_frame(&mut server_write, response.as_bytes())
			.await
			.expect("response frame");
		assert_eq!(
			request.await.expect("request task"),
			Bytes::from_static(b"{ \"answer\" : [1, 2] }")
		);
		transport.close("test complete");
		reader.abort();
		writer.abort();
	}

	#[tokio::test]
	async fn cancellation_emits_cancel_request_with_matching_id() {
		let (client, server) = duplex(4096);
		let (client_read, client_write) = split(client);
		let (mut server_read, _server_write) = split(server);
		let (transport, _inbound, reader, writer) =
			ProcessTransport::start(client_read, client_write, &settings());
		let cancel = CancellationToken::new();
		let request_transport = transport.clone();
		let request_cancel = cancel.clone();
		let request = tokio::spawn(async move {
			request_transport
				.request("slow", Bytes::from_static(b"null"), request_cancel)
				.await
		});
		let outbound = read_frame(&mut server_read, 1024, 4096)
			.await
			.expect("request frame");
		let fields = parse_fields(&outbound).expect("request object");
		let id = fields.get("id").expect("request id").get().to_owned();
		cancel.cancel();
		assert!(matches!(request.await.expect("request task"), Err(LspTransportError::Cancelled)));
		let cancelled = read_frame(&mut server_read, 1024, 4096)
			.await
			.expect("cancel frame");
		let fields = parse_fields(&cancelled).expect("cancel object");
		assert_eq!(fields.get("method").expect("method").get(), "\"$/cancelRequest\"");
		let params = parse_fields(fields.get("params").expect("params").get().as_bytes())
			.expect("cancel params");
		assert_eq!(params.get("id").expect("cancel id").get(), id);
		transport.close("test complete");
		reader.abort();
		writer.abort();
	}

	#[test]
	fn extracts_json_rpc_error_data_without_normalizing_it() {
		let raw = serde_json::from_str::<&RawValue>(
			r#"{"code":-32001,"message":"failed","data":{ "detail" : [1, 2] }}"#,
		)
		.expect("raw error");
		let error = parse_rpc_error(raw).expect("valid JSON-RPC error");
		match error {
			LspTransportError::JsonRpc { code, message, data } => {
				assert_eq!(code, -32001);
				assert_eq!(message, "failed");
				assert_eq!(data, Some(Bytes::from_static(b"{ \"detail\" : [1, 2] }")),);
			},
			other => panic!("unexpected error {other}"),
		}
	}

	#[tokio::test]
	async fn eof_fails_every_pending_request() {
		let (client, server) = duplex(4096);
		let (client_read, client_write) = split(client);
		let (mut server_read, server_write) = split(server);
		let (transport, _inbound, reader, writer) =
			ProcessTransport::start(client_read, client_write, &settings());
		let first_transport = transport.clone();
		let first = tokio::spawn(async move {
			first_transport
				.request("first", Bytes::from_static(b"null"), CancellationToken::new())
				.await
		});
		let second_transport = transport.clone();
		let second = tokio::spawn(async move {
			second_transport
				.request("second", Bytes::from_static(b"null"), CancellationToken::new())
				.await
		});
		let _ = read_frame(&mut server_read, 1024, 4096)
			.await
			.expect("first request frame");
		let _ = read_frame(&mut server_read, 1024, 4096)
			.await
			.expect("second request frame");
		drop(server_read);
		drop(server_write);
		assert!(matches!(
			first.await.expect("first request task"),
			Err(LspTransportError::Closed { .. })
		));
		assert!(matches!(
			second.await.expect("second request task"),
			Err(LspTransportError::Closed { .. })
		));
		transport.close("test complete");
		reader.abort();
		writer.abort();
	}
}
