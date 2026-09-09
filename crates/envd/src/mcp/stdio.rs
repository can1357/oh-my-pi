//! Environment-owned NDJSON child-process MCP transport.

#[cfg(all(unix, not(target_os = "macos")))]
use std::io;
use std::{
	collections::{BTreeMap, HashMap},
	env,
	ffi::{OsStr, OsString},
	iter,
	path::{self, Path, PathBuf},
	process::Stdio,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::Duration,
};

use flume::Receiver;
#[cfg(unix)]
use nix::{sys::signal, unistd::Pid};
use omp_core::Str;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::{
	io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
	process,
	process::{Child, ChildStdin, Command},
	sync::{Mutex as AsyncMutex, oneshot},
	time,
};
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use windows_sys::Win32::System::Threading;

use super::{
	json_rpc::{RequestId, RequestIdAllocator, RequestIdFormat},
	transport::{
		DispatchState, IncomingMessage, McpTransport, ServerResponseError, TransportError,
		TransportFailure, TransportFuture, TransportResponse,
	},
};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const TERM_GRACE: Duration = Duration::from_secs(1);
const KILL_GRACE: Duration = Duration::from_millis(500);

/// Platform family used for deterministic spawn-policy selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StdioPlatform {
	/// Windows console/PATHEXT behavior.
	Windows,
	/// macOS processes stay in the inherited session for TCC prompts.
	Macos,
	/// Other POSIX systems use a detached session.
	Posix,
}

impl StdioPlatform {
	/// Current host platform.
	pub const fn host() -> Self {
		if cfg!(windows) {
			Self::Windows
		} else if cfg!(target_os = "macos") {
			Self::Macos
		} else {
			Self::Posix
		}
	}
}

/// Validated stdio transport configuration.
#[derive(Clone, Debug)]
pub struct StdioConfig {
	/// Executable or Windows command shim.
	pub command:           PathBuf,
	/// Exact argument vector.
	pub args:              Vec<Str>,
	/// Exact child environment additions.
	pub env:               BTreeMap<Str, OsString>,
	/// Child working directory.
	pub cwd:               PathBuf,
	/// Per-request deadline; `None` disables it.
	pub timeout:           Option<Duration>,
	/// Request-ID encoding.
	pub request_id_format: RequestIdFormat,
}

/// Derived platform spawn vector, independently fixture-testable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpawnPlan {
	/// Executable passed to process creation.
	pub executable:       OsString,
	/// Exact argument vector.
	pub args:             Vec<OsString>,
	/// Whether POSIX creates a detached session.
	pub detached_session: bool,
	/// Whether Windows requires verbatim command-line forwarding.
	pub windows_verbatim: bool,
}

/// Resolves platform session and Windows batch behavior.
pub fn resolve_spawn_plan(
	config: &StdioConfig,
	platform: StdioPlatform,
	command_resolved: bool,
	comspec: Option<&OsStr>,
) -> Result<SpawnPlan, SpawnPlanError> {
	if platform != StdioPlatform::Windows {
		return Ok(SpawnPlan {
			executable:       config.command.as_os_str().to_owned(),
			args:             config
				.args
				.iter()
				.map(|value| OsString::from(value.as_str()))
				.collect(),
			detached_session: platform == StdioPlatform::Posix,
			windows_verbatim: false,
		});
	}
	let extension = config
		.command
		.extension()
		.and_then(OsStr::to_str)
		.unwrap_or_default();
	let batch = extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat");
	if command_resolved && !batch {
		return Ok(SpawnPlan {
			executable:       config.command.as_os_str().to_owned(),
			args:             config
				.args
				.iter()
				.map(|value| OsString::from(value.as_str()))
				.collect(),
			detached_session: false,
			windows_verbatim: false,
		});
	}
	let shell = comspec.unwrap_or_else(|| OsStr::new("cmd.exe"));
	let line = windows_batch_line(&config.command.to_string_lossy(), &config.args)?;
	Ok(SpawnPlan {
		executable:       shell.to_owned(),
		args:             ["/d", "/e:ON", "/v:OFF", "/c"]
			.into_iter()
			.map(OsString::from)
			.chain([OsString::from(line)])
			.collect(),
		detached_session: false,
		windows_verbatim: true,
	})
}

