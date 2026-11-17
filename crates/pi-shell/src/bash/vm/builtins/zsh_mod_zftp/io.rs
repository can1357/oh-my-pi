//! The I/O side of zsh/zftp: the operations the `zftp` builtin asks for
//! through [`Probe::Zftp`](crate::bash::vm::proc::Probe::Zftp) and their
//! pollable implementation ([`perform`]). The builtin re-runs from scratch
//! after each answer, so every network or terminal side effect happens
//! here, once; the answers are cached in the op's scratch.
//!
//! Ported from zsh 5.9 `Src/Modules/zftp.c` (MIT-style licence, Copyright
//! (c) 1998 Peter Stephenson and the zsh development group).

use std::{
	io,
	net::{IpAddr, SocketAddr},
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use super::super::zsh_mod_util::zsh_errmsg;
use crate::bash::{
	event::WaitKey,
	fd::{FdFlags, FdOrigin, FdRef},
	fs::{File, FileKind, FsOp, FsPending, FsPoll, Stat},
	host::{Deadline, Timer},
	socket::{Accepted, IpFamily, ListenStage, SockAddr},
	store::{Attrs, Key, MiscKey, Record, VarValue},
	term::{SetWhen, TermFlag},
	vm::{
		Cx, Kernel,
		fsprobe::FsErr,
		proc::{Live, Scratch, Vproc},
		state,
	},
};

/// TELNET `IAC`.
const IAC: u8 = 255;
/// TELNET `DONT`.
const DONT: u8 = 254;
/// TELNET `DO`.
const DO: u8 = 253;
/// TELNET `WONT`.
const WONT: u8 = 252;
/// TELNET `WILL`.
const WILL: u8 = 251;
/// TELNET `IP` (interrupt process).
const IP: u8 = 244;
/// TELNET `SYNCH` (data mark).
const SYNCH: u8 = 242;

/// zsh `ZF_BUFSIZE`: the transfer buffer and the largest block.
pub const BUFSIZE: usize = 32768;
/// zsh `ZF_ASCSIZE`: what one read takes when sending ASCII.
const ASCSIZE: usize = BUFSIZE / 2;
/// zsh `ZFHD_MARK`: a restart-marker block.
const HD_MARK: u8 = 16;
/// zsh `ZFHD_EOFB`: the last block of the file.
pub const HD_EOFB: u8 = 64;
/// Longest control reply line kept (zsh's 256-byte line buffer).
const LINE_MAX: usize = 255;

/// One operation of the `zftp` builtin ([`perform`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZftpOp {
	/// The module's state record and the shared status file as the
	/// command found them.
	Start,
	/// A parameter's value as text (zsh `getsparam`), `None` when unset.
	Param(BString),
	/// Whether the shell function exists (zsh `getshfunc`).
	Func(BString),
	/// The host clock in nanoseconds.
	Clock,
	/// Whether the fd is a terminal (`isatty`).
	Tty(i32),
	/// Turn echo of the terminal on fd 0 on or off (zftp's password prompt).
	Echo(bool),
	/// Whether this host may open sockets at all.
	Sockets,
	/// The port of a TCP service (`getservbyname`).
	Service(BString),
	/// Whether a port is a known TCP service (`getservbyport`).
	ServicePort(u16),
	/// The addresses of a host in one family (`getipnodebyname`), giving
	/// up at the deadline.
	Resolve { host: BString, v6: bool, deadline: Option<u64> },
	/// Connect to `addr`, the socket going to the lowest free fd from 10.
	Connect { addr: SocketAddr, deadline: Option<u64> },
	/// One write of `data` to an fd (zftp `write`), timing out after
	/// `timeout` seconds (0: never).
	Write { fd: i32, data: BString, timeout: u32 },
	/// Write all of `data` to an fd, ignoring failures (stdio output).
	Out { fd: i32, data: BString },
	/// One control reply line (zsh `zfgetline`).
	Line { fd: i32, timeout: u32 },
	/// Whether the control connection has input waiting (zsh `poll` with a
	/// zero timeout).
	Poll { fd: i32 },
	/// Listen on `addr` (port 0) for the server's data connection.
	Listen { addr: SocketAddr },
	/// Accept the data connection on listening fd `fd` and close that fd.
	Accept { fd: i32 },
	/// Close an fd.
	Close { fd: i32 },
	/// The abort sequence: `IAC IP IAC` in band, `SYNCH` out of band.
	Urgent { fd: i32 },
	/// Move data over the data connection (zsh `zfsenddata`'s loop).
	Xfer(XferSpec),
	/// `stat` of a local file, or `fstat` of fd 0 without a path.
	Stat { path: Option<BString> },
}

