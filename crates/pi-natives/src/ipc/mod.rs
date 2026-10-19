//! Native local IPC: Unix domain sockets and Windows named pipes behind one
//! N-API surface.
//!
//! The native layer owns transport, peer security, single-instance bind,
//! stale-endpoint takeover and line framing; lifecycle policy (spawn, auth,
//! idle exit) stays in TypeScript. Every failure surfaces as a JS `Error`
//! whose `code` is an errno-style string (`ENOENT`, `EADDRINUSE`, …).

use std::{io, sync::Arc, time::Duration};

use memchr::memchr;
use napi::{
	Env, Error, JsError, JsString, JsTypeError, Result,
	bindgen_prelude::{Either, Function, PromiseRaw, Uint8Array},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::js;

mod conn;
mod cork;
mod endpoint;
mod lines;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

use self::conn::{FrameCallback, Framing, Shared};

#[cfg(not(any(unix, windows)))]
compile_error!("pi-natives IPC requires Unix or Windows");

/// Default `maxFrameBytes` for `lines` framing.
const DEFAULT_MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;
/// Default connect deadline.
const DEFAULT_CONNECT_TIMEOUT_MS: u32 = 3000;

/// Transport failure carrying an errno-style code.
pub struct IpcError {
	code:    &'static str,
	message: String,
}

impl IpcError {
	fn new(code: &'static str, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	fn io(error: &io::Error, context: &str) -> Self {
		Self { code: io_error_code(error), message: format!("{context}: {error}") }
	}

	/// `onClose` reason text: `"<CODE>: <message>"`.
	fn reason(&self) -> String {
		format!("{}: {}", self.code, self.message)
	}

	/// JS `Error` whose `code` property is this error's code.
	fn into_js(self, env: &Env) -> Error {
		Error::from(JsError::from(Error::new(self.code, self.message)).into_unknown(*env))
	}
}

/// JS `TypeError` with `code`, for argument misuse.
fn type_error(env: &Env, code: &str, message: &str) -> Error {
	Error::from(JsTypeError::from(Error::new(code, message)).into_unknown(*env))
}

/// Errno-style name for `error`.
fn io_error_code(error: &io::Error) -> &'static str {
	if let Some(code) = error.raw_os_error().and_then(platform::os_error_code) {
		return code;
	}
	match error.kind() {
		io::ErrorKind::NotFound => "ENOENT",
		io::ErrorKind::PermissionDenied => "EACCES",
		io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
		io::ErrorKind::ConnectionReset => "ECONNRESET",
		io::ErrorKind::ConnectionAborted => "ECONNABORTED",
		io::ErrorKind::NotConnected => "ENOTCONN",
		io::ErrorKind::AddrInUse => "EADDRINUSE",
		io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
		io::ErrorKind::BrokenPipe => "EPIPE",
		io::ErrorKind::AlreadyExists => "EEXIST",
		io::ErrorKind::WouldBlock => "EAGAIN",
		io::ErrorKind::InvalidInput => "EINVAL",
		io::ErrorKind::TimedOut => "ETIMEDOUT",
		io::ErrorKind::Interrupted => "EINTR",
		io::ErrorKind::Unsupported => "ENOTSUP",
		io::ErrorKind::OutOfMemory => "ENOMEM",
		_ => "EIO",
	}
}

fn parse_framing(env: &Env, framing: &str) -> Result<Framing> {
	match framing {
		"lines" => Ok(Framing::Lines),
		"raw" => Ok(Framing::Raw),
		other => Err(type_error(
			env,
			"ERR_INVALID_ARG_VALUE",
			&format!("framing must be \"lines\" or \"raw\", got {other:?}"),
		)),
	}
}

/// Options for `IpcServer.listen`.
#[napi(object)]
pub struct IpcListenOptions {
	/// `lines`: UTF-8 text frames delimited by LF; `raw`: byte chunks as
	/// received.
	#[napi(ts_type = "\"lines\" | \"raw\"")]
	pub framing:         String,
	/// Max bytes of one received line (lines framing). Default 64 MiB.
	/// Exceeding closes that connection with reason "EMSGSIZE: …".
	pub max_frame_bytes: Option<u32>,
}

/// Options for `IpcConnection.connect`.
#[napi(object)]
pub struct IpcConnectOptions {
	/// `lines`: UTF-8 text frames delimited by LF; `raw`: byte chunks as
	/// received.
	#[napi(ts_type = "\"lines\" | \"raw\"")]
	pub framing:         String,
	/// Connect deadline. Default 3000 ms. Expiry rejects with code ETIMEDOUT.
	pub timeout_ms:      Option<u32>,
	/// Max bytes of one received line (lines framing). Default 64 MiB.
	pub max_frame_bytes: Option<u32>,
}