fn windows_batch_line(command: &str, args: &[Str]) -> Result<String, SpawnPlanError> {
	validate_windows_token(command)?;
	let mut line = format!("\"\"{}\"", escape_windows_quoted(command));
	for arg in args {
		line.push(' ');
		line.push_str(&escape_windows_argument(arg)?);
	}
	line.push('"');
	Ok(line)
}

fn validate_windows_token(value: &str) -> Result<(), SpawnPlanError> {
	if value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n')) {
		Err(SpawnPlanError::ControlCharacter)
	} else {
		Ok(())
	}
}

fn escape_windows_argument(value: &str) -> Result<String, SpawnPlanError> {
	validate_windows_token(value)?;
	let safe = !value.is_empty()
		&& !value.ends_with('\\')
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || b"#$*+-./:?@\\_".contains(&byte));
	Ok(if safe {
		value.to_owned()
	} else {
		format!("\"{}\"", escape_windows_quoted(value))
	})
}

fn escape_windows_quoted(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	let mut backslashes = 0;
	for character in value.chars() {
		match character {
			'\\' => {
				backslashes += 1;
				output.push(character);
			},
			'"' => {
				for _ in 0..backslashes {
					output.push('\\');
				}
				output.push_str("\"\"");
				backslashes = 0;
			},
			'%' => {
				output.push_str("%%cd:~,%");
				backslashes = 0;
			},
			_ => {
				output.push(character);
				backslashes = 0;
			},
		}
	}
	for _ in 0..backslashes {
		output.push('\\');
	}
	output
}

/// Spawn-vector validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SpawnPlanError {
	/// Windows batch tokens cannot safely contain NUL, CR, or LF.
	#[error("Windows MCP batch token contains a command-terminating control character")]
	ControlCharacter,
}

async fn resolve_host_spawn_plan(config: &StdioConfig) -> Result<SpawnPlan, SpawnPlanError> {
	let platform = StdioPlatform::host();
	if platform != StdioPlatform::Windows {
		return resolve_spawn_plan(config, platform, true, None);
	}
	let resolved = resolve_windows_command(&config.command, &config.cwd, &config.env).await;
	let mut concrete = config.clone();
	if let Some(path) = resolved.as_ref() {
		concrete.command = path.clone();
	}
	if let Some(plan) = resolve_windows_npm_shim(&concrete).await {
		return Ok(plan);
	}
	let comspec = config
		.env
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case("COMSPEC"))
		.map(|(_, value)| value.as_os_str());
	resolve_spawn_plan(&concrete, platform, resolved.is_some(), comspec)
}

async fn resolve_windows_command(
	command: &Path,
	cwd: &Path,
	environment: &BTreeMap<Str, OsString>,
) -> Option<PathBuf> {
	let path_value = environment
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
		.map(|(_, value)| value.clone())
		.or_else(|| env::var_os("PATH"));
	let path_ext = environment
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case("PATHEXT"))
		.and_then(|(_, value)| value.to_str().map(str::to_owned))
		.or_else(|| env::var("PATHEXT").ok())
		.unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
	let extensions: Vec<&str> = path_ext
		.split(';')
		.filter(|value| !value.is_empty())
		.collect();
	let explicit_extension = command
		.extension()
		.and_then(OsStr::to_str)
		.is_some_and(|extension| {
			extensions.iter().any(|candidate| {
				candidate
					.trim_start_matches('.')
					.eq_ignore_ascii_case(extension)
			})
		});
	let names: Vec<OsString> = if explicit_extension {
		vec![command.as_os_str().to_owned()]
	} else {
		extensions
			.iter()
			.map(|extension| {
				let mut value = command.as_os_str().to_owned();
				value.push(extension);
				value
			})
			.collect()
	};
	let has_segment = command.components().count() > 1;
	let mut directories = vec![cwd.to_path_buf()];
	if !has_segment {
		if let Some(path) = path_value {
			directories.extend(env::split_paths(&path));
		}
	}
	for directory in directories {
		for name in &names {
			let candidate = if has_segment {
				let path = PathBuf::from(name);
				if path.is_absolute() {
					path
				} else {
					cwd.join(path)
				}
			} else {
				directory.join(name)
			};
			if tokio::fs::metadata(&candidate).await.is_ok() {
				return Some(candidate);
			}
		}
	}
	explicit_extension.then(|| command.to_path_buf())
}