/// What a data transfer asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct XferSpec {
	/// Receiving (data fd to fd 1), else sending (fd 0 to the data fd).
	pub recv:     bool,
	/// The data connection.
	pub data_fd:  i32,
	/// Convert `\r\n` to `\n` on the way in (ASCII type).
	pub fromasc:  bool,
	/// Convert `\n` to `\r\n` on the way out (ASCII type).
	pub toasc:    bool,
	/// Block mode framing (on the data connection: reads when receiving,
	/// writes when sending).
	pub block:    bool,
	/// Network timeout in seconds (0: none).
	pub tmout:    u32,
	/// The shell is interactive (an `EPIPE` goes unreported).
	pub interact: bool,
	/// Stop after one read and its write: a progress report is due.
	pub one:      bool,
	/// The data connection hit the end of a block-mode file already.
	pub eof:      bool,
}

/// What a data transfer did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct XferOut {
	/// Bytes added to the count (`sofar`).
	pub n:    i64,
	/// zsh's `ret`: 0 fine, 1 failed, 2 local failure (abort), 3 local
	/// failure, quietly.
	pub ret:  u8,
	/// The end of a block-mode file was seen (`zfread_eof`).
	pub eof:  bool,
	/// The loop ended.
	pub done: bool,
	/// Warnings in order: under the subcommand's full name (`true`) or
	/// under `zftp`, and the message.
	pub msgs: Vec<(bool, String)>,
}

/// A failed socket operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fail {
	/// The error.
	pub err:       FsErr,
	/// It was the timeout (zftp's alarm), not the error.
	pub timed_out: bool,
}

impl Fail {
	fn of(e: &io::Error) -> Self {
		Self { err: FsErr::of(e), timed_out: false }
	}

	fn timeout() -> Self {
		Self { err: FsErr::of(&io::Error::from(io::ErrorKind::TimedOut)), timed_out: true }
	}

	/// zsh's `%e` text of the error.
	pub fn text(&self) -> String {
		zsh_errmsg(&self.err.io())
	}
}

/// A socket put into the fd table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SockInfo {
	/// Its fd.
	pub fd:    i32,
	/// `getsockname`.
	pub local: Option<SocketAddr>,
	/// `getpeername`.
	pub peer:  Option<SocketAddr>,
}

/// The answer to a [`ZftpOp`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZftpAns {
	/// [`ZftpOp::Start`]: the state record and the shared status record.
	Start { state: Option<BString>, shared: Option<BString> },
	/// A text, or none.
	Text(Option<BString>),
	/// A yes/no answer.
	Flag(bool),
	/// A number.
	Num(u64),
	/// A port, if known.
	Port(Option<u16>),
	/// Addresses; `Err(true)` the deadline passed, `Err(false)` the name
	/// did not resolve.
	Addrs(Result<Vec<IpAddr>, bool>),
	/// A socket in the fd table.
	Sock(Result<SockInfo, Fail>),
	/// A listening socket, or the step that failed (zsh's 1 bind, 2
	/// getsockname, 3 listen, 0 socket) and its error.
	Listen(Result<SockInfo, (u8, Fail)>),
	/// Bytes written.
	Wrote(Result<usize, Fail>),
	/// A reply line: its text, whether the connection ended (zsh's
	/// `zcfinish` 2), whether the timeout passed.
	Line { text: BString, eof: bool, timed_out: bool },
	/// Readiness, or the poll failed.
	Polled(Result<bool, Fail>),
	/// A transfer's result.
	Xfer(XferOut),
	/// Size and modification time (seconds), or the stat failed.
	Stat(Option<(i64, i64)>),
	/// Done.
	Done,
}

/// In-flight state of a [`ZftpOp`] ([`Live::Zftp`]).
#[derive(Default)]
pub struct ZftpLive {
	/// The timer of the timeout or deadline.
	timer: Option<Box<dyn Timer>>,
	/// The step under way.
	step:  Step,
}

/// What a [`ZftpLive`] waits for.
#[derive(Default)]
enum Step {
	#[default]
	Idle,
	Resolve(Box<dyn FsPending<Vec<IpAddr>>>),
	Connect(Box<dyn FsPending<Box<dyn File>>>),
	Accept(Box<dyn FsPending<Accepted>>),
	Stat(Box<dyn FsPending<Stat>>),
	/// Bytes of an [`ZftpOp::Out`] written so far.
	Out(usize),
	Line(LineState),
	Xfer(Box<Xfer>),
}

/// Progress of [`ZftpOp::Line`].
#[derive(Default)]
struct LineState {
	text: Vec<u8>,
	at:   LineAt,
}

