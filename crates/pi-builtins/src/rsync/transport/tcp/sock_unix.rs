//! Raw BSD-socket operations the daemon connect needs and `std::net` lacks:
//! resolver hints and error text, binding before connecting, integer socket
//! options, and a non-blocking connect.

use std::{
	ffi::{CStr, CString},
	io,
	mem::zeroed,
	net::TcpStream,
	os::fd::{AsRawFd, FromRawFd, OwnedFd},
	time::Duration,
};

/// `EAI_NONAME`, the resolver's "unknown host or service" code.
pub(super) const EAI_NONAME: i32 = libc::EAI_NONAME;

/// Socket option levels and names for `--sockopts`.
pub(super) mod opt {
	pub(crate) const SOL_SOCKET: i32 = libc::SOL_SOCKET;
	pub(crate) const IPPROTO_TCP: i32 = libc::IPPROTO_TCP;
	pub(crate) const IPPROTO_IP: i32 = libc::IPPROTO_IP;
	pub(crate) const SO_KEEPALIVE: i32 = libc::SO_KEEPALIVE;
	pub(crate) const SO_REUSEADDR: i32 = libc::SO_REUSEADDR;
	pub(crate) const SO_BROADCAST: i32 = libc::SO_BROADCAST;
	pub(crate) const TCP_NODELAY: i32 = libc::TCP_NODELAY;
	pub(crate) const IP_TOS: i32 = libc::IP_TOS;
	pub(crate) const SO_SNDBUF: i32 = libc::SO_SNDBUF;
	pub(crate) const SO_RCVBUF: i32 = libc::SO_RCVBUF;
	pub(crate) const SO_SNDLOWAT: i32 = libc::SO_SNDLOWAT;
	pub(crate) const SO_RCVLOWAT: i32 = libc::SO_RCVLOWAT;
	pub(crate) const SO_SNDTIMEO: i32 = libc::SO_SNDTIMEO;
	pub(crate) const SO_RCVTIMEO: i32 = libc::SO_RCVTIMEO;
}

/// `gai_strerror(code)`.
pub(super) fn gai_text(code: i32) -> String {
	// SAFETY: gai_strerror returns a pointer to a static NUL-terminated string.
	let text = unsafe { libc::gai_strerror(code) };
	if text.is_null() {
		return format!("Unknown error {code}");
	}
	// SAFETY: non-null, NUL-terminated, static.
	unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned()
}

/// Address family for `-4`/`-6`.
pub(super) fn family(af_hint: u8) -> i32 {
	match af_hint {
		4 => libc::AF_INET,
		6 => libc::AF_INET6,
		_ => libc::AF_UNSPEC,
	}
}

/// One resolved stream address.
pub(super) struct Addr {
	pub(super) family: i32,
	socktype:          i32,
	protocol:          i32,
	storage:           libc::sockaddr_storage,
	len:               libc::socklen_t,
}

impl Addr {
	fn as_ptr(&self) -> *const libc::sockaddr {
		(&raw const self.storage).cast()
	}
}

/// `getaddrinfo` for stream sockets; Err is the resolver's error code.
pub(super) fn resolve(
	host: Option<&str>,
	service: Option<&str>,
	family: i32,
	passive: bool,
) -> Result<Vec<Addr>, i32> {
	let host = host.map(CString::new).transpose().map_err(|_| EAI_NONAME)?;
	let service = service.map(CString::new).transpose().map_err(|_| EAI_NONAME)?;
	// SAFETY: an all-zero addrinfo is a valid "no hints" value.
	let mut hints: libc::addrinfo = unsafe { zeroed() };
	hints.ai_family = family;
	hints.ai_socktype = libc::SOCK_STREAM;
	if passive {
		hints.ai_flags = libc::AI_PASSIVE;
	}
	let mut list: *mut libc::addrinfo = std::ptr::null_mut();
	// SAFETY: the C strings and hints outlive the call; `list` receives an
	// allocation we free below.
	let rc = unsafe {
		libc::getaddrinfo(
			host.as_ref().map_or(std::ptr::null(), |h| h.as_ptr()),
			service.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
			&hints,
			&mut list,
		)
	};
	if rc != 0 {
		return Err(rc);
	}
	let mut out = Vec::new();
	let mut cur = list;
	while !cur.is_null() {
		// SAFETY: `cur` walks the list getaddrinfo returned, which stays valid
		// until freeaddrinfo.
		let ai = unsafe { &*cur };
		if !ai.ai_addr.is_null() {
			// SAFETY: zeroed storage is valid; we copy at most its size from a
			// sockaddr of `ai_addrlen` bytes.
			let mut storage: libc::sockaddr_storage = unsafe { zeroed() };
			let len = (ai.ai_addrlen as usize).min(size_of::<libc::sockaddr_storage>());
			unsafe {
				std::ptr::copy_nonoverlapping(
					ai.ai_addr.cast::<u8>(),
					(&raw mut storage).cast::<u8>(),
					len,
				);
			}
			out.push(Addr {
				family: ai.ai_family,
				socktype: ai.ai_socktype,
				protocol: ai.ai_protocol,
				storage,
				len: len as libc::socklen_t,
			});
		}
		cur = ai.ai_next;
	}
	// SAFETY: `list` came from a successful getaddrinfo.
	unsafe { libc::freeaddrinfo(list) };
	Ok(out)
}

