//! zsh/net/tcp: `ztcp`, TCP connections, listeners and accepted
//! connections on shell fds, and their session table (`ztcp_sessions`,
//! kept in the store as [`MiscKey::ZshTcpSessions`], also used by
//! zsh/zftp for its control connection).
//!
//! Ported from zsh 5.9 `Src/Modules/tcp.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group; tcp.c
//! Copyright (c) 1998-2001 Peter Stephenson).

use std::{
	io,
	net::{IpAddr, Ipv4Addr, SocketAddr},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::{Ops, zerr},
	zsh_mod_socket::{install, pending_connection},
	zsh_mod_system::{atoi, errmsg, fd_probe, set_errno, setiparam},
};
use crate::bash::{
	socket::{IpFamily, ListenStage, SockAddr},
	store::{Key, KeyBuf, MiscKey, Record},
	vm::{
		fdprobe::{FdAnswer, FdProbe, FdSlot},
		fsprobe::FsErr,
	},
};

/// What a tcp session is (zsh `ZTCP_*` flags).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKind {
	/// `ZTCP_LISTEN`: a listener (`ztcp -l`).
	Listen,
	/// `ZTCP_INBOUND`: an accepted connection (`ztcp -a`).
	Inbound,
	/// An outbound connection (`ztcp host port`).
	Outbound,
	/// `ZTCP_ZFTP`: zsh/zftp's control connection.
	Zftp,
}

impl SessionKind {
	/// The `ztcp -L` type letter.
	const fn letter(self) -> u8 {
		match self {
			Self::Listen => b'L',
			Self::Inbound => b'I',
			Self::Outbound => b'O',
			Self::Zftp => b'Z',
		}
	}

	const fn from_letter(c: u8) -> Option<Self> {
		Some(match c {
			b'L' => Self::Listen,
			b'I' => Self::Inbound,
			b'O' => Self::Outbound,
			b'Z' => Self::Zftp,
			_ => return None,
		})
	}
}

/// One `ztcp_sessions` entry (zsh `struct tcp_session`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
	/// The shell fd.
	pub fd:    i32,
	/// What it is.
	pub kind:  SessionKind,
	/// `sess->sock`: the bound address (a listener's; zeros otherwise, as
	/// zsh never fills it for a connection).
	pub local: SocketAddr,
	/// `sess->peer`: the peer (zeros for a listener).
	pub peer:  SocketAddr,
}

/// `0.0.0.0:0`.
const ZERO: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);

impl Session {
	fn encode(&self) -> BString {
		BString::from(format!(
			"{} {} {} {} {} {}",
			self.fd,
			char::from(self.kind.letter()),
			self.local.ip(),
			self.local.port(),
			self.peer.ip(),
			self.peer.port()
		))
	}

	fn decode(word: &[u8]) -> Option<Self> {
		let text = word.to_str().ok()?;
		let mut f = text.split(' ');
		let fd = f.next()?.parse().ok()?;
		let kind = SessionKind::from_letter(*f.next()?.as_bytes().first()?)?;
		let lip: IpAddr = f.next()?.parse().ok()?;
		let lport = f.next()?.parse().ok()?;
		let pip: IpAddr = f.next()?.parse().ok()?;
		let pport = f.next()?.parse().ok()?;
		Some(Self { fd, kind, local: SocketAddr::new(lip, lport), peer: SocketAddr::new(pip, pport) })
	}
}

/// The session table as the builtin's vproc sees it, in creation order.
///
/// # Errors
/// [`super::Need::Store`] when the store fails.
pub fn sessions(ctx: &mut Ctx<'_, '_>) -> Result<Vec<Session>, super::Need> {
	Ok(match ctx.record(Key::Misc(MiscKey::ZshTcpSessions))? {
		Some(Record::Words(w)) => w.iter().filter_map(|e| Session::decode(e)).collect(),
		_ => Vec::new(),
	})
}

/// Store the session table.
pub fn store_sessions(ctx: &mut Ctx<'_, '_>, list: &[Session]) {
	let rec = (!list.is_empty()).then(|| Record::Words(list.iter().map(Session::encode).collect()));
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshTcpSessions), rec);
}

/// zsh `zts_alloc` + filling: append `s` to the table.
///
/// # Errors
/// [`super::Need::Store`] when the store fails.
pub fn add_session(ctx: &mut Ctx<'_, '_>, s: Session) -> Result<(), super::Need> {
	let mut list = sessions(ctx)?;
	list.push(s);
	store_sessions(ctx, &list);
	Ok(())
}

