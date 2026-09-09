//! Common cancellation-aware MCP transport contract.

use std::{future::Future, io, pin::Pin};

use omp_core::Str;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{header_policy::HeaderPolicyError, json_rpc::RequestId};

/// Boxed future at the cold dynamic transport boundary.
pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Evidence about whether an operation may have reached the server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchState {
	/// Failed before any frame or HTTP body was handed to the transport.
	PreDispatch,
	/// The complete request was handed off or accepted by HTTP.
	Dispatched,
	/// Transport failed after handoff without a correlated response.
	EffectsUnknown,
	/// A correlated response was received.
	Responded,
}

/// Successful JSON-RPC request receipt.
#[derive(Debug)]
pub struct TransportResponse {
	/// Request identity assigned by the transport.
	pub id:       RequestId,
	/// JSON-RPC result value.
	pub result:   Value,
	/// Dispatch evidence; successful responses are always `Responded`.
	pub dispatch: DispatchState,
}

/// Server-initiated message delivered independently of request responses.
#[derive(Debug)]
pub enum IncomingMessage {
	/// Notification without an ID.
	Notification {
		/// JSON-RPC method read from child stdout for stdio or the remote event
		/// stream for HTTP/SSE.
		method: Str,
		/// Uncorrelated notification parameters supplied by the server.
		params: Value,
	},
	/// Server-to-client request requiring a response.
	Request {
		/// Server-assigned identity that must be echoed by the client response.
		id:     RequestId,
		/// JSON-RPC method read from child stdout for stdio or the remote event
		/// stream for HTTP/SSE.
		method: Str,
		/// Parameters supplied for the server-initiated request.
		params: Value,
	},
	/// Physical connection ended.
	Closed,
}

/// Cancellation-aware transport used by the MCP client/supervisor.
///
/// The boxed future is confined to this dynamic I/O boundary. Concrete stdio
/// and HTTP internals remain allocation-free per poll.
pub trait McpTransport: Send + Sync {
	/// Records the protocol revision negotiated during initialization.
	/// Transports that carry the Streamable HTTP protocol header override this
	/// hook.
	fn set_protocol_version(&self, _revision: Str) {}

	/// Sends one JSON-RPC request and waits for its correlated response.
	fn request<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<TransportResponse, TransportError>>;

	/// Sends one JSON-RPC notification.
	fn notify<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>>;

	/// Receives the next server-initiated request or notification.
	fn next_message<'a>(
		&'a self,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<IncomingMessage, TransportError>>;

	/// Sends a response to a server-initiated request.
	fn respond<'a>(
		&'a self,
		id: RequestId,
		result: Result<Value, ServerResponseError>,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>>;

	/// Closes the logical transport and owned resources.
	fn close(&self) -> TransportFuture<'_, Result<(), TransportError>>;
}

/// JSON-RPC error returned to a server request.
#[derive(Clone, Debug)]
pub struct ServerResponseError {
	/// JSON-RPC error code.
	pub code:    i64,
	/// Redaction-safe static or classified message.
	pub message: Str,
	/// Optional structured error data.
	pub data:    Option<Value>,
}

/// Transport failure with retry-accounting evidence.
#[derive(thiserror::Error)]
#[error("MCP transport failed after dispatch state {dispatch:?}")]
pub struct TransportError {
	/// Best available dispatch evidence.
	pub dispatch: DispatchState,
	/// Typed failure cause.
	#[source]
	pub cause:    TransportFailure,
}

impl std::fmt::Debug for TransportError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("TransportError")
			.field("dispatch", &self.dispatch)
			.field("cause", &self.cause)
			.finish()
	}
}

impl TransportError {
	/// Constructs a pre-dispatch failure.
	pub const fn pre_dispatch(cause: TransportFailure) -> Self {
		Self { dispatch: DispatchState::PreDispatch, cause }
	}

	/// Constructs a failure after request handoff.
	pub const fn effects_unknown(cause: TransportFailure) -> Self {
		Self { dispatch: DispatchState::EffectsUnknown, cause }
	}
}

