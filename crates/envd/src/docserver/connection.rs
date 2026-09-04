//! Concurrent request multiplexing over one framed document-server connection.

use std::{
	collections::HashMap,
	mem,
	num::NonZeroUsize,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use bytes::BytesMut;
#[cfg(test)]
use omp_proto::document::v1::{document_target, read_selection};
use omp_proto::{
	document::{
		v1,
		v1::{
			ClientFrame, EventStreamFailure, ProtocolError, ProtocolErrorCode, ServerFrame,
			client_frame, server_frame,
		},
	},
	prost::Message,
};
use parking_lot::Mutex;
use thiserror::Error;
use tokio::{
	io,
	io::{AsyncRead, AsyncWrite},
	sync::{Notify, broadcast::error},
	task::{JoinError, JoinSet},
};
use tokio_util::sync::CancellationToken;

use crate::docserver::{
	Environment, EnvironmentSession, LeaseId,
	protocol::{
		close_session, dispatch_request, lsp_event_stream_error_frame, registry_event_frame,
	},
	wire::{FrameConfig, WireError, read_client_frame, write_server_frame},
};

/// Current document protocol major version.
pub const PROTOCOL_MAJOR: u32 = 2;
/// Current document protocol minor version.
pub const PROTOCOL_MINOR: u32 = 2;
/// Default number of completed responses and events buffered per connection.
pub const DEFAULT_OUTBOUND_FRAMES: usize = 64;
/// Default number of concurrently executing requests accepted per connection.
pub const DEFAULT_MAX_INFLIGHT_REQUESTS: usize = 64;
/// Default deadline for receiving the connection's initial `ClientHello`.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const OPEN_RESPONSE_CLEANUP_DEADLINE: Duration = Duration::from_secs(1);

#[derive(Default)]
struct OpenEventGate {
	active: AtomicUsize,
	notify: Notify,
}

impl OpenEventGate {
	fn enter(self: &Arc<Self>) -> OpenEventGuard {
		self.active.fetch_add(1, Ordering::AcqRel);
		OpenEventGuard { gate: Arc::clone(self) }
	}

	async fn wait(&self) {
		loop {
			let notified = self.notify.notified();
			if self.active.load(Ordering::Acquire) == 0 {
				return;
			}
			notified.await;
		}
	}
}

struct OpenEventGuard {
	gate: Arc<OpenEventGate>,
}

impl Drop for OpenEventGuard {
	fn drop(&mut self) {
		if self.gate.active.fetch_sub(1, Ordering::AcqRel) == 1 {
			self.gate.notify.notify_waiters();
		}
	}
}

/// Framing and backpressure policy for one document connection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectionConfig {
	/// Length-delimited protobuf framing limits.
	pub frame:                 FrameConfig,
	/// Bounded response/event queue capacity.
	pub outbound_frames:       NonZeroUsize,
	/// Maximum concurrently executing ordinary requests.
	pub max_inflight_requests: NonZeroUsize,
	/// Maximum time allowed for the initial `ClientHello`.
	pub handshake_timeout:     Duration,
}

impl Default for ConnectionConfig {
	fn default() -> Self {
		Self {
			frame:                 FrameConfig::default(),
			outbound_frames:       NonZeroUsize::new(DEFAULT_OUTBOUND_FRAMES)
				.expect("default outbound capacity is nonzero"),
			max_inflight_requests: NonZeroUsize::new(DEFAULT_MAX_INFLIGHT_REQUESTS)
				.expect("default request capacity is nonzero"),
			handshake_timeout:     DEFAULT_HANDSHAKE_TIMEOUT,
		}
	}
}

