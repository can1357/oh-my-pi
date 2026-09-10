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

use std::{fmt, io};

pub use health::{HealthReporter, health_service};
pub use hello::{HelloService, MIN_SCHEMA_REV, Peer, handshake};
pub use tls::{TlsConfig, client_tls, server_tls};
use tonic::transport;
pub use uds::{Incoming, connect, listen};

/// An RPC transport or protocol-negotiation failure.
#[derive(thiserror::Error)]
pub enum Error {
	/// A filesystem, socket, or stream operation failed.
	#[error("I/O error")]
	Io(#[source] #[from] io::Error),
	/// Tonic could not establish or configure a transport.
	#[error("transport error")]
	Transport(#[source] #[from] transport::Error),
	/// A gRPC request failed after the transport was established.
	#[error("RPC error")]
	Rpc(#[source] #[from] tonic::Status),
	/// TLS material was invalid or could not be configured.
	#[error("TLS configuration error")]
	Tls(Str),
	/// The server schema is older than the client schema.
	#[error("server schema revision {server} is older than client revision {client}")]
	SchemaTooOld {
		/// Revision advertised by the server.
		server: u32,
		/// Revision sent by the client.
		client: u32,
	},
	/// The client does not implement the oldest schema accepted by the server.
	#[error("client schema revision {client} is below server minimum {server_min}")]
	SchemaUnsupported {
		/// Minimum revision accepted by the server.
		server_min: u32,
		/// Revision implemented by the client.
		client:     u32,
	},
	/// The requested transport is unavailable on this operating system.
	#[error("unsupported transport: {0}")]
	Unsupported(&'static str),
}

impl fmt::Debug for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		fmt::Display::fmt(self, formatter)
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

		for error in &errors {
			assert!(!error.to_string().contains(CANARY));
			assert!(!format!("{error:?}").contains(CANARY));
		}
		assert!(error::Error::source(&errors[0]).is_some());
		assert!(error::Error::source(&errors[1]).is_some());
		assert!(error::Error::source(&errors[2]).is_none());
	}
}
