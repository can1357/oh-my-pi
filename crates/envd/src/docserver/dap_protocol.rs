//! Bounded Content-Length framed Debug Adapter Protocol engine.

#[cfg(target_os = "linux")]
use std::env;
use std::{
	collections::HashMap,
	io,
	net::SocketAddr,
	path::{Path, PathBuf},
	process,
	sync::{
		Arc,
		atomic::{AtomicI64, Ordering},
	},
	time::Duration,
};

use omp_core::{Str, sf};
use serde_json::json;
use tokio::{
	io::{AsyncRead, AsyncWrite},
	net::{self, TcpListener, TcpStream, UnixStream},
	process::{Child, Command},
	sync::{Mutex, broadcast, oneshot},
	time,
	time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::docserver::{DapTransport, lsp_process, lsp_process::LspFrameError};
const MAX_DAP_HEADER_BYTES: usize = 8 * 1024;
const MAX_DAP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const EVENT_CAPACITY: usize = 512;

type PendingResponse = (Str, oneshot::Sender<Result<serde_json::Value, DapProtocolError>>);
type PendingRequests = HashMap<i64, PendingResponse>;

/// An event or reverse request received from a debug adapter.
#[derive(Clone, Debug)]
pub enum DapInbound {
	/// Adapter event.
	Event {
		/// Event name.
		event: Str,
		/// Opaque event body.
		body:  serde_json::Value,
	},
	/// Adapter-to-client request.
	ReverseRequest {
		/// Adapter request sequence.
		seq:       i64,
		/// Requested client command.
		command:   Str,
		/// Opaque arguments.
		arguments: serde_json::Value,
	},
}

/// Framing, transport, or adapter response failure.
#[derive(Debug, thiserror::Error)]
pub enum DapProtocolError {
	/// The transport ended before completion.
	#[error("DAP transport closed")]
	TransportClosed,
	/// A bounded read, write, or request timed out.
	#[error("DAP request timed out")]
	Timeout,
	/// A message violated DAP framing.
	#[error("invalid DAP frame: {0}")]
	InvalidFrame(Str),
	/// Decoding a Content-Length-framed message failed.
	#[error("invalid DAP frame")]
	Frame {
		/// The underlying frame decoding failure.
		#[source]
		source: LspFrameError,
	},
	/// The adapter returned `success: false`.
	#[error("DAP adapter rejected {command}: {message}")]
	Adapter {
		/// Failed command.
		command: Str,
		/// Adapter-supplied sanitized message.
		message: Str,
	},
	/// Transport I/O failed.
	#[error("DAP I/O failed: {0}")]
	Io(#[from] io::Error),
	/// Message JSON was malformed.
	#[error("DAP JSON failed: {0}")]
	Json(#[from] serde_json::Error),
}

struct OutgoingRequest {
	seq:       i64,
	command:   Str,
	arguments: serde_json::Value,
	response:  oneshot::Sender<Result<serde_json::Value, DapProtocolError>>,
}

enum Outgoing {
	Request(OutgoingRequest),
	Response {
		request_seq: i64,
		command:     Str,
		success:     bool,
		body:        serde_json::Value,
		message:     Option<Str>,
	},
	Shutdown,
}

struct ProtocolInner {
	next_seq: AtomicI64,
	outgoing: flume::Sender<Outgoing>,
	events:   broadcast::Sender<DapInbound>,
	closed:   CancellationToken,
}

/// Cloneable client handle for one ordered DAP connection.
#[derive(Clone)]
pub struct DapProtocol {
	inner: Arc<ProtocolInner>,
}

const ADAPTER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ADAPTER_READY_POLL: Duration = Duration::from_millis(25);
/// A spawned stdio adapter and its protocol connection.
pub struct SpawnedDap {
	/// Active framed protocol.
	pub protocol:     DapProtocol,
	/// Owned adapter process.
	pub child:        Arc<Mutex<Child>>,
	/// Unix socket removed when the owning session tears down.
	pub cleanup_path: Option<PathBuf>,
}

impl DapProtocol {
	/// Starts the protocol actor over an already-connected byte transport.
	pub fn from_streams<R, W>(reader: R, writer: W) -> Self
	where
		R: AsyncRead + Unpin + Send + 'static,
		W: AsyncWrite + Unpin + Send + 'static,
	{
		let (outgoing, receiver) = flume::unbounded();
		let (events, _) = broadcast::channel(EVENT_CAPACITY);
		let closed = CancellationToken::new();
		let inner = Arc::new(ProtocolInner { next_seq: AtomicI64::new(1), outgoing, events, closed });
		let actor = Arc::clone(&inner);
		tokio::spawn(
			async move { protocol_actor::run_protocol(reader, writer, receiver, actor).await },
		);
		Self { inner }
	}

	/// Spawns a non-interactive stdio adapter without a controlling terminal.
	pub fn spawn_stdio(
		command: &str,
		args: &[Str],
		cwd: &Path,
	) -> Result<SpawnedDap, DapProtocolError> {
		let mut process = Command::new(command);
		process
			.args(args.iter().map(Str::as_str))
			.current_dir(cwd)
			.stdin(process::Stdio::piped())
			.stdout(process::Stdio::piped())
			.stderr(process::Stdio::null())
			.kill_on_drop(true)
			.env("CI", "1")
			.env("TERM", "dumb")
			.env("GIT_TERMINAL_PROMPT", "0");
		#[cfg(unix)]
		{
			// SAFETY: `setsid` is async-signal-safe and touches no shared Rust state.
			unsafe {
				process.pre_exec(|| {
					if libc::setsid() < 0 {
						Err(io::Error::last_os_error())
					} else {
						Ok(())
					}
				})
			};
		}
		let mut child = process.spawn()?;
		let reader = child
			.stdout
			.take()
			.ok_or_else(|| io::Error::other("adapter stdout unavailable"))?;
		let writer = child
			.stdin
			.take()
			.ok_or_else(|| io::Error::other("adapter stdin unavailable"))?;
		Ok(SpawnedDap {
			protocol:     Self::from_streams(reader, writer),
			child:        Arc::new(Mutex::new(child)),
			cleanup_path: None,
		})
	}

	/// Connects an existing TCP debug adapter.
	pub async fn connect_tcp(address: SocketAddr) -> Result<Self, DapProtocolError> {
		let stream = TcpStream::connect(address).await?;
		let (reader, writer) = stream.into_split();
		Ok(Self::from_streams(reader, writer))
	}

	/// Resolves and connects a configured remote adapter endpoint.
	pub async fn connect_tcp_host(host: &str, port: u16) -> Result<Self, DapProtocolError> {
		let mut addresses = net::lookup_host((host, port)).await?;
		let address = addresses
			.next()
			.ok_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no DAP address"))?;
		Self::connect_tcp(address).await
	}

	/// Connects an existing Unix-domain debug adapter.
	#[cfg(unix)]
	pub async fn connect_unix(path: &Path) -> Result<Self, DapProtocolError> {
		let stream = UnixStream::connect(path).await?;
		let (reader, writer) = stream.into_split();
		Ok(Self::from_streams(reader, writer))
	}

	/// Sends one request and resolves its correlated response body.
	pub async fn request(
		&self,
		command: impl AsRef<str>,
		arguments: serde_json::Value,
	) -> Result<serde_json::Value, DapProtocolError> {
		if self.inner.closed.is_cancelled() {
			return Err(DapProtocolError::TransportClosed);
		}
		let seq = self.inner.next_seq.fetch_add(1, Ordering::Relaxed);
		if seq <= 0 {
			return Err(DapProtocolError::InvalidFrame(sf!("sequence space exhausted")));
		}
		let (response, receiver) = oneshot::channel();
		self
			.inner
			.outgoing
			.send_async(Outgoing::Request(OutgoingRequest {
				seq,
				command: Str::new(command.as_ref()),
				arguments,
				response,
			}))
			.await
			.map_err(|_| DapProtocolError::TransportClosed)?;
		match time::timeout(REQUEST_TIMEOUT, receiver).await {
			Ok(Ok(result)) => result,
			Ok(Err(_)) => Err(DapProtocolError::TransportClosed),
			Err(_) => Err(DapProtocolError::Timeout),
		}
	}

	/// Answers one adapter reverse request.
	pub async fn respond_reverse(
		&self,
		request_seq: i64,
		command: impl AsRef<str>,
		success: bool,
		body: serde_json::Value,
		message: Option<Str>,
	) -> Result<(), DapProtocolError> {
		self
			.inner
			.outgoing
			.send_async(Outgoing::Response {
				request_seq,
				command: Str::new(command.as_ref()),
				success,
				body,
				message,
			})
			.await
			.map_err(|_| DapProtocolError::TransportClosed)
	}

	/// Resolves when the byte transport closes or the actor shuts down.
	pub async fn closed(&self) {
		self.inner.closed.cancelled().await;
	}

	/// Stops the protocol actor and wakes subscribers.
	pub fn shutdown(&self) {
		let _ = self.inner.outgoing.send(Outgoing::Shutdown);
	}

	/// Reports whether the protocol transport has closed.
	pub fn is_closed(&self) -> bool {
		self.inner.closed.is_cancelled()
	}

	/// Spawns an adapter using its declared stdio, TCP, Unix-socket, or
	/// reverse-client transport and waits for a bounded owner-local connection.
	#[tracing::instrument(
		name = "dap_server_spawn",
		level = "debug",
		skip_all,
		fields(command = %command)
	)]
	pub async fn spawn_adapter(
		command: &str,
		args: &[Str],
		transport: &DapTransport,
		cwd: &Path,
	) -> Result<SpawnedDap, DapProtocolError> {
		match transport {
			DapTransport::Stdio => Self::spawn_stdio(command, args, cwd),
			DapTransport::Tcp { port_argument } => {
				Self::spawn_tcp(command, args, port_argument, cwd).await
			},
			DapTransport::Unix { socket_argument } => {
				#[cfg(target_os = "linux")]
				{
					Self::spawn_unix(command, args, socket_argument, cwd).await
				}
				#[cfg(not(target_os = "linux"))]
				{
					Self::spawn_reverse_tcp(command, args, socket_argument, cwd).await
				}
			},
		}
	}

	async fn spawn_tcp(
		command: &str,
		args: &[Str],
		port_argument: &str,
		cwd: &Path,
	) -> Result<SpawnedDap, DapProtocolError> {
		let reservation = TcpListener::bind(("127.0.0.1", 0)).await?;
		let port = reservation.local_addr()?.port();
		drop(reservation);
		let replacement = port.to_string();
		let args = substituted_args(args, port_argument, &replacement);
		let child = spawn_socket_process(command, &args, cwd)?;
		let child = Arc::new(Mutex::new(child));
		let deadline = Instant::now() + ADAPTER_READY_TIMEOUT;
		loop {
			match TcpStream::connect(("127.0.0.1", port)).await {
				Ok(stream) => {
					let (reader, writer) = stream.into_split();
					return Ok(SpawnedDap {
						protocol: Self::from_streams(reader, writer),
						child,
						cleanup_path: None,
					});
				},
				Err(error) if Instant::now() < deadline => {
					if child.lock().await.try_wait()?.is_some() {
						return Err(DapProtocolError::Io(error));
					}
					time::sleep(ADAPTER_READY_POLL).await;
				},
				Err(_error) => {
					kill_child(&child).await;
					return Err(DapProtocolError::Timeout);
				},
			}
		}
	}

	#[cfg(target_os = "linux")]
	async fn spawn_unix(
		command: &str,
		args: &[Str],
		socket_argument: &str,
		cwd: &Path,
	) -> Result<SpawnedDap, DapProtocolError> {
		let socket_path =
			env::temp_dir().join(format!("omp-dap-{}-{}.sock", process::id(), rand::random::<u64>()));
		let replacement = socket_path.to_string_lossy();
		let args = substituted_args(args, socket_argument, replacement.as_ref());
		let child = Arc::new(Mutex::new(spawn_socket_process(command, &args, cwd)?));
		let deadline = Instant::now() + ADAPTER_READY_TIMEOUT;
		loop {
			match UnixStream::connect(&socket_path).await {
				Ok(stream) => {
					let (reader, writer) = stream.into_split();
					return Ok(SpawnedDap {
						protocol: Self::from_streams(reader, writer),
						child,
						cleanup_path: Some(socket_path),
					});
				},
				Err(error) if Instant::now() < deadline => {
					if child.lock().await.try_wait()?.is_some() {
						return Err(DapProtocolError::Io(error));
					}
					time::sleep(ADAPTER_READY_POLL).await;
				},
				Err(_error) => {
					kill_child(&child).await;
					let _ = tokio::fs::remove_file(&socket_path).await;
					return Err(DapProtocolError::Timeout);
				},
			}
		}
	}

	#[cfg(not(target_os = "linux"))]
	async fn spawn_reverse_tcp(
		command: &str,
		args: &[Str],
		client_argument: &str,
		cwd: &Path,
	) -> Result<SpawnedDap, DapProtocolError> {
		let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
		let address = listener.local_addr()?;
		let replacement = address.to_string();
		let args = substituted_args(args, client_argument, &replacement);
		let child = Arc::new(Mutex::new(spawn_socket_process(command, &args, cwd)?));
		let accepted = time::timeout(ADAPTER_READY_TIMEOUT, listener.accept()).await;
		match accepted {
			Ok(Ok((stream, peer))) if peer.ip().is_loopback() => {
				let (reader, writer) = stream.into_split();
				Ok(SpawnedDap {
					protocol: Self::from_streams(reader, writer),
					child,
					cleanup_path: None,
				})
			},
			Ok(Ok((_stream, _))) => {
				kill_child(&child).await;
				Err(DapProtocolError::InvalidFrame(sf!(
					"reverse DAP adapter connected from a non-owner-local address",
				)))
			},
			Ok(Err(error)) => {
				kill_child(&child).await;
				Err(DapProtocolError::Io(error))
			},
			Err(_) => {
				kill_child(&child).await;
				Err(DapProtocolError::Timeout)
			},
		}
	}
}

fn substituted_args(args: &[Str], marker: &str, replacement: &str) -> Vec<Str> {
	args
		.iter()
		.map(|argument| {
			if argument.contains(marker) {
				Str::from(argument.replace(marker, replacement))
			} else {
				argument.clone()
			}
		})
		.collect()
}

fn spawn_socket_process(
	command: &str,
	args: &[Str],
	cwd: &Path,
) -> Result<Child, DapProtocolError> {
	let mut process = Command::new(command);
	process
		.args(args.iter().map(Str::as_str))
		.current_dir(cwd)
		.stdin(process::Stdio::null())
		.stdout(process::Stdio::null())
		.stderr(process::Stdio::null())
		.kill_on_drop(true)
		.env("CI", "1")
		.env("TERM", "dumb")
		.env("GIT_TERMINAL_PROMPT", "0");
	#[cfg(unix)]
	{
		// SAFETY: `setsid` is async-signal-safe and touches no shared Rust state.
		unsafe {
			process.pre_exec(|| {
				if libc::setsid() < 0 {
					Err(io::Error::last_os_error())
				} else {
					Ok(())
				}
			})
		};
	}
	Ok(process.spawn()?)
}

async fn kill_child(child: &Arc<Mutex<Child>>) {
	let mut child = child.lock().await;
	if child.try_wait().ok().flatten().is_none() {
		let _ = child.kill().await;
	}
}

impl Drop for DapProtocol {
	fn drop(&mut self) {
		if Arc::strong_count(&self.inner) == 1 {
			let _ = self.inner.outgoing.send(Outgoing::Shutdown);
		}
	}
}
mod inbound {
	use tokio::sync::broadcast::{Receiver, error};

	use super::*;

	impl DapProtocol {
		/// Subscribes before a launch request to avoid stop-on-entry and
		/// initialized races.
		pub fn subscribe(&self) -> Receiver<DapInbound> {
			self.inner.events.subscribe()
		}

		/// Waits for an event with an exact name.
		pub async fn wait_for_event(
			mut receiver: Receiver<DapInbound>,
			event_name: &str,
			timeout: Duration,
		) -> Result<serde_json::Value, DapProtocolError> {
			let wait = async {
				loop {
					match receiver.recv().await {
						Ok(DapInbound::Event { event, body }) if event == event_name => return Ok(body),
						Ok(_) | Err(error::RecvError::Lagged(_)) => {},
						Err(error::RecvError::Closed) => {
							return Err(DapProtocolError::TransportClosed);
						},
					}
				}
			};
			time::timeout(timeout, wait)
				.await
				.map_err(|_| DapProtocolError::Timeout)?
		}
	}
}

mod protocol_actor {
	use flume::Receiver;
	use parking_lot::Mutex;

	use super::*;

	pub(super) async fn run_protocol<R, W>(
		reader: R,
		mut writer: W,
		outgoing: Receiver<Outgoing>,
		inner: Arc<ProtocolInner>,
	) where
		R: AsyncRead + Unpin,
		W: AsyncWrite + Unpin,
	{
		let mut reader = reader;
		let pending = Mutex::new(PendingRequests::new());
		loop {
			tokio::select! {
				outbound = outgoing.recv_async() => match outbound {
					Ok(Outgoing::Request(request)) => {
						let message = json!({"seq": request.seq, "type": "request", "command": request.command, "arguments": request.arguments});
						pending.lock().insert(request.seq, (request.command, request.response));
						if write_message(&mut writer, &message).await.is_err() { break; }
					},
					Ok(Outgoing::Response { request_seq, command, success, body, message }) => {
						let seq = inner.next_seq.fetch_add(1, Ordering::Relaxed);
						let value = json!({"seq": seq, "type": "response", "request_seq": request_seq, "command": command, "success": success, "body": body, "message": message});
						if write_message(&mut writer, &value).await.is_err() { break; }
					},
					Ok(Outgoing::Shutdown) | Err(_) => break,
				},
				message = read_message(&mut reader) => match message {
					Ok(message) => dispatch_message(message, &pending, &inner.events),
					Err(_) => break,
				},
			}
		}
		inner.closed.cancel();
		for (_, (_, response)) in pending.into_inner() {
			let _ = response.send(Err(DapProtocolError::TransportClosed));
		}
	}

	fn dispatch_message(
		message: serde_json::Value,
		pending: &Mutex<PendingRequests>,
		events: &broadcast::Sender<DapInbound>,
	) {
		match message.get("type").and_then(serde_json::Value::as_str) {
			Some("response") => {
				let Some(request_seq) = message
					.get("request_seq")
					.and_then(serde_json::Value::as_i64)
				else {
					return;
				};
				let Some((command, response)) = pending.lock().remove(&request_seq) else {
					return;
				};
				let result = if message
					.get("success")
					.and_then(serde_json::Value::as_bool)
					.unwrap_or(false)
				{
					Ok(message
						.get("body")
						.cloned()
						.unwrap_or(serde_json::Value::Null))
				} else {
					Err(DapProtocolError::Adapter {
						command,
						message: Str::new(
							message
								.get("message")
								.and_then(serde_json::Value::as_str)
								.unwrap_or("adapter request failed"),
						),
					})
				};
				let _ = response.send(result);
			},
			Some("event") => {
				let Some(event) = message.get("event").and_then(serde_json::Value::as_str) else {
					return;
				};
				let _ = events.send(DapInbound::Event {
					event: Str::new(event),
					body:  message
						.get("body")
						.cloned()
						.unwrap_or(serde_json::Value::Null),
				});
			},
			Some("request") => {
				let (Some(seq), Some(command)) = (
					message.get("seq").and_then(serde_json::Value::as_i64),
					message.get("command").and_then(serde_json::Value::as_str),
				) else {
					return;
				};
				let _ = events.send(DapInbound::ReverseRequest {
					seq,
					command: Str::new(command),
					arguments: message
						.get("arguments")
						.cloned()
						.unwrap_or(serde_json::Value::Null),
				});
			},
			_ => {},
		}
	}
}

async fn read_message<R: AsyncRead + Unpin>(
	reader: &mut R,
) -> Result<serde_json::Value, DapProtocolError> {
	let body = lsp_process::read_frame(reader, MAX_DAP_HEADER_BYTES, MAX_DAP_MESSAGE_BYTES)
		.await
		.map_err(|source| DapProtocolError::Frame { source })?;
	Ok(serde_json::from_slice(&body)?)
}

async fn write_message<W: AsyncWrite + Unpin>(
	writer: &mut W,
	message: &serde_json::Value,
) -> Result<(), DapProtocolError> {
	let body = serde_json::to_vec(message)?;
	if body.len() > MAX_DAP_MESSAGE_BYTES {
		return Err(DapProtocolError::InvalidFrame(sf!("message exceeds size bound")));
	}
	let write = lsp_process::write_frame(writer, &body);
	time::timeout(WRITE_TIMEOUT, write)
		.await
		.map_err(|_| DapProtocolError::Timeout)??;
	Ok(())
}

#[cfg(test)]
mod tests {

	use super::*;

	#[tokio::test]
	async fn correlates_response_and_publishes_event() {
		let (client, mut adapter) = {
			use tokio::io;
			io::duplex(16 * 1024)
		};
		let (reader, writer) = {
			use tokio::io;
			io::split(client)
		};
		let protocol = DapProtocol::from_streams(reader, writer);
		let mut events = protocol.subscribe();
		tokio::spawn(async move {
			let request = read_message(&mut adapter).await.unwrap();
			let seq = request["seq"].as_i64().unwrap();
			write_message(
				&mut adapter,
				&json!({"seq": 9, "type": "event", "event": "stopped", "body": {"reason": "entry"}}),
			)
			.await
			.unwrap();
			write_message(&mut adapter, &json!({"seq": 10, "type": "response", "request_seq": seq, "command": "threads", "success": true, "body": {"threads": []}})).await.unwrap();
		});
		let response = protocol.request("threads", json!({})).await.unwrap();
		assert_eq!(response["threads"], json!([]));
		assert!(
			matches!(events.recv().await.unwrap(), DapInbound::Event { event, .. } if event == "stopped")
		);
	}
}
