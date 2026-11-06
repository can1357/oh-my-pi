//! fd-level probes of the zsh module builtins (zsh/system, zsh/zselect,
//! zsh/net/socket, zsh/net/tcp): one `read(2)` with a timeout, a whole
//! write, readiness of several fds with a timeout, and the operations that
//! put a new descriptor into the vproc's fd table (an open, a `zsystem
//! flock` lock, a socket connect or accept), plus host name lookups.
//!
//! A builtin asks for them as [`Probe::Fd`](super::proc::Probe::Fd) and
//! [`super::probe::perform_mut`] runs them with the vproc mutable: an
//! [`File`] cannot live in a cached [`ProbeResult`](super::proc::ProbeResult),
//! so the probe itself installs the descriptor ([`FdSlot`]) and answers
//! with its number. The builtin then runs again from scratch, finds the
//! answer cached and goes on: it must issue the same probe again (an
//! [`FdSlot::Free`] names the search, not the fd it found, so the answer
//! still matches once the fd is taken).

use std::{
	io,
	net::IpAddr,
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::{
	Cx, Kernel,
	fsprobe::FsErr,
	probe::dev_fd,
	proc::{Live, Scratch, Vproc},
};
use crate::bash::{
	event::WaitKey,
	fd::{FdFlags, FdOrigin, FdRef, FdWeak},
	fs::{FdLock, File, FileKind, Fs, FsOp, FsPending, FsPoll, OpenFlags, Stat},
	host::{Deadline, OsHandle, Timer},
	socket::{Accepted, IpFamily, SockAddr},
};

/// Where an fd-installing probe puts the new descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FdSlot {
	/// Exactly this fd (zsh `redup`): what it held is closed.
	At(i32),
	/// The lowest closed fd at or above this one: zsh's `movefd` (≥ 10)
	/// or a fresh `socket(2)`/`accept(2)` descriptor (≥ 0).
	Free(i32),
}

impl FdSlot {
	/// The fd this slot names in `vp` now.
	fn resolve(self, vp: &Vproc) -> i32 {
		match self {
			Self::At(fd) => fd,
			Self::Free(from) => (from.max(0)..i32::MAX)
				.find(|&fd| vp.fds.get(fd).is_none_or(|h| !h.is_open()))
				.unwrap_or(from),
		}
	}
}

/// An fd-level operation ([`Probe::Fd`](super::proc::Probe::Fd)).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FdProbe {
	/// One `read(2)` of at most `max` bytes from `fd` (zsh `sysread`):
	/// waits for input, at most `timeout_ns` when given (`Some(0)`: only
	/// if input is there now). A regular file reads as the kernel would:
	/// `max` bytes unless the end comes first.
	ReadOnce { fd: i32, max: usize, timeout_ns: Option<u64> },
	/// Write all of `data` to `fd` (zsh `syswrite`, `sysread -o`).
	Write { fd: i32, data: BString },
	/// Which of the fds are ready for reading, writing and exceptional
	/// conditions (zsh `zselect`, `select(2)`): waits for one of them, at
	/// most `timeout_ns` when given.
	Select { sets: [Vec<i32>; 3], timeout_ns: Option<u64> },
	/// Open absolute `path` into `slot` with `fd_flags` (zsh `sysopen`).
	/// `/dev/fd/N` duplicates the shell's fd `N`.
	Open {
		path:     BString,
		flags:    OpenFlags,
		mode:     u32,
		slot:     FdSlot,
		fd_flags: FdFlags,
	},
	/// zsh `zsystem flock`: open absolute `path` (read-write for an
	/// exclusive lock, read-only for a shared one), lock the whole file
	/// and install it at the lowest free fd ≥ 10 with `fd_flags`. Without
	/// `timeout_ns` it waits as long as it takes, retrying every
	/// `interval_ns`; `Some(0)` tries once; otherwise it retries every
	/// `interval_ns` until the timeout.
	Lock {
		path:        BString,
		write:       bool,
		timeout_ns:  Option<u64>,
		interval_ns: u64,
		fd_flags:    FdFlags,
	},
	/// Connect a stream socket to `addr` into `slot`.
	Connect { addr: SockAddr, slot: FdSlot },
	/// Accept a connection on the listening socket at fd `fd` into `slot`.
	Accept { fd: i32, slot: FdSlot },
	/// The addresses of host name `host`.
	Resolve { host: BString, family: IpFamily },
	/// The host name of `addr`.
	HostName { addr: IpAddr },
}