/// Where zsh's `zfgetline` is in the TELNET stream.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum LineAt {
	#[default]
	Plain,
	/// After `\r`.
	Cr,
	/// After `IAC`.
	Iac,
	/// After `IAC WILL|WONT|DO|DONT`: the answer to send with the option.
	Option(u8),
}

/// The live state of the zsh `ZftpLive` in the scratch, created on first use.
fn live(sc: &mut Scratch) -> &mut ZftpLive {
	if !matches!(sc.live, Live::Zftp(_)) {
		sc.live = Live::Zftp(Box::default());
	}
	match &mut sc.live {
		Live::Zftp(l) => l,
		_ => unreachable!("set above"),
	}
}

/// Whether `deadline` (host clock ns) has passed, arming the timer once.
fn expired(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	l: &mut ZftpLive,
	deadline: Option<u64>,
) -> bool {
	let Some(at) = deadline else {
		return false;
	};
	let timer = l.timer.get_or_insert_with(|| cx.host.timer(Deadline(at)));
	timer.poll(tcx).is_ready()
}

/// The deadline `secs` seconds from now (0: none).
fn after(cx: &Cx<'_>, secs: u32) -> Option<u64> {
	(secs > 0).then(|| {
		cx.host
			.now_ns()
			.saturating_add(u64::from(secs) * 1_000_000_000)
	})
}

fn unsupported() -> io::Error {
	io::ErrorKind::Unsupported.into()
}

// `EBADF` and `EIO`. Windows OS error numbers are not C's, so there the
// error carries the `strerror` text, which `FsErr` reports.
#[cfg(unix)]
fn ebadf() -> io::Error {
	io::Error::from_raw_os_error(libc::EBADF)
}
#[cfg(not(unix))]
fn ebadf() -> io::Error {
	io::Error::other("Bad file descriptor")
}
#[cfg(unix)]
fn eio() -> io::Error {
	io::Error::from_raw_os_error(libc::EIO)
}
#[cfg(not(unix))]
fn eio() -> io::Error {
	io::Error::other("Input/output error")
}

const fn inet(a: &SockAddr) -> Option<SocketAddr> {
	match a {
		SockAddr::Inet(s) => Some(*s),
		SockAddr::Unix(_) => None,
	}
}

/// Put a connected or listening socket into the fd table at the lowest
/// free fd from 10 (zsh `zfmovefd`), close-on-exec.
fn install(cx: &mut Cx<'_>, vp: &mut Vproc, file: Box<dyn File>) -> SockInfo {
	let (local, peer) = match (file.os_handle(), cx.host.sockets()) {
		(Some(h), Some(s)) => {
			(s.local_addr(h).ok().as_ref().and_then(inet), s.peer_addr(h).ok().as_ref().and_then(inet))
		},
		_ => (None, None),
	};
	let fd = vp.fds.lowest_free(10);
	let r = FdRef::open(file, FdOrigin::Host);
	r.set_flags(FdFlags::CLOEXEC);
	vp.fds.set(fd, Some(r));
	SockInfo { fd, local, peer }
}