/// A connection transport or spawned request task failed.
#[derive(Debug, Error)]
pub enum ConnectionError {
	/// Framing or stream I/O failed.
	#[error(transparent)]
	Wire(#[from] WireError),
	/// A spawned request handler panicked or was cancelled unexpectedly.
	#[error("document request task failed: {0}")]
	Task(#[from] JoinError),
	/// The bounded LSP event subscriber fell behind the registry.
	#[error("LSP event subscriber lagged by {0} events")]
	LspEventsLagged(u64),
	/// The registry-wide LSP event producer stopped unexpectedly.
	#[error("LSP event stream closed unexpectedly")]
	LspEventsClosed,
	/// The peer did not complete the initial handshake before its deadline.
	#[error("document connection handshake timed out")]
	HandshakeTimeout,
}

/// Serves one duplex byte stream with a fresh connection-local session.
pub async fn serve_connection<S>(
	environment: Environment,
	stream: S,
	config: ConnectionConfig,
) -> Result<(), ConnectionError>
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	serve_session(environment.session(), stream, config).await
}

/// Serves a preconfigured session, including any custom edit adapters
/// registered before the connection starts.
pub async fn serve_session<S>(
	session: EnvironmentSession,
	stream: S,
	config: ConnectionConfig,
) -> Result<(), ConnectionError>
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	let (reader, writer) = io::split(stream);
	serve_io(session, reader, writer, config).await
}

/// Serves independent asynchronous reader and writer halves, suitable for
/// standard I/O, sockets, and relayed transports.
pub async fn serve_io<R, W>(
	session: EnvironmentSession,
	reader: R,
	writer: W,
	config: ConnectionConfig,
) -> Result<(), ConnectionError>
where
	R: AsyncRead + Unpin + Send + 'static,
	W: AsyncWrite + Unpin + Send + 'static,
{
	serve_io_until(session, reader, writer, config, CancellationToken::new()).await
}