async fn resolve_windows_npm_shim(config: &StdioConfig) -> Option<SpawnPlan> {
	let extension = config.command.extension().and_then(OsStr::to_str)?;
	if !matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat")
		|| config.command.components().count() <= 1
		|| config
			.command
			.file_stem()
			.and_then(OsStr::to_str)
			.is_some_and(|name| name.eq_ignore_ascii_case("npx"))
	{
		return None;
	}
	let content = tokio::fs::read_to_string(&config.command).await.ok()?;
	let interpreter = regex::Regex::new(r#"(?i)SET\s+"_prog=([^%"][^"]*)""#)
		.ok()?
		.captures(&content)?
		.get(1)?
		.as_str();
	if !Path::new(interpreter)
		.file_stem()
		.and_then(OsStr::to_str)
		.is_some_and(|name| name.eq_ignore_ascii_case("node"))
	{
		return None;
	}
	let raw_target = regex::Regex::new(r#"(?i)"%_prog%"\s+"([^"]+)"\s+%\*"#)
		.ok()?
		.captures(&content)?
		.get(1)?
		.as_str();
	let shim_dir = config.command.parent()?;
	let relative = raw_target
		.trim_start_matches("%~dp0")
		.trim_start_matches("%dp0%")
		.trim_start_matches(['\\', '/']);
	let target = shim_dir.join(relative.replace('\\', path::MAIN_SEPARATOR_STR));
	let sibling_node = shim_dir.join("node.exe");
	let executable = if tokio::fs::metadata(&sibling_node).await.is_ok() {
		sibling_node.into_os_string()
	} else {
		OsString::from("node")
	};
	Some(SpawnPlan {
		executable,
		args: iter::once(target.into_os_string())
			.chain(
				config
					.args
					.iter()
					.map(|value| OsString::from(value.as_str())),
			)
			.collect(),
		detached_session: false,
		windows_verbatim: false,
	})
}

enum PendingResult {
	Value(Value),
	RpcError(i64),
	Malformed,
	FrameTooLarge,
	Closed,
}

struct Inner {
	stdin:       AsyncMutex<Option<ChildStdin>>,
	child:       AsyncMutex<Option<Child>>,
	pending:     Mutex<HashMap<RequestId, oneshot::Sender<PendingResult>>>,
	incoming_tx: flume::Sender<IncomingMessage>,
	incoming_rx: Receiver<IncomingMessage>,
	ids:         Mutex<RequestIdAllocator>,
	id_format:   RequestIdFormat,
	timeout:     Option<Duration>,
	pid:         Option<u32>,
	detached:    bool,
	owners:      AtomicUsize,
	closed:      AtomicBool,
	teardown:    AtomicBool,
}

struct PendingGuard<'a> {
	pending: &'a Mutex<HashMap<RequestId, oneshot::Sender<PendingResult>>>,
	id:      RequestId,
}

impl Drop for PendingGuard<'_> {
	fn drop(&mut self) {
		self.pending.lock().remove(&self.id);
	}
}

/// Concurrent newline-delimited JSON-RPC child transport.
pub struct StdioTransport {
	inner: Arc<Inner>,
}

impl Clone for StdioTransport {
	fn clone(&self) -> Self {
		self.inner.owners.fetch_add(1, Ordering::Relaxed);
		Self { inner: Arc::clone(&self.inner) }
	}
}

impl Drop for StdioTransport {
	fn drop(&mut self) {
		if self.inner.owners.fetch_sub(1, Ordering::AcqRel) != 1 {
			return;
		}
		self.inner.closed.store(true, Ordering::Release);
		close_pending(&self.inner);
		if self.inner.teardown.swap(true, Ordering::AcqRel) {
			return;
		}
		// Drop has no async grace window. Terminate the complete execution unit
		// synchronously, then reap it opportunistically on the live runtime.
		signal_child(self.inner.pid, self.inner.detached, true);
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			let inner = Arc::clone(&self.inner);
			runtime.spawn(async move {
				reap_inner(&inner).await;
			});
		}
	}
}

