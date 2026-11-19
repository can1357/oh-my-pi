//! TCP transport: the same connection machinery over a TCP socket.
//!
//! Unlike the local transports there is no peer-credential check — callers
//! authenticate in-band. Loopback and non-loopback addresses are both
//! accepted. Every socket has `TCP_NODELAY` set: frames are already coalesced
//! per JS task by the cork, so Nagle would only add latency.

use std::{
	io,
	mem::ManuallyDrop,
	net::{Shutdown, TcpStream as StdTcpStream},
};

use tokio::net::{TcpListener, TcpStream};

use super::IpcError;

/// Bind and listen on `host:port` (`port` 0 picks an ephemeral port).
pub async fn listen(host: &str, port: u16) -> Result<TcpListener, IpcError> {
	TcpListener::bind((host, port))
		.await
		.map_err(|error| IpcError::io(&error, &format!("listen tcp {host}:{port}")))
}

/// Next accepted connection, with `TCP_NODELAY` set.
pub async fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
	let (stream, _) = listener.accept().await?;
	stream.set_nodelay(true)?;
	Ok(stream)
}

/// Dial `host:port` with `TCP_NODELAY` set. The caller bounds the wait.
pub async fn connect(host: &str, port: u16) -> Result<TcpStream, IpcError> {
	let context = || format!("connect tcp {host}:{port}");
	let stream = TcpStream::connect((host, port))
		.await
		.map_err(|error| IpcError::io(&error, &context()))?;
	stream
		.set_nodelay(true)
		.map_err(|error| IpcError::io(&error, &context()))?;
	Ok(stream)
}

/// Shut the write half; the peer reads EOF after the queued bytes.
pub fn shutdown_write(stream: &TcpStream) -> io::Result<()> {
	// Borrow the socket as a std stream without taking ownership: tokio's
	// stream keeps the descriptor and closes it on drop.
	#[cfg(unix)]
	let std = {
		use std::os::fd::{AsRawFd, FromRawFd};
		// SAFETY: the descriptor is owned by `stream` and live for this call;
		// `ManuallyDrop` keeps the borrowed std stream from closing it.
		ManuallyDrop::new(unsafe { StdTcpStream::from_raw_fd(stream.as_raw_fd()) })
	};
	#[cfg(windows)]
	let std = {
		use std::os::windows::io::{AsRawSocket, FromRawSocket};
		// SAFETY: the socket is owned by `stream` and live for this call;
		// `ManuallyDrop` keeps the borrowed std stream from closing it.
		ManuallyDrop::new(unsafe { StdTcpStream::from_raw_socket(stream.as_raw_socket()) })
	};
	std.shutdown(Shutdown::Write)
}