/// Serves reader and writer halves until the transport ends or `shutdown` is
/// cancelled, then releases all connection-owned document leases.
pub async fn serve_io_until<R, W>(
	session: EnvironmentSession,
	mut reader: R,
	mut writer: W,
	config: ConnectionConfig,
	shutdown: CancellationToken,
) -> Result<(), ConnectionError>
where
	R: AsyncRead + Unpin + Send + 'static,
	W: AsyncWrite + Unpin + Send + 'static,
{
	let (output, outbound) = flume::bounded(config.outbound_frames.get());
	let mut read_scratch = BytesMut::new();
	let frame_config = config.frame;
	let mut writer_task = tokio::spawn(async move {
		let mut scratch = BytesMut::new();
		loop {
			let frame = tokio::select! {
				() = shutdown.cancelled() => return Ok(()),
				frame = outbound.recv_async() => frame,
			};
			let Ok(frame) = frame else {
				return Ok(());
			};
			let frame = bounded_server_frame(frame, frame_config)?;
			tokio::select! {
				() = shutdown.cancelled() => return Ok(()),
				result = write_server_frame(&mut writer, &frame, frame_config, &mut scratch) => result?,
			}
		}
	});

	let handshake = tokio::select! {
		result = &mut writer_task => return writer_result(result),
		result = read_client_frame(&mut reader, config.frame, &mut read_scratch) => result?,
		() = tokio::time::sleep(config.handshake_timeout) => {
			drop(output);
			writer_result(writer_task.await)?;
			return Err(ConnectionError::HandshakeTimeout);
		},
	};
	let Some(handshake) = handshake else {
		drop(output);
		return writer_result(writer_task.await);
	};
	let Some(protocol_minor) = accept_handshake(&session, handshake, &output).await else {
		finish_connection(&session, HashMap::new(), JoinSet::new(), output).await;
		return writer_result(writer_task.await);
	};

	let mut registry_events = session.environment().lsp().subscribe_events();
	let event_session = session.clone();
	let event_output = output.clone();
	let event_frame_limit = config.frame.max_frame_bytes();
	let open_event_gate = Arc::new(OpenEventGate::default());
	let event_open_gate = Arc::clone(&open_event_gate);
	let mut event_task = tokio::spawn(async move {
		loop {
			match registry_events.recv().await {
				Ok(event) => {
					event_open_gate.wait().await;
					let Some(frame) = registry_event_frame(&event_session, event).await else {
						continue;
					};
					if frame.encoded_len() > event_frame_limit {
						let _ = event_output
							.send_async(lsp_event_stream_error_frame(
								protocol_minor,
								EventStreamFailure::Closed,
								0,
							))
							.await;
						return Err(ConnectionError::LspEventsClosed);
					}
					if event_output.send_async(frame).await.is_err() {
						return Ok(());
					}
				},
				Err(error::RecvError::Lagged(skipped)) => {
					let _ = event_output
						.send_async(lsp_event_stream_error_frame(
							protocol_minor,
							EventStreamFailure::Lagged,
							skipped,
						))
						.await;
					return Err(ConnectionError::LspEventsLagged(skipped));
				},
				Err(error::RecvError::Closed) => {
					let _ = event_output
						.send_async(lsp_event_stream_error_frame(
							protocol_minor,
							EventStreamFailure::Closed,
							0,
						))
						.await;
					return Err(ConnectionError::LspEventsClosed);
				},
			}
		}
	});

	let inflight = Arc::new(Mutex::new(HashMap::<u64, CancellationToken>::new()));
	let mut requests = JoinSet::new();
	let mut completed_writer = None;
	let mut completed_events = false;
	let read_result = 'read: loop {
		let next = tokio::select! {
			result = &mut writer_task => {
				completed_writer = Some(result);
				break Ok(());
			},
			result = &mut event_task => {
				completed_events = true;
				match result {
					Ok(result) => break result,
					Err(error) => break Err(error.into()),
				}
			},
			joined = requests.join_next(), if !requests.is_empty() => {
				if let Some(Err(error)) = joined {
					break 'read Err(error.into());
				}
				continue;
			},
			result = read_client_frame(&mut reader, config.frame, &mut read_scratch) => result,
		};
		let frame = match next {
			Ok(Some(frame)) => frame,
			Ok(None) => break Ok(()),
			Err(error) => break Err(error.into()),
		};
		let Some(body) = frame.body else {
			tracing::warn!(request_id = frame.request_id, "rejected protocol frame with missing body");
			send_error(
				&output,
				frame.request_id,
				ProtocolErrorCode::InvalidArgument,
				"client frame body is missing",
			)
			.await;
			continue;
		};
		if let client_frame::Body::Cancel(cancel) = body {
			if frame.request_id != 0 {
				tracing::warn!(
					request_id = frame.request_id,
					"rejected cancel frame with nonzero request id"
				);
				send_error(
					&output,
					frame.request_id,
					ProtocolErrorCode::InvalidArgument,
					"cancel control frames must use request_id 0",
				)
				.await;
				continue;
			}
			if let Some(cancellation) = inflight.lock().get(&cancel.target_request_id) {
				cancellation.cancel();
			}
			continue;
		}
		if frame.request_id == 0 {
			tracing::warn!("rejected protocol request with zero request id");
			send_error(
				&output,
				0,
				ProtocolErrorCode::InvalidArgument,
				"ordinary requests must use a nonzero request_id",
			)
			.await;
			continue;
		}
		let cancellation = CancellationToken::new();
		let admission_error = {
			let mut active = inflight.lock();
			if active.contains_key(&frame.request_id) {
				Some((ProtocolErrorCode::InvalidArgument, "request_id is already in flight", true))
			} else if active.len() >= config.max_inflight_requests.get() {
				Some((
					ProtocolErrorCode::PreconditionFailed,
					"connection has reached its in-flight request limit",
					false,
				))
			} else {
				active.insert(frame.request_id, cancellation.clone());
				None
			}
		};
		if let Some((code, message, terminal)) = admission_error {
			tracing::warn!(
				request_id = frame.request_id,
				code = ?code,
				terminal,
				"protocol request admission rejected"
			);
			send_error(&output, frame.request_id, code, message).await;
			if terminal {
				break Ok(());
			}
			continue;
		}
		let request_id = frame.request_id;
		let request_session = session.clone();
		let request_output = output.clone();
		let request_inflight = Arc::clone(&inflight);
		let request_frame = config.frame;
		let open_event_guard =
			matches!(&body, client_frame::Body::OpenDocument(_)).then(|| open_event_gate.enter());
		requests.spawn(async move {
			let _open_event_guard = open_event_guard;
			let response = dispatch_request(
				request_session.clone(),
				request_id,
				body,
				protocol_minor,
				request_output.clone(),
				request_frame.max_frame_bytes(),
				cancellation,
			)
			.await;
			let opened_lease = opened_lease_id(&response);
			let oversized = response.encoded_len() > request_frame.max_frame_bytes();
			let response = bounded_server_frame(response, request_frame)
				.expect("ordinary request responses are correlated");
			if oversized && let Some(lease_id) = opened_lease {
				close_unpublished_lease(&request_session, lease_id).await;
			}
			let delivered = request_output.send_async(response).await.is_ok();
			if delivered
				&& !oversized
				&& let Some(lease_id) = opened_lease
			{
				request_session.start_lease_events(lease_id);
			}
			request_inflight.lock().remove(&request_id);
		});
	};

	if !completed_events {
		event_task.abort();
		let _ = event_task.await;
	}
	let active = {
		let mut active = inflight.lock();
		for cancellation in active.values() {
			cancellation.cancel();
		}
		mem::take(&mut *active)
	};
	finish_connection(&session, active, requests, output).await;
	match completed_writer {
		Some(result) => writer_result(result)?,
		None => writer_result(writer_task.await)?,
	}
	read_result
}

