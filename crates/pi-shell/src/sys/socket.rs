//! OS stream sockets for the process host ([`Sockets`]): Unix-domain and
//! TCP connect, listen and accept, host name and service lookups, with raw
//! `libc` calls.
//!
//! Nothing here blocks the engine thread: a TCP connect runs non-blocking
//! and waits for writability through [`super::ready`], an accept waits for
//! readability the same way (the listening descriptor keeps its flags:
//! they belong to the open file description, which externals may share),
//! and resolver lookups (`getaddrinfo`, `getnameinfo`) run on a helper
//! thread. Every descriptor made here is close-on-exec: the engine hands
//! sockets to externals itself, at the fd numbers of the shell.

use std::{
	ffi::CString,
	fs, io,
	mem::{size_of, zeroed},
	net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6, ToSocketAddrs},
	os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
	sync::Arc,
	task::{Context, Poll, Waker},
	thread,
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use super::{StdFile, ready};
use crate::bash::{
	Accepted, File, FsPending, FsPoll, IpFamily, ListenError, ListenStage, OsHandle, SockAddr,
	Sockets,
};

/// [`Sockets`] over the host OS.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeSockets;

fn last_error() -> io::Error {
	io::Error::last_os_error()
}

/// The raw descriptor of `h`.
fn raw(h: OsHandle) -> io::Result<RawFd> {
	RawFd::try_from(h.0).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))
}

/// Mark `fd` close-on-exec.
fn cloexec(fd: RawFd) -> io::Result<()> {
	// SAFETY: fcntl on a descriptor this module owns.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
	// SAFETY: as above.
	if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
		return Err(last_error());
	}
	Ok(())
}

/// Turn `O_NONBLOCK` on or off.
fn nonblocking(fd: RawFd, on: bool) -> io::Result<()> {
	// SAFETY: fcntl on a descriptor this module owns.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(last_error());
	}
	let want = if on {
		flags | libc::O_NONBLOCK
	} else {
		flags & !libc::O_NONBLOCK
	};
	// SAFETY: as above.
	if want != flags && unsafe { libc::fcntl(fd, libc::F_SETFL, want) } < 0 {
		return Err(last_error());
	}
	Ok(())
}

/// A new close-on-exec stream socket of `domain`.
fn socket(domain: libc::c_int) -> io::Result<OwnedFd> {
	// SAFETY: plain socket(2).
	let fd = unsafe { libc::socket(domain, libc::SOCK_STREAM, 0) };
	if fd < 0 {
		return Err(last_error());
	}
	// SAFETY: a fresh descriptor nothing else owns.
	let owned = unsafe { OwnedFd::from_raw_fd(fd) };
	cloexec(fd)?;
	Ok(owned)
}

/// `SO_OOBINLINE` (zsh's `ztcp` sets it on every TCP socket).
fn oob_inline(fd: RawFd) {
	let one: libc::c_int = 1;
	// SAFETY: a valid option value of the right size; failure is ignored,
	// as zsh ignores it.
	unsafe {
		libc::setsockopt(
			fd,
			libc::SOL_SOCKET,
			libc::SO_OOBINLINE,
			(&raw const one).cast(),
			size_of::<libc::c_int>() as libc::socklen_t,
		);
	}
}