/// Answer of an [`FdProbe`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FdAnswer {
	/// [`FdProbe::ReadOnce`]: the bytes read (empty at end of file), or
	/// nothing when the timeout passed first.
	Read { data: BString, timed_out: bool },
	/// [`FdProbe::Write`]: the bytes written, and the error that stopped
	/// the write early.
	Wrote { n: usize, err: Option<FsErr> },
	/// [`FdProbe::Select`]: the ready fds of each set (all empty: the
	/// timeout passed).
	Ready([Vec<i32>; 3]),
	/// A descriptor was installed at `fd`; an accepted connection's
	/// peer.
	Opened { fd: i32, peer: Option<SockAddr> },
	/// [`FdProbe::Lock`]: the locked file's fd, `None` when the timeout
	/// passed.
	Locked(Option<i32>),
	/// [`FdProbe::Lock`]: the file could not be opened.
	LockOpen(FsErr),
	/// [`FdProbe::Resolve`]: the addresses.
	Addrs(Vec<IpAddr>),
	/// [`FdProbe::HostName`]: the name, if any.
	Name(Option<BString>),
	/// The operation failed.
	Err(FsErr),
}

/// A socket or lock operation of an [`FdProbe`] in flight
/// ([`Live::Fd`]).
pub enum FdLive {
	/// Bytes of a [`FdProbe::Write`] written so far.
	Written(usize),
	/// [`FdProbe::Resolve`] in flight.
	Resolve(Box<dyn FsPending<Vec<IpAddr>>>),
	/// [`FdProbe::HostName`] in flight.
	HostName(Box<dyn FsPending<Option<BString>>>),
	/// [`FdProbe::Accept`] in flight.
	Accept(Box<dyn FsPending<Accepted>>),
	/// [`FdProbe::Lock`] waiting to retry: the opened file, when to give
	/// up and the retry timer.
	Lock {
		file:     Box<dyn File>,
		/// The file's `(dev, ino)` once known ([`LOCKS`]).
		key:      Option<(u64, u64)>,
		/// Its `stat` in flight.
		stat:     Option<Box<dyn FsPending<Stat>>>,
		deadline: Option<Deadline>,
		timer:    Option<Box<dyn Timer>>,
	},
}

impl FdLive {
	/// Whether dropping it and issuing the probe again is invisible (a
	/// name lookup is).
	pub const fn is_idempotent(&self) -> bool {
		matches!(self, Self::Resolve(_) | Self::HostName(_))
	}
}

fn err(e: &io::Error) -> FdAnswer {
	FdAnswer::Err(FsErr::of(e))
}

/// `EBADF`.
fn bad_fd() -> io::Error {
	io::Error::other(crate::bash::fd::BadFd)
}

/// The error of an operation the host refuses.
fn unsupported() -> io::Error {
	io::ErrorKind::Unsupported.into()
}

/// Whether a zero-length poll's error means "not this direction" (the
/// [`File`] direction contract, or `EBADF` from a descriptor opened the
/// other way) rather than a condition `select(2)` reports as ready.
fn wrong_direction(e: &io::Error) -> bool {
	#[cfg(unix)]
	if e.raw_os_error() == Some(libc::EBADF) {
		return true;
	}
	e.kind() == io::ErrorKind::Unsupported
}

/// Install `file` at `slot` with `flags`: its fd.
fn install(vp: &mut Vproc, slot: FdSlot, r: FdRef, flags: FdFlags) -> i32 {
	let fd = slot.resolve(vp);
	r.set_flags(flags);
	vp.fds.set(fd, Some(r));
	fd
}

