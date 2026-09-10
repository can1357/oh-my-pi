//! Transport plumbing for the omp gRPC protocol.
//!
//! The daemon serves local clients over an owner-only Unix-domain socket; `omp
//! gateway serve` exposes the same services over TCP with mutual TLS. Every
//! connection starts with the gateway Hello handshake. A client rejects a
//! server whose schema revision is older than its own, because protobuf's
//! unknown-field behavior would otherwise silently discard newer client data.
//!
//! Liveness and per-service readiness use the standard `grpc.health.v1`
//! protocol.

use omp_core::Str;

pub mod client;
pub mod framing;
pub mod health;
pub mod hello;
pub mod protocol;
pub mod tls;
pub mod uds;

use std::{
	fmt::{self, Display},
	io,
};

pub use health::{HealthReporter, health_service};
pub use hello::{HelloService, MIN_SCHEMA_REV, Peer, handshake};
pub use tls::{TlsConfig, client_tls, server_tls};
use tonic::transport;
pub use uds::{Incoming, connect, listen};

/// An RPC transport or protocol-negotiation failure.
#[derive(thiserror::Error)]
pub enum Error {
	/// A filesystem, socket, or stream operation failed.
	Io(io::Error),
	/// Tonic could not establish or configure a transport.
	Transport(transport::Error),
	/// A gRPC request failed after the transport was established.
	Rpc(tonic::Status),
	/// TLS material was invalid or could not be configured.
	Tls(Str),
	/// The server schema is older than the client schema.
	SchemaTooOld {
		/// Revision advertised by the server.
		server: u32,
		/// Revision sent by the client.
		client: u32,
	},
	/// The client does not implement the oldest schema accepted by the server.
	SchemaUnsupported {
		/// Minimum revision accepted by the server.
		server_min: u32,
		/// Revision implemented by the client.
		client:     u32,
	},
	/// The requested transport is unavailable on this operating system.
	Unsupported(&'static str),
}

impl fmt::Debug for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		Display::fmt(self, formatter)
	}
}

impl Display for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(error) => write!(formatter, "I/O error ({:?})", error.kind()),
			Self::Transport(_) => formatter.write_str("transport error"),
			Self::Rpc(status) => write!(formatter, "RPC error ({:?})", status.code()),
			Self::Tls(_) => formatter.write_str("TLS configuration error"),
			Self::SchemaTooOld { server, client } => write!(
				formatter,
				"server schema revision {server} is older than client revision {client}"
			),
			Self::SchemaUnsupported { server_min, client } => write!(
				formatter,
				"client schema revision {client} is below server minimum {server_min}"
			),
			Self::Unsupported(kind) => write!(formatter, "unsupported transport: {kind}"),
		}
	}
}

impl From<io::Error> for Error {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

impl From<transport::Error> for Error {
	fn from(error: transport::Error) -> Self {
		Self::Transport(error)
	}
}

impl From<tonic::Status> for Error {
	fn from(status: tonic::Status) -> Self {
		Self::Rpc(status)
	}
}

#[cfg(test)]
mod tests {
	use std::{error, io};

	use super::Error;

	#[test]
	fn observable_error_surfaces_discard_untrusted_diagnostics() {
		const CANARY: &str = "canary-private-key-and-access-token";
		let errors = [
			Error::Io(io::Error::other(CANARY)),
			Error::Rpc(tonic::Status::permission_denied(CANARY)),
			Error::Tls(CANARY.into()),
		];

		for error in errors {
			assert!(!error.to_string().contains(CANARY));
			assert!(!format!("{error:?}").contains(CANARY));
			assert!(error::Error::source(&error).is_none());
		}
	}
}