/// `addr` as a C socket address and its length.
fn to_c(addr: &SockAddr) -> (libc::sockaddr_storage, libc::socklen_t) {
	// SAFETY: plain data; all-zero is a valid value.
	let mut ss: libc::sockaddr_storage = unsafe { zeroed() };
	let len = match addr {
		SockAddr::Unix(path) => {
			// SAFETY: `sockaddr_un` fits in `sockaddr_storage`.
			let un = unsafe { &mut *(&raw mut ss).cast::<libc::sockaddr_un>() };
			un.sun_family = libc::AF_UNIX as libc::sa_family_t;
			// zsh `strncpy(sun_path, path, sizeof(sun_path) - 1)`: longer
			// paths are cut, the last byte stays NUL.
			let room = un.sun_path.len() - 1;
			for (dst, &src) in un.sun_path.iter_mut().zip(path.iter().take(room)) {
				if src == 0 {
					break;
				}
				*dst = src as libc::c_char;
			}
			size_of::<libc::sockaddr_un>()
		},
		SockAddr::Inet(SocketAddr::V4(v4)) => {
			// SAFETY: `sockaddr_in` fits in `sockaddr_storage`.
			let sin = unsafe { &mut *(&raw mut ss).cast::<libc::sockaddr_in>() };
			sin.sin_family = libc::AF_INET as libc::sa_family_t;
			sin.sin_port = v4.port().to_be();
			sin.sin_addr = libc::in_addr { s_addr: u32::from_ne_bytes(v4.ip().octets()) };
			size_of::<libc::sockaddr_in>()
		},
		SockAddr::Inet(SocketAddr::V6(v6)) => {
			// SAFETY: `sockaddr_in6` fits in `sockaddr_storage`.
			let sin6 = unsafe { &mut *(&raw mut ss).cast::<libc::sockaddr_in6>() };
			sin6.sin6_family = libc::AF_INET6 as libc::sa_family_t;
			sin6.sin6_port = v6.port().to_be();
			sin6.sin6_addr = libc::in6_addr { s6_addr: v6.ip().octets() };
			sin6.sin6_flowinfo = v6.flowinfo();
			sin6.sin6_scope_id = v6.scope_id();
			size_of::<libc::sockaddr_in6>()
		},
	};
	#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
	{
		ss.ss_len = len as u8;
	}
	(ss, len as libc::socklen_t)
}

/// A C socket address as a [`SockAddr`].
fn from_c(ss: &libc::sockaddr_storage, len: libc::socklen_t) -> io::Result<SockAddr> {
	match libc::c_int::from(ss.ss_family) {
		libc::AF_UNIX => {
			// SAFETY: the family says it is a `sockaddr_un`.
			let un = unsafe { &*std::ptr::from_ref(ss).cast::<libc::sockaddr_un>() };
			let offset = std::mem::offset_of!(libc::sockaddr_un, sun_path);
			let n = (len as usize).saturating_sub(offset).min(un.sun_path.len());
			let path: Vec<u8> = un.sun_path[..n]
				.iter()
				.map(|&c| c as u8)
				.take_while(|&c| c != 0)
				.collect();
			Ok(SockAddr::Unix(BString::from(path)))
		},
		libc::AF_INET => {
			// SAFETY: the family says it is a `sockaddr_in`.
			let sin = unsafe { &*std::ptr::from_ref(ss).cast::<libc::sockaddr_in>() };
			let ip = Ipv4Addr::from(sin.sin_addr.s_addr.to_ne_bytes());
			Ok(SockAddr::Inet(SocketAddr::V4(SocketAddrV4::new(ip, u16::from_be(sin.sin_port)))))
		},
		libc::AF_INET6 => {
			// SAFETY: the family says it is a `sockaddr_in6`.
			let sin6 = unsafe { &*std::ptr::from_ref(ss).cast::<libc::sockaddr_in6>() };
			Ok(SockAddr::Inet(SocketAddr::V6(SocketAddrV6::new(
				Ipv6Addr::from(sin6.sin6_addr.s6_addr),
				u16::from_be(sin6.sin6_port),
				sin6.sin6_flowinfo,
				sin6.sin6_scope_id,
			))))
		},
		// An unbound peer of a Unix-domain socket may report no family.
		libc::AF_UNSPEC => Ok(SockAddr::Unix(BString::default())),
		_ => Err(io::Error::from_raw_os_error(libc::EAFNOSUPPORT)),
	}
}

/// The engine file of connected or listening socket `fd`.
fn file(fd: OwnedFd) -> Box<dyn File> {
	Box::new(StdFile::new(fs::File::from(fd)))
}

const fn domain(addr: &SockAddr) -> libc::c_int {
	match addr {
		SockAddr::Unix(_) => libc::AF_UNIX,
		SockAddr::Inet(SocketAddr::V4(_)) => libc::AF_INET,
		SockAddr::Inet(SocketAddr::V6(_)) => libc::AF_INET6,
	}
}

/// The pending error of a socket (`SO_ERROR`).
fn so_error(fd: RawFd) -> io::Result<()> {
	let mut e: libc::c_int = 0;
	let mut len = size_of::<libc::c_int>() as libc::socklen_t;
	// SAFETY: a valid out pointer and length.
	if unsafe {
		libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_ERROR, (&raw mut e).cast(), &raw mut len)
	} < 0
	{
		return Err(last_error());
	}
	if e == 0 {
		Ok(())
	} else {
		Err(io::Error::from_raw_os_error(e))
	}
}

