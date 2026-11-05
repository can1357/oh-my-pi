//! WinSock counterparts of the raw socket operations the daemon connect
//! needs: resolver, bind before connect, integer socket options, and a
//! non-blocking connect.

use std::{
	ffi::CString,
	io,
	mem::zeroed,
	net::TcpStream,
	os::windows::io::FromRawSocket,
	sync::Once,
	time::Duration,
};

use windows_sys::Win32::Networking::WinSock as ws;

/// `WSAHOST_NOT_FOUND`, the resolver's "unknown host" code.
pub(super) const EAI_NONAME: i32 = 11001;

/// Socket option levels and names for `--sockopts`.
pub(super) mod opt {
	use windows_sys::Win32::Networking::WinSock as ws;
	pub(crate) const SOL_SOCKET: i32 = ws::SOL_SOCKET;
	pub(crate) const IPPROTO_TCP: i32 = ws::IPPROTO_TCP;
	pub(crate) const IPPROTO_IP: i32 = ws::IPPROTO_IP;
	pub(crate) const SO_KEEPALIVE: i32 = ws::SO_KEEPALIVE;
	pub(crate) const SO_REUSEADDR: i32 = ws::SO_REUSEADDR;
	pub(crate) const SO_BROADCAST: i32 = ws::SO_BROADCAST;
	pub(crate) const TCP_NODELAY: i32 = ws::TCP_NODELAY;
	pub(crate) const IP_TOS: i32 = ws::IP_TOS;
	pub(crate) const SO_SNDBUF: i32 = ws::SO_SNDBUF;
	pub(crate) const SO_RCVBUF: i32 = ws::SO_RCVBUF;
	pub(crate) const SO_SNDLOWAT: i32 = ws::SO_SNDLOWAT;
	pub(crate) const SO_RCVLOWAT: i32 = ws::SO_RCVLOWAT;
	pub(crate) const SO_SNDTIMEO: i32 = ws::SO_SNDTIMEO;
	pub(crate) const SO_RCVTIMEO: i32 = ws::SO_RCVTIMEO;
}

/// WinSock must be started before the first resolver or socket call; std
/// only does so lazily from its own networking calls.
fn startup() {
	static START: Once = Once::new();
	START.call_once(|| {
		// SAFETY: WSADATA is plain data; WSAStartup fills it. The matching
		// WSACleanup is intentionally never called (process lifetime).
		let mut data: ws::WSADATA = unsafe { zeroed() };
		unsafe { ws::WSAStartup(0x202, &mut data) };
	});
}

/// The system message for a WinSock error code.
pub(super) fn gai_text(code: i32) -> String {
	crate::host::strip_errno(&io::Error::from_raw_os_error(code))
}

/// Address family for `-4`/`-6`.
pub(super) fn family(af_hint: u8) -> i32 {
	i32::from(match af_hint {
		4 => ws::AF_INET,
		6 => ws::AF_INET6,
		_ => ws::AF_UNSPEC,
	})
}

/// One resolved stream address.
pub(super) struct Addr {
	pub(super) family: i32,
	socktype:          i32,
	protocol:          i32,
	storage:           ws::SOCKADDR_STORAGE,
	len:               i32,
}

impl Addr {
	fn as_ptr(&self) -> *const ws::SOCKADDR {
		(&raw const self.storage).cast()
	}
}

fn last_error() -> io::Error {
	// SAFETY: plain thread-local error query.
	io::Error::from_raw_os_error(unsafe { ws::WSAGetLastError() })
}

/// `getaddrinfo` for stream sockets; Err is the resolver's error code.
pub(super) fn resolve(
	host: Option<&str>,
	service: Option<&str>,
	family: i32,
	passive: bool,
) -> Result<Vec<Addr>, i32> {
	startup();
	let host = host.map(CString::new).transpose().map_err(|_| EAI_NONAME)?;
	let service = service.map(CString::new).transpose().map_err(|_| EAI_NONAME)?;
	// SAFETY: an all-zero ADDRINFOA is a valid "no hints" value.
	let mut hints: ws::ADDRINFOA = unsafe { zeroed() };
	hints.ai_family = family;
	hints.ai_socktype = ws::SOCK_STREAM;
	if passive {
		hints.ai_flags = ws::AI_PASSIVE as i32;
	}
	let mut list: *mut ws::ADDRINFOA = std::ptr::null_mut();
	// SAFETY: the C strings and hints outlive the call; `list` is freed below.
	let rc = unsafe {
		ws::getaddrinfo(
			host.as_ref().map_or(std::ptr::null(), |h| h.as_ptr().cast()),
			service.as_ref().map_or(std::ptr::null(), |s| s.as_ptr().cast()),
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
		// SAFETY: walking the list getaddrinfo returned, valid until freed.
		let ai = unsafe { &*cur };
		if !ai.ai_addr.is_null() {
			// SAFETY: zeroed storage is valid; at most its size is copied.
			let mut storage: ws::SOCKADDR_STORAGE = unsafe { zeroed() };
			let len = ai.ai_addrlen.min(size_of::<ws::SOCKADDR_STORAGE>());
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
				len: len as i32,
			});
		}
		cur = ai.ai_next;
	}
	// SAFETY: `list` came from a successful getaddrinfo.
	unsafe { ws::freeaddrinfo(list) };
	Ok(out)
}