impl StdioTransport {
	/// Spawns and connects one Environment-owned process tree.
	pub async fn spawn(config: StdioConfig) -> Result<Self, TransportError> {
		let plan = resolve_host_spawn_plan(&config)
			.await
			.map_err(|_| TransportError::pre_dispatch(TransportFailure::InvalidSpawnPlan))?;
		let mut command = Command::new(&plan.executable);
		#[cfg(not(windows))]
		command.args(&plan.args);
		#[cfg(windows)]
		if plan.windows_verbatim {
			use std::os::windows::process::CommandExt as _;
			let (line, ordinary) = plan
				.args
				.split_last()
				.ok_or_else(|| TransportError::pre_dispatch(TransportFailure::InvalidSpawnPlan))?;
			command.args(ordinary);
			command.as_std_mut().raw_arg(line);
		} else {
			command.args(&plan.args);
		}
		command
			.current_dir(&config.cwd)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);
		for (name, value) in &config.env {
			command.env(name.as_str(), value);
		}
		#[cfg(all(unix, not(target_os = "macos")))]
		if plan.detached_session {
			use std::os::unix::process::CommandExt as _;
			// SAFETY: `setsid` has no memory-safety preconditions and this callback
			// performs no allocation between fork and exec.
			unsafe {
				command.as_std_mut().pre_exec(|| {
					if libc::setsid() == -1 {
						Err(io::Error::last_os_error())
					} else {
						Ok(())
					}
				});
			}
		}
		#[cfg(target_os = "macos")]
		{
			use std::os::unix::process::CommandExt as _;
			// A separate process group preserves the inherited macOS session/TCC
			// attachment while still giving teardown authority over descendants.
			command.as_std_mut().process_group(0);
		}
		#[cfg(windows)]
		{
			command.creation_flags(Threading::CREATE_NEW_PROCESS_GROUP);
		}
		let mut child = command
			.spawn()
			.map_err(|source| TransportError::pre_dispatch(TransportFailure::Spawn(source)))?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| TransportError::pre_dispatch(TransportFailure::Closed))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| TransportError::pre_dispatch(TransportFailure::Closed))?;
		let stderr = child
			.stderr
			.take()
			.ok_or_else(|| TransportError::pre_dispatch(TransportFailure::Closed))?;
		let (incoming_tx, incoming_rx) = flume::bounded(256);
		let pid = child.id();
		let inner = Arc::new(Inner {
			stdin: AsyncMutex::new(Some(stdin)),
			child: AsyncMutex::new(Some(child)),
			pending: Mutex::new(HashMap::new()),
			incoming_tx,
			incoming_rx,
			ids: Mutex::new(RequestIdAllocator::default()),
			id_format: config.request_id_format,
			timeout: config.timeout,
			pid,
			// Every host spawn path creates a targetable process group: a session
			// on POSIX, a process group on macOS, and CREATE_NEW_PROCESS_GROUP on
			// Windows. Always sweep it after the leader settles.
			detached: true,
			owners: AtomicUsize::new(1),
			closed: AtomicBool::new(false),
			teardown: AtomicBool::new(false),
		});
		tokio::spawn(read_stdout(Arc::clone(&inner), stdout));
		tokio::spawn(async move {
			let mut stderr = stderr;
			let mut buffer = [0_u8; 4096];
			while stderr.read(&mut buffer).await.is_ok_and(|read| read != 0) {}
		});
		Ok(Self { inner })
	}

	async fn send(
		&self,
		value: &Value,
		cancellation: &CancellationToken,
	) -> Result<DispatchState, TransportError> {
		if self.inner.closed.load(Ordering::Acquire) {
			return Err(TransportError::pre_dispatch(TransportFailure::Closed));
		}
		let mut frame = serde_json::to_vec(value)
			.map_err(|source| TransportError::pre_dispatch(TransportFailure::Json(source)))?;
		if frame.len() >= MAX_FRAME_BYTES {
			return Err(TransportError::pre_dispatch(TransportFailure::FrameTooLarge));
		}
		frame.push(b'\n');
		let mut stdin = tokio::select! {
			() = cancellation.cancelled() => return Err(TransportError::pre_dispatch(TransportFailure::Cancelled)),
			stdin = self.inner.stdin.lock() => stdin,
		};
		let stdin = stdin
			.as_mut()
			.ok_or_else(|| TransportError::pre_dispatch(TransportFailure::Closed))?;
		let write = async {
			stdin.write_all(&frame).await?;
			stdin.flush().await
		};
		tokio::select! {
			() = cancellation.cancelled() => Err(TransportError::effects_unknown(TransportFailure::Cancelled)),
			result = write => result.map(|()| DispatchState::Dispatched).map_err(|source| TransportError::effects_unknown(TransportFailure::Io(source))),
		}
	}

	async fn request_inner(
		&self,
		method: &str,
		params: Value,
		cancellation: CancellationToken,
	) -> Result<TransportResponse, TransportError> {
		let id = self
			.inner
			.ids
			.lock()
			.next(self.inner.id_format)
			.map_err(|_| TransportError::pre_dispatch(TransportFailure::Correlation))?;
		let (sender, receiver) = oneshot::channel();
		self.inner.pending.lock().insert(id.clone(), sender);
		let _pending = PendingGuard { pending: &self.inner.pending, id: id.clone() };
		let frame = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
		if let Err(error) = self.send(&frame, &cancellation).await {
			self.inner.pending.lock().remove(&id);
			return Err(error);
		}
		let receive = async { receiver.await.unwrap_or(PendingResult::Closed) };
		let pending = if let Some(timeout) = self.inner.timeout {
			tokio::select! {
				() = cancellation.cancelled() => { self.inner.pending.lock().remove(&id); return Err(TransportError::effects_unknown(TransportFailure::Cancelled)); },
				result = time::timeout(timeout, receive) => match result { Ok(value) => value, Err(_) => { self.inner.pending.lock().remove(&id); return Err(TransportError::effects_unknown(TransportFailure::TimedOut)); } },
			}
		} else {
			tokio::select! { () = cancellation.cancelled() => { self.inner.pending.lock().remove(&id); return Err(TransportError::effects_unknown(TransportFailure::Cancelled)); }, value = receive => value }
		};
		match pending {
			PendingResult::Value(result) => {
				Ok(TransportResponse { id, result, dispatch: DispatchState::Responded })
			},
			PendingResult::RpcError(code) => Err(TransportError {
				dispatch: DispatchState::Responded,
				cause:    TransportFailure::JsonRpc { code },
			}),
			PendingResult::Malformed => {
				Err(TransportError::effects_unknown(TransportFailure::MalformedFrame))
			},
			PendingResult::FrameTooLarge => {
				Err(TransportError::effects_unknown(TransportFailure::FrameTooLarge))
			},
			PendingResult::Closed => Err(TransportError::effects_unknown(TransportFailure::Closed)),
		}
	}

	async fn close_inner(&self) -> Result<(), TransportError> {
		if !self.inner.closed.swap(true, Ordering::AcqRel) {
			close_pending(&self.inner);
		}
		terminate_inner(&self.inner).await;
		Ok(())
	}
}