/// Perform `op` (or continue it); `Err` is the wait key while it is
/// pending.
pub fn perform(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	op: &ZftpOp,
) -> Result<ZftpAns, WaitKey> {
	let mut tcx = Context::from_waker(&k.waker);
	let tcx = &mut tcx;
	Ok(match op {
		ZftpOp::Start => {
			let state = match state::record(cx.store, vp, Key::Misc(MiscKey::Zftp)) {
				Ok(Some(Record::Misc(b))) => Some(b.clone()),
				_ => None,
			};
			let shared = match cx.store.get(Key::Misc(MiscKey::ZftpStatus)) {
				Ok(Some(Record::Misc(b))) => Some(b.clone()),
				_ => None,
			};
			ZftpAns::Start { state, shared }
		},
		ZftpOp::Param(name) => {
			let text = match state::lookup(&k.root, cx.store, vp, name) {
				Ok(Some(v)) if !v.attrs.contains(Attrs::INVISIBLE) => Some(match &v.value {
					VarValue::Str(s) => s.clone(),
					_ => BString::from(bstr::join(" ", v.values())),
				}),
				_ => None,
			};
			ZftpAns::Text(text)
		},
		ZftpOp::Func(name) => ZftpAns::Flag(matches!(
			state::record(cx.store, vp, Key::Func(BStr::new(name))),
			Ok(Some(Record::Func { .. }))
		)),
		ZftpOp::Clock => ZftpAns::Num(cx.host.now_ns()),
		ZftpOp::Tty(fd) => {
			ZftpAns::Flag(vp.fds.get(*fd).and_then(FdRef::kind) == Some(FileKind::Tty))
		},
		ZftpOp::Echo(on) => {
			if let (Some(h), Some(term)) =
				(vp.fds.get(0).and_then(FdRef::os_handle), cx.host.terminal())
				&& let Ok(mut t) = term.attrs(h)
			{
				t.set(TermFlag::Echo, *on);
				let _ = term.set_attrs(h, &t, SetWhen::Drain);
			}
			ZftpAns::Done
		},
		ZftpOp::Sockets => ZftpAns::Flag(cx.host.sockets().is_some()),
		ZftpOp::Service(name) => ZftpAns::Port(
			cx.host
				.sockets()
				.and_then(|s| s.service_port(BStr::new(name))),
		),
		ZftpOp::ServicePort(port) => {
			ZftpAns::Flag(cx.host.sockets().is_some_and(|s| s.service_by_port(*port)))
		},
		ZftpOp::Resolve { host, v6, deadline } => {
			let l = live(sc);
			if expired(tcx, cx, l, *deadline) {
				return Ok(ZftpAns::Addrs(Err(true)));
			}
			let polled = match &mut l.step {
				Step::Resolve(fut) => fut.poll(tcx),
				_ => match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => {
						let family = if *v6 { IpFamily::V6 } else { IpFamily::V4 };
						match s.resolve(BStr::new(host), family) {
							FsPoll::Ready(r) => Poll::Ready(r),
							FsPoll::Pending(mut fut) => {
								let polled = fut.poll(tcx);
								if polled.is_pending() {
									l.step = Step::Resolve(fut);
								}
								polled
							},
						}
					},
				},
			};
			match polled {
				Poll::Ready(Ok(addrs)) if !addrs.is_empty() => ZftpAns::Addrs(Ok(addrs)),
				Poll::Ready(_) => ZftpAns::Addrs(Err(false)),
				Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Open, path: host.clone() }),
			}
		},
		ZftpOp::Connect { addr, deadline } => {
			let l = live(sc);
			if expired(tcx, cx, l, *deadline) {
				return Ok(ZftpAns::Sock(Err(Fail::timeout())));
			}
			let polled = match &mut l.step {
				Step::Connect(fut) => fut.poll(tcx),
				_ => match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => match s.connect(&SockAddr::Inet(*addr)) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								l.step = Step::Connect(fut);
							}
							polled
						},
					},
				},
			};
			match polled {
				Poll::Ready(Ok(file)) => ZftpAns::Sock(Ok(install(cx, vp, file))),
				Poll::Ready(Err(e)) => ZftpAns::Sock(Err(Fail::of(&e))),
				Poll::Pending => {
					return Err(WaitKey::Fs { op: FsOp::Open, path: BString::from(addr.to_string()) });
				},
			}
		},
		ZftpOp::Write { fd, data, timeout } => {
			let deadline = after(cx, *timeout);
			let l = live(sc);
			if matches!(l.step, Step::Idle) {
				l.step = Step::Out(0);
				if let Some(at) = deadline {
					l.timer = Some(cx.host.timer(Deadline(at)));
				}
			}
			if l.timer.as_mut().is_some_and(|t| t.poll(tcx).is_ready()) {
				return Ok(ZftpAns::Wrote(Err(Fail::timeout())));
			}
			match vp.fds.handle(*fd).poll_write(tcx, data) {
				Poll::Ready(Ok(n)) => ZftpAns::Wrote(Ok(n)),
				Poll::Ready(Err(e)) => ZftpAns::Wrote(Err(Fail::of(&e))),
				Poll::Pending => return Err(WaitKey::Write { fd: *fd }),
			}
		},
		ZftpOp::Out { fd, data } => {
			let l = live(sc);
			let mut off = match l.step {
				Step::Out(off) => off,
				_ => 0,
			};
			let h = vp.fds.handle(*fd);
			while off < data.len() {
				match h.poll_write(tcx, &data[off..]) {
					Poll::Ready(Ok(n)) if n > 0 => off += n,
					Poll::Ready(_) => break,
					Poll::Pending => {
						l.step = Step::Out(off);
						return Err(WaitKey::Write { fd: *fd });
					},
				}
			}
			ZftpAns::Done
		},
		ZftpOp::Line { fd, timeout } => {
			let deadline = after(cx, *timeout);
			let l = live(sc);
			if matches!(l.step, Step::Idle) {
				l.step = Step::Line(LineState::default());
				if let Some(at) = deadline {
					l.timer = Some(cx.host.timer(Deadline(at)));
				}
			}
			let ZftpLive { timer, step } = l;
			let Step::Line(st) = step else {
				unreachable!("set above");
			};
			let h = vp.fds.handle(*fd);
			loop {
				let mut b = [0u8; 1];
				let ch = match h.poll_read(tcx, &mut b) {
					Poll::Ready(Ok(1)) => Some(b[0]),
					Poll::Ready(Ok(_)) => None,
					Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
					Poll::Ready(Err(_)) => None,
					Poll::Pending => {
						if timer.as_mut().is_some_and(|t| t.poll(tcx).is_ready()) {
							return Ok(ZftpAns::Line {
								text:      BString::from(std::mem::take(&mut st.text)),
								eof:       false,
								timed_out: true,
							});
						}
						return Err(WaitKey::Read { fd: *fd });
					},
				};
				// zsh `zfgetline`: TELNET line rules.
				let mut keep = None;
				match (st.at, ch) {
					(LineAt::Option(answer), _) => {
						// `(char)EOF` is 0xff.
						let cmd = [IAC, answer, ch.unwrap_or(0xff)];
						let _ = h.poll_write(tcx, &cmd);
						st.at = LineAt::Plain;
						continue;
					},
					(_, None) => {
						return Ok(ZftpAns::Line {
							text:      BString::from(std::mem::take(&mut st.text)),
							eof:       true,
							timed_out: false,
						});
					},
					(LineAt::Plain, Some(b'\r')) => st.at = LineAt::Cr,
					(LineAt::Plain | LineAt::Cr, Some(b'\n')) => {
						return Ok(ZftpAns::Line {
							text:      BString::from(std::mem::take(&mut st.text)),
							eof:       false,
							timed_out: false,
						});
					},
					(LineAt::Plain, Some(IAC)) => st.at = LineAt::Iac,
					(LineAt::Plain, Some(c)) => keep = Some(c),
					// `\r\0` is a carriage return; `\r` before anything else
					// keeps the `\r` and drops what followed.
					(LineAt::Cr, Some(_)) => {
						st.at = LineAt::Plain;
						keep = Some(b'\r');
					},
					(LineAt::Iac, Some(WILL | WONT)) => st.at = LineAt::Option(DONT),
					(LineAt::Iac, Some(DO | DONT)) => st.at = LineAt::Option(WONT),
					(LineAt::Iac, Some(c)) => {
						st.at = LineAt::Plain;
						keep = Some(c);
					},
				}
				if let Some(c) = keep
					&& st.text.len() < LINE_MAX
				{
					st.text.push(c);
				}
			}
		},
		ZftpOp::Poll { fd } => {
			let h = vp.fds.handle(*fd);
			if !h.is_open() {
				let e = ebadf();
				return Ok(ZftpAns::Polled(Err(Fail::of(&e))));
			}
			ZftpAns::Polled(Ok(h.poll_read(tcx, &mut []).is_ready()))
		},
		ZftpOp::Listen { addr } => {
			let Some(s) = cx.host.sockets() else {
				return Ok(ZftpAns::Listen(Err((0, Fail::of(&unsupported())))));
			};
			match s.listen(&SockAddr::Inet(*addr), 1) {
				Ok(file) => ZftpAns::Listen(Ok(install(cx, vp, file))),
				Err(e) => {
					let stage = match e.stage {
						ListenStage::Socket => 0,
						ListenStage::Bind => 1,
						ListenStage::Listen => 3,
					};
					ZftpAns::Listen(Err((stage, Fail::of(&e.error))))
				},
			}
		},
		ZftpOp::Accept { fd } => {
			let l = live(sc);
			let polled = match &mut l.step {
				Step::Accept(fut) => fut.poll(tcx),
				_ => match (vp.fds.get(*fd).and_then(FdRef::os_handle), cx.host.sockets()) {
					(Some(h), Some(s)) => match s.accept(h) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								l.step = Step::Accept(fut);
							}
							polled
						},
					},
					_ => Poll::Ready(Err(unsupported())),
				},
			};
			let ans = match polled {
				Poll::Ready(Ok(acc)) => {
					// The listening socket goes first (zsh `zfclosedata` after
					// `accept`), so the data socket may take its fd.
					vp.fds.set(*fd, None);
					Ok(install(cx, vp, acc.file))
				},
				Poll::Ready(Err(e)) => {
					vp.fds.set(*fd, None);
					Err(Fail::of(&e))
				},
				Poll::Pending => return Err(WaitKey::Read { fd: *fd }),
			};
			ZftpAns::Sock(ans)
		},
		ZftpOp::Close { fd } => {
			vp.fds.set(*fd, None);
			ZftpAns::Done
		},
		ZftpOp::Urgent { fd } => {
			let h = vp.fds.handle(*fd);
			let _ = h.poll_write(tcx, &[IAC, IP, IAC]);
			if let (Some(oh), Some(s)) = (h.os_handle(), cx.host.sockets()) {
				let _ = s.send_urgent(oh, &[SYNCH]);
			}
			ZftpAns::Done
		},
		ZftpOp::Stat { path } => {
			let Some(path) = path else {
				let st = vp.fds.get(0).and_then(FdRef::stat).and_then(Result::ok);
				return Ok(ZftpAns::Stat(st.map(|s| stat_pair(&s))));
			};
			let l = live(sc);
			let polled = match &mut l.step {
				Step::Stat(fut) => fut.poll(tcx),
				_ => match cx.host.fs().stat(BStr::new(path), true) {
					FsPoll::Ready(r) => Poll::Ready(r),
					FsPoll::Pending(mut fut) => {
						let polled = fut.poll(tcx);
						if polled.is_pending() {
							l.step = Step::Stat(fut);
						}
						polled
					},
				},
			};
			match polled {
				Poll::Ready(r) => ZftpAns::Stat(r.ok().map(|s| stat_pair(&s))),
				Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Stat, path: path.clone() }),
			}
		},
		ZftpOp::Xfer(spec) => {
			let l = live(sc);
			if !matches!(l.step, Step::Xfer(_)) {
				l.step = Step::Xfer(Box::new(Xfer::new(spec)));
			}
			let Step::Xfer(x) = &mut l.step else {
				unreachable!("set above");
			};
			{
				let out = x.run(tcx, cx, vp, spec)?;
				ZftpAns::Xfer(out)
			}
		},
	})
}