/// A non-blocking connect waiting for writability.
struct Connecting {
	fd:    Option<OwnedFd>,
	watch: Option<ready::Watch>,
}

impl FsPending<Box<dyn File>> for Connecting {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Box<dyn File>>> {
		let Some(fd) = self.fd.as_ref().map(AsRawFd::as_raw_fd) else {
			return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EBADF)));
		};
		match ready::now(fd, ready::WRITE) {
			Ok(true) => {},
			Ok(false) => {
				self.watch = None;
				match ready::watch(fd, ready::WRITE, cx.waker()) {
					Ok(w) => self.watch = Some(w),
					Err(e) => return Poll::Ready(Err(e)),
				}
				if !matches!(ready::now(fd, ready::WRITE), Ok(true)) {
					return Poll::Pending;
				}
			},
			Err(e) => return Poll::Ready(Err(e)),
		}
		self.watch = None;
		let res = so_error(fd).and_then(|()| nonblocking(fd, false));
		Poll::Ready(res.map(|()| file(self.fd.take().expect("connecting socket"))))
	}

	fn reissuable(&self) -> bool {
		false
	}
}

/// An accept waiting for readability of (a duplicate of) the listener.
struct Accepting {
	listener: OwnedFd,
	watch:    Option<ready::Watch>,
}

/// `accept(2)` on `fd`, retried on `EINTR`; the new socket is
/// close-on-exec.
fn accept(fd: RawFd) -> io::Result<Accepted> {
	loop {
		// SAFETY: plain data; all-zero is a valid value.
		let mut ss: libc::sockaddr_storage = unsafe { zeroed() };
		let mut len = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
		// SAFETY: valid out pointers and length.
		let new = unsafe { libc::accept(fd, (&raw mut ss).cast(), &raw mut len) };
		if new < 0 {
			let e = last_error();
			if e.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(e);
		}
		// SAFETY: a fresh descriptor nothing else owns.
		let owned = unsafe { OwnedFd::from_raw_fd(new) };
		cloexec(new)?;
		let peer = from_c(&ss, len)?;
		return Ok(Accepted { file: file(owned), peer });
	}
}

impl FsPending<Accepted> for Accepting {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Accepted>> {
		let fd = self.listener.as_raw_fd();
		match ready::now(fd, ready::READ) {
			Ok(true) => {},
			Ok(false) => {
				self.watch = None;
				match ready::watch(fd, ready::READ, cx.waker()) {
					Ok(w) => self.watch = Some(w),
					Err(e) => return Poll::Ready(Err(e)),
				}
				if !matches!(ready::now(fd, ready::READ), Ok(true)) {
					return Poll::Pending;
				}
			},
			Err(e) => return Poll::Ready(Err(e)),
		}
		self.watch = None;
		Poll::Ready(accept(fd))
	}

	fn reissuable(&self) -> bool {
		false
	}
}

/// The result slot of a lookup on a helper thread.
struct Slot<T> {
	result: Option<io::Result<T>>,
	waker:  Option<Waker>,
}

/// A lookup running on a helper thread.
struct Threaded<T>(Arc<Mutex<Slot<T>>>);

impl<T: Send + 'static> Threaded<T> {
	fn start(name: &str, f: impl FnOnce() -> io::Result<T> + Send + 'static) -> FsPoll<T> {
		let slot = Arc::new(Mutex::new(Slot { result: None, waker: None }));
		let theirs = Arc::clone(&slot);
		let spawned = thread::Builder::new()
			.name(name.into())
			.stack_size(256 << 10)
			.spawn(move || {
				let r = f();
				let mut s = theirs.lock();
				s.result = Some(r);
				if let Some(w) = s.waker.take() {
					w.wake();
				}
			});
		match spawned {
			Ok(_) => FsPoll::Pending(Box::new(Self(slot))),
			Err(e) => FsPoll::Ready(Err(e)),
		}
	}
}

impl<T: Send + 'static> FsPending<T> for Threaded<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		let mut s = self.0.lock();
		if let Some(r) = s.result.take() {
			Poll::Ready(r)
		} else {
			s.waker = Some(cx.waker().clone());
			Poll::Pending
		}
	}
}