impl McpTransport for StdioTransport {
	fn request<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<TransportResponse, TransportError>> {
		Box::pin(async move {
			let operation = self.request_inner(method, params, cancellation);
			match self.inner.timeout {
				Some(timeout) => time::timeout(timeout, operation)
					.await
					.map_err(|_| TransportError::effects_unknown(TransportFailure::TimedOut))?,
				None => operation.await,
			}
		})
	}

	fn notify<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
		Box::pin(async move {
			self
				.send(&json!({"jsonrpc":"2.0", "method":method, "params":params}), &cancellation)
				.await
		})
	}

	fn next_message<'a>(
		&'a self,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<IncomingMessage, TransportError>> {
		Box::pin(async move {
			tokio::select! { () = cancellation.cancelled() => Err(TransportError::pre_dispatch(TransportFailure::Cancelled)), message = self.inner.incoming_rx.recv_async() => message.map_err(|_| TransportError::pre_dispatch(TransportFailure::Closed)) }
		})
	}

	fn respond<'a>(
		&'a self,
		id: RequestId,
		result: Result<Value, ServerResponseError>,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
		Box::pin(async move {
			let frame = match result {
				Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
				Err(error) => {
					json!({"jsonrpc":"2.0", "id":id, "error":{"code":error.code,"message":error.message,"data":error.data}})
				},
			};
			self.send(&frame, &cancellation).await
		})
	}

	fn close(&self) -> TransportFuture<'_, Result<(), TransportError>> {
		Box::pin(self.close_inner())
	}
}