fn stat_pair(s: &Stat) -> (i64, i64) {
	(i64::try_from(s.size).unwrap_or(i64::MAX), s.mtime_ns.div_euclid(1_000_000_000))
}

/// A read or write of one call: bytes, or the error (`None`: the timeout,
/// zsh's `zfdrrrring`).
type Moved = Result<usize, Option<io::Error>>;

/// Where a transfer is (zsh `zfsenddata` and its `zfread`/`zfwrite`
/// helpers, block mode included), kept across polls.
struct Xfer {
	/// zsh's `lsbuf`: kept across reads, as the C stack buffer is.
	buf:   Vec<u8>,
	/// zsh's `ascbuf`.
	asc:   Vec<u8>,
	at:    XferAt,
	/// The timer of the read or write in flight.
	timer: XferTimer,
	out:   XferOut,
}

/// The timeout of the call in flight.
enum XferTimer {
	/// Not armed yet (no call started).
	Unarmed,
	/// Armed without a timeout.
	Never,
	Armed(Box<dyn Timer>),
}

/// The call in flight.
#[derive(Clone, Copy)]
enum XferAt {
	/// The next read (a block header in block mode).
	Read,
	/// Block mode: `got` of `size` bytes of the block body read.
	Body { size: usize, got: usize, flags: u8 },
	/// Writing `buf[off..end]`; in block mode after the header for it
	/// (`hdr`: that header is written).
	Write { off: usize, end: usize, hdr: bool },
}