/// The numeric form of an address (`getnameinfo(NI_NUMERICHOST)`).
pub(super) fn numeric_host(addr: &Addr) -> String {
	let mut buf = [0 as libc::c_char; 1025];
	// SAFETY: `addr` holds `len` valid bytes; `buf` is writable for its length.
	let rc = unsafe {
		libc::getnameinfo(
			addr.as_ptr(),
			addr.len,
			buf.as_mut_ptr(),
			buf.len() as libc::socklen_t,
			std::ptr::null_mut(),
			0,
			libc::NI_NUMERICHOST,
		)
	};
	if rc != 0 {
		return format!("*getnameinfo failure: {}*", gai_text(rc));
	}
	// SAFETY: getnameinfo NUL-terminated the buffer on success.
	unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

/// A socket being connected.
pub(super) struct Socket(OwnedFd);

impl Socket {
	/// A close-on-exec stream socket for `addr`'s family.
	pub(super) fn new(addr: &Addr) -> io::Result<Self> {
		// SAFETY: plain socket(2) call.
		let fd = unsafe { libc::socket(addr.family, addr.socktype, addr.protocol) };
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fd` is a fresh descriptor we own.
		let sock = Self(unsafe { OwnedFd::from_raw_fd(fd) });
		// SAFETY: valid fd.
		if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
			return Err(io::Error::last_os_error());
		}
		super::super::no_sigpipe(std::os::fd::AsFd::as_fd(&sock.0));
		Ok(sock)
	}

	pub(super) fn bind(&self, addr: &Addr) -> io::Result<()> {
		// SAFETY: valid fd and sockaddr of `len` bytes.
		if unsafe { libc::bind(self.0.as_raw_fd(), addr.as_ptr(), addr.len) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	/// `setsockopt` with an `int` value, as upstream passes every option.
	pub(super) fn set_int(&self, level: i32, name: i32, value: i32) -> io::Result<()> {
		let value: libc::c_int = value;
		// SAFETY: valid fd; `value` lives across the call with its size passed.
		let rc = unsafe {
			libc::setsockopt(
				self.0.as_raw_fd(),
				level,
				name,
				(&raw const value).cast(),
				size_of::<libc::c_int>() as libc::socklen_t,
			)
		};
		(rc >= 0).ok_or_else(io::Error::last_os_error)
	}

	fn set_nonblocking(&self, on: bool) -> io::Result<()> {
		let fd = self.0.as_raw_fd();
		// SAFETY: valid fd.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		if flags < 0 {
			return Err(io::Error::last_os_error());
		}
		let flags = if on { flags | libc::O_NONBLOCK } else { flags & !libc::O_NONBLOCK };
		// SAFETY: valid fd.
		if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	/// Starts a non-blocking connect: Ok(true) when already connected,
	/// Ok(false) when in progress.
	pub(super) fn start_connect(&self, addr: &Addr) -> io::Result<bool> {
		self.set_nonblocking(true)?;
		// SAFETY: valid fd and sockaddr of `len` bytes.
		if unsafe { libc::connect(self.0.as_raw_fd(), addr.as_ptr(), addr.len) } == 0 {
			return Ok(true);
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINPROGRESS | libc::EINTR) => Ok(false),
			_ => Err(err),
		}
	}

	/// Waits up to `timeout` for the pending connect to settle.
	pub(super) fn wait_writable(&self, timeout: Duration) -> io::Result<bool> {
		use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
		let mut fds = [PollFd::new(std::os::fd::AsFd::as_fd(&self.0), PollFlags::POLLOUT)];
		let ms = u16::try_from(timeout.as_millis()).unwrap_or(u16::MAX);
		match poll(&mut fds, PollTimeout::from(ms)) {
			Ok(n) => Ok(n > 0),
			Err(nix::errno::Errno::EINTR) => Ok(false),
			Err(err) => Err(io::Error::from(err)),
		}
	}

	/// The connect result (`SO_ERROR`).
	pub(super) fn take_error(&self) -> io::Result<Option<io::Error>> {
		let mut value: libc::c_int = 0;
		let mut len = size_of::<libc::c_int>() as libc::socklen_t;
		// SAFETY: valid fd; `value`/`len` are writable and sized.
		let rc = unsafe {
			libc::getsockopt(
				self.0.as_raw_fd(),
				libc::SOL_SOCKET,
				libc::SO_ERROR,
				(&raw mut value).cast(),
				&mut len,
			)
		};
		if rc < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok((value != 0).then(|| io::Error::from_raw_os_error(value)))
	}

	/// The connected socket as a blocking `TcpStream`.
	pub(super) fn into_stream(self) -> io::Result<TcpStream> {
		self.set_nonblocking(false)?;
		Ok(TcpStream::from(self.0))
	}
}
