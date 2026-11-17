//! The socket seam: stream sockets for zsh's `zsh/net/socket`,
//! `zsh/net/tcp` and `zsh/zftp` modules.
//!
//! [`Host::sockets`](crate::bash::Host::sockets) returns a [`Sockets`] when
//! the host may open OS sockets (the process shell, `omp zsh`); hosts
//! without them (agent shells, the testkit) return `None`, and the socket
//! builtins report the operation as unsupported.
//!
//! Sockets come back as [`File`]s of
//! [`FileKind::Socket`](crate::bash::fs::FileKind) with an [`OsHandle`], so the
//! engine puts them into a vproc's fd table like any other descriptor and
//! externals inherit them directly. Closing a socket is dropping its file.
//! Sockets are addressed by that handle ([`File::os_handle`]) for
//! [`Sockets::accept`], [`Sockets::local_addr`] and [`Sockets::peer_addr`].
//!
//! Operations that can wait (name resolution, connecting, accepting)
//! return [`FsPoll`]: never block the engine thread.

use std::{
	io,
	net::{IpAddr, SocketAddr},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::{File, FsPoll},
	host::OsHandle,
};

/// A stream socket's address.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SockAddr {
	/// A Unix-domain socket path (empty for an unbound peer).
	Unix(BString),
	/// An IPv4 or IPv6 address and port.
	Inet(SocketAddr),
}

/// Which addresses [`Sockets::resolve`] asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IpFamily {
	/// IPv4 only (`AF_INET`).
	V4,
	/// IPv6 only (`AF_INET6`).
	V6,
	/// Either (`AF_UNSPEC`).
	Any,
}

/// The step of [`Sockets::listen`] that failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ListenStage {
	/// `socket(2)`.
	Socket,
	/// `bind(2)`.
	Bind,
	/// `listen(2)`.
	Listen,
}

/// Failure of [`Sockets::listen`].
#[derive(Debug)]
pub struct ListenError {
	/// The step that failed.
	pub stage: ListenStage,
	/// Its error.
	pub error: io::Error,
}

/// A connection taken by [`Sockets::accept`].
pub struct Accepted {
	/// The connected socket.
	pub file: Box<dyn File>,
	/// The peer's address as `accept(2)` reported it.
	pub peer: SockAddr,
}

/// Stream sockets of the host's OS.
pub trait Sockets {
	/// The addresses `host` names, in resolver order without duplicates:
	/// a numeric address of the family is taken as is, anything else asks
	/// the resolver (`getaddrinfo`). `NotFound` when the name does not
	/// resolve.
	fn resolve(&mut self, host: &BStr, family: IpFamily) -> FsPoll<Vec<IpAddr>>;
	/// The host name `addr` maps back to (`gethostbyaddr`), `None` when it
	/// has none.
	fn host_name(&mut self, addr: IpAddr) -> FsPoll<Option<BString>>;
	/// The port of TCP service `name` in host byte order
	/// (`getservbyname(name, "tcp")`), `None` when unknown.
	fn service_port(&mut self, name: &BStr) -> Option<u16>;
	/// Whether `port` (host byte order) is a known TCP service
	/// (`getservbyport(htons(port), "tcp")` finds an entry).
	fn service_by_port(&mut self, port: u16) -> bool;
	/// A stream socket connected to `addr`; the error is the connect's.
	fn connect(&mut self, addr: &SockAddr) -> FsPoll<Box<dyn File>>;
	/// A stream socket bound to `addr` and listening with `backlog`.
	///
	/// # Errors
	///
	/// The step that failed and its error.
	fn listen(&mut self, addr: &SockAddr, backlog: u32) -> Result<Box<dyn File>, ListenError>;
	/// The next connection on the listening socket `listener`; pending
	/// until one arrives.
	fn accept(&mut self, listener: OsHandle) -> FsPoll<Accepted>;
	/// The address socket `sock` is bound to (`getsockname`).
	///
	/// # Errors
	///
	/// The OS error (`ENOTSOCK` for a handle that is no socket).
	fn local_addr(&mut self, sock: OsHandle) -> io::Result<SockAddr>;
	/// The address socket `sock` is connected to (`getpeername`).
	///
	/// # Errors
	///
	/// The OS error (`ENOTCONN` for an unconnected socket).
	fn peer_addr(&mut self, sock: OsHandle) -> io::Result<SockAddr>;
	/// Send `data` on the connected socket `sock` as out-of-band data
	/// (`send(2)` with `MSG_OOB`): the count sent.
	///
	/// # Errors
	///
	/// The OS error.
	fn send_urgent(&mut self, sock: OsHandle, data: &[u8]) -> io::Result<usize>;
}