/// zsh `tcp_close`: close the session's fd and drop it from the table.
///
/// # Errors
/// [`super::Need::Store`] when the store fails.
pub fn close_session(ctx: &mut Ctx<'_, '_>, fd: i32) -> Result<(), super::Need> {
	let mut list = sessions(ctx)?;
	if let Some(at) = list.iter().position(|s| s.fd == fd) {
		list.remove(at);
		ctx.vp.fds.set(fd, None);
		store_sessions(ctx, &list);
	}
	Ok(())
}

/// zsh `tcp_cleanup`: close every session (`ztcp -c`, unloading the
/// module).
///
/// # Errors
/// [`super::Need::Store`] when the store fails.
pub fn cleanup(ctx: &mut Ctx<'_, '_>) -> Result<(), super::Need> {
	for s in sessions(ctx)? {
		ctx.vp.fds.set(s.fd, None);
	}
	store_sessions(ctx, &[]);
	Ok(())
}

/// A TCP port argument: a `/etc/services` name, else a number (zsh
/// `getservbyname`, else `htons(atoi(arg))`), in host byte order.
fn port_of(ctx: &mut Ctx<'_, '_>, arg: &[u8]) -> u16 {
	if let Some(s) = ctx.cx.host.sockets()
		&& let Some(p) = s.service_port(BStr::new(arg))
	{
		return p;
	}
	atoi(arg) as u16
}

/// The fd `-d` asks for, or where a new descriptor goes (`socket(2)`'s
/// lowest free fd).
const fn slot(targetfd: i32) -> FdSlot {
	if targetfd != 0 {
		FdSlot::At(targetfd)
	} else {
		FdSlot::Free(0)
	}
}

/// zsh `bin_ztcp`.
pub fn ztcp(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let force = ops.isset(b'f');
	let verbose = ops.isset(b'v');
	let test = ops.isset(b't');
	let mut targetfd = 0;
	if let Some(d) = ops.arg(b'd').map(<[u8]>::to_vec) {
		targetfd = atoi(&d);
		if targetfd == 0 {
			ctx.usage(format!("{} is an invalid argument to -d", BStr::new(&d)));
			return done(1);
		}
	}
	if ops.isset(b'c') {
		let Some(arg) = args.first() else {
			cleanup(ctx)?;
			return done(0);
		};
		let fd = atoi(arg);
		let sess = sessions(ctx)?.into_iter().find(|s| s.fd == fd);
		if fd == 0 {
			ctx.usage(format!("{} is an invalid argument to -c", arg.as_bstr()));
			return done(1);
		}
		let Some(sess) = sess else {
			ctx.usage(format!("fd {} not found in tcp table", arg.as_bstr()));
			return done(1);
		};
		if sess.kind == SessionKind::Zftp && !force {
			ctx.usage("use -f to force closure of a zftp control connection");
			return done(1);
		}
		close_session(ctx, fd)?;
		return done(0);
	}
	if ops.isset(b'l') {
		let Some(arg) = args.first().cloned() else {
			ctx.usage("-l requires an argument");
			return done(1);
		};
		let port = port_of(ctx, &arg);
		if port == 0 {
			ctx.usage("bad service name or port number");
			return done(1);
		}
		let local = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
		let listened = match ctx.cx.host.sockets() {
			Some(s) => s.listen(&SockAddr::Inet(local), 1),
			None => Err(crate::bash::socket::ListenError {
				stage: ListenStage::Socket,
				error: io::ErrorKind::Unsupported.into(),
			}),
		};
		let file = match listened {
			Ok(f) => f,
			Err(e) => {
				let fe = FsErr::of(&e.error);
				set_errno(ctx, &fe);
				// zsh does not check `socket(2)`: its failure shows as the
				// bind's.
				let msg = match e.stage {
					ListenStage::Socket | ListenStage::Bind => {
						format!("could not bind to port {port}: {}", errmsg(&fe))
					},
					ListenStage::Listen => format!("could not listen on socket: {}", errmsg(&fe)),
				};
				ctx.usage(msg);
				return done(1);
			},
		};
		let slot = if targetfd != 0 {
			FdSlot::At(targetfd)
		} else {
			// zsh `movefd`: nobody reads a listener.
			FdSlot::Free(10)
		};
		let fd = install(ctx, slot, file);
		add_session(ctx, Session { fd, kind: SessionKind::Listen, local, peer: ZERO })?;
		if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
			return zerr(ctx, d);
		}
		if verbose {
			ctx.out(format!("{port} listener is on fd {fd}\n").as_bytes());
		}
		return done(0);
	}
	if ops.isset(b'a') {
		let Some(arg) = args.first() else {
			ctx.usage("-a requires an argument");
			return done(1);
		};
		let lfd = atoi(arg);
		if lfd == 0 {
			ctx.usage("invalid numerical argument");
			return done(1);
		}
		let Some(sess) = sessions(ctx)?.into_iter().find(|s| s.fd == lfd) else {
			ctx.usage(format!("fd {} is not registered as a tcp connection", arg.as_bstr()));
			return done(1);
		};
		if sess.kind != SessionKind::Listen {
			ctx.usage("tcp connection not a listener");
			return done(1);
		}
		if test && !pending_connection(ctx, lfd)? {
			return done(1);
		}
		let (fd, peer) = match fd_probe(ctx, FdProbe::Accept { fd: lfd, slot: slot(targetfd) })? {
			FdAnswer::Opened { fd, peer } => (fd, peer),
			FdAnswer::Err(e) => {
				set_errno(ctx, &e);
				ctx.usage(format!("could not accept connection: {}", errmsg(&e)));
				return done(1);
			},
			_ => return done(1),
		};
		let peer = match peer {
			Some(SockAddr::Inet(a)) => a,
			_ => ZERO,
		};
		add_session(ctx, Session { fd, kind: SessionKind::Inbound, local: ZERO, peer })?;
		if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
			return zerr(ctx, d);
		}
		if verbose {
			ctx.out(format!("{} is on fd {fd}\n", peer.port()).as_bytes());
		}
		return done(0);
	}
	let Some(host) = args.first().cloned() else {
		return list(ctx, ops.isset(b'L'));
	};
	let port = match args.get(1) {
		None => 23,
		Some(p) => {
			let p = p.clone();
			port_of(ctx, &p)
		},
	};
	let addrs = match fd_probe(ctx, FdProbe::Resolve { host: host.clone(), family: IpFamily::V4 })? {
		FdAnswer::Addrs(a) if !a.is_empty() => a,
		_ => {
			ctx.usage(format!("host resolution failure: {}", host.as_bstr()));
			return done(1);
		},
	};
	// Each address in turn until one connects; the last error otherwise.
	let mut connected = None;
	let mut last_err = None;
	for ip in addrs {
		let addr = SocketAddr::new(ip, port);
		match fd_probe(ctx, FdProbe::Connect { addr: SockAddr::Inet(addr), slot: slot(targetfd) })? {
			FdAnswer::Opened { fd, .. } => {
				connected = Some((fd, addr));
				break;
			},
			FdAnswer::Err(e) => last_err = Some(e),
			_ => {},
		}
	}
	let Some((fd, peer)) = connected else {
		let e = last_err.unwrap_or_else(|| FsErr::of(&io::Error::from(io::ErrorKind::Unsupported)));
		set_errno(ctx, &e);
		ctx.usage(format!("connection failed: {}", errmsg(&e)));
		return done(1);
	};
	add_session(ctx, Session { fd, kind: SessionKind::Outbound, local: ZERO, peer })?;
	if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
		return zerr(ctx, d);
	}
	if verbose {
		// zsh prints the port as it holds it, in network byte order.
		let shown = i32::from(port.to_be());
		ctx.out(format!("{}:{shown} is now on fd {fd}\n", host.as_bstr()).as_bytes());
	}
	done(0)
}

