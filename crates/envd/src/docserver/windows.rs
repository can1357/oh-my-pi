//! Owner-scoped Windows named-pipe transport for document authority
//! connections.

use std::{io, path::Path};

pub use omp_env::windows::OwnerPipeListener;
use thiserror::Error;
use tokio::{net::windows::named_pipe::NamedPipeClient, sync::watch, task, task::JoinSet};
use tokio_util::sync::CancellationToken;

use crate::docserver::{
	Environment,
	connection::{ConnectionConfig, ConnectionError, serve_connection},
};

/// A Windows document-authority listener or connection failure.
#[derive(Debug, Error)]
pub enum WindowsTransportError {
	/// Binding or connecting the owner-only pipe failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// A document protocol connection failed.
	#[error(transparent)]
	Connection(#[from] ConnectionError),
	/// A spawned connection task failed.
	#[error(transparent)]
	Task(#[from] task::JoinError),
}

/// Connects to a ready, current-user-only document authority pipe.
///
/// # Errors
/// Returns an OS error when the endpoint is not a canonical local named pipe
/// or the ready listener cannot be opened.
pub fn connect_owner_pipe(endpoint: impl AsRef<Path>) -> io::Result<NamedPipeClient> {
	omp_env::windows::open_owner_pipe(endpoint)
}

/// Serves document protocol connections from a pre-bound owner pipe.
///
/// The pre-bound listener is already ready before this future starts. Shutdown
/// closes the pending instance, aborts accepted connections, and updates
/// `connection_gauge` to zero.
///
/// # Errors
/// Returns the first listener, connection, or task failure.
pub async fn serve_owner_pipe(
	environment: Environment,
	mut listener: OwnerPipeListener,
	config: ConnectionConfig,
	shutdown: CancellationToken,
	connection_gauge: Option<watch::Sender<usize>>,
) -> Result<(), WindowsTransportError> {
	let mut connections = JoinSet::new();
	if let Some(gauge) = &connection_gauge {
		gauge.send_replace(0);
	}
	loop {
		tokio::select! {
			() = shutdown.cancelled() => break,
			accepted = listener.accept() => {
				let stream = accepted?;
				let environment = environment.clone();
				connections.spawn(async move {
					serve_connection(environment, stream, config).await
				});
				if let Some(gauge) = &connection_gauge {
					gauge.send_replace(connections.len());
				}
			},
			completed = connections.join_next(), if !connections.is_empty() => {
				if let Some(gauge) = &connection_gauge {
					gauge.send_replace(connections.len());
				}
				match completed {
					Some(Ok(Ok(()))) | None => {},
					Some(Ok(Err(error))) => return Err(error.into()),
					Some(Err(error)) => return Err(error.into()),
				}
			},
		}
	}
	drop(listener);
	connections.abort_all();
	while let Some(result) = connections.join_next().await {
		if let Err(error) = result
			&& !error.is_cancelled()
		{
			return Err(error.into());
		}
	}
	if let Some(gauge) = connection_gauge {
		gauge.send_replace(0);
	}
	Ok(())
}

/// Starts a ready owner-only listener and serves until cancellation.
///
/// # Errors
/// Returns the first bind, connection, or task failure.
pub async fn bind_and_serve_owner_pipe(
	environment: Environment,
	endpoint: impl AsRef<Path>,
	config: ConnectionConfig,
	shutdown: CancellationToken,
	connection_gauge: Option<watch::Sender<usize>>,
) -> Result<(), WindowsTransportError> {
	let listener = OwnerPipeListener::bind(endpoint)?;
	serve_owner_pipe(environment, listener, config, shutdown, connection_gauge).await
}

#[cfg(test)]
mod tests {
	use super::*;

	fn assert_stream_capabilities<T: AsyncRead + AsyncWrite + Unpin>() {}

	#[test]
	fn named_pipe_client_is_a_document_transport_stream() {
		assert_stream_capabilities::<NamedPipeClient>();
	}

	#[test]
	fn listener_type_is_shared_with_environment_data_transport() {
		fn same_type(_: Option<OwnerPipeListener>) -> Option<OwnerPipeListener> {
			None
		}
		let _ = same_type(None);
	}
}