/// Arm (once) and poll the timer of a probe waiting at most `ns`: whether
/// the time is up.
fn timed_out(tcx: &mut Context<'_>, cx: &mut Cx<'_>, sc: &mut Scratch, ns: u64) -> bool {
	if ns == 0 {
		return true;
	}
	if !matches!(sc.live, Live::Timer(_)) {
		let at = Deadline(cx.host.now_ns().saturating_add(ns));
		sc.live = Live::Timer(cx.host.timer(at));
	}
	if let Live::Timer(t) = &mut sc.live {
		t.poll(tcx).is_ready()
	} else {
		false
	}
}

/// Perform `probe` (or continue it); `Err` is the wait key while it is
/// pending.
pub fn perform(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	probe: &FdProbe,
) -> Result<FdAnswer, WaitKey> {
	let mut tcx = Context::from_waker(&k.waker);
	let tcx = &mut tcx;
	match probe {
		FdProbe::ReadOnce { fd, max, timeout_ns } => {
			read_once(tcx, cx, vp, sc, *fd, *max, *timeout_ns)
		},
		FdProbe::Write { fd, data } => write_all(tcx, vp, sc, *fd, data),
		FdProbe::Select { sets, timeout_ns } => select(tcx, cx, vp, sc, sets, *timeout_ns),
		FdProbe::Open { path, flags, mode, slot, fd_flags } => {
			if let Some(n) = dev_fd(path) {
				let dup = match vp.fds.get(n) {
					Some(h) if h.is_open() => h.dup(),
					_ => Err(bad_fd()),
				};
				return Ok(match dup {
					Ok(r) => FdAnswer::Opened { fd: install(vp, *slot, r, *fd_flags), peer: None },
					Err(e) => err(&e),
				});
			}
			let file = match open(tcx, cx, sc, path, *flags, *mode)? {
				Ok(file) => file,
				Err(e) => return Ok(err(&e)),
			};
			let r = FdRef::open(file, FdOrigin::Host);
			Ok(FdAnswer::Opened { fd: install(vp, *slot, r, *fd_flags), peer: None })
		},
		FdProbe::Lock { path, write, timeout_ns, interval_ns, fd_flags } => {
			let owner = (Arc::as_ptr(&k.ctl).addr(), vp.vpid.0);
			let how =
				LockHow { write: *write, timeout_ns: *timeout_ns, interval_ns: *interval_ns, owner };
			lock(tcx, cx, vp, sc, path, how, *fd_flags)
		},
		FdProbe::Connect { addr, slot } => {
			let polled = match &mut sc.live {
				Live::Open(fut) => fut.poll(tcx),
				_ => match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => match s.connect(addr) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								sc.live = Live::Open(fut);
							}
							polled
						},
					},
				},
			};
			match polled {
				Poll::Ready(Ok(file)) => {
					sc.live = Live::None;
					let r = FdRef::open(file, FdOrigin::Host);
					Ok(FdAnswer::Opened { fd: install(vp, *slot, r, FdFlags::NONE), peer: None })
				},
				Poll::Ready(Err(e)) => Ok(err(&e)),
				Poll::Pending => Err(WaitKey::Write { fd: slot.resolve(vp) }),
			}
		},
		FdProbe::Accept { fd, slot } => {
			let polled = if let Live::Fd(live) = &mut sc.live {
				match &mut **live {
					FdLive::Accept(fut) => fut.poll(tcx),
					_ => Poll::Ready(Err(bad_fd())),
				}
			} else {
				let handle = match vp.fds.get(*fd) {
					Some(h) if h.is_open() => h.os_handle(),
					_ => return Ok(err(&bad_fd())),
				};
				let Some(handle) = handle else {
					// An engine object (a pipe, a document) is no socket.
					#[cfg(unix)]
					return Ok(err(&io::Error::from_raw_os_error(libc::ENOTSOCK)));
					#[cfg(not(unix))]
					return Ok(err(&unsupported()));
				};
				match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => match s.accept(handle) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								sc.live = Live::Fd(Box::new(FdLive::Accept(fut)));
							}
							polled
						},
					},
				}
			};
			match polled {
				Poll::Ready(Ok(Accepted { file, peer })) => {
					sc.live = Live::None;
					let r = FdRef::open(file, FdOrigin::Host);
					Ok(FdAnswer::Opened { fd: install(vp, *slot, r, FdFlags::NONE), peer: Some(peer) })
				},
				Poll::Ready(Err(e)) => Ok(err(&e)),
				Poll::Pending => Err(WaitKey::Read { fd: *fd }),
			}
		},
		FdProbe::Resolve { host, family } => {
			let polled = match &mut sc.live {
				Live::Fd(live) => match &mut **live {
					FdLive::Resolve(fut) => fut.poll(tcx),
					_ => Poll::Ready(Err(unsupported())),
				},
				_ => match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => match s.resolve(BStr::new(host), *family) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								sc.live = Live::Fd(Box::new(FdLive::Resolve(fut)));
							}
							polled
						},
					},
				},
			};
			match polled {
				Poll::Ready(Ok(addrs)) => Ok(FdAnswer::Addrs(addrs)),
				Poll::Ready(Err(e)) => Ok(err(&e)),
				Poll::Pending => Err(WaitKey::Fs { op: FsOp::Open, path: host.clone() }),
			}
		},
		FdProbe::HostName { addr } => {
			let polled = match &mut sc.live {
				Live::Fd(live) => match &mut **live {
					FdLive::HostName(fut) => fut.poll(tcx),
					_ => Poll::Ready(Err(unsupported())),
				},
				_ => match cx.host.sockets() {
					None => Poll::Ready(Err(unsupported())),
					Some(s) => match s.host_name(*addr) {
						FsPoll::Ready(r) => Poll::Ready(r),
						FsPoll::Pending(mut fut) => {
							let polled = fut.poll(tcx);
							if polled.is_pending() {
								sc.live = Live::Fd(Box::new(FdLive::HostName(fut)));
							}
							polled
						},
					},
				},
			};
			match polled {
				Poll::Ready(Ok(name)) => Ok(FdAnswer::Name(name)),
				Poll::Ready(Err(e)) => Ok(err(&e)),
				Poll::Pending => {
					Err(WaitKey::Fs { op: FsOp::Open, path: BString::from(addr.to_string()) })
				},
			}
		},
	}
}

