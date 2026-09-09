//! Owner-local Unix-socket and Windows named-pipe transport for daemon RPC.

#[cfg(unix)]
use std::{
	fs,
	os::unix::fs::{FileTypeExt, PermissionsExt},
};
use std::{io, path::Path};

#[cfg(unix)]
use hyper_util::rt::TokioIo;
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(unix)]
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::{self, Channel};
#[cfg(unix)]
use tower::service_fn;
#[cfg(windows)]
use {
	hyper_util::rt::TokioIo,
	std::{
		pin::Pin,
		task::{Context, Poll},
		time::Duration,
	},
	tokio::{
		io::{AsyncRead, AsyncWrite, ReadBuf},
		net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
		time,
	},
	tonic::transport::server::Connected,
	tower::service_fn,
};

use crate::Error;

/// A stream of accepted local RPC connections.
#[cfg(unix)]
pub type Incoming = UnixListenerStream;

/// A stream of accepted owner-local Windows named-pipe connections.
#[cfg(windows)]
pub type Incoming = flume::r#async::RecvStream<'static, Result<NamedPipeConnection, io::Error>>;

/// Bind an owner-only Unix-domain socket and return its incoming connection
/// stream.
///
/// Parent directories are created as needed. An existing path is removed only
/// when it is a socket that cannot be connected to; an active socket or a
/// non-socket path is left untouched.
#[cfg(unix)]
#[tracing::instrument(level = "debug", skip_all, fields(transport = "unix", socket = %path.display()))]
pub async fn listen(path: &Path) -> Result<Incoming, Error> {
	if let Some(parent) = path.parent()
		&& !parent.as_os_str().is_empty()
	{
		tokio::fs::create_dir_all(parent).await?;
	}

	match tokio::fs::symlink_metadata(path).await {
		Ok(metadata) if metadata.file_type().is_socket() => {
			match UnixStream::connect(path).await {
				Ok(_) => {
					return Err(
						io::Error::new(
							io::ErrorKind::AddrInUse,
							"Unix socket is already accepting connections",
						)
						.into(),
					);
				},
				Err(error) => {
					tracing::warn!(
						socket = %path.display(),
						%error,
						"stale RPC socket probe failed; removing socket"
					);
				},
			}
			tokio::fs::remove_file(path).await?;
		},
		Ok(_) => {},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(error.into()),
	}

	let listener = UnixListener::bind(path)?;
	tokio::fs::set_permissions(path, fs::Permissions::from_mode(0o600)).await?;
	tracing::info!(transport = "unix", socket = %path.display(), "RPC listener ready");
	Ok(UnixListenerStream::new(listener))
}

/// Connect a tonic channel to a Unix-domain socket.
#[cfg(unix)]
#[tracing::instrument(level = "debug", skip_all, fields(transport = "unix", socket = %path.display()))]
pub async fn connect(path: &Path) -> Result<Channel, Error> {
	let path = path.to_owned();
	let endpoint = transport::Endpoint::from_static("http://[::]:50051");
	let channel = endpoint
		.connect_with_connector(service_fn(move |_| {
			let path = path.clone();
			async move { UnixStream::connect(path).await.map(TokioIo::new) }
		}))
		.await?;
	Ok(channel)
}

/// Binds an owner-local Windows named pipe and accepts successive instances.
#[cfg(windows)]
#[tracing::instrument(level = "debug", skip_all, fields(transport = "named_pipe", pipe = %path.display()))]
pub async fn listen(path: &Path) -> Result<Incoming, Error> {
	let name = path.to_string_lossy().into_owned();
	let first = ServerOptions::new()
		.first_pipe_instance(true)
		.create(&name)?;
	tracing::info!(transport = "named_pipe", pipe = %path.display(), "RPC listener ready");
	let (sender, receiver) = flume::bounded(16);
	tokio::spawn(async move {
		let mut pending = first;
		loop {
			if let Err(error) = pending.connect().await {
				tracing::warn!(transport = "named_pipe", pipe = %name, %error, "RPC listener accept failed");
				let _ = sender.send_async(Err(error)).await;
				break;
			}
			let next = match ServerOptions::new().create(&name) {
				Ok(next) => next,
				Err(error) => {
					tracing::warn!(transport = "named_pipe", pipe = %name, %error, "RPC listener instance creation failed");
					let _ = sender.send_async(Err(error)).await;
					break;
				},
			};
			if sender
				.send_async(Ok(NamedPipeConnection(pending)))
				.await
				.is_err()
			{
				break;
			}
			pending = next;
		}
	});
	Ok(receiver.into_stream())
}

/// Connects a tonic channel to an owner-local Windows named pipe.
#[cfg(windows)]
#[tracing::instrument(level = "debug", skip_all, fields(transport = "named_pipe", pipe = %path.display()))]
pub async fn connect(path: &Path) -> Result<Channel, Error> {
	let name = path.to_string_lossy().into_owned();
	let endpoint = transport::Endpoint::from_static("http://[::]:50051");
	let channel = endpoint
		.connect_with_connector(service_fn(move |_| {
			let name = name.clone();
			async move {
				loop {
					match ClientOptions::new().open(&name) {
						Ok(client) => return Ok::<_, io::Error>(TokioIo::new(client)),
						Err(error) if error.raw_os_error() == Some(231) => {
							time::sleep(Duration::from_millis(10)).await;
						},
						Err(error) => return Err(error),
					}
				}
			}
		}))
		.await?;
	Ok(channel)
}

/// Tonic-compatible accepted Windows named-pipe server instance.
#[cfg(windows)]
#[derive(Debug)]
pub struct NamedPipeConnection(NamedPipeServer);

#[cfg(windows)]
impl Connected for NamedPipeConnection {
	type ConnectInfo = ();

	fn connect_info(&self) -> Self::ConnectInfo {}
}

#[cfg(windows)]
impl AsyncRead for NamedPipeConnection {
	fn poll_read(
		self: Pin<&mut Self>,
		context: &mut Context<'_>,
		buffer: &mut ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_read(context, buffer)
	}
}

#[cfg(windows)]
impl AsyncWrite for NamedPipeConnection {
	fn poll_write(
		self: Pin<&mut Self>,
		context: &mut Context<'_>,
		buffer: &[u8],
	) -> Poll<io::Result<usize>> {
		Pin::new(&mut self.get_mut().0).poll_write(context, buffer)
	}

	fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_flush(context)
	}

	fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
		Pin::new(&mut self.get_mut().0).poll_shutdown(context)
	}
}