async fn accept_handshake(
	session: &EnvironmentSession,
	frame: ClientFrame,
	output: &flume::Sender<ServerFrame>,
) -> Option<u32> {
	let Some(client_frame::Body::Hello(hello)) = frame.body else {
		tracing::warn!("rejected connection without client hello");
		send_error(
			output,
			0,
			ProtocolErrorCode::InvalidArgument,
			"the first client frame must be ClientHello",
		)
		.await;
		return None;
	};
	if frame.request_id != 0 {
		tracing::warn!(
			request_id = frame.request_id,
			"rejected client hello with nonzero request id"
		);
		send_error(
			output,
			frame.request_id,
			ProtocolErrorCode::InvalidArgument,
			"ClientHello must use request_id 0",
		)
		.await;
		return None;
	}
	if hello.protocol_major != PROTOCOL_MAJOR {
		tracing::warn!(
			client_protocol_major = hello.protocol_major,
			server_protocol_major = PROTOCOL_MAJOR,
			"rejected unsupported document protocol version"
		);
		send_error(
			output,
			0,
			ProtocolErrorCode::Unsupported,
			&format!(
				"unsupported document protocol major {}; server requires {PROTOCOL_MAJOR}",
				hello.protocol_major
			),
		)
		.await;
		return None;
	}
	let protocol_minor = hello.protocol_minor.min(PROTOCOL_MINOR);
	let environment = session.environment();
	let response = ServerFrame {
		request_id: 0,
		body:       Some(server_frame::Body::Hello(v1::ServerHello {
			protocol_major: PROTOCOL_MAJOR,
			protocol_minor,
			workspace_id: bytes::Bytes::copy_from_slice(environment.workspace_id()),
			root_uri: environment.root_uri().as_str().to_owned(),
			server_epoch: bytes::Bytes::copy_from_slice(environment.server_epoch()),
			server_build: environment.server_build().to_owned(),
		})),
	};
	output
		.send_async(response)
		.await
		.ok()
		.map(|()| protocol_minor)
}

async fn finish_connection(
	session: &EnvironmentSession,
	_active: HashMap<u64, CancellationToken>,
	mut requests: JoinSet<()>,
	output: flume::Sender<ServerFrame>,
) {
	while requests.join_next().await.is_some() {}
	close_session(session).await;
	drop(output);
}

fn bounded_server_frame(frame: ServerFrame, config: FrameConfig) -> Result<ServerFrame, WireError> {
	let encoded_len = frame.encoded_len();
	if encoded_len <= config.max_frame_bytes() {
		return Ok(frame);
	}
	if frame.request_id == 0 {
		return Err(WireError::FrameTooLarge {
			actual: encoded_len,
			limit:  config.max_frame_bytes(),
		});
	}
	Ok(ServerFrame {
		request_id: frame.request_id,
		body:       Some(server_frame::Body::Error(ProtocolError {
			code:    ProtocolErrorCode::Internal.into(),
			message: format!(
				"document response is {encoded_len} bytes; frame limit is {}",
				config.max_frame_bytes()
			),
		})),
	})
}