/// `ztcp` without arguments (`-L`: the machine-readable form): every
/// session, its addresses by host name where they have one
/// (`gethostbyaddr`), else in dotted form.
fn list(ctx: &mut Ctx<'_, '_>, machine: bool) -> R {
	let list = sessions(ctx)?;
	let mut out = Vec::new();
	for s in &list {
		let local = name_of(ctx, s.local.ip())?;
		let remote = name_of(ctx, s.peer.ip())?;
		let line = if machine {
			format!(
				"{} {} {local} {} {remote} {}\n",
				s.fd,
				char::from(s.kind.letter()),
				s.local.port(),
				s.peer.port()
			)
		} else {
			let arrow = match s.kind {
				SessionKind::Listen => "-<",
				SessionKind::Inbound => "<-",
				SessionKind::Outbound | SessionKind::Zftp => "->",
			};
			let zftp = if s.kind == SessionKind::Zftp {
				" ZFTP"
			} else {
				""
			};
			format!(
				"{local}:{} {arrow} {remote}:{} is on fd {}{zftp}\n",
				s.local.port(),
				s.peer.port(),
				s.fd
			)
		};
		out.extend_from_slice(line.as_bytes());
	}
	ctx.out(&out);
	done(0)
}

/// zsh's `gethostbyaddr(…)->h_name`, else `inet_ntoa`.
fn name_of(ctx: &Ctx<'_, '_>, ip: IpAddr) -> Result<String, super::Need> {
	Ok(match fd_probe(ctx, FdProbe::HostName { addr: ip })? {
		FdAnswer::Name(Some(n)) => n.to_str_lossy().into_owned(),
		_ => ip.to_string(),
	})
}