/// `getaddrinfo` of `host` for stream sockets: the addresses of `family`,
/// in resolver order, without duplicates.
fn lookup(host: &str, family: IpFamily) -> io::Result<Vec<IpAddr>> {
	let mut out: Vec<IpAddr> = Vec::new();
	let found = (host, 0)
		.to_socket_addrs()
		.map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
	for a in found {
		let ip = a.ip();
		let wanted = match family {
			IpFamily::V4 => ip.is_ipv4(),
			IpFamily::V6 => ip.is_ipv6(),
			IpFamily::Any => true,
		};
		if wanted && !out.contains(&ip) {
			out.push(ip);
		}
	}
	if out.is_empty() {
		return Err(io::ErrorKind::NotFound.into());
	}
	Ok(out)
}

/// `getnameinfo(NI_NAMEREQD)` of `addr`: its host name, if it has one.
fn reverse(addr: IpAddr) -> Option<BString> {
	let (ss, len) = to_c(&SockAddr::Inet(SocketAddr::new(addr, 0)));
	let mut host = [0 as libc::c_char; 1025];
	// SAFETY: a valid address of `len` bytes and a host buffer of its
	// stated size; no service buffer.
	let rc = unsafe {
		libc::getnameinfo(
			(&raw const ss).cast(),
			len,
			host.as_mut_ptr(),
			host.len() as libc::socklen_t,
			std::ptr::null_mut(),
			0,
			libc::NI_NAMEREQD,
		)
	};
	if rc != 0 {
		return None;
	}
	let name: Vec<u8> = host
		.iter()
		.map(|&c| c as u8)
		.take_while(|&c| c != 0)
		.collect();
	Some(BString::from(name))
}

impl Sockets for NativeSockets {
	fn resolve(&mut self, host: &BStr, family: IpFamily) -> FsPoll<Vec<IpAddr>> {
		let Ok(text) = host.to_str() else {
			return FsPoll::Ready(Err(io::ErrorKind::NotFound.into()));
		};
		if let Ok(ip) = text.parse::<IpAddr>() {
			let ok = match family {
				IpFamily::V4 => ip.is_ipv4(),
				IpFamily::V6 => ip.is_ipv6(),
				IpFamily::Any => true,
			};
			return FsPoll::Ready(if ok {
				Ok(vec![ip])
			} else {
				Err(io::ErrorKind::NotFound.into())
			});
		}
		let text = text.to_owned();
		Threaded::start("pi-shell-resolve", move || lookup(&text, family))
	}

	fn host_name(&mut self, addr: IpAddr) -> FsPoll<Option<BString>> {
		Threaded::start("pi-shell-resolve", move || Ok(reverse(addr)))
	}

	fn service_port(&mut self, name: &BStr) -> Option<u16> {
		let name = CString::new(name.as_bytes()).ok()?;
		// SAFETY: NUL-terminated strings; the entry is read at once (the
		// engine thread is the only caller of these lookups).
		let ent = unsafe { libc::getservbyname(name.as_ptr(), c"tcp".as_ptr()) };
		if ent.is_null() {
			return None;
		}
		// SAFETY: a non-null entry from `getservbyname`.
		let port = unsafe { (*ent).s_port };
		// `s_port` holds the port in network byte order in an int.
		Some(u16::from_be(port as u16))
	}

	fn service_by_port(&mut self, port: u16) -> bool {
		// SAFETY: a NUL-terminated protocol name; only nullness is read.
		let ent = unsafe { libc::getservbyport(libc::c_int::from(port.to_be()), c"tcp".as_ptr()) };
		!ent.is_null()
	}

	fn connect(&mut self, addr: &SockAddr) -> FsPoll<Box<dyn File>> {
		let fd = match socket(domain(addr)) {
			Ok(fd) => fd,
			Err(e) => return FsPoll::Ready(Err(e)),
		};
		let raw = fd.as_raw_fd();
		if matches!(addr, SockAddr::Inet(_)) {
			oob_inline(raw);
		}
		if let Err(e) = nonblocking(raw, true) {
			return FsPoll::Ready(Err(e));
		}
		let (ss, len) = to_c(addr);
		// SAFETY: a valid address of `len` bytes.
		let rc = unsafe { libc::connect(raw, (&raw const ss).cast(), len) };
		if rc == 0 {
			return FsPoll::Ready(nonblocking(raw, false).map(|()| file(fd)));
		}
		let e = last_error();
		match e.raw_os_error() {
			// The connection goes on in the background (an interrupted
			// non-blocking connect too).
			Some(libc::EINPROGRESS | libc::EINTR) => {
				FsPoll::Pending(Box::new(Connecting { fd: Some(fd), watch: None }))
			},
			_ => FsPoll::Ready(Err(e)),
		}
	}