async fn read_stdout(inner: Arc<Inner>, stdout: process::ChildStdout) {
	let mut reader = BufReader::new(stdout);
	let mut frame = Vec::new();
	let mut malformed = false;
	let mut frame_too_large = false;
	'stream: loop {
		let available = match reader.fill_buf().await {
			Ok(bytes) if bytes.is_empty() => {
				if !frame.is_empty() {
					match serde_json::from_slice::<Value>(&frame) {
						Ok(value) => dispatch(&inner, value),
						Err(_) => malformed = true,
					}
				}
				break;
			},
			Ok(bytes) => bytes,
			Err(_) => break,
		};
		let newline = available.iter().position(|byte| *byte == b'\n');
		let consumed = newline.map_or(available.len(), |position| position + 1);
		if frame.len().saturating_add(consumed) > MAX_FRAME_BYTES {
			frame_too_large = true;
			break;
		}
		frame.extend_from_slice(&available[..consumed]);
		reader.consume(consumed);
		if newline.is_none() {
			continue;
		}
		match serde_json::from_slice::<Value>(&frame) {
			Ok(value) => dispatch(&inner, value),
			Err(_) => {
				malformed = true;
				break;
			},
		}
		frame.clear();
		if inner.closed.load(Ordering::Acquire) {
			break 'stream;
		}
	}
	inner.closed.store(true, Ordering::Release);
	if malformed || frame_too_large {
		for (_, sender) in inner.pending.lock().drain() {
			let result = if malformed {
				PendingResult::Malformed
			} else {
				PendingResult::FrameTooLarge
			};
			let _ = sender.send(result);
		}
	} else {
		close_pending(&inner);
	}
	let _ = inner.incoming_tx.try_send(IncomingMessage::Closed);
	terminate_inner(&inner).await;
}

fn dispatch(inner: &Inner, message: Value) {
	if let Value::Array(messages) = message {
		for message in messages {
			dispatch(inner, message);
		}
		return;
	}
	let Some(object) = message.as_object() else {
		return;
	};
	if let Some(id_value) = object.get("id")
		&& (object.contains_key("result") || object.contains_key("error"))
		&& let Ok(id) = serde_json::from_value::<RequestId>(id_value.clone())
		&& let Some(pending) = inner.pending.lock().remove(&id)
	{
		let result = if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
			PendingResult::Malformed
		} else {
			match (object.get("result"), object.get("error")) {
				(Some(result), None) => PendingResult::Value(result.clone()),
				(None, Some(error)) => error
					.get("code")
					.and_then(Value::as_i64)
					.map_or(PendingResult::Malformed, PendingResult::RpcError),
				_ => PendingResult::Malformed,
			}
		};
		let _ = pending.send(result);
		return;
	}
	let Some(method) = object.get("method").and_then(Value::as_str) else {
		return;
	};
	let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
	let incoming = if let Some(value) = object.get("id") {
		let Ok(id) = serde_json::from_value::<RequestId>(value.clone()) else {
			return;
		};
		IncomingMessage::Request { id, method: Str::from(method), params }
	} else {
		IncomingMessage::Notification { method: Str::from(method), params }
	};
	let _ = inner.incoming_tx.try_send(incoming);
}

fn close_pending(inner: &Inner) {
	for (_, sender) in inner.pending.lock().drain() {
		let _ = sender.send(PendingResult::Closed);
	}
}

async fn terminate_inner(inner: &Inner) {
	if inner.teardown.swap(true, Ordering::AcqRel) {
		return;
	}
	reap_inner(inner).await;
}

async fn reap_inner(inner: &Inner) {
	if let Ok(mut stdin) = inner.stdin.try_lock() {
		stdin.take();
	}
	let Some(mut child) = inner.child.lock().await.take() else {
		return;
	};
	let pid = child.id().or(inner.pid);
	signal_child(pid, inner.detached, false);
	let exited = time::timeout(TERM_GRACE, child.wait()).await.is_ok();
	if !exited || inner.detached {
		signal_child(pid, inner.detached, true);
		if !exited {
			let _ = time::timeout(KILL_GRACE, child.wait()).await;
		}
	}
}