/// Platform endpoint for `name` scoped to directory `dir`.
///
/// Unix: `<dir>/<stem>.sock`; when that path does not fit `sun_path` (104 bytes
/// on macOS/BSD, 108 on Linux, including NUL), `/tmp/omp-<euid>/<hash16>.sock`.
/// Windows: `\\.\pipe\omp-<stem>-<hash16(lowercase(resolve(dir)))>`.
/// `stem` is `name` with every char outside `[A-Za-z0-9._-]` replaced by "_".
/// Pure and deterministic: every process computes the same endpoint.
#[napi(js_name = "ipcEndpoint")]
pub fn ipc_endpoint(dir: String, name: String) -> String {
	let resolved = endpoint::resolve_dir(&dir);
	#[cfg(unix)]
	{
		endpoint::unix_endpoint(&resolved, &name, platform::euid(), endpoint::SUN_PATH_MAX)
	}
	#[cfg(windows)]
	{
		endpoint::windows_pipe_name(&resolved, &name)
	}
}

type ConnectionCallback =
	ThreadsafeFunction<IpcConnection, UnknownReturnValue, IpcConnection, napi::Status, false>;

struct ServerState {
	on_connection: Option<ConnectionCallback>,
	refed:         bool,
	accept_task:   Option<JoinHandle<()>>,
	cancel:        CancellationToken,
	bound:         Option<platform::Bound>,
}

/// Listening IPC endpoint.
#[napi]
pub struct IpcServer {
	endpoint: String,
	state:    Arc<Mutex<ServerState>>,
}

#[napi]
impl IpcServer {
	/// Bind and listen.
	///
	/// Unix: creates the parent dir (0700) if missing; under an exclusive flock
	/// on `<path>.bind.lock`, rejects EADDRINUSE when a live server answers,
	/// otherwise replaces the stale socket file; the socket is chmod 0600 before
	/// `listen()`. Windows: first pipe instance (exists → EADDRINUSE), remote
	/// clients rejected, DACL granting only the current user.
	/// `onConnection` receives each accepted, peer-verified connection (not yet
	/// started).
	#[napi(
		ts_args_type = "endpoint: string, options: IpcListenOptions, onConnection: (connection: \
		                IpcConnection) => void",
		ts_return_type = "Promise<IpcServer>"
	)]
	pub fn listen<'env>(
		env: &'env Env,
		endpoint: String,
		options: IpcListenOptions,
		on_connection: Function<'_, IpcConnection, UnknownReturnValue>,
	) -> Result<PromiseRaw<'env, Self>> {
		let framing = parse_framing(env, &options.framing)?;
		let max_frame_bytes = options.max_frame_bytes.unwrap_or(DEFAULT_MAX_FRAME_BYTES) as usize;
		let callback: ConnectionCallback = on_connection.build_threadsafe_function().build()?;
		let state = Arc::new(Mutex::new(ServerState {
			on_connection: Some(callback),
			refed:         true,
			accept_task:   None,
			cancel:        CancellationToken::new(),
			bound:         None,
		}));
		let task_state = Arc::clone(&state);
		env.spawn_future_with_callback(
			async move {
				let bound = platform::listen(&endpoint).await;
				Ok(bound.map(|(listener, bound)| {
					let cancel = {
						let mut guard = task_state.lock();
						guard.bound = Some(bound);
						guard.cancel.clone()
					};
					let accept_state = Arc::clone(&task_state);
					let task = napi::bindgen_prelude::spawn(accept_loop(
						listener,
						accept_state,
						cancel,
						framing,
						max_frame_bytes,
					));
					task_state.lock().accept_task = Some(task);
					Self { endpoint, state: task_state }
				}))
			},
			|env, outcome| outcome.map_err(|error| error.into_js(env)),
		)
	}

	/// The endpoint this server listens on.
	#[napi(getter)]
	pub fn endpoint(&self) -> String {
		self.endpoint.clone()
	}

	/// Stop accepting. Unix: unlink the socket file if it is still the inode
	/// this server bound. Accepted connections are untouched. Idempotent.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		let (task, callback) = {
			let mut state = self.state.lock();
			// Unlink while the listener is still open: no other process can
			// have replaced the file, because its liveness probe still succeeds.
			if let Some(bound) = state.bound.take() {
				platform::release(bound);
			}
			state.cancel.cancel();
			(state.accept_task.take(), state.on_connection.take())
		};
		drop(callback);
		env.spawn_future(async move {
			if let Some(task) = task {
				let _ = task.await;
			}
			Ok(())
		})
	}

	/// Keep the event loop alive while listening (default).
	#[napi(js_name = "ref")]
	pub fn refer(&self, env: &Env) -> Result<()> {
		self.set_ref(env, true)
	}

	/// Let the event loop exit while listening.
	#[napi]
	pub fn unref(&self, env: &Env) -> Result<()> {
		self.set_ref(env, false)
	}
}