/// zsh `bin_sysread`'s `poll` and `read(2)`.
fn read_once(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	fd: i32,
	max: usize,
	timeout_ns: Option<u64>,
) -> Result<FdAnswer, WaitKey> {
	let Some(h) = vp.fds.get(fd).filter(|h| h.is_open()).cloned() else {
		return Ok(err(&bad_fd()));
	};
	let regular = h.kind() == Some(FileKind::Regular);
	let buf = &mut sc.io().input;
	buf.clear();
	buf.resize(max, 0);
	let mut got = 0;
	loop {
		match h.poll_read(tcx, &mut sc.io().input[got..]) {
			Poll::Ready(Ok(n)) => {
				got += n;
				// The kernel fills a regular file's read but at the end;
				// an engine read-ahead may hand it over in parts.
				if regular && n > 0 && got < max {
					continue;
				}
				break;
			},
			Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::Interrupted && got == 0 => {},
			Poll::Ready(Err(e)) => {
				if got > 0 {
					break;
				}
				sc.io().input.clear();
				return Ok(err(&e));
			},
			Poll::Pending if got > 0 => break,
			Poll::Pending => {
				if let Some(ns) = timeout_ns
					&& timed_out(tcx, cx, sc, ns)
				{
					sc.io().input.clear();
					return Ok(FdAnswer::Read { data: BString::default(), timed_out: true });
				}
				return Err(WaitKey::Read { fd });
			},
		}
	}
	let input = &mut sc.io().input;
	input.truncate(got);
	Ok(FdAnswer::Read { data: BString::from(std::mem::take(input)), timed_out: false })
}