fn opened_lease_id(frame: &ServerFrame) -> Option<LeaseId> {
	let server_frame::Body::DocumentOpened(opened) = frame.body.as_ref()? else {
		return None;
	};
	let bytes: [u8; 16] = opened.lease_id.as_ref().try_into().ok()?;
	Some(LeaseId::from_bytes(bytes))
}

async fn close_unpublished_lease(session: &EnvironmentSession, lease_id: LeaseId) {
	session.release_lease(lease_id);
	let cancellation = CancellationToken::new();
	let close = session
		.environment()
		.lsp()
		.close_document(lease_id, cancellation.child_token());
	tokio::pin!(close);
	tokio::select! {
		result = &mut close => {
			let _ = result;
		},
		() = tokio::time::sleep(OPEN_RESPONSE_CLEANUP_DEADLINE) => {
			cancellation.cancel();
			let _ = close.await;
		},
	}
}

async fn send_error(
	output: &flume::Sender<ServerFrame>,
	request_id: u64,
	code: ProtocolErrorCode,
	message: &str,
) {
	let _ = output
		.send_async(ServerFrame {
			request_id,
			body: Some(server_frame::Body::Error(ProtocolError {
				code:    code.into(),
				message: message.to_owned(),
			})),
		})
		.await;
}

fn writer_result(result: Result<Result<(), WireError>, JoinError>) -> Result<(), ConnectionError> {
	result??;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::fs;

	use bytes::Bytes;
	use omp_proto::document::v1::{self as proto, commit_transaction_response};
	use tempfile::TempDir;
	use tokio::{
		io::{DuplexStream, ReadHalf, WriteHalf},
		task,
		time::{Duration, timeout},
	};

	use super::*;
	use crate::docserver::{
		ServerConfig,
		wire::{read_server_frame, write_client_frame},
	};

	type TestReader = ReadHalf<DuplexStream>;
	type TestWriter = WriteHalf<DuplexStream>;

	async fn send(writer: &mut TestWriter, request_id: u64, body: client_frame::Body) {
		let mut scratch = BytesMut::new();
		write_client_frame(
			writer,
			&ClientFrame { request_id, body: Some(body) },
			FrameConfig::default(),
			&mut scratch,
		)
		.await
		.expect("write client frame");
	}

	async fn receive(reader: &mut TestReader) -> ServerFrame {
		let mut scratch = BytesMut::new();
		read_server_frame(reader, FrameConfig::default(), &mut scratch)
			.await
			.expect("read server frame")
			.expect("server frame")
	}

	async fn response(reader: &mut TestReader, request_id: u64) -> server_frame::Body {
		loop {
			let frame = receive(reader).await;
			if frame.request_id == request_id {
				return frame.body.expect("response body");
			}
			assert_eq!(frame.request_id, 0, "unexpected concurrent response");
		}
	}

	async fn handshake(reader: &mut TestReader, writer: &mut TestWriter) {
		send(
			writer,
			0,
			client_frame::Body::Hello(proto::ClientHello {
				protocol_major: PROTOCOL_MAJOR,
				protocol_minor: PROTOCOL_MINOR,
				client_id:      Bytes::from_static(b"test-client"),
			}),
		)
		.await;
		assert!(matches!(response(reader, 0).await, server_frame::Body::Hello(_)));
	}

	fn text_commit(
		transaction_id: &'static [u8; 16],
		lease_id: Bytes,
		base_revision: proto::Revision,
		content: &'static [u8],
	) -> client_frame::Body {
		client_frame::Body::CommitTransaction(proto::CommitTransactionRequest {
			transaction_id: Bytes::from_static(transaction_id),
			operations:     vec![proto::DocumentMutation {
				document:  Some(proto::DocumentTarget {
					target: Some(document_target::Target::LeaseId(lease_id)),
				}),
				operation: Some(proto::document_mutation::Operation::Text(proto::TextMutation {
					base_revision: Some(base_revision),
					change:        Some(proto::text_mutation::Change::ProposedContent(
						Bytes::from_static(content),
					)),
					stale_policy:  proto::StalePolicy::Fail as i32,
					format_policy: proto::FormatPolicy::Disabled as i32,
				})),
			}],
		})
	}

	#[tokio::test]
	async fn shared_environment_serializes_writers_and_notifies_other_connections() {
		static FIRST_TRANSACTION: &[u8; 16] = b"aaaaaaaaaaaaaaaa";
		static SECOND_TRANSACTION: &[u8; 16] = b"bbbbbbbbbbbbbbbb";

		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("shared.txt");
		fs::write(&path, b"alpha").expect("initial file");
		let config = ServerConfig::new(root.path()).expect("server config");
		let uri = config
			.file_uri(&config.environment_root().join("shared.txt"))
			.expect("file URI")
			.to_string();
		let environment = Environment::new(config).expect("environment");

		let (a_client, a_server) = io::duplex(64 * 1024);
		let (b_client, b_server) = io::duplex(64 * 1024);
		let a_task =
			tokio::spawn(serve_connection(environment.clone(), a_server, ConnectionConfig::default()));
		let b_task =
			tokio::spawn(serve_connection(environment.clone(), b_server, ConnectionConfig::default()));
		let (mut a_reader, mut a_writer) = io::split(a_client);
		let (mut b_reader, mut b_writer) = io::split(b_client);
		handshake(&mut a_reader, &mut a_writer).await;
		handshake(&mut b_reader, &mut b_writer).await;

		send(
			&mut a_writer,
			1,
			client_frame::Body::OpenDocument(proto::OpenDocumentRequest {
				uri:         uri.clone(),
				language_id: String::new(),
			}),
		)
		.await;
		let server_frame::Body::DocumentOpened(a_open) = response(&mut a_reader, 1).await else {
			panic!("expected first open response");
		};
		send(
			&mut b_writer,
			1,
			client_frame::Body::OpenDocument(proto::OpenDocumentRequest {
				uri,
				language_id: String::new(),
			}),
		)
		.await;
		let server_frame::Body::DocumentOpened(b_open) = response(&mut b_reader, 1).await else {
			panic!("expected second open response");
		};
		let a_head = a_open.head.expect("first head");
		let b_head = b_open.head.expect("second head");
		assert_eq!(a_head.document, b_head.document);
		assert_eq!(a_head.revision, b_head.revision);
		let base_revision = a_head.revision.expect("base revision");

		send(
			&mut a_writer,
			2,
			text_commit(FIRST_TRANSACTION, a_open.lease_id, base_revision.clone(), b"bravo"),
		)
		.await;
		let server_frame::Body::TransactionResult(committed) = response(&mut a_reader, 2).await
		else {
			panic!("expected committed transaction response");
		};
		assert!(matches!(
			committed.outcome,
			Some(commit_transaction_response::Outcome::Committed(_))
		));

		let observed = timeout(Duration::from_secs(2), async {
			loop {
				let frame = receive(&mut b_reader).await;
				if let Some(server_frame::Body::DocumentEvent(event)) = frame.body {
					break event;
				}
			}
		})
		.await
		.expect("second connection document event");
		assert_eq!(
			observed.previous_revision,
			Some(base_revision.clone()),
			"other lease observes the serialized transition",
		);

		send(
			&mut b_writer,
			2,
			text_commit(SECOND_TRANSACTION, b_open.lease_id, base_revision, b"charlie"),
		)
		.await;
		let server_frame::Body::TransactionResult(rejected) = response(&mut b_reader, 2).await else {
			panic!("expected transaction outcome response");
		};
		let Some(commit_transaction_response::Outcome::Rejected(rejected)) = rejected.outcome else {
			panic!("stale writer unexpectedly committed");
		};
		assert_eq!(rejected.reason, proto::TransactionRejectReason::StaleBase as i32);
		assert_eq!(std::fs::read(&path).expect("committed file"), b"bravo");

		drop((a_reader, a_writer, b_reader, b_writer));
		a_task
			.await
			.expect("first connection task")
			.expect("first connection");
		b_task
			.await
			.expect("second connection task")
			.expect("second connection");
		environment.shutdown().await;
	}

	#[tokio::test]
	async fn idle_peer_cannot_hold_the_handshake_open() {
		let root = TempDir::new().expect("temporary directory");
		let environment = Environment::new(ServerConfig::new(root.path()).expect("server config"))
			.expect("environment");
		let (_client, server) = io::duplex(1024);
		let config = ConnectionConfig {
			handshake_timeout: Duration::from_millis(10),
			..ConnectionConfig::default()
		};

		let result = timeout(Duration::from_secs(1), serve_connection(environment, server, config))
			.await
			.expect("handshake deadline");
		assert!(matches!(result, Err(ConnectionError::HandshakeTimeout)));
	}

	#[tokio::test]
	async fn oversized_response_is_correlated_without_closing_the_connection() {
		let root = TempDir::new().expect("temporary directory");
		let server_config = ServerConfig::new(root.path()).expect("server config");
		let path = server_config.environment_root().join("large.txt");
		fs::write(&path, vec![b'x'; 2048]).expect("large fixture");
		let uri = server_config.file_uri(&path).expect("file URI").to_string();
		let environment = Environment::new(server_config).expect("environment");
		let (client, server) = io::duplex(16 * 1024);
		let config = ConnectionConfig {
			frame: FrameConfig::new(NonZeroUsize::new(512).expect("frame limit")),
			..ConnectionConfig::default()
		};
		let server_task = tokio::spawn(serve_connection(environment.clone(), server, config));
		let (mut reader, mut writer) = io::split(client);
		handshake(&mut reader, &mut writer).await;

		send(
			&mut writer,
			1,
			client_frame::Body::OpenDocument(proto::OpenDocumentRequest {
				uri:         uri.clone(),
				language_id: String::new(),
			}),
		)
		.await;
		let server_frame::Body::DocumentOpened(opened) = response(&mut reader, 1).await else {
			panic!("expected open response");
		};

		send(
			&mut writer,
			2,
			client_frame::Body::ReadDocument(proto::ReadDocumentRequest {
				document:  Some(proto::DocumentTarget {
					target: Some(document_target::Target::LeaseId(opened.lease_id)),
				}),
				revision:  None,
				selection: Some(proto::ReadSelection {
					selection: Some(read_selection::Selection::Whole(proto::WholeDocument {})),
				}),
			}),
		)
		.await;
		let server_frame::Body::Error(error) = response(&mut reader, 2).await else {
			panic!("oversized read must receive a correlated error");
		};
		assert_eq!(error.code, ProtocolErrorCode::Internal as i32, "{}", error.message);

		send(
			&mut writer,
			3,
			client_frame::Body::CanonicalizePath(proto::CanonicalizePathRequest { uri }),
		)
		.await;
		assert!(matches!(response(&mut reader, 3).await, server_frame::Body::PathCanonicalized(_)));

		drop((reader, writer));
		server_task
			.await
			.expect("connection task")
			.expect("connection remains healthy");
		environment.shutdown().await;
	}

	#[tokio::test]
	async fn registry_events_wait_for_every_open_response_barrier() {
		let gate = Arc::new(OpenEventGate::default());
		let first = gate.enter();
		let second = gate.enter();
		let released = CancellationToken::new();
		let waiter_gate = Arc::clone(&gate);
		let waiter_released = released.clone();
		let waiter = tokio::spawn(async move {
			waiter_gate.wait().await;
			waiter_released.cancel();
		});

		task::yield_now().await;
		assert!(!released.is_cancelled());
		drop(first);
		task::yield_now().await;
		assert!(!released.is_cancelled());
		drop(second);
		timeout(Duration::from_secs(1), waiter)
			.await
			.expect("open barrier release")
			.expect("waiter task");
		assert!(released.is_cancelled());
	}
}