/// Typed MCP transport failure cause.
#[derive(strum::IntoStaticStr, thiserror::Error)]
#[strum(serialize_all = "snake_case")]
pub enum TransportFailure {
	/// Caller cancellation won the operation race.
	#[error("MCP transport operation was cancelled")]
	Cancelled,
	/// Configured deadline elapsed.
	#[error("MCP transport operation timed out")]
	TimedOut,
	/// Transport is not connected.
	#[error("MCP transport is not connected")]
	NotConnected,
	/// Connection or process stream closed.
	#[error("MCP transport connection closed")]
	Closed,
	/// A frame exceeded its bounded size.
	#[error("MCP transport frame exceeded its size limit")]
	FrameTooLarge,
	/// Platform spawn planning rejected the configured command vector.
	#[error("MCP stdio child process command is invalid")]
	InvalidSpawnPlan,
	/// Child process could not be spawned.
	#[error("MCP stdio child process could not be started")]
	Spawn(#[source] io::Error),
	/// Pipe or socket I/O failed.
	#[error("MCP transport I/O failed")]
	Io(#[source] io::Error),
	/// HTTP endpoint could not be reached.
	#[error("MCP HTTP endpoint could not be reached")]
	HttpConnect(#[source] reqwest::Error),
	/// HTTP connection was reset after it was opened.
	#[error("MCP HTTP connection was reset")]
	HttpReset(#[source] reqwest::Error),
	/// HTTP connection ended before a complete frame arrived.
	#[error("MCP HTTP connection ended unexpectedly")]
	HttpEof(#[source] reqwest::Error),
	/// HTTP client failed without a more specific stable class.
	#[error("MCP HTTP transport failed")]
	Http(#[source] reqwest::Error),
	/// HTTP response status is not successful.
	#[error("MCP HTTP endpoint returned status {status}")]
	HttpStatus {
		/// Non-successful HTTP response status code returned by the configured
		/// remote endpoint.
		status: u16,
	},
	/// Header policy rejected configuration or redirect behavior.
	#[error("MCP HTTP header or redirect policy rejected the request")]
	HeaderPolicy(#[source] HeaderPolicyError),
	/// JSON serialization or buffered response decoding failed.
	#[error("MCP transport received malformed JSON")]
	Json(#[source] serde_json::Error),
	/// A streaming frame was malformed. The input is intentionally omitted so
	/// credential-bearing payloads cannot enter diagnostics.
	#[error("MCP transport received a malformed frame")]
	MalformedFrame,
	/// JSON-RPC response did not correlate with the request.
	#[error("MCP transport received an uncorrelated JSON-RPC response")]
	Correlation,
	/// Server returned a JSON-RPC error.
	#[error("MCP server returned JSON-RPC error code {code}")]
	JsonRpc {
		/// Application error code from a correlated JSON-RPC error response.
		code: i64,
	},
	/// SSE stream or endpoint event was malformed.
	#[error("MCP server-sent-event stream was malformed")]
	SseProtocol,
}

impl TransportFailure {
	/// Classifies a reqwest failure without copying its potentially
	/// credential-bearing diagnostic text.
	pub fn from_http(source: reqwest::Error) -> Self {
		use std::error::Error as _;

		let mut current = source.source();
		let mut io_kind = None;
		while let Some(error) = current {
			if let Some(io) = error.downcast_ref::<io::Error>() {
				io_kind = Some(io.kind());
				break;
			}
			current = error.source();
		}
		match io_kind {
			Some(io::ErrorKind::ConnectionReset) => Self::HttpReset(source),
			Some(io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe) => Self::HttpEof(source),
			_ if source.is_connect() => Self::HttpConnect(source),
			_ if source.is_timeout() => Self::TimedOut,
			_ => Self::Http(source),
		}
	}
}

impl std::fmt::Debug for TransportFailure {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let kind: &'static str = self.into();
		let mut debug = formatter.debug_struct("TransportFailure");
		debug.field("kind", &kind);
		match self {
			Self::HttpStatus { status } => {
				debug.field("status", status);
			},
			Self::JsonRpc { code } => {
				debug.field("code", code);
			},
			_ => {},
		}
		debug.finish()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn transport_debug_never_exposes_inner_diagnostics() {
		let error = TransportError::effects_unknown(TransportFailure::Io(io::Error::other(
			"Authorization: Bearer top-secret",
		)));
		let debug = format!("{error:?}");
		assert!(!debug.contains("top-secret"));
		assert!(debug.contains("io"));
		assert!(debug.contains("EffectsUnknown"));
	}
}