impl Xfer {
	fn new(spec: &XferSpec) -> Self {
		Self {
			buf:   vec![0; BUFSIZE],
			asc:   vec![0; ASCSIZE],
			at:    XferAt::Read,
			timer: XferTimer::Unarmed,
			out:   XferOut { eof: spec.eof, ..XferOut::default() },
		}
	}

	/// Arm the timeout of a call once (zftp's `alarm` per `read`/`write`);
	/// whether it has passed.
	fn timed_out(&mut self, tcx: &mut Context<'_>, cx: &mut Cx<'_>, tmout: u32) -> bool {
		if matches!(self.timer, XferTimer::Unarmed) {
			self.timer = after(cx, tmout)
				.map_or(XferTimer::Never, |at| XferTimer::Armed(cx.host.timer(Deadline(at))));
		}
		match &mut self.timer {
			XferTimer::Armed(t) => t.poll(tcx).is_ready(),
			XferTimer::Unarmed | XferTimer::Never => false,
		}
	}

	/// One poll of a call: its result, or `Pending` (then waiting).
	fn call(
		&mut self,
		tcx: &mut Context<'_>,
		cx: &mut Cx<'_>,
		tmout: u32,
		polled: Poll<io::Result<usize>>,
	) -> Poll<Moved> {
		let r = match polled {
			Poll::Ready(Ok(n)) => Ok(n),
			Poll::Ready(Err(e)) => Err(Some(e)),
			Poll::Pending => {
				if !self.timed_out(tcx, cx, tmout) {
					return Poll::Pending;
				}
				Err(None)
			},
		};
		self.timer = XferTimer::Unarmed;
		Poll::Ready(r)
	}