/// The numeric form of an address (`getnameinfo(NI_NUMERICHOST)`).
pub(super) fn numeric_host(addr: &Addr) -> String {
	let mut buf = [0u8; 1025];
	// SAFETY: `addr` holds `len` valid bytes; `buf` is writable for its length.
	let rc = unsafe {
		ws::getnameinfo(
			addr.as_ptr(),
			addr.len,
			buf.as_mut_ptr(),
			buf.len() as u32,
			std::ptr::null_mut(),
			0,
			ws::NI_NUMERICHOST as i32,
		)
	};
	if rc != 0 {
		return format!("*getnameinfo failure: {}*", gai_text(rc));
	}
	let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
	String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// A socket being connected (closed on drop unless converted).
pub(super) struct Socket(Option<ws::SOCKET>);

impl Drop for Socket {
	fn drop(&mut self) {
		if let Some(sock) = self.0.take() {
			// SAFETY: we own the socket.
			unsafe { ws::closesocket(sock) };
		}
	}
}

impl Socket {
	fn raw(&self) -> ws::SOCKET {
		self.0.unwrap_or(ws::INVALID_SOCKET)
	}

	/// A non-inheritable stream socket for `addr`'s family.
	pub(super) fn new(addr: &Addr) -> io::Result<Self> {
		startup();
		// SAFETY: plain WSASocketW call with no protocol info.
		let sock = unsafe {
			ws::WSASocketW(
				addr.family,
				addr.socktype,
				addr.protocol,
				std::ptr::null(),
				0,
				ws::WSA_FLAG_OVERLAPPED | ws::WSA_FLAG_NO_HANDLE_INHERIT,
			)
		};
		if sock == ws::INVALID_SOCKET {
			return Err(last_error());
		}
		Ok(Self(Some(sock)))
	}

	pub(super) fn bind(&self, addr: &Addr) -> io::Result<()> {
		// SAFETY: valid socket and sockaddr of `len` bytes.
		if unsafe { ws::bind(self.raw(), addr.as_ptr(), addr.len) } == ws::SOCKET_ERROR {
			return Err(last_error());
		}
		Ok(())
	}

	/// `setsockopt` with an `int` value, as upstream passes every option.
	pub(super) fn set_int(&self, level: i32, name: i32, value: i32) -> io::Result<()> {
		// SAFETY: valid socket; `value` lives across the call with its size passed.
		let rc = unsafe {
			ws::setsockopt(
				self.raw(),
				level,
				name,
				(&raw const value).cast(),
				size_of::<i32>() as i32,
			)
		};
		(rc != ws::SOCKET_ERROR).ok_or_else(last_error)
	}

	fn set_nonblocking(&self, on: bool) -> io::Result<()> {
		let mut mode: u32 = u32::from(on);
		// SAFETY: valid socket; `mode` is writable.
		if unsafe { ws::ioctlsocket(self.raw(), ws::FIONBIO, &mut mode) } == ws::SOCKET_ERROR {
			return Err(last_error());
		}
		Ok(())
	}

	/// Starts a non-blocking connect: Ok(true) when already connected,
	/// Ok(false) when in progress.
	pub(super) fn start_connect(&self, addr: &Addr) -> io::Result<bool> {
		self.set_nonblocking(true)?;
		// SAFETY: valid socket and sockaddr of `len` bytes.
		if unsafe { ws::connect(self.raw(), addr.as_ptr(), addr.len) } == 0 {
			return Ok(true);
		}
		let err = last_error();
		match err.raw_os_error() {
			Some(ws::WSAEWOULDBLOCK | ws::WSAEINPROGRESS) => Ok(false),
			_ => Err(err),
		}
	}

	/// Waits up to `timeout` for the pending connect to settle.
	pub(super) fn wait_writable(&self, timeout: Duration) -> io::Result<bool> {
		let mut fd = ws::WSAPOLLFD { fd: self.raw(), events: ws::POLLWRNORM, revents: 0 };
		let ms = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
		// SAFETY: one initialised WSAPOLLFD outliving the call.
		let n = unsafe { ws::WSAPoll(&mut fd, 1, ms) };
		if n == ws::SOCKET_ERROR { Err(last_error()) } else { Ok(n > 0) }
	}

	/// The connect result (`SO_ERROR`).
	pub(super) fn take_error(&self) -> io::Result<Option<io::Error>> {
		let mut value: i32 = 0;
		let mut len = size_of::<i32>() as i32;
		// SAFETY: valid socket; `value`/`len` are writable and sized.
		let rc = unsafe {
			ws::getsockopt(self.raw(), ws::SOL_SOCKET, ws::SO_ERROR, (&raw mut value).cast(), &mut len)
		};
		if rc == ws::SOCKET_ERROR {
			return Err(last_error());
		}
		Ok((value != 0).then(|| io::Error::from_raw_os_error(value)))
	}

	/// The connected socket as a blocking `TcpStream`.
	pub(super) fn into_stream(mut self) -> io::Result<TcpStream> {
		self.set_nonblocking(false)?;
		let sock = self.0.take().unwrap_or(ws::INVALID_SOCKET);
		// SAFETY: we own `sock`, a connected stream socket, and hand it over.
		Ok(unsafe { TcpStream::from_raw_socket(sock as std::os::windows::io::RawSocket) })
	}
}