/// zsh `bin_syswrite`'s loop of `write(2)`s.
fn write_all(
	tcx: &mut Context<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	fd: i32,
	data: &[u8],
) -> Result<FdAnswer, WaitKey> {
	let mut done = match &sc.live {
		Live::Fd(live) => match **live {
			FdLive::Written(n) => n,
			_ => 0,
		},
		_ => 0,
	};
	let h = vp.fds.handle(fd);
	while done < data.len() {
		match h.poll_write(tcx, &data[done..]) {
			Poll::Ready(Ok(0)) => {
				sc.live = Live::None;
				let e = io::Error::from(io::ErrorKind::WriteZero);
				return Ok(FdAnswer::Wrote { n: done, err: Some(FsErr::of(&e)) });
			},
			Poll::Ready(Ok(n)) => done += n,
			Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::Interrupted => {},
			Poll::Ready(Err(e)) => {
				sc.live = Live::None;
				return Ok(FdAnswer::Wrote { n: done, err: Some(FsErr::of(&e)) });
			},
			Poll::Pending => {
				sc.live = Live::Fd(Box::new(FdLive::Written(done)));
				return Err(WaitKey::Write { fd });
			},
		}
	}
	sc.live = Live::None;
	Ok(FdAnswer::Wrote { n: done, err: None })
}

/// zsh `bin_zselect`'s `select(2)`: read readiness is a zero-length read
/// that does not wait, write readiness a zero-length write; no engine
/// object reports exceptional conditions, so the third set stays empty.
fn select(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	sets: &[Vec<i32>; 3],
	timeout_ns: Option<u64>,
) -> Result<FdAnswer, WaitKey> {
	let mut ready: [Vec<i32>; 3] = Default::default();
	for (i, set) in sets.iter().enumerate() {
		for &fd in set {
			let Some(h) = vp.fds.get(fd).filter(|h| h.is_open()) else {
				return Ok(err(&bad_fd()));
			};
			let polled = match i {
				0 => h.poll_read(tcx, &mut []),
				1 => h.poll_write(tcx, &[]),
				_ => Poll::Pending,
			};
			let is_ready = match polled {
				Poll::Ready(Ok(_)) => true,
				Poll::Ready(Err(e)) => !wrong_direction(&e),
				Poll::Pending => false,
			};
			if is_ready && !ready[i].contains(&fd) {
				ready[i].push(fd);
			}
		}
		ready[i].sort_unstable();
	}
	if ready.iter().any(|s| !s.is_empty()) {
		return Ok(FdAnswer::Ready(ready));
	}
	if let Some(ns) = timeout_ns
		&& timed_out(tcx, cx, sc, ns)
	{
		return Ok(FdAnswer::Ready(ready));
	}
	let fd = sets.iter().flatten().next().copied().unwrap_or(0);
	Err(WaitKey::Read { fd })
}

/// Open `path` through the host's filesystem, holding a pending open in
/// `sc.live`.
fn open(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
	flags: OpenFlags,
	mode: u32,
) -> Result<io::Result<Box<dyn File>>, WaitKey> {
	let polled = match &mut sc.live {
		Live::Open(fut) => fut.poll(tcx),
		_ => match cx.host.fs().open(BStr::new(path), flags, mode) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut fut) => {
				let polled = fut.poll(tcx);
				if polled.is_pending() {
					sc.live = Live::Open(fut);
				}
				polled
			},
		},
	};
	match polled {
		Poll::Ready(r) => {
			sc.live = Live::None;
			Ok(r)
		},
		Poll::Pending => Err(WaitKey::Fs { op: FsOp::Open, path: path.clone() }),
	}
}