	fn listen(&mut self, addr: &SockAddr, backlog: u32) -> Result<Box<dyn File>, ListenError> {
		let fd =
			socket(domain(addr)).map_err(|error| ListenError { stage: ListenStage::Socket, error })?;
		let raw = fd.as_raw_fd();
		if matches!(addr, SockAddr::Inet(_)) {
			oob_inline(raw);
		}
		let (ss, len) = to_c(addr);
		// SAFETY: a valid address of `len` bytes.
		if unsafe { libc::bind(raw, (&raw const ss).cast(), len) } < 0 {
			return Err(ListenError { stage: ListenStage::Bind, error: last_error() });
		}
		let backlog = libc::c_int::try_from(backlog).unwrap_or(libc::c_int::MAX);
		// SAFETY: plain listen(2) on our socket.
		if unsafe { libc::listen(raw, backlog) } < 0 {
			return Err(ListenError { stage: ListenStage::Listen, error: last_error() });
		}
		Ok(file(fd))
	}

	fn accept(&mut self, listener: OsHandle) -> FsPoll<Accepted> {
		let fd = match raw(listener) {
			Ok(fd) => fd,
			Err(e) => return FsPoll::Ready(Err(e)),
		};
		if matches!(ready::now(fd, ready::READ), Ok(true)) {
			return FsPoll::Ready(accept(fd));
		}
		// Wait on a duplicate: the shell may close its fd meanwhile.
		// SAFETY: F_DUPFD_CLOEXEC of a caller-supplied descriptor.
		let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
		if dup < 0 {
			return FsPoll::Ready(Err(last_error()));
		}
		// SAFETY: a fresh descriptor nothing else owns.
		let listener = unsafe { OwnedFd::from_raw_fd(dup) };
		FsPoll::Pending(Box::new(Accepting { listener, watch: None }))
	}

	fn local_addr(&mut self, sock: OsHandle) -> io::Result<SockAddr> {
		let fd = raw(sock)?;
		// SAFETY: plain data; all-zero is a valid value.
		let mut ss: libc::sockaddr_storage = unsafe { zeroed() };
		let mut len = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
		// SAFETY: valid out pointers and length.
		if unsafe { libc::getsockname(fd, (&raw mut ss).cast(), &raw mut len) } < 0 {
			return Err(last_error());
		}
		from_c(&ss, len)
	}

	fn peer_addr(&mut self, sock: OsHandle) -> io::Result<SockAddr> {
		let fd = raw(sock)?;
		// SAFETY: plain data; all-zero is a valid value.
		let mut ss: libc::sockaddr_storage = unsafe { zeroed() };
		let mut len = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
		// SAFETY: valid out pointers and length.
		if unsafe { libc::getpeername(fd, (&raw mut ss).cast(), &raw mut len) } < 0 {
			return Err(last_error());
		}
		from_c(&ss, len)
	}

	fn send_urgent(&mut self, sock: OsHandle, data: &[u8]) -> io::Result<usize> {
		let fd = raw(sock)?;
		loop {
			// SAFETY: a valid buffer of `data.len()` bytes.
			let n = unsafe { libc::send(fd, data.as_ptr().cast(), data.len(), libc::MSG_OOB) };
			if n >= 0 {
				return Ok(n as usize);
			}
			let e = last_error();
			if e.kind() != io::ErrorKind::Interrupted {
				return Err(e);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn socket_addresses_round_trip_through_c() {
		for addr in [
			SockAddr::Inet("127.0.0.1:5555".parse().unwrap()),
			SockAddr::Inet("[::1]:80".parse().unwrap()),
			SockAddr::Unix(BString::from("/tmp/x.sock")),
		] {
			let (ss, len) = to_c(&addr);
			assert_eq!(from_c(&ss, len).unwrap(), addr);
		}
	}
}