impl IpcServer {
	#[allow(deprecated, reason = "explicit loop ref toggling is the documented intent")]
	fn set_ref(&self, env: &Env, refed: bool) -> Result<()> {
		let mut state = self.state.lock();
		if state.refed == refed {
			return Ok(());
		}
		state.refed = refed;
		if let Some(callback) = state.on_connection.as_mut() {
			if refed {
				callback.refer(env)?;
			} else {
				callback.unref(env)?;
			}
		}
		Ok(())
	}
}

async fn accept_loop(
	mut listener: platform::Listener,
	state: Arc<Mutex<ServerState>>,
	cancel: CancellationToken,
	framing: Framing,
	max_frame_bytes: usize,
) {
	loop {
		let accepted = tokio::select! {
			() = cancel.cancelled() => return,
			accepted = listener.accept() => accepted,
		};
		match accepted {
			Ok(stream) => {
				let connection = IpcConnection::spawn(stream, framing, max_frame_bytes);
				let state = state.lock();
				if let Some(callback) = &state.on_connection {
					callback.call(connection, ThreadsafeFunctionCallMode::NonBlocking);
				}
			},
			// Transient accept failures (EMFILE, aborted handshakes, a pipe
			// instance that could not be recreated) must not spin the loop.
			Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
		}
	}
}

/// One accepted or dialed IPC connection.
#[napi]
pub struct IpcConnection {
	shared: Arc<Shared>,
}

