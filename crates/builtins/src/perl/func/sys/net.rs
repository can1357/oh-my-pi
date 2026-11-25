//! Socket-backed filehandles and Perl's packed sockaddr API (perlfunc, perlipc).

use crate::perl::{ast::{Builtin, Call}, interp::{Interp, PResult, Ret}};

#[cfg(unix)]
use crate::perl::{interp::Flow, io::{Handle, Io, Layers}, value::{PStr, Value}};

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Ret> {
	#[cfg(unix)]
	{ unix::call(interp, b, call) }
	#[cfg(not(unix))]
	{ let _ = (b, super::list(interp, call)?); Ok(super::fail(interp, libc::ENOSYS)) }
}

#[cfg(unix)]
pub(in crate::perl) use self::unix::{pack_sockaddr, sockaddr_family};

#[cfg(unix)]
mod unix {
	use std::{io::{self, IoSliceMut}, net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddrV4, SocketAddrV6}, os::fd::{AsRawFd as _, OwnedFd}, time::{Duration, Instant}};

	use nix::{errno::Errno, poll::{PollFd, PollFlags, poll}, sys::socket::{MsgFlags, SockaddrStorage, recvmsg}};
	use socket2::{Domain, Protocol, SockAddr, SockRef, Socket, Type};

	use crate::openfile::OpenFile;

	use super::*;
	use crate::perl::func::sys::{READ_WRITE, args, bad_fd, fail, handles, one, path, result, scalar, tail, yes};

	pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Ret> {
		use Builtin as B;
		let es = args(call);
		let Some(e) = es.first() else { return Err(interp.die_msg(format!("Not enough arguments for {}", b.name()))); };
		if matches!(b, B::Socket | B::Socketpair) {
			let left = handles::slot(interp, e)?;
			let right = if b == B::Socketpair && let Some(expr) = es.get(1) { Some(handles::slot(interp, expr)?) } else { None };
			let args = tail(interp, es.get(if right.is_some() { 2 } else { 1 }..).unwrap_or_default())?;
			let arg = |i: usize| args.get(i).map_or(0, Value::to_i64) as i32;
			let domain = Domain::from(arg(0));
			let typ = Type::from(arg(1));
			let protocol = (arg(2) != 0).then(|| Protocol::from(arg(2)));
			if let Some(right) = right {
				let (a, b) = match Socket::pair(domain, typ, protocol) { Ok(pair) => pair, Err(e) => return Ok(super::super::errno(interp, &e)) };
				install(interp, &left.io, a);
				return Ok(install(interp, &right.io, b));
			}
			return Ok(match Socket::new(domain, typ, protocol) {
				Ok(socket) => install(interp, &left.io, socket), Err(e) => super::super::errno(interp, &e),
			});
		}
		if b == B::Accept {
			let out = handles::slot(interp, e)?;
			let Some(src) = es.get(1) else { return Err(interp.die_msg("Not enough arguments for accept")); };
			let Some(src) = handles::from_expr(interp, src)? else { return Ok(fail(interp, libc::EBADF)); };
			// Try once without blocking: a socket that is not listening fails at
			// once (EINVAL) instead of waiting for a connection that never comes.
			let attempt = with_socket(&src, |s| {
				let blocking = !s.nonblocking()?;
				if blocking { s.set_nonblocking(true)?; }
				let r = s.accept();
				if blocking { s.set_nonblocking(false)?; }
				// BSD accept() copies O_NONBLOCK to the new socket.
				r.and_then(|(socket, addr)| { if blocking { socket.set_nonblocking(false)?; } Ok((socket, addr)) })
			});
			let accepted = match attempt {
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					if !ready(interp, &src, false)? { return Ok(one(Value::Undef)); }
					with_socket(&src, Socket::accept)
				},
				r => r,
			};
			return Ok(match accepted {
				Ok((socket, addr)) => { install(interp, &out.io, socket); one(Value::Str(PStr::new(pack_sockaddr(&addr), false))) },
				Err(e) => super::super::errno(interp, &e),
			});
		}
		let Some(io) = handles::from_expr(interp, e)? else { return Ok(fail(interp, libc::EBADF)); };
		if b == B::Recv {
			let dest = es.get(1).ok_or_else(|| interp.die_msg("Not enough arguments for recv"))?;
			let dest = interp.eval_lvalue(dest)?;
			let n = scalar(interp, es.get(2))?.to_i64();
			let flags = scalar(interp, es.get(3))?.to_i64() as i32;
			if n < 0 { return Err(interp.die_msg("Negative length")); }
			if !ready(interp, &io, flags & libc::MSG_DONTWAIT != 0)? { return Ok(one(Value::Undef)); }
			let n = usize::try_from(n).map_err(|_| interp.die_msg("Out of memory!"))?;
			crate::perl::limits::check_len(n, "string").map_err(|e| interp.die_msg(e))?;
			// One recvmsg never returns more than a datagram or the socket's receive buffer.
			let n = n.min(RECV_MAX);
			let mut data = Vec::new();
			data.try_reserve_exact(n).map_err(|_| interp.die_msg("Out of memory!"))?;
			data.resize(n, 0);
			let r = io.borrow().with_fd(|fd| {
				let mut iov = [IoSliceMut::new(&mut data)];
				let msg = recvmsg::<SockaddrStorage>(fd.as_raw_fd(), &mut iov, None, MsgFlags::from_bits_retain(flags)).map_err(os_error)?;
				Ok((msg.bytes, msg.address))
			});
			return match r {
				Ok((n, addr)) => {
					data.truncate(n);
					interp.write_sv(&dest, Value::Str(PStr::new(data, false)))?;
					Ok(one(Value::Str(PStr::new(addr.as_ref().map_or_else(Vec::new, pack_recv), false))))
				},
				Err(e) => Ok(super::super::errno(interp, &e)),
			};
		}
		let args = tail(interp, &es[1..])?;
		let v = |i: usize| args.get(i).unwrap_or(&Value::Undef);
		let n = |i| v(i).to_i64() as i32;
		let r = match b {
			B::Bind => {
				let s = interp.stringify(v(0))?;
				unpack(interp, &s.bytes).and_then(|addr| with_socket(&io, |s| s.bind(&addr))).map(|()| yes())
			},
			B::Connect => {
				let s = interp.stringify(v(0))?;
				match unpack(interp, &s.bytes) {
					Ok(addr) => connect(interp, &io, &addr)?.map(|()| yes()),
					Err(e) => Err(e),
				}
			},
			B::Listen => with_socket(&io, |s| s.listen(n(0))).map(|()| yes()),
			B::Shutdown => {
				let direction = match n(0) { 0 => Shutdown::Read, 1 => Shutdown::Write, 2 => Shutdown::Both, _ => return Ok(fail(interp, libc::EINVAL)) };
				with_socket(&io, |s| s.shutdown(direction)).map(|()| yes())
			},
			B::Getsockname | B::Getpeername => with_socket(&io, |s| {
				if b == B::Getsockname { s.local_addr() } else { s.peer_addr() }
			}).map(|addr| one(Value::Str(PStr::new(pack_sockaddr(&addr), false)))),
			B::Send => {
				let data = interp.stringify(v(0))?;
				let data = if data.utf8 {
					data.downgraded().ok_or_else(|| interp.die_msg("Wide character in send"))?
				} else { data.bytes };
				let flags = n(1);
				#[cfg(any(target_os = "linux", target_os = "android"))]
				let flags = flags | libc::MSG_NOSIGNAL;
				let sent = if args.len() < 3 || v(2).is_undef() {
					with_socket(&io, |s| s.send_with_flags(&data, flags))
				} else {
					let addr = interp.stringify(v(2))?;
					unpack(interp, &addr.bytes).and_then(|addr| with_socket(&io, |s| s.send_to_with_flags(&data, &addr, flags)))
				};
				sent.map(|n| one(Value::Int(n as i64)))
			},
			B::Getsockopt => with_socket(&io, |s| get_option(s, n(0), n(1))).map(|bytes| one(Value::Str(PStr::new(bytes, false)))),
			B::Setsockopt => {
				let arg = v(2);
				let bytes = if matches!(arg, Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_)) {
					(arg.to_i64() as i32).to_ne_bytes().to_vec()
				} else { interp.stringify(arg)?.bytes };
				with_socket(&io, |s| set_option(s, n(0), n(1), &bytes)).map(|()| yes())
			},
			_ => Err(bad_fd()),
		};
		Ok(result(interp, r, |v| v))
	}

	/// `connect` without parking in the kernel: a blocking socket connects in non-blocking mode and
	/// waits for completion in short polls that observe cancellation and `alarm` (EINTR when a
	/// handler returns, as an interrupted connect(2)). The socket's blocking mode is restored.
	fn connect(interp: &mut Interp<'_>, io: &Io, addr: &SockAddr) -> PResult<io::Result<()>> {
		let blocking = match with_socket(io, |s| {
			let blocking = !s.nonblocking()?;
			if blocking { s.set_nonblocking(true)?; }
			Ok(blocking)
		}) { Ok(b) => b, Err(e) => return Ok(Err(e)) };
		if !blocking { return Ok(with_socket(io, |s| s.connect(addr))); }
		let outcome = connect_nonblocking(interp, io, addr);
		let restored = with_socket(io, |s| s.set_nonblocking(false));
		match outcome {
			Ok(Ok(())) => Ok(restored),
			other => other,
		}
	}

	fn connect_nonblocking(interp: &mut Interp<'_>, io: &Io, addr: &SockAddr) -> PResult<io::Result<()>> {
		loop {
			match with_socket(io, |s| s.connect(addr)) {
				Ok(()) => return Ok(Ok(())),
				Err(e) if e.raw_os_error() == Some(libc::EINPROGRESS) => break,
				// AF_UNIX with a full backlog: a blocking connect would wait for room, so retry.
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					if interp.is_cancelled() { return Err(Flow::Cancelled); }
					if interp.poll_alarm()? { return Ok(Err(io::Error::from_raw_os_error(libc::EINTR))); }
					std::thread::sleep(Duration::from_millis(10));
				},
				Err(e) => return Ok(Err(e)),
			}
		}
		loop {
			if interp.is_cancelled() { return Err(Flow::Cancelled); }
			if interp.poll_alarm()? { return Ok(Err(io::Error::from_raw_os_error(libc::EINTR))); }
			let ready = io.borrow().with_fd(|fd| poll(&mut [PollFd::new(fd, PollFlags::POLLOUT)], 30u16).map_err(os_error));
			match ready {
				Ok(0) => {},
				Ok(_) => break,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) => return Ok(Err(e)),
			}
		}
		Ok(match with_socket(io, Socket::take_error) {
			Ok(None) => Ok(()),
			Ok(Some(e)) | Err(e) => Err(e),
		})
	}

	/// Largest buffer one `recv` zero-fills: above any datagram and typical socket receive buffers.
	const RECV_MAX: usize = 16 << 20;

	fn with_socket<T>(io: &Io, op: impl FnOnce(&Socket) -> io::Result<T>) -> io::Result<T> {
		io.borrow().with_fd(|fd| op(&SockRef::from(&fd)))
	}

	fn install(interp: &mut Interp<'_>, io: &Io, socket: Socket) -> Ret {
		let fd: OwnedFd = socket.into();
		let file = OpenFile::from(std::fs::File::from(fd));
		let h = Handle::from_descriptor(interp.host(), file, READ_WRITE, Layers::default());
		handles::replace(interp, io, h)
	}

	fn ready(interp: &mut Interp<'_>, io: &Io, nonblocking: bool) -> PResult<bool> {
		if nonblocking { return Ok(true); }
		let options = with_socket(io, |s| Ok((s.nonblocking()?, s.read_timeout()?)));
		let timeout = match options {
			Ok((true, _)) => return Ok(true),
			Ok((false, timeout)) => timeout,
			Err(e) => { interp.set_errno(&e); return Ok(false); },
		};
		let started = Instant::now();
		loop {
			if interp.is_cancelled() { return Err(Flow::Cancelled); }
			if interp.poll_alarm()? { interp.set_errno_code(libc::EINTR); return Ok(false); }
			let sleep = timeout.map_or(Duration::MAX, |t| t.saturating_sub(started.elapsed()));
			if sleep.is_zero() { interp.set_errno_code(libc::EAGAIN); return Ok(false); }
			let millis = sleep.as_millis().clamp(1, 30) as u16;
			let ready = io.borrow().with_fd(|fd| poll(&mut [PollFd::new(fd, PollFlags::POLLIN)], millis).map_err(os_error));
			match ready {
				Ok(0) => {},
				Ok(_) => return Ok(true),
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) => { interp.set_errno(&e); return Ok(false); },
			}
		}
	}

	fn os_error(e: Errno) -> io::Error { io::Error::from_raw_os_error(e as i32) }
	fn invalid() -> io::Error { io::Error::from_raw_os_error(libc::EINVAL) }
	fn unsupported_option() -> io::Error { io::Error::from_raw_os_error(libc::ENOPROTOOPT) }

	const BSD_SOCKADDR: bool = cfg!(any(target_vendor = "apple", target_os = "freebsd", target_os = "dragonfly", target_os = "netbsd", target_os = "openbsd"));

	/// The address family of a packed sockaddr (the platform's `sa_family` layout).
	pub(in crate::perl) fn sockaddr_family(bytes: &[u8]) -> Option<i32> {
		if BSD_SOCKADDR { bytes.get(1).map(|&b| i32::from(b)) }
		else { take::<2>(bytes, 0).ok().map(|b| i32::from(u16::from_ne_bytes(b))) }
	}

	fn unpack(interp: &mut Interp<'_>, bytes: &[u8]) -> io::Result<SockAddr> {
		let family = sockaddr_family(bytes).ok_or_else(invalid)?;
		match family {
			libc::AF_INET => Ok(SocketAddrV4::new(Ipv4Addr::from(take::<4>(bytes, 4)?), u16::from_be_bytes(take(bytes, 2)?)).into()),
			libc::AF_INET6 => Ok(SocketAddrV6::new(Ipv6Addr::from(take::<16>(bytes, 8)?), u16::from_be_bytes(take(bytes, 2)?),
				u32::from_be_bytes(take(bytes, 4)?), u32::from_ne_bytes(take(bytes, 24)?)).into()),
			libc::AF_UNIX => {
				let path_bytes = bytes.get(2..).ok_or_else(invalid)?;
				#[cfg(any(target_os = "linux", target_os = "android"))]
				if path_bytes.first() == Some(&0) && path_bytes.len() > 1 {
					return SockAddr::unix(&*super::super::os_str(path_bytes));
				}
				let name = path_bytes.split(|&b| b == 0).next().unwrap_or_default();
				if name.is_empty() { return SockAddr::unix(""); }
				let path = path(interp, name)?;
				if !interp.host().fs().is_native_local(&path) { return Err(io::Error::from_raw_os_error(libc::EOPNOTSUPP)); }
				SockAddr::unix(path)
			},
			_ => Err(io::Error::from_raw_os_error(libc::EAFNOSUPPORT)),
		}
	}

	fn take<const N: usize>(bytes: &[u8], at: usize) -> io::Result<[u8; N]> {
		bytes.get(at..at + N).and_then(|b| b.try_into().ok()).ok_or_else(invalid)
	}

	fn header(family: i32, n: usize) -> Vec<u8> {
		let mut bytes = vec![0; n.max(2)];
		if BSD_SOCKADDR { bytes[..2].copy_from_slice(&[n as u8, family as u8]); }
		else { bytes[..2].copy_from_slice(&(family as u16).to_ne_bytes()); }
		bytes
	}

	/// Perl's packed form of a socket address, as `getsockname` returns it.
	pub(in crate::perl) fn pack_sockaddr(addr: &SockAddr) -> Vec<u8> {
		if let Some(a) = addr.as_socket_ipv4() { return v4(*a.ip(), a.port()); }
		if let Some(a) = addr.as_socket_ipv6() { return v6(*a.ip(), a.port(), a.flowinfo(), a.scope_id()); }
		let n = addr.len() as usize;
		let mut bytes = header(i32::from(addr.family()), n);
		if let Some(path) = addr.as_pathname() { copy_path(&mut bytes, path.as_os_str().as_encoded_bytes(), 2); }
		#[cfg(any(target_os = "linux", target_os = "android"))]
		if let Some(path) = addr.as_abstract_namespace() { copy_path(&mut bytes, path, 3); }
		bytes
	}

	fn pack_recv(addr: &SockaddrStorage) -> Vec<u8> {
		if let Some(a) = addr.as_sockaddr_in() { return v4(a.ip(), a.port()); }
		if let Some(a) = addr.as_sockaddr_in6() { return v6(a.ip(), a.port(), a.flowinfo(), a.scope_id()); }
		if let Some(a) = addr.as_unix_addr() {
			let mut bytes = header(libc::AF_UNIX, a.path_len() + 2);
			if let Some(path) = a.path() { copy_path(&mut bytes, path.as_os_str().as_encoded_bytes(), 2); }
			#[cfg(any(target_os = "linux", target_os = "android"))]
			if let Some(path) = a.as_abstract() { copy_path(&mut bytes, path, 3); }
			return bytes;
		}
		Vec::new()
	}

	fn copy_path(dst: &mut [u8], src: &[u8], start: usize) {
		if let Some(dst) = dst.get_mut(start..) { let n = dst.len().min(src.len()); dst[..n].copy_from_slice(&src[..n]); }
	}

	fn v4(ip: Ipv4Addr, port: u16) -> Vec<u8> {
		let mut bytes = header(libc::AF_INET, 16);
		bytes[2..4].copy_from_slice(&port.to_be_bytes());
		bytes[4..8].copy_from_slice(&ip.octets());
		bytes
	}

	fn v6(ip: Ipv6Addr, port: u16, flow: u32, scope: u32) -> Vec<u8> {
		let mut bytes = header(libc::AF_INET6, 28);
		bytes[2..4].copy_from_slice(&port.to_be_bytes());
		bytes[4..8].copy_from_slice(&flow.to_be_bytes());
		bytes[8..24].copy_from_slice(&ip.octets());
		bytes[24..28].copy_from_slice(&scope.to_ne_bytes());
		bytes
	}

	fn get_option(s: &Socket, level: i32, name: i32) -> io::Result<Vec<u8>> {
		use libc::*;
		let d = match (level, name) {
			(SOL_SOCKET, SO_TYPE) => s.r#type().map(i32::from),
			(SOL_SOCKET, SO_ERROR) => s.take_error().map(|e| e.and_then(|e| e.raw_os_error()).unwrap_or(0)),
			(SOL_SOCKET, SO_REUSEADDR) => s.reuse_address().map(i32::from),
			(SOL_SOCKET, SO_REUSEPORT) => s.reuse_port().map(i32::from),
			(SOL_SOCKET, SO_BROADCAST) => s.broadcast().map(i32::from),
			(SOL_SOCKET, SO_OOBINLINE) => s.out_of_band_inline().map(i32::from),
			(SOL_SOCKET, SO_KEEPALIVE) => s.keepalive().map(i32::from),
			(SOL_SOCKET, SO_ACCEPTCONN) => nix::sys::socket::getsockopt(s, nix::sys::socket::sockopt::AcceptConn)
				.map(i32::from).map_err(os_error),
			(SOL_SOCKET, SO_SNDBUF) => s.send_buffer_size().map(|n| n as i32),
			(SOL_SOCKET, SO_RCVBUF) => s.recv_buffer_size().map(|n| n as i32),
			(SOL_SOCKET, SO_LINGER) => {
				let duration = s.linger()?;
				return Ok([i32::from(duration.is_some()).to_ne_bytes(), (duration.map_or(0, |d| d.as_secs()) as i32).to_ne_bytes()].concat());
			},
			(SOL_SOCKET, SO_RCVTIMEO) => return s.read_timeout().map(pack_time),
			(SOL_SOCKET, SO_SNDTIMEO) => return s.write_timeout().map(pack_time),
			(IPPROTO_IP, IP_TTL) => s.ttl_v4().map(|n| n as i32),
			(IPPROTO_IP, IP_TOS) => s.tos_v4().map(|n| n as i32),
			(IPPROTO_IPV6, IPV6_V6ONLY) => s.only_v6().map(i32::from),
			(IPPROTO_TCP, TCP_NODELAY) => s.tcp_nodelay().map(i32::from),
			_ => Err(unsupported_option()),
		}?;
		Ok(d.to_ne_bytes().to_vec())
	}

	fn set_option(s: &Socket, level: i32, name: i32, bytes: &[u8]) -> io::Result<()> {
		use libc::*;
		if level == SOL_SOCKET {
			match name {
				SO_LINGER => {
					let on = i32::from_ne_bytes(take(bytes, 0)?) != 0;
					let sec = i32::from_ne_bytes(take(bytes, 4)?);
					if sec < 0 { return Err(invalid()); }
					return s.set_linger(on.then(|| Duration::from_secs(sec as u64)));
				},
				SO_RCVTIMEO => return s.set_read_timeout(unpack_time(bytes)?),
				SO_SNDTIMEO => return s.set_write_timeout(unpack_time(bytes)?),
				_ => {},
			}
		}
		let n = i32::from_ne_bytes(take(bytes, 0)?);
		let on = n != 0;
		match (level, name) {
			(SOL_SOCKET, SO_REUSEADDR) => s.set_reuse_address(on),
			(SOL_SOCKET, SO_REUSEPORT) => s.set_reuse_port(on),
			(SOL_SOCKET, SO_BROADCAST) => s.set_broadcast(on),
			(SOL_SOCKET, SO_OOBINLINE) => s.set_out_of_band_inline(on),
			(SOL_SOCKET, SO_KEEPALIVE) => s.set_keepalive(on),
			(SOL_SOCKET, SO_SNDBUF) if n >= 0 => s.set_send_buffer_size(n as usize),
			(SOL_SOCKET, SO_RCVBUF) if n >= 0 => s.set_recv_buffer_size(n as usize),
			(IPPROTO_IP, IP_TTL) => s.set_ttl_v4(n as u32),
			(IPPROTO_IP, IP_TOS) => s.set_tos_v4(n as u32),
			(IPPROTO_IPV6, IPV6_V6ONLY) => s.set_only_v6(on),
			(IPPROTO_TCP, TCP_NODELAY) => s.set_tcp_nodelay(on),
			_ => Err(unsupported_option()),
		}
	}

	fn pack_time(time: Option<Duration>) -> Vec<u8> {
		let d = time.unwrap_or_default();
		let mut bytes = vec![0; size_of::<libc::timeval>()];
		let sec = (d.as_secs() as libc::time_t).to_ne_bytes();
		let usec = (d.subsec_micros() as libc::suseconds_t).to_ne_bytes();
		bytes[..sec.len()].copy_from_slice(&sec);
		bytes[sec.len()..sec.len() + usec.len()].copy_from_slice(&usec);
		bytes
	}

	fn unpack_time(bytes: &[u8]) -> io::Result<Option<Duration>> {
		let sec = libc::time_t::from_ne_bytes(take(bytes, 0)?);
		let usec = libc::suseconds_t::from_ne_bytes(take(bytes, size_of::<libc::time_t>())?);
		if sec < 0 || !(0..1_000_000).contains(&usec) { return Err(invalid()); }
		let duration = Duration::new(sec as u64, usec as u32 * 1_000);
		Ok((!duration.is_zero()).then_some(duration))
	}
}