	fn run(
		&mut self,
		tcx: &mut Context<'_>,
		cx: &mut Cx<'_>,
		vp: &Vproc,
		spec: &XferSpec,
	) -> Result<XferOut, WaitKey> {
		let (fdin, fdout) = if spec.recv {
			(spec.data_fd, 1)
		} else {
			(0, spec.data_fd)
		};
		let hin = vp.fds.handle(fdin);
		let hout = vp.fds.handle(fdout);
		// zsh: the timeout applies to reads when receiving, writes when
		// sending.
		let (rtmout, wtmout) = if spec.recv {
			(spec.tmout, 0)
		} else {
			(0, spec.tmout)
		};
		loop {
			if self.out.done {
				return Ok(std::mem::take(&mut self.out));
			}
			match self.at {
				// Block framing is on the data connection's side only.
				XferAt::Read if spec.block && spec.recv => {
					// zsh `zfread_block`: the 3-byte header in one read.
					let mut hdr = [0u8; 3];
					let polled = hin.poll_read(tcx, &mut hdr);
					let r = match self.call(tcx, cx, rtmout, polled) {
						Poll::Ready(r) => r,
						Poll::Pending => return Err(WaitKey::Read { fd: fdin }),
					};
					match r {
						Ok(3) => {},
						Ok(n) => {
							self
								.out
								.msgs
								.push((false, "failure reading FTP block header".into()));
							// zsh hands back the short count; the buffer holds
							// what the last block left there.
							self.got(spec, n as i64, None);
							continue;
						},
						Err(None) => {
							self
								.out
								.msgs
								.push((false, "timeout on network read".into()));
							self.got(spec, -1, None);
							continue;
						},
						Err(Some(e)) => {
							self
								.out
								.msgs
								.push((false, "failure reading FTP block header".into()));
							self.got(spec, -1, Some(e));
							continue;
						},
					}
					if hdr[0] & HD_EOFB != 0 {
						self.out.eof = true;
					}
					let size = (usize::from(hdr[1]) << 8) | usize::from(hdr[2]);
					if size > BUFSIZE {
						self
							.out
							.msgs
							.push((false, "block too large to handle".into()));
						self.got(spec, -1, Some(eio()));
						continue;
					}
					self.at = XferAt::Body { size, got: 0, flags: hdr[0] };
				},
				XferAt::Read => {
					let polled = if spec.toasc {
						hin.poll_read(tcx, &mut self.asc)
					} else {
						hin.poll_read(tcx, &mut self.buf)
					};
					let r = match self.call(tcx, cx, rtmout, polled) {
						Poll::Ready(r) => r,
						Poll::Pending => return Err(WaitKey::Read { fd: fdin }),
					};
					match r {
						Ok(n) => self.got(spec, n as i64, None),
						Err(None) => {
							self
								.out
								.msgs
								.push((false, "timeout on network read".into()));
							self.got(spec, -1, None);
						},
						Err(Some(e)) => self.got(spec, -1, Some(e)),
					}
				},
				XferAt::Body { size, got, flags } => {
					if got < size {
						let polled = hin.poll_read(tcx, &mut self.buf[got..size]);
						let r = match self.call(tcx, cx, rtmout, polled) {
							Poll::Ready(r) => r,
							Poll::Pending => return Err(WaitKey::Read { fd: fdin }),
						};
						match r {
							Ok(0) => {
								self.out.msgs.push((false, "short data block".into()));
								self.got(spec, -1, Some(eio()));
							},
							Ok(n) => self.at = XferAt::Body { size, got: got + n, flags },
							Err(None) => {
								self
									.out
									.msgs
									.push((false, "timeout on network read".into()));
								self.got(spec, -1, None);
							},
							Err(Some(e)) => self.got(spec, -1, Some(e)),
						}
						continue;
					}
					self.at = XferAt::Read;
					if flags & HD_MARK != 0 {
						// A restart marker: read on unless the file ended.
						if !self.out.eof {
							continue;
						}
						self.got(spec, 0, None);
					} else {
						self.got(spec, size as i64, None);
					}
				},
				XferAt::Write { off, end, hdr } => {
					if !hdr {
						// zsh `zfwrite_block`: the header in one write.
						let len = end - off;
						let h = [0, (len >> 8) as u8, (len & 0xff) as u8];
						let polled = hout.poll_write(tcx, &h);
						let r = match self.call(tcx, cx, wtmout, polled) {
							Poll::Ready(r) => r,
							Poll::Pending => return Err(WaitKey::Write { fd: fdout }),
						};
						match r {
							Ok(3) => self.at = XferAt::Write { off, end, hdr: true },
							// zsh returns the short count as the bytes written: the
							// caller writes the rest as a new block.
							Ok(n) => {
								self
									.out
									.msgs
									.push((false, "failure writing FTP block header".into()));
								self.at = XferAt::Write { off: (off + n).min(end), end, hdr: false };
								if off + n >= end {
									self.wrote_chunk(spec);
								}
							},
							Err(None) => {
								self
									.out
									.msgs
									.push((false, "timeout on network write".into()));
								self.wrote_fail(spec, None);
							},
							Err(Some(e)) => self.wrote_fail(spec, Some(e)),
						}
						continue;
					}
					let polled = hout.poll_write(tcx, &self.buf[off..end]);
					let r = match self.call(tcx, cx, wtmout, polled) {
						Poll::Ready(r) => r,
						Poll::Pending => return Err(WaitKey::Write { fd: fdout }),
					};
					match r {
						Ok(n) if off + n >= end => self.wrote_chunk(spec),
						Ok(n) => self.at = XferAt::Write { off: off + n, end, hdr: true },
						Err(None) => {
							self
								.out
								.msgs
								.push((false, "timeout on network write".into()));
							self.wrote_fail(spec, None);
						},
						Err(Some(e)) => self.wrote_fail(spec, Some(e)),
					}
				},
			}
			if spec.one && !self.out.done && matches!(self.at, XferAt::Read) && self.out.n > 0 {
				// A chunk went through: back to the builtin for its progress
				// report.
				return Ok(std::mem::take(&mut self.out));
			}
		}
	}