fn signal_child(pid: Option<u32>, detached: bool, hard: bool) {
	#[cfg(unix)]
	if let Some(pid) = pid {
		let signal = if hard {
			signal::Signal::SIGKILL
		} else {
			signal::Signal::SIGTERM
		};
		let raw = Pid::from_raw(pid.cast_signed());
		if detached {
			match signal::kill(Pid::from_raw(-raw.as_raw()), signal) {
				Ok(()) | Err(nix::errno::Errno::ESRCH) => {},
				Err(_) => {
					let _ = signal::kill(raw, signal);
				},
			}
		} else {
			let _ = signal::kill(raw, signal);
		}
	}
	#[cfg(windows)]
	if let Some(pid) = pid {
		let _ = detached;
		if hard {
			terminate_windows_process_tree(pid);
		} else {
			// CREATE_NEW_PROCESS_GROUP makes `pid` a valid CTRL_BREAK group.
			// Failure is harmless: the bounded hard-kill sweep follows.
			// SAFETY: the event code and process-group identifier are plain values;
			// Windows validates whether the target group still exists.
			unsafe {
				windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent(
					windows_sys::Win32::System::Console::CTRL_BREAK_EVENT,
					pid,
				);
			}
		}
	}
}

#[cfg(windows)]
fn terminate_windows_process_tree(root: u32) {
	use std::mem::size_of;

	use windows_sys::Win32::{
		Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
		System::{
			Diagnostics::ToolHelp::{
				CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
				TH32CS_SNAPPROCESS,
			},
			Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess},
		},
	};

	// SAFETY: the flags request a system-owned snapshot and require no caller
	// pointers.
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE_VALUE {
		return;
	}
	let mut entry =
		PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..PROCESSENTRY32W::default() };
	let mut relationships = Vec::new();
	// SAFETY: `snapshot` is live and `entry` has the required size initialized.
	if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
		loop {
			relationships.push((entry.th32ProcessID, entry.th32ParentProcessID));
			// SAFETY: the same live snapshot and initialized writable entry remain
			// valid for the duration of enumeration.
			if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
				break;
			}
		}
	}
	// SAFETY: `snapshot` is a live owned handle and is closed exactly once here.
	unsafe {
		CloseHandle(snapshot);
	}

	let mut tree = vec![root];
	loop {
		let before = tree.len();
		for &(pid, parent) in &relationships {
			if !tree.contains(&pid) && tree.contains(&parent) {
				tree.push(pid);
			}
		}
		if tree.len() == before {
			break;
		}
	}
	for pid in tree.into_iter().rev() {
		// SAFETY: Windows validates the process identifier and requested access.
		let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
		if !process.is_null() {
			// SAFETY: `process` is a live owned handle, terminated and then closed
			// exactly once in this branch.
			unsafe {
				TerminateProcess(process, 1);
				CloseHandle(process);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::env;

	use super::*;

	#[tokio::test]
	async fn npm_cmd_shim_bypasses_cmd_exe_for_node_target() {
		let scratch = tempfile::tempdir().expect("scratch");
		let shim = scratch.path().join("server.cmd");
		tokio::fs::write(
			&shim,
			"@SET \"_prog=node\"\r\n\"%_prog%\"  \"%~dp0\\node_modules\\server\\index.js\" %*\r\n",
		)
		.await
		.expect("shim");
		let config = StdioConfig {
			command:           shim,
			args:              vec![Str::from("arg")],
			env:               BTreeMap::new(),
			cwd:               scratch.path().to_path_buf(),
			timeout:           None,
			request_id_format: RequestIdFormat::Number,
		};
		let plan = resolve_windows_npm_shim(&config).await.expect("bypass");
		assert_eq!(plan.executable, OsString::from("node"));
		assert!(
			plan.args[0]
				.to_string_lossy()
				.ends_with("node_modules/server/index.js")
		);
		assert_eq!(plan.args[1], "arg");
	}

	#[test]
	fn platform_spawn_vectors_cover_sessions_and_batbadbut() {
		let config = StdioConfig {
			command:           PathBuf::from(r"C:\work\%TOKEN%\server.cmd"),
			args:              vec![Str::from("hello & goodbye"), Str::from("plain")],
			env:               BTreeMap::new(),
			cwd:               PathBuf::from("."),
			timeout:           None,
			request_id_format: RequestIdFormat::Number,
		};
		assert!(
			resolve_spawn_plan(&config, StdioPlatform::Posix, true, None)
				.expect("posix")
				.detached_session
		);
		assert!(
			!resolve_spawn_plan(&config, StdioPlatform::Macos, true, None)
				.expect("mac")
				.detached_session
		);
		let windows =
			resolve_spawn_plan(&config, StdioPlatform::Windows, true, Some(OsStr::new("cmd.exe")))
				.expect("windows");
		assert!(windows.windows_verbatim);
		let line = windows.args.last().expect("line").to_string_lossy();
		assert!(line.contains("%%cd:~,%TOKEN%%cd:~,%"));
		assert!(line.contains("\"hello & goodbye\""));
	}

	#[tokio::test]
	async fn concurrent_ndjson_fixture_correlates_and_closes() {
		let executable = env::current_exe().expect("test executable");
		let transport = StdioTransport::spawn(StdioConfig {
			command:           executable,
			args:              vec![
				Str::from("--exact"),
				Str::from("mcp::stdio::tests::stdio_fixture_child"),
				Str::from("--nocapture"),
				Str::from("-Z"),
				Str::from("unstable-options"),
				Str::from("--format"),
				Str::from("json"),
			],
			env:               BTreeMap::from([(
				Str::from("OMP_MCP_STDIO_FIXTURE"),
				OsString::from("1"),
			)]),
			cwd:               env::current_dir().expect("cwd"),
			timeout:           Some(Duration::from_secs(5)),
			request_id_format: RequestIdFormat::Number,
		})
		.await
		.expect("spawn");
		let (left, right) = tokio::join!(
			transport.request("echo", json!({"value":"left"}), CancellationToken::new()),
			transport.request("echo", json!({"value":"right"}), CancellationToken::new())
		);
		assert_eq!(left.expect("left").result["value"], "left");
		assert_eq!(right.expect("right").result["value"], "right");
		transport.close().await.expect("close");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn close_terminates_descendant_process_group() {
		let executable = env::current_exe().expect("test executable");
		let transport = StdioTransport::spawn(StdioConfig {
			command:           executable,
			args:              vec![
				Str::from("--exact"),
				Str::from("mcp::stdio::tests::stdio_fixture_child"),
				Str::from("--nocapture"),
				Str::from("-Z"),
				Str::from("unstable-options"),
				Str::from("--format"),
				Str::from("json"),
			],
			env:               BTreeMap::from([(
				Str::from("OMP_MCP_STDIO_FIXTURE"),
				OsString::from("1"),
			)]),
			cwd:               env::current_dir().expect("cwd"),
			timeout:           Some(Duration::from_secs(5)),
			request_id_format: RequestIdFormat::Number,
		})
		.await
		.expect("spawn");
		let response = transport
			.request("spawn-grandchild", json!({}), CancellationToken::new())
			.await
			.expect("request");
		let pid = response.result["pid"].as_i64().expect("pid");
		transport.close().await.expect("close");
		let pid = Pid::from_raw(i32::try_from(pid).expect("pid range"));
		for _ in 0..20 {
			if signal::kill(pid, None).is_err() {
				return;
			}
			time::sleep(Duration::from_millis(25)).await;
		}
		panic!("stdio descendant survived process-group teardown");
	}

	#[tokio::test]
	async fn stdio_fixture_child() {
		use tokio::io;
		if env::var_os("OMP_MCP_STDIO_FIXTURE").is_none() {
			return;
		}
		let mut input = BufReader::new(io::stdin()).lines();
		let mut output = io::stdout();
		while let Ok(Some(line)) = input.next_line().await {
			let request: Value = serde_json::from_str(&line).expect("request");
			let result = if request["method"] == "spawn-grandchild" {
				#[cfg(unix)]
				{
					let child = process::Command::new("/bin/sh")
						.args(["-c", "trap '' TERM; exec sleep 30"])
						.stdin(Stdio::null())
						.stdout(Stdio::null())
						.stderr(Stdio::null())
						.spawn()
						.expect("grandchild");
					json!({"pid": child.id().expect("grandchild pid")})
				}
				#[cfg(windows)]
				{
					json!({})
				}
			} else {
				request["params"].clone()
			};
			let response = json!({"jsonrpc":"2.0", "id":request["id"], "result":result});
			output
				.write_all(
					serde_json::to_string(&response)
						.expect("response")
						.as_bytes(),
				)
				.await
				.expect("write");
			output.write_all(b"\n").await.expect("newline");
			output.flush().await.expect("flush");
		}
	}
}