#[napi]
impl IpcConnection {
	/// Dial `endpoint`. Rejects with code ENOENT (no endpoint), ECONNREFUSED
	/// (stale socket / no listener), ETIMEDOUT, EACCES (peer owned by another
	/// user, or permission), or the OS errno name.
	#[napi(ts_return_type = "Promise<IpcConnection>")]
	pub fn connect(
		env: &Env,
		endpoint: String,
		options: IpcConnectOptions,
	) -> Result<PromiseRaw<'_, Self>> {
		let framing = parse_framing(env, &options.framing)?;
		let max_frame_bytes = options.max_frame_bytes.unwrap_or(DEFAULT_MAX_FRAME_BYTES) as usize;
		let timeout =
			Duration::from_millis(u64::from(options.timeout_ms.unwrap_or(DEFAULT_CONNECT_TIMEOUT_MS)));
		env.spawn_future_with_callback(
			async move {
				let connected =
					match tokio::time::timeout(timeout, platform::connect(&endpoint, timeout)).await {
						Ok(connected) => connected,
						Err(_) => Err(IpcError::new(
							"ETIMEDOUT",
							format!("connect {endpoint} timed out after {} ms", timeout.as_millis()),
						)),
					};
				Ok(connected.map(|stream| Self::spawn(stream, framing, max_frame_bytes)))
			},
			|env, outcome| outcome.map_err(|error| error.into_js(env)),
		)
	}

	/// Begin delivery on a `lines` connection (throws `TypeError` on a `raw`
	/// one). Call `start`/`startRaw` exactly once. Frames received before
	/// start are buffered, never dropped. `onLine` gets each non-empty line
	/// (one trailing CR stripped, invalid UTF-8 replaced lossily). `onClose`
	/// fires exactly once, after the last frame — including after local
	/// `end()`/`destroy()`: `null` for an orderly close, otherwise
	/// `"<CODE>: <message>"`.
	#[napi(ts_args_type = "onLine: (line: string) => void, onClose: (reason: string | null) => void")]
	pub fn start(
		&self,
		env: &Env,
		on_line: Function<'_, String, UnknownReturnValue>,
		on_close: Function<'_, Option<String>, UnknownReturnValue>,
	) -> Result<()> {
		self.check_start(env, Framing::Lines)?;
		self
			.shared
			.start(env, FrameCallback::Lines(on_line.create_ref()?), &on_close)
	}

	/// Same as `start()` for a `raw` connection (throws `TypeError` on a
	/// `lines` one): `onChunk` gets each received chunk.
	#[napi(ts_args_type = "onChunk: (chunk: Uint8Array) => void, onClose: (reason: string | null) \
	                       => void")]
	pub fn start_raw(
		&self,
		env: &Env,
		on_chunk: Function<'_, Uint8Array, UnknownReturnValue>,
		on_close: Function<'_, Option<String>, UnknownReturnValue>,
	) -> Result<()> {
		self.check_start(env, Framing::Raw)?;
		self
			.shared
			.start(env, FrameCallback::Raw(on_chunk.create_ref()?), &on_close)
	}

	/// Send one frame. lines: a string without LF (`TypeError` otherwise);
	/// LF is appended. raw: string (UTF-8) or `Uint8Array` written as-is.
	/// Frames sent during one JS task are written together when it ends (a
	/// microtask), in order; `end()` writes them first. Returns false once
	/// unwritten bytes exceed 1 MiB (await `drained()` before sending more).
	/// After close: returns false and drops the frame.
	#[napi]
	pub fn send(&self, env: &Env, frame: Either<JsString<'_>, Uint8Array>) -> Result<bool> {
		// Bytes are copied once, from the JS string scratch (or the caller's
		// typed array) into the cork — or not at all for large frames the
		// socket takes directly.
		let outcome = match (self.shared.framing, frame) {
			(Framing::Lines, Either::A(text)) => {
				let text = js::utf8(text)?;
				if memchr(b'\n', text.as_bytes()).is_some() {
					return Err(type_error(
						env,
						"ERR_INVALID_ARG_VALUE",
						"lines frame must not contain \"\\n\"",
					));
				}
				self.shared.send(&[text.as_bytes(), b"\n"])
			},
			(Framing::Lines, Either::B(_)) => {
				return Err(type_error(
					env,
					"ERR_INVALID_ARG_TYPE",
					"lines connections send strings, not bytes",
				));
			},
			(Framing::Raw, Either::A(text)) => self.shared.send(&[js::utf8(text)?.as_bytes()]),
			(Framing::Raw, Either::B(bytes)) => self.shared.send(&[&bytes]),
		};
		if outcome.uncorked {
			cork::schedule(env, &self.shared)?;
		}
		Ok(outcome.below_high_water)
	}

	/// Resolves when the write queue is empty, or the connection closed.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn drained<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		let shared = Arc::clone(&self.shared);
		env.spawn_future(async move {
			shared.wait_drained().await;
			Ok(())
		})
	}

	/// Graceful: write everything queued, then shut the write half (Unix) /
	/// close the pipe (Windows); onClose follows when the read side ends.
	#[napi]
	pub fn end(&self) {
		self.shared.end();
	}

	/// Immediate close; queued writes are dropped; onClose(null) follows.
	/// Idempotent.
	#[napi]
	pub fn destroy(&self) {
		self.shared.destroy();
	}

	/// Keep the event loop alive while delivering (default).
	#[napi(js_name = "ref")]
	pub fn refer(&self, env: &Env) -> Result<()> {
		self.shared.set_ref(env, true)
	}

	/// Let the event loop exit while this connection is open.
	#[napi]
	pub fn unref(&self, env: &Env) -> Result<()> {
		self.shared.set_ref(env, false)
	}

	/// Whether the connection is closed (or `destroy()` was called).
	#[napi(getter)]
	pub fn closed(&self) -> bool {
		self.shared.is_closed()
	}
}

impl IpcConnection {
	fn spawn(stream: platform::Stream, framing: Framing, max_frame_bytes: usize) -> Self {
		let (commands, receiver) = mpsc::unbounded_channel();
		let stream = Arc::new(stream);
		let shared = Arc::new(Shared::new(framing, commands, Arc::clone(&stream)));
		napi::bindgen_prelude::spawn(conn::run(
			stream,
			Arc::clone(&shared),
			receiver,
			max_frame_bytes,
		));
		Self { shared }
	}

	fn check_start(&self, env: &Env, framing: Framing) -> Result<()> {
		if self.shared.framing != framing {
			let message = match framing {
				Framing::Lines => "start() requires a lines connection; use startRaw()",
				Framing::Raw => "startRaw() requires a raw connection; use start()",
			};
			return Err(type_error(env, "ERR_INVALID_ARG_TYPE", message));
		}
		if self.shared.is_started() {
			return Err(IpcError::new("ERR_INVALID_STATE", "connection already started").into_js(env));
		}
		Ok(())
	}
}

impl Drop for IpcConnection {
	/// A connection JavaScript never started has no observer left: close it
	/// instead of leaking the stream. Started connections keep running until
	/// they close, like `net.Socket`.
	fn drop(&mut self) {
		if !self.shared.is_started() {
			self.shared.destroy();
		}
	}
}