/// A `zsystem flock` lock held in this process, with its virtual owner.
///
/// `fcntl` locks belong to OS processes, but a zsh subshell is a process
/// of its own while here it is a vproc of the same OS process: two vprocs
/// would never conflict. So the locks are also recorded per owner (the
/// shell and the vproc that took them) and checked between owners as
/// `fcntl` checks between processes; the OS lock is still taken, for
/// other processes. A child vproc does not inherit its parent's locks
/// (`fork`): it shares the fd, not the ownership.
struct Holder {
	/// The file's `(dev, ino)`.
	key:       (u64, u64),
	/// The shell (its control block's address) and vproc holding it.
	owner:     (usize, u32),
	/// `F_WRLCK` rather than `F_RDLCK`.
	exclusive: bool,
	/// The lock's fd object: the lock ends with it (its owner closed the fd
	/// or exited) or with `zsystem flock -u`.
	token:     FdWeak,
	/// Its descriptor, to take the OS lock again (closing any descriptor of
	/// a file drops all of the process's locks on it).
	handle:    OsHandle,
}

/// The locks of this process's shells ([`Holder`]).
static LOCKS: Mutex<Vec<Holder>> = Mutex::new(Vec::new());

/// Take the OS locks of the live holders of `key` again.
fn reassert(fs: &mut dyn Fs, locks: &[Holder], key: (u64, u64)) {
	for h in locks.iter().filter(|h| h.key == key) {
		let kind = if h.exclusive {
			FdLock::Exclusive
		} else {
			FdLock::Shared
		};
		// The OS answers at once (a deferring filesystem has done it too).
		let _ = fs.lock_fd(h.handle, kind);
	}
}

/// Forget the locks whose fd objects are gone (closed by their owner,
/// which exited or ran `exec {fd}>&-`). As with `fcntl`, closing one
/// descriptor of a file ends all of its owner's locks on that file; the
/// close also released the OS lock of every other holder of the file, so
/// those take theirs again.
fn prune(fs: &mut dyn Fs) {
	let mut locks = LOCKS.lock();
	let dead: Vec<((u64, u64), (usize, u32))> = locks
		.iter()
		.filter(|h| !h.token.is_alive())
		.map(|h| (h.key, h.owner))
		.collect();
	if dead.is_empty() {
		return;
	}
	locks.retain(|h| !dead.contains(&(h.key, h.owner)));
	for (key, _) in dead {
		reassert(fs, &locks, key);
	}
}

/// zsh `zsystem flock -u`'s close of lock fd `r`: its lock ends at once,
/// even while a child vproc still shares the descriptor.
pub fn release_lock(fs: &mut dyn Fs, r: &FdRef) {
	let mut locks = LOCKS.lock();
	let Some(at) = locks.iter().position(|h| h.token.is(r)) else {
		drop(locks);
		if let Some(handle) = r.os_handle() {
			let _ = fs.lock_fd(handle, FdLock::Unlock);
		}
		return;
	};
	let gone = locks.remove(at);
	// `fcntl`: closing one descriptor ends all of the owner's locks on the
	// file.
	locks.retain(|h| h.key != gone.key || h.owner != gone.owner);
	if locks.iter().any(|h| h.key == gone.key) {
		reassert(fs, &locks, gone.key);
	} else {
		let _ = fs.lock_fd(gone.handle, FdLock::Unlock);
	}
}

/// How a [`FdProbe::Lock`] locks.
struct LockHow {
	write:       bool,
	timeout_ns:  Option<u64>,
	interval_ns: u64,
	/// The shell and vproc asking ([`Holder::owner`]).
	owner:       (usize, u32),
}