	/// zsh `zfsenddata` after a read returned `n` (`-1` with `err`, `None`
	/// for the timeout): convert and start writing, or end the loop.
	fn got(&mut self, spec: &XferSpec, n: i64, err: Option<io::Error>) {
		self.at = XferAt::Read;
		if n > 0 {
			let mut n = n as usize;
			if spec.toasc {
				// `\n` -> `\r\n`.
				let mut o = 0;
				for i in 0..n {
					let c = self.asc[i];
					if c == b'\n' {
						self.buf[o] = b'\r';
						o += 1;
					}
					self.buf[o] = c;
					o += 1;
				}
				n = o;
			}
			if spec.fromasc
				&& let Some(start) = self.buf[..n].iter().position(|&c| c == b'\r')
			{
				// `\r\n` -> `\n`; past the last byte zsh looks at whatever
				// the buffer held there.
				let total = n;
				let mut o = start;
				for i in start..total {
					let next = self.buf.get(i + 1).copied().unwrap_or(0);
					if self.buf[i] != b'\r' || next != b'\n' {
						self.buf[o] = self.buf[i];
						o += 1;
					} else {
						n -= 1;
					}
				}
			}
			self.out.n += n as i64;
			self.at = XferAt::Write { off: 0, end: n, hdr: !spec.block || spec.recv };
			return;
		}
		if n < 0 {
			// zsh: reported unless the timeout (reported already) or,
			// interactively, `EPIPE`.
			match err {
				Some(e) if !spec.interact || !is_epipe(&e) => {
					self.out.ret = if spec.recv { 1 } else { 2 };
					self
						.out
						.msgs
						.push((true, format!("read failed: {}", zsh_errmsg(&e))));
				},
				_ => self.out.ret = if spec.recv { 1 } else { 3 },
			}
		}
		self.out.done = true;
	}

	/// A write failed (`None`: the timeout).
	fn wrote_fail(&mut self, spec: &XferSpec, err: Option<io::Error>) {
		self.at = XferAt::Read;
		match err {
			Some(e) if !spec.interact || !is_epipe(&e) => {
				self.out.ret = if spec.recv { 2 } else { 1 };
				self
					.out
					.msgs
					.push((true, format!("write failed: {}", zsh_errmsg(&e))));
			},
			_ => self.out.ret = if spec.recv { 3 } else { 1 },
		}
		self.out.done = true;
	}

	/// The chunk is written: the next read, unless the file ended.
	const fn wrote_chunk(&mut self, _spec: &XferSpec) {
		self.at = XferAt::Read;
		if self.out.eof {
			self.out.done = true;
		}
	}
}

/// `EPIPE` maps to `BrokenPipe` on every platform.
fn is_epipe(e: &io::Error) -> bool {
	e.kind() == io::ErrorKind::BrokenPipe
}