/// zsh `bin_zsystem_flock`'s open, lock attempts and `movefd`.
fn lock(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	path: &BString,
	how: LockHow,
	fd_flags: FdFlags,
) -> Result<FdAnswer, WaitKey> {
	let LockHow { write, timeout_ns, interval_ns, owner } = how;
	let wait = WaitKey::Fs { op: FsOp::Open, path: path.clone() };
	// A retry timer still running: wait for it.
	if let Live::Fd(live) = &mut sc.live
		&& let FdLive::Lock { timer: Some(timer), .. } = &mut **live
		&& timer.poll(tcx).is_pending()
	{
		return Err(wait);
	}
	if !matches!(&sc.live, Live::Fd(live) if matches!(**live, FdLive::Lock { .. })) {
		let flags = if write {
			OpenFlags::READ.with(OpenFlags::WRITE)
		} else {
			OpenFlags::READ
		};
		let file = match open(tcx, cx, sc, path, flags, 0)? {
			Ok(file) => file,
			Err(e) => return Ok(FdAnswer::LockOpen(FsErr::of(&e))),
		};
		let deadline = timeout_ns
			.filter(|&ns| ns > 0)
			.map(|ns| Deadline(cx.host.now_ns().saturating_add(ns)));
		// The file's identity: the lock is the file's, whatever the path.
		let (key, stat) = match cx.host.fs().stat(BStr::new(path), true) {
			FsPoll::Ready(r) => (r.ok().map(|st| (st.dev, st.ino)), None),
			FsPoll::Pending(fut) => (None, Some(fut)),
		};
		sc.live = Live::Fd(Box::new(FdLive::Lock { file, key, stat, deadline, timer: None }));
	}
	let Live::Fd(live) = &mut sc.live else {
		return Ok(err(&bad_fd()));
	};
	let FdLive::Lock { file, key, stat, deadline, timer } = &mut **live else {
		return Ok(err(&bad_fd()));
	};
	if let Some(fut) = stat {
		match fut.poll(tcx) {
			Poll::Ready(r) => {
				*key = r.ok().map(|st| (st.dev, st.ino));
				*stat = None;
			},
			Poll::Pending => return Err(wait),
		}
	}
	let Some(handle) = file.os_handle() else {
		sc.live = Live::None;
		return Ok(err(&unsupported()));
	};
	let key = *key;
	prune(cx.host.fs());
	// Another (virtual) process's conflicting lock: as `fcntl` answers.
	let busy = key.is_some_and(|key| {
		LOCKS
			.lock()
			.iter()
			.any(|h| h.key == key && h.owner != owner && (h.exclusive || write))
	});
	let kind = if write {
		FdLock::Exclusive
	} else {
		FdLock::Shared
	};
	let attempt = if busy {
		Err(io::ErrorKind::WouldBlock.into())
	} else {
		match cx.host.fs().lock_fd(handle, kind) {
			FsPoll::Ready(r) => r,
			FsPoll::Pending(mut fut) => match fut.poll(tcx) {
				Poll::Ready(r) => r,
				// A lock attempt does not wait; retry on the next wake.
				Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
			},
		}
	};
	match attempt {
		Ok(()) => {
			let Live::Fd(live) = std::mem::take(&mut sc.live) else {
				return Ok(err(&bad_fd()));
			};
			let FdLive::Lock { file, .. } = *live else {
				return Ok(err(&bad_fd()));
			};
			let r = FdRef::open(file, FdOrigin::Host);
			if let Some(key) = key {
				let token = r.downgrade();
				LOCKS
					.lock()
					.push(Holder { key, owner, exclusive: write, token, handle });
			}
			Ok(FdAnswer::Locked(Some(install(vp, FdSlot::Free(10), r, fd_flags))))
		},
		// zsh: without a timeout `F_SETLKW` waits; with `-t 0` a busy lock
		// is a failure; with a timeout `EAGAIN`/`EACCES` retry.
		Err(e) if e.kind() == io::ErrorKind::WouldBlock && timeout_ns != Some(0) => {
			let now = cx.host.now_ns();
			let mut next = now.saturating_add(interval_ns.max(1));
			if let Some(Deadline(end)) = *deadline {
				if now >= end {
					sc.live = Live::None;
					return Ok(FdAnswer::Locked(None));
				}
				next = next.min(end);
			}
			let mut t = cx.host.timer(Deadline(next));
			if t.poll(tcx).is_ready() {
				// Already due: try again at once on the next wake.
				tcx.waker().wake_by_ref();
				*timer = None;
			} else {
				*timer = Some(t);
			}
			Err(wait)
		},
		Err(e) => {
			sc.live = Live::None;
			Ok(err(&e))
		},
	}
}
