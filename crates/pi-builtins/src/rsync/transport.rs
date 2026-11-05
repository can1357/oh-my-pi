//! How the client reaches its peer: a remote shell child, an in-process duplex
//! for local transfers, or a TCP connection to a daemon (see [`tcp`]).
//!
//! Every stream handed out here observes the host's cancellation flag and the
//! per-connection limits in [`ConnCtl`]: a read waits in short slices, so a
//! cancelled run or an expired handshake deadline surfaces promptly instead of
//! blocking forever. Cancellation is reported as an `io::Error` carrying
//! `RsyncError { code: RERR_SIGNAL }` (never `ErrorKind::Interrupted`, which
//! `read_exact`/`write_all` would retry forever).

use std::{
	collections::VecDeque,
	ffi::{OsStr, OsString},
	io::{self, Read, Write},
	process::{Child, ExitStatus},
	sync::{
		Arc, Condvar, LazyLock, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread::JoinHandle,
	time::{Duration, Instant},
};

use crate::{
	host::{ChildEnv, os_bytes_lossy},
	rsync::{
		flists::lock,
		exit::{
			RERR_IPC, RERR_SYNTAX, RERR_TIMEOUT, RERR_WAITCHILD, RsyncError, timeout_message,
		},
		log::{Debug, LogCode, Logger, Role, syserr_text},
		mux::ReadProbe,
		paths::vec_os_lossy,
	},
};

mod tcp;

pub(crate) use tcp::{TcpConfig, connect_tcp, unknown_name_text};

/// How long one wait slice lasts before cancellation and limits are rechecked.
const SLICE: Duration = Duration::from_millis(100);
/// Capacity of each direction of the in-process duplex: what a Unix-domain socket
/// pair holds on this platform (upstream's local copies run over `fd_pair`'s
/// socketpair; 8192 bytes on macOS). The small buffer makes writers wait on readers
/// exactly as upstream's processes do, which fixes where frames meet reads.
fn pipe_capacity() -> usize {
	static CAPACITY: LazyLock<usize> = LazyLock::new(measure_socketpair);
	*CAPACITY
}

#[cfg(unix)]
fn measure_socketpair() -> usize {
	use std::os::unix::net::UnixStream;
	const FALLBACK: usize = 8192;
	let Ok((ours, _theirs)) = UnixStream::pair() else { return FALLBACK };
	if ours.set_nonblocking(true).is_err() {
		return FALLBACK;
	}
	let chunk = [0u8; 1024];
	let mut total = 0usize;
	while total < 16 * 1024 * 1024 {
		match (&ours).write(&chunk) {
			Ok(0) | Err(_) => break,
			Ok(n) => total += n,
		}
	}
	if total == 0 { FALLBACK } else { total }
}

#[cfg(not(unix))]
fn measure_socketpair() -> usize {
	8192
}
/// Upstream's argv limit (`MAX_ARGS`) and the room it keeps for server options.
const MAX_ARGS: usize = 1000;
const MAX_SERVER_ARGS: usize = 20 * 2 + 100;
/// How long `finish` waits for a child's stderr to drain after it exited
/// (a backgrounded grandchild such as an ssh control master can hold it open).
const STDERR_DRAIN: Duration = Duration::from_millis(500);

/// Characters a remote shell would interpret (`SHELL_CHARS`).
const SHELL_CHARS: &[u8] = b"!#$&;|<>(){}\"'` \t\n\r\\";
/// Wildcards a backslash may keep escaped in a file name (`WILD_CHARS`).
const WILD_CHARS: &[u8] = b"*?[]";

/// Per-connection limits the transport streams enforce while a caller waits on
/// them: an absolute deadline (`--contimeout` across a daemon-over-shell
/// handshake) and an idle timeout (`--timeout` before the multiplexed stream
/// takes over). Expiry fails the read with `ErrorKind::TimedOut` carrying the
/// exact `RsyncError` upstream exits with. Cheap to clone; clones share state.
#[derive(Clone, Default)]
pub(crate) struct ConnCtl {
	inner: Arc<Mutex<Limits>>,
}

#[derive(Default)]
struct Limits {
	deadline: Option<(Instant, RsyncError)>,
	idle:     Option<(Duration, Role)>,
}

impl ConnCtl {
	/// Fails reads and writes with `err` once `at` passes (None clears it).
	pub(crate) fn set_deadline(&self, deadline: Option<(Instant, RsyncError)>) {
		lock(&self.inner).deadline = deadline;
	}

	/// Fails a read that waited `idle` without data with upstream's
	/// `[role] io timeout after N seconds -- exiting` (None clears it).
	pub(crate) fn set_idle_timeout(&self, idle: Option<(Duration, Role)>) {
		lock(&self.inner).idle = idle;
	}

	/// How long the caller may wait before rechecking; fails when cancelled or
	/// when a limit expired. `started` is when the current wait began.
	fn slice(&self, cancel: &AtomicBool, started: Instant, reading: bool) -> io::Result<Duration> {
		if cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled_io());
		}
		let limits = lock(&self.inner);
		let now = Instant::now();
		let mut wait = SLICE;
		if let Some((at, err)) = &limits.deadline {
			if now >= *at {
				return Err(io::Error::new(io::ErrorKind::TimedOut, err.clone()));
			}
			wait = wait.min(*at - now);
		}
		if reading && let Some((idle, role)) = limits.idle {
			let waited = now.saturating_duration_since(started);
			if waited >= idle {
				let err = RsyncError::new(RERR_TIMEOUT, timeout_message(waited.as_secs(), role))
					.at("io.c", 266);
				return Err(io::Error::new(io::ErrorKind::TimedOut, err));
			}
			wait = wait.min(idle - waited);
		}
		Ok(wait.max(Duration::from_millis(1)))
	}
}

/// The longest prefix of `s` that fits `max` bytes (C `strlcpy`).
pub(crate) fn truncate(s: &str, max: usize) -> &str {
	&s[..s.floor_char_boundary(max)]
}

/// A bidirectional byte stream to the peer.
pub(crate) struct Connection {
	pub reader: Box<dyn Read + Send>,
	pub writer: Box<dyn Write + Send>,
	/// Whether `reader` would return at once (data or EOF waiting), without
	/// reading; None when the stream cannot tell.
	pub probe:  Option<ReadProbe>,
	/// Remote-shell (or connect-program) process; killed on drop or cancel,
	/// reaped by [`Connection::finish`].
	pub child:  Option<ChildGuard>,
	/// Limits enforced by `reader`/`writer` when they were created here.
	pub ctl:    ConnCtl,
}

impl Connection {
	/// Closes both directions, then waits for the remote-shell child (if any)
	/// and maps its status like upstream: a non-zero exit code becomes the run's
	/// exit code verbatim (127 = RERR_CMD_NOTFOUND, 255 = "unexplained error",
	/// …), a signal RERR_TERMINATED, a core dump RERR_CRASHED.
	pub(crate) fn finish(self) -> Result<(), RsyncError> {
		let Self { reader, writer, child, .. } = self;
		drop(writer);
		drop(reader);
		match child {
			Some(child) => child.wait(),
			None => Ok(()),
		}
	}

	/// The child's exit code if it has already exited (signals count as 0),
	/// without waiting: upstream folds it into the final exit code when it is
	/// higher than the code the run is exiting with.
	pub(crate) fn child_exit_code(&self) -> Option<i32> {
		self.child.as_ref().and_then(ChildGuard::exit_code_now)
	}
}

/// A spawned helper process: the remote shell or `RSYNC_CONNECT_PROG`.
pub(crate) struct ChildGuard {
	child:    Arc<Mutex<Child>>,
	cancel:   Arc<AtomicBool>,
	stderr:   Option<JoinHandle<()>>,
	/// Dropping it stops the watchdog.
	stop:     Option<flume::Sender<()>>,
	watchdog: Option<JoinHandle<()>>,
	/// Upstream never waits on a connect-program child, so its status is not
	/// reported.
	report:   bool,
	reaped:   bool,
	role:     Role,
}

impl ChildGuard {
	/// Takes ownership of `child`, forwarding its stderr through `env` and
	/// killing it as soon as `cancel` rises.
	fn new(
		env: &ChildEnv,
		mut child: Child,
		cancel: Arc<AtomicBool>,
		report: bool,
		role: Role,
	) -> Self {
		let stderr = child.stderr.take().map(|err| env.forward_stderr(err));
		let child = Arc::new(Mutex::new(child));
		let (stop, stopped) = flume::bounded::<()>(1);
		let watchdog = {
			let child = Arc::clone(&child);
			let cancel = Arc::clone(&cancel);
			std::thread::Builder::new()
				.name("rsync-child-watchdog".into())
				.spawn(move || {
					loop {
						match stopped.recv_timeout(Duration::from_millis(50)) {
							Err(flume::RecvTimeoutError::Timeout) => {
								if cancel.load(Ordering::Relaxed) {
									let _ = lock(&child).kill();
									return;
								}
							}
							_ => return,
						}
					}
				})
				.ok()
		};
		Self {
			child,
			cancel,
			stderr,
			stop: Some(stop),
			watchdog,
			report,
			reaped: false,
			role,
		}
	}

	/// `WEXITSTATUS` of an already exited child (0 after a signal), else None.
	pub(crate) fn exit_code_now(&self) -> Option<i32> {
		let status = lock(&self.child).try_wait().ok().flatten()?;
		Some(status.code().unwrap_or(0))
	}

	/// Waits for the child, observing cancellation, then maps its status.
	fn wait(mut self) -> Result<(), RsyncError> {
		let status = loop {
			if self.cancel.load(Ordering::Relaxed) {
				let mut child = lock(&self.child);
				let _ = child.kill();
				let _ = child.wait();
				self.reaped = true;
				return Err(RsyncError::cancelled());
			}
			match lock(&self.child).try_wait() {
				Ok(Some(status)) => break Ok(status),
				Ok(None) => {}
				Err(err) => break Err(err),
			}
			std::thread::sleep(Duration::from_millis(20));
		};
		self.reaped = true;
		self.stop_watchdog();
		self.drain_stderr();
		match status {
			Ok(status) if self.report => map_status(status),
			Ok(_) => Ok(()),
			Err(err) => Err(RsyncError::new(RERR_WAITCHILD, syserr_text(self.role, &err, "waitpid"))),
		}
	}

	fn stop_watchdog(&mut self) {
		self.stop.take();
		if let Some(handle) = self.watchdog.take() {
			let _ = handle.join();
		}
	}

	/// Lets the stderr forwarder finish so the child's last words land before
	/// ours, without hanging on a descendant that keeps the pipe open.
	fn drain_stderr(&mut self) {
		if let Some(handle) = self.stderr.take() {
			let until = Instant::now() + STDERR_DRAIN;
			while !handle.is_finished() && Instant::now() < until {
				std::thread::sleep(Duration::from_millis(5));
			}
			if handle.is_finished() {
				let _ = handle.join();
			}
		}
	}
}

impl Drop for ChildGuard {
	fn drop(&mut self) {
		if !self.reaped {
			let mut child = lock(&self.child);
			if !matches!(child.try_wait(), Ok(Some(_))) {
				let _ = child.kill();
				let _ = child.wait();
			}
		}
		self.stop_watchdog();
	}
}

/// Upstream's child-status mapping (`wait_process_with_flush`).
fn map_status(status: ExitStatus) -> Result<(), RsyncError> {
	if status.success() {
		return Ok(());
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;

		use crate::rsync::exit::{RERR_CRASHED, RERR_TERMINATED};
		if status.signal().is_some() {
			let code = if status.core_dumped() { RERR_CRASHED } else { RERR_TERMINATED };
			return Err(RsyncError::bare(code));
		}
	}
	Err(RsyncError::bare(status.code().unwrap_or(RERR_WAITCHILD)))
}

// ---------------------------------------------------------------------------
// Streams.

/// A socket the transport owns: TCP everywhere, Unix-domain on unix.
enum Sock {
	Tcp(std::net::TcpStream),
	#[cfg(unix)]
	Unix(std::os::unix::net::UnixStream),
}

impl Sock {
	/// Our end becomes non-blocking: a write takes what the socket buffer has room
	/// for and returns (upstream's fds are non-blocking too), and the waits stay in
	/// [`Sock::ready`].
	fn set_nonblocking(&self) -> io::Result<()> {
		match self {
			Self::Tcp(s) => s.set_nonblocking(true),
			#[cfg(unix)]
			Self::Unix(s) => s.set_nonblocking(true),
		}
	}

	#[cfg(unix)]
	fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
		use std::os::fd::AsFd;
		match self {
			Self::Tcp(s) => s.as_fd(),
			Self::Unix(s) => s.as_fd(),
		}
	}

	/// Waits up to `timeout` for readability (or writability); EINTR counts
	/// as "not yet".
	#[cfg(unix)]
	fn ready(&self, write: bool, timeout: Duration) -> io::Result<bool> {
		use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
		let flags = if write { PollFlags::POLLOUT } else { PollFlags::POLLIN };
		let mut fds = [PollFd::new(self.fd(), flags)];
		let ms = u16::try_from(timeout.as_millis()).unwrap_or(u16::MAX);
		match poll(&mut fds, PollTimeout::from(ms)) {
			Ok(n) => Ok(n > 0),
			Err(nix::errno::Errno::EINTR) => Ok(false),
			Err(err) => Err(io::Error::from(err)),
		}
	}

	#[cfg(windows)]
	fn ready(&self, write: bool, timeout: Duration) -> io::Result<bool> {
		use std::os::windows::io::AsRawSocket;

		use windows_sys::Win32::Networking::WinSock::{
			POLLRDNORM, POLLWRNORM, SOCKET_ERROR, WSAPOLLFD, WSAPoll,
		};
		let Self::Tcp(sock) = self;
		let mut fd = WSAPOLLFD {
			fd:      sock.as_raw_socket() as usize,
			events:  if write { POLLWRNORM } else { POLLRDNORM },
			revents: 0,
		};
		let ms = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
		// SAFETY: `fd` is one initialised WSAPOLLFD that outlives the call.
		let n = unsafe { WSAPoll(&mut fd, 1, ms) };
		if n == SOCKET_ERROR { Err(io::Error::last_os_error()) } else { Ok(n > 0) }
	}

	fn read_now(&self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Tcp(s) => (&mut &*s).read(buf),
			#[cfg(unix)]
			Self::Unix(s) => (&mut &*s).read(buf),
		}
	}

	/// One send that never raises SIGPIPE.
	#[cfg(unix)]
	fn write_now(&self, buf: &[u8]) -> io::Result<usize> {
		use std::os::fd::AsRawFd;
		#[cfg(any(target_os = "linux", target_os = "android"))]
		const FLAGS: libc::c_int = libc::MSG_NOSIGNAL;
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		const FLAGS: libc::c_int = 0;
		// SAFETY: the fd is owned by `self` and `buf` is a valid readable slice.
		let n = unsafe { libc::send(self.fd().as_raw_fd(), buf.as_ptr().cast(), buf.len(), FLAGS) };
		if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n.unsigned_abs()) }
	}

	#[cfg(windows)]
	fn write_now(&self, buf: &[u8]) -> io::Result<usize> {
		let Self::Tcp(s) = self;
		(&mut &*s).write(buf)
	}
}

/// Platforms where SIGPIPE is suppressed per socket rather than per send.
#[cfg(unix)]
fn no_sigpipe(fd: std::os::fd::BorrowedFd<'_>) {
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	{
		use std::os::fd::AsRawFd;
		let on: libc::c_int = 1;
		// SAFETY: valid fd; `on` lives across the call with the size passed.
		unsafe {
			libc::setsockopt(
				fd.as_raw_fd(),
				libc::SOL_SOCKET,
				libc::SO_NOSIGPIPE,
				(&raw const on).cast(),
				std::mem::size_of::<libc::c_int>() as libc::socklen_t,
			);
		}
	}
	#[cfg(not(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	)))]
	let _ = fd;
}

/// Read half over a socket.
struct SockReader {
	sock:   Arc<Sock>,
	cancel: Arc<AtomicBool>,
	ctl:    ConnCtl,
}

impl Read for SockReader {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let started = Instant::now();
		loop {
			let wait = self.ctl.slice(&self.cancel, started, true)?;
			if !self.sock.ready(false, wait)? {
				continue;
			}
			match self.sock.read_now(buf) {
				Ok(n) => {
					if n == 0 && self.cancel.load(Ordering::Relaxed) {
						return Err(RsyncError::cancelled_io());
					}
					return Ok(n);
				}
				Err(err) if retryable(&err) => {}
				Err(err) => {
					return Err(if self.cancel.load(Ordering::Relaxed) {
						RsyncError::cancelled_io()
					} else {
						err
					});
				}
			}
		}
	}
}

/// Write half over a socket.
struct SockWriter {
	sock:   Arc<Sock>,
	cancel: Arc<AtomicBool>,
	ctl:    ConnCtl,
}

impl Write for SockWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let started = Instant::now();
		loop {
			let wait = self.ctl.slice(&self.cancel, started, false)?;
			if !self.sock.ready(true, wait)? {
				continue;
			}
			match self.sock.write_now(buf) {
				Ok(n) => return Ok(n),
				Err(err) if retryable(&err) => {}
				Err(err) => {
					return Err(if self.cancel.load(Ordering::Relaxed) {
						RsyncError::cancelled_io()
					} else {
						err
					});
				}
			}
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

fn retryable(err: &io::Error) -> bool {
	matches!(err.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock)
}

/// Reader and writer over one socket, sharing `ctl`, plus a readiness probe (a
/// zero-timeout poll).
fn sock_halves(
	sock: Sock,
	cancel: &Arc<AtomicBool>,
	ctl: &ConnCtl,
) -> (Box<dyn Read + Send>, Box<dyn Write + Send>, ReadProbe) {
	// Best effort: a socket left blocking still works, only with whole writes.
	let _ = sock.set_nonblocking();
	let sock = Arc::new(sock);
	let reader =
		SockReader { sock: Arc::clone(&sock), cancel: Arc::clone(cancel), ctl: ctl.clone() };
	// Weak: the probe must not keep the socket open once both halves are gone
	// (a child such as `cat` waits for that EOF).
	let probed = Arc::downgrade(&sock);
	let probe: ReadProbe = Arc::new(move || {
		probed.upgrade().is_none_or(|sock| sock.ready(false, Duration::ZERO).unwrap_or(true))
	});
	let writer = SockWriter { sock, cancel: Arc::clone(cancel), ctl: ctl.clone() };
	(Box::new(reader), Box::new(writer), probe)
}

/// One direction of the in-process duplex.
struct Pipe {
	state:   Mutex<PipeState>,
	changed: Condvar,
}

#[derive(Default)]
struct PipeState {
	buf:           VecDeque<u8>,
	writer_closed: bool,
	reader_closed: bool,
}

struct PipeReader {
	pipe:   Arc<Pipe>,
	cancel: Arc<AtomicBool>,
	ctl:    ConnCtl,
}

impl Read for PipeReader {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let started = Instant::now();
		let mut state = lock(&self.pipe.state);
		loop {
			if !state.buf.is_empty() {
				let n = buf.len().min(state.buf.len());
				for (dst, src) in buf.iter_mut().zip(state.buf.drain(..n)) {
					*dst = src;
				}
				self.pipe.changed.notify_all();
				return Ok(n);
			}
			if state.writer_closed {
				return Ok(0);
			}
			let wait = self.ctl.slice(&self.cancel, started, true)?;
			state = self
				.pipe
				.changed
				.wait_timeout(state, wait)
				.unwrap_or_else(std::sync::PoisonError::into_inner)
				.0;
		}
	}
}

impl Drop for PipeReader {
	fn drop(&mut self) {
		lock(&self.pipe.state).reader_closed = true;
		self.pipe.changed.notify_all();
	}
}

struct PipeWriter {
	pipe:   Arc<Pipe>,
	cancel: Arc<AtomicBool>,
	ctl:    ConnCtl,
}

impl Write for PipeWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		if self.cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled_io());
		}
		let started = Instant::now();
		let mut state = lock(&self.pipe.state);
		loop {
			if state.reader_closed {
				return Err(io::Error::from(io::ErrorKind::BrokenPipe));
			}
			let room = pipe_capacity().saturating_sub(state.buf.len());
			if room > 0 {
				let n = room.min(buf.len());
				state.buf.extend(&buf[..n]);
				self.pipe.changed.notify_all();
				return Ok(n);
			}
			let wait = self.ctl.slice(&self.cancel, started, false)?;
			state = self
				.pipe
				.changed
				.wait_timeout(state, wait)
				.unwrap_or_else(std::sync::PoisonError::into_inner)
				.0;
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

impl Drop for PipeWriter {
	fn drop(&mut self) {
		lock(&self.pipe.state).writer_closed = true;
		self.pipe.changed.notify_all();
	}
}

/// In-process duplex pair for local transfers (client half, server half).
///
/// Each direction is a bounded in-memory pipe: dropping a writer is EOF for
/// the other side's reader, dropping a reader makes the other side's writes
/// fail with `BrokenPipe`, and raising `cancel` fails every blocked or later
/// operation on both halves promptly.
pub(crate) fn local_pair(cancel: Arc<AtomicBool>) -> (Connection, Connection) {
	let half = |cancel: &Arc<AtomicBool>, ctl: &ConnCtl, inbound: &Arc<Pipe>, outbound: &Arc<Pipe>| {
		let reader =
			PipeReader { pipe: Arc::clone(inbound), cancel: Arc::clone(cancel), ctl: ctl.clone() };
		let writer =
			PipeWriter { pipe: Arc::clone(outbound), cancel: Arc::clone(cancel), ctl: ctl.clone() };
		let probed = Arc::clone(inbound);
		let probe: ReadProbe = Arc::new(move || {
			let state = lock(&probed.state);
			!state.buf.is_empty() || state.writer_closed
		});
		Connection {
			reader: Box::new(reader),
			writer: Box::new(writer),
			probe:  Some(probe),
			child:  None,
			ctl:    ctl.clone(),
		}
	};
	let new_pipe =
		|| Arc::new(Pipe { state: Mutex::new(PipeState::default()), changed: Condvar::new() });
	let to_server = new_pipe();
	let to_client = new_pipe();
	let client = half(&cancel, &ConnCtl::default(), &to_client, &to_server);
	let server = half(&cancel, &ConnCtl::default(), &to_server, &to_client);
	(client, server)
}

/// Reader over a child's stdout pipe on Windows, where anonymous pipes cannot
/// be polled: a pump thread blocks in `read` and hands chunks over a channel
/// the caller waits on in slices.
#[cfg(windows)]
struct PumpReader {
	rx:      flume::Receiver<io::Result<Vec<u8>>>,
	pending: Vec<u8>,
	pos:     usize,
	cancel:  Arc<AtomicBool>,
	ctl:     ConnCtl,
}

#[cfg(windows)]
impl PumpReader {
	fn new<R: Read + Send + 'static>(mut src: R, cancel: Arc<AtomicBool>, ctl: ConnCtl) -> Self {
		let (tx, rx) = flume::bounded::<io::Result<Vec<u8>>>(4);
		let _ = std::thread::Builder::new().name("rsync-pipe-pump".into()).spawn(move || {
			let mut buf = vec![0u8; 64 * 1024];
			loop {
				match src.read(&mut buf) {
					Ok(0) => return,
					Ok(n) => {
						if tx.send(Ok(buf[..n].to_vec())).is_err() {
							return;
						}
					}
					Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
					Err(err) => {
						let _ = tx.send(Err(err));
						return;
					}
				}
			}
		});
		Self { rx, pending: Vec::new(), pos: 0, cancel, ctl }
	}
}

#[cfg(windows)]
impl Read for PumpReader {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let started = Instant::now();
		while self.pos == self.pending.len() {
			let wait = self.ctl.slice(&self.cancel, started, true)?;
			match self.rx.recv_timeout(wait) {
				Ok(Ok(chunk)) => {
					self.pending = chunk;
					self.pos = 0;
				}
				Ok(Err(err)) => return Err(err),
				Err(flume::RecvTimeoutError::Timeout) => {}
				Err(flume::RecvTimeoutError::Disconnected) => {
					return if self.cancel.load(Ordering::Relaxed) {
						Err(RsyncError::cancelled_io())
					} else {
						Ok(0)
					};
				}
			}
		}
		let n = buf.len().min(self.pending.len() - self.pos);
		buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
		self.pos += n;
		Ok(n)
	}
}

/// Writer over a child's stdin pipe on Windows; cancellation kills the child
/// (watchdog), which breaks a blocked write.
#[cfg(windows)]
struct ChildWriter {
	pipe:   std::process::ChildStdin,
	cancel: Arc<AtomicBool>,
}

#[cfg(windows)]
impl Write for ChildWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if self.cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled_io());
		}
		self.pipe.write(buf).map_err(|err| {
			if self.cancel.load(Ordering::Relaxed) { RsyncError::cancelled_io() } else { err }
		})
	}

	fn flush(&mut self) -> io::Result<()> {
		self.pipe.flush()
	}
}

// ---------------------------------------------------------------------------
// Remote shell.

/// Splits a -e / RSYNC_RSH command like upstream: words are separated by
/// spaces only; single or double quotes group (a doubled quote character
/// inside quotes is a literal quote); backslashes are not special.
pub(crate) fn split_rsh(cmd: &str) -> Result<Vec<String>, RsyncError> {
	let bytes = cmd.as_bytes();
	let mut words = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b' ' {
			i += 1;
			continue;
		}
		if words.len() >= MAX_ARGS - MAX_SERVER_ARGS {
			return Err(args_overflow());
		}
		let mut word = Vec::new();
		let mut quote: Option<u8> = None;
		while let Some(&c) = bytes.get(i) {
			if quote.is_none() && c == b' ' {
				break;
			}
			if c == b'\'' || c == b'"' {
				match quote {
					None => {
						quote = Some(c);
						i += 1;
						continue;
					}
					Some(q) if q == c => {
						if bytes.get(i + 1) == Some(&c) {
							word.push(c);
							i += 2;
						} else {
							quote = None;
							i += 1;
						}
						continue;
					}
					Some(_) => {}
				}
			}
			word.push(c);
			i += 1;
		}
		if let Some(q) = quote {
			return Err(RsyncError::new(
				RERR_SYNTAX,
				format!("Missing trailing-{} in remote-shell command.", char::from(q)),
			)
			.at("main.c", 560));
		}
		// Splitting happens at ASCII bytes, so each word is still valid UTF-8.
		words.push(String::from_utf8_lossy_owned(word));
	}
	Ok(words)
}

fn args_overflow() -> RsyncError {
	RsyncError::new(RERR_SYNTAX, "internal: args[] overflowed in do_cmd()").at("main.c", 637)
}

/// Remote-shell spawn settings.
///
/// The remote command is `rsync_path --server [--sender] REMOTE_ARGV… . FILES…`
/// (or `rsync_path --server --daemon .` for a daemon over the shell), run as
/// `RSH-WORDS [-l USER] [-4|-6] HOST REMOTE-COMMAND…`.
pub(crate) struct ShellConfig<'a> {
	/// The resolved remote-shell command (`-e`, else `RSYNC_RSH`, else `ssh`).
	pub rsh:               &'a str,
	pub user:              Option<&'a str>,
	pub host:              &'a str,
	/// Server options after `--server [--sender]`, as `options::server_args`
	/// built them (option values already escaped). Ignored for `daemon`.
	pub remote_argv:       &'a [OsString],
	/// `--blocking-io` (also implied for an `rsh`/`remsh` shell).
	pub blocking_io:       bool,
	/// `--old-args`: file operands are not backslash-escaped.
	pub old_args:          bool,
	/// `--secluded-args`: the arguments from `secluded_cut` on (plus `.` and the
	/// file operands) go over the pipe instead of the command line.
	pub secluded_args:     bool,
	/// `--rsync-path` (default `rsync`), passed as one word.
	pub rsync_path:        &'a OsStr,
	/// The remote side is the sender (adds `--sender`).
	pub remote_is_sender:  bool,
	/// Start `rsync --server --daemon .` for a daemon over the remote shell.
	pub daemon:            bool,
	/// Where `options::server_args_split` cut the server options for
	/// `--secluded-args` (`None`: after all of them).
	pub secluded_cut:      Option<usize>,
	/// Remote file operands (host prefix stripped), escaped here.
	pub files:             &'a [OsString],
	/// `--trust-sender` (or anything implying trusted sender args).
	pub trust_sender_args: bool,
	/// `--relative`.
	pub relative_paths:    bool,
	/// `-4`/`-6` (0 = any); forwarded to a shell named `ssh`.
	pub af_hint:           u8,
	/// Extra environment for the shell (upstream exports `RSYNC_PORT` for a
	/// daemon over the shell).
	pub env:               &'a [(String, String)],
	pub logger:            &'a Logger,
}

/// How a remote file operand is escaped for the remote shell (`safe_arg`
/// with no option name).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FileArgRules {
	/// Backslash-escape shell metacharacters (off for `--old-args` and
	/// `--secluded-args`).
	pub escape:            bool,
	/// The local side sends (remote operands are destinations).
	pub am_sender:         bool,
	pub trust_sender_args: bool,
	pub relative_paths:    bool,
}

/// Escapes one remote file operand exactly like upstream's `safe_arg(NULL, …)`:
/// a leading `-` gains `./`; with escaping on, shell metacharacters (including
/// newline and CR) get a backslash, an existing backslash is doubled unless it
/// escapes a wildcard, and a leading `~` is escaped when the remote side would
/// otherwise expand it for a path we did not ask to trust.
pub(crate) fn safe_file_arg(arg: &[u8], rules: FileArgRules) -> Vec<u8> {
	let mut out = Vec::with_capacity(arg.len() + 8);
	if arg.first() == Some(&b'-') {
		out.extend_from_slice(b"./");
	}
	if !rules.escape {
		out.extend_from_slice(arg);
		return out;
	}
	let tilde = arg.first() == Some(&b'~')
		&& !rules.am_sender
		&& !rules.trust_sender_args
		&& ((rules.relative_paths && !arg.array_windows().any(|w| w == b"/./")) || !arg.contains(&b'/'));
	if tilde {
		out.push(b'\\');
	}
	escape_shell_arg(&mut out, arg, true);
	out
}

/// Appends `arg` to `out` with upstream `safe_arg`'s backslash escaping: shell
/// metacharacters always, wildcards too unless `is_filename` (where an existing
/// backslash that escapes a wildcard is kept as is instead of being doubled).
pub(crate) fn escape_shell_arg(out: &mut Vec<u8>, arg: &[u8], is_filename: bool) {
	for (i, &c) in arg.iter().enumerate() {
		if c == b'\\' {
			let wild_next = arg.get(i + 1).is_some_and(|next| WILD_CHARS.contains(next));
			if !is_filename || !wild_next {
				out.push(b'\\');
			}
		} else if SHELL_CHARS.contains(&c) || (!is_filename && WILD_CHARS.contains(&c)) {
			out.push(b'\\');
		}
		out.push(c);
	}
}

/// The remote-shell invocation upstream's `do_cmd` builds.
struct ShellArgv {
	argv:     Vec<OsString>,
	/// Arguments sent over the pipe for `--secluded-args` (empty when none).
	secluded: Vec<Vec<u8>>,
	/// The shell is `rsh`/`remsh`, which implies `--blocking-io`.
	rsh_like: bool,
}

fn shell_argv(cfg: &ShellConfig<'_>) -> Result<ShellArgv, RsyncError> {
	let words = split_rsh(cfg.rsh)?;
	let base = words.first().map_or("", |w| shell_basename(w));
	let rsh_like = base == "rsh" || base == "remsh";
	let dash_l_set = words.array_windows().any(|[flag, value]| flag == "-l" && !value.starts_with('-'));

	let mut argv: Vec<OsString> = words.iter().map(OsString::from).collect();
	if let Some(user) = cfg.user
		&& !(cfg.daemon && dash_l_set)
	{
		argv.push("-l".into());
		argv.push(user.into());
	}
	if base == "ssh" {
		match cfg.af_hint {
			4 => argv.push("-4".into()),
			6 => argv.push("-6".into()),
			_ => {}
		}
	}
	argv.push(cfg.host.into());
	argv.push(cfg.rsync_path.to_os_string());

	let mut secluded = Vec::new();
	if cfg.daemon {
		argv.push("--server".into());
		argv.push("--daemon".into());
		argv.push(".".into());
		return Ok(ShellArgv { argv, secluded, rsh_like });
	}
	argv.push("--server".into());
	if cfg.remote_is_sender {
		argv.push("--sender".into());
	}
	let cut = if cfg.secluded_args {
		cfg.secluded_cut.unwrap_or(cfg.remote_argv.len()).min(cfg.remote_argv.len())
	} else {
		cfg.remote_argv.len()
	};
	if argv.len() + cfg.remote_argv.len() + 1 + cfg.files.len() > MAX_ARGS - 1 {
		return Err(args_overflow());
	}
	argv.extend(cfg.remote_argv[..cut].iter().cloned());
	let rules = FileArgRules {
		escape:            !cfg.old_args && !cfg.secluded_args,
		am_sender:         !cfg.remote_is_sender,
		trust_sender_args: cfg.trust_sender_args,
		relative_paths:    cfg.relative_paths,
	};
	let files = cfg.files.iter().map(|f| safe_file_arg(&os_bytes_lossy(f), rules));
	if cfg.secluded_args {
		secluded.push(b"rsync".to_vec());
		secluded.extend(cfg.remote_argv[cut..].iter().map(|a| os_bytes_lossy(a).into_owned()));
		secluded.push(b".".to_vec());
		secluded.extend(files);
	} else {
		argv.push(".".into());
		argv.extend(files.map(vec_os_lossy));
	}
	Ok(ShellArgv { argv, secluded, rsh_like })
}

/// The command name upstream compares against `ssh`/`rsh`/`remsh`.
fn shell_basename(word: &str) -> &str {
	let base = word.rsplit('/').next().unwrap_or(word);
	if cfg!(windows) {
		let base = base.rsplit('\\').next().unwrap_or(base);
		let len = base.len();
		if len > 4
			&& let Some((stem, ext)) = base.split_at_checked(len - 4)
			&& ext.eq_ignore_ascii_case(".exe")
		{
			return stem;
		}
		return base;
	}
	base
}

/// `print_child_argv`: `PREFIX arg "quoted arg" … (N args)`.
pub(crate) fn child_argv_line(prefix: &str, args: &[&[u8]]) -> Vec<u8> {
	let size = prefix.len() + 16 + args.iter().map(|a| a.len() + 3).sum::<usize>();
	let mut out = Vec::with_capacity(size);
	out.extend_from_slice(prefix.as_bytes());
	out.push(b' ');
	for arg in args {
		let plain = arg.iter().all(|b| b.is_ascii_alphanumeric() || b",.-_=+@/".contains(b));
		if plain {
			out.extend_from_slice(arg);
			out.push(b' ');
		} else {
			out.push(b'"');
			out.extend_from_slice(arg);
			out.extend_from_slice(b"\" ");
		}
	}
	out.extend_from_slice(format!(" ({} args)\n", args.len()).as_bytes());
	out
}

/// The NUL-terminated stream `--secluded-args` sends (an empty argument goes
/// as `.`), ending with an empty string.
pub(crate) fn secluded_stream(args: &[Vec<u8>]) -> Vec<u8> {
	let mut out = Vec::with_capacity(args.iter().map(|a| a.len() + 2).sum::<usize>() + 1);
	for arg in args {
		if arg.is_empty() {
			out.push(b'.');
		} else {
			out.extend_from_slice(arg);
		}
		out.push(0);
	}
	out.push(0);
	out
}

/// Remote-shell spawn: argv = rsh words + [-l user] + host + remote command
/// words (quoted per --old-args/-s rules). For `--secluded-args` the protected
/// arguments are written to the shell's stdin before returning.
pub(crate) fn spawn_shell(
	env: &ChildEnv,
	cfg: &ShellConfig<'_>,
	cancel: Arc<AtomicBool>,
) -> Result<Connection, RsyncError> {
	let ShellArgv { argv, secluded, rsh_like } = shell_argv(cfg)?;
	let logger = cfg.logger;
	let role = logger.role();
	let levels = logger.levels();
	if levels.debug(Debug::Cmd) >= 2 {
		// Upstream prints its whole args[] array, the secluded-args cut
		// included (as "(null)").
		let mut line = Vec::new();
		let mut all: Vec<Vec<u8>> = argv.iter().map(|a| os_bytes_lossy(a).into_owned()).collect();
		if !secluded.is_empty() {
			all.push(b"(null)".to_vec());
			all.extend(secluded.iter().skip(1).cloned());
		}
		for (i, arg) in all.iter().enumerate() {
			line.extend_from_slice(format!("cmd[{i}]=").as_bytes());
			line.extend_from_slice(arg);
			line.push(b' ');
		}
		line.push(b'\n');
		logger.rprintf(LogCode::Client, &line);
	}
	if levels.debug(Debug::Cmd) >= 1 {
		let shown: Vec<Vec<u8>> = argv.iter().map(|a| os_bytes_lossy(a).into_owned()).collect();
		let refs: Vec<&[u8]> = shown.iter().map(Vec::as_slice).collect();
		logger.rprintf(LogCode::Client, &child_argv_line("opening connection using:", &refs));
	}

	let program = &argv[0];
	let exec_error = |err: &io::Error| {
		RsyncError::new(
			RERR_IPC,
			syserr_text(role, err, &format!("Failed to exec {}", program.display())),
		)
		.at("pipe.c", 85)
	};
	let mut cmd = env.command(program).map_err(|err| exec_error(&err))?;
	cmd.args(&argv[1..]);
	cmd.envs(cfg.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
	let blocking = cfg.blocking_io || rsh_like;

	let ctl = ConnCtl::default();
	let mut conn = spawn_piped(env, cmd, blocking, &cancel, &ctl, true, role)
		.map_err(|err| exec_error(&err))?;

	if !secluded.is_empty() {
		if levels.debug(Debug::Cmd) >= 1 {
			let refs: Vec<&[u8]> = secluded[1..].iter().map(Vec::as_slice).collect();
			logger.rprintf(LogCode::Client, &child_argv_line("protected args:", &refs));
		}
		let stream = secluded_stream(&secluded);
		conn.writer
			.write_all(&stream)
			.and_then(|()| conn.writer.flush())
			.map_err(RsyncError::from_stream)?;
	}
	Ok(conn)
}

/// Spawns `cmd` with its stdin/stdout connected to us: Unix-domain socket
/// pairs on unix (like upstream's `fd_pair`), pipes on Windows.
fn spawn_piped(
	env: &ChildEnv,
	mut cmd: std::process::Command,
	blocking: bool,
	cancel: &Arc<AtomicBool>,
	ctl: &ConnCtl,
	report: bool,
	role: Role,
) -> io::Result<Connection> {
	#[cfg(unix)]
	{
		use std::os::{fd::OwnedFd, unix::net::UnixStream};
		let (ours_to, theirs_in) = UnixStream::pair()?;
		let (ours_from, theirs_out) = UnixStream::pair()?;
		// The child's stdin is always blocking; its stdout too when asked
		// (fresh socket pairs start out blocking either way).
		theirs_in.set_nonblocking(false)?;
		if blocking {
			theirs_out.set_nonblocking(false)?;
		}
		no_sigpipe(std::os::fd::AsFd::as_fd(&ours_to));
		cmd.stdin(std::process::Stdio::from(OwnedFd::from(theirs_in)));
		cmd.stdout(std::process::Stdio::from(OwnedFd::from(theirs_out)));
		let child = cmd.spawn();
		drop(cmd);
		let child = child?;
		let (reader, _, probe) = sock_halves(Sock::Unix(ours_from), cancel, ctl);
		let (_, writer, _) = sock_halves(Sock::Unix(ours_to), cancel, ctl);
		Ok(Connection {
			reader,
			writer,
			probe: Some(probe),
			child: Some(ChildGuard::new(env, child, Arc::clone(cancel), report, role)),
			ctl: ctl.clone(),
		})
	}
	#[cfg(windows)]
	{
		let _ = blocking;
		cmd.stdin(std::process::Stdio::piped());
		cmd.stdout(std::process::Stdio::piped());
		let mut child = cmd.spawn()?;
		drop(cmd);
		let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
			let _ = child.kill();
			let _ = child.wait();
			return Err(io::Error::other("child pipes missing"));
		};
		let reader = PumpReader::new(stdout, Arc::clone(cancel), ctl.clone());
		let pumped = reader.rx.clone();
		let probe: ReadProbe = Arc::new(move || !pumped.is_empty() || pumped.is_disconnected());
		let writer = ChildWriter { pipe: stdin, cancel: Arc::clone(cancel) };
		Ok(Connection {
			reader: Box::new(reader),
			writer: Box::new(writer),
			probe:  Some(probe),
			child:  Some(ChildGuard::new(env, child, Arc::clone(cancel), report, role)),
			ctl:    ctl.clone(),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::exit::RERR_SIGNAL;

	#[test]
	fn split_rsh_follows_upstream_quoting() {
		let cases: &[(&str, &[&str])] = &[
			("ssh", &["ssh"]),
			("  ssh   -p 22  ", &["ssh", "-p", "22"]),
			("ssh -o 'ProxyCommand nc %h %p'", &["ssh", "-o", "ProxyCommand nc %h %p"]),
			("ssh -o \"A B\"x", &["ssh", "-o", "A Bx"]),
			("a\"b c\"d", &["ab cd"]),
			("'it''s'", &["it's"]),
			("\"say \"\"hi\"\"\"", &["say \"hi\""]),
			("'a\"b'", &["a\"b"]),
			("back\\slash 'x\\y'", &["back\\slash", "x\\y"]),
			("ssh ''", &["ssh", ""]),
			("tab\tsep", &["tab\tsep"]),
			("", &[]),
		];
		for (cmd, want) in cases {
			assert_eq!(split_rsh(cmd).unwrap(), *want, "{cmd:?}");
		}
	}

	#[test]
	fn split_rsh_rejects_unterminated_quotes() {
		let err = split_rsh("ssh -o 'oops").unwrap_err();
		assert_eq!(err.code, RERR_SYNTAX);
		assert_eq!(err.message.as_deref(), Some("Missing trailing-' in remote-shell command."));
		assert_eq!(err.site, Some(("main.c", 560)));
		let err = split_rsh("ssh \"x").unwrap_err();
		assert_eq!(err.message.as_deref(), Some("Missing trailing-\" in remote-shell command."));
	}

	fn rules(escape: bool, am_sender: bool) -> FileArgRules {
		FileArgRules { escape, am_sender, trust_sender_args: false, relative_paths: false }
	}

	/// Expected strings are what rsync 3.5.1 put on the remote command line
	/// (captured with an argv-dumping `-e` script).
	#[test]
	fn safe_file_arg_matches_reference() {
		let pull = rules(true, false);
		let cases: &[(&[u8], FileArgRules, &[u8])] = &[
			(b"a b*c", pull, b"a\\ b*c"),
			(b"-y", pull, b"./-y"),
			(b"$z;q", pull, b"\\$z\\;q"),
			(b"a\nb", pull, b"a\\\nb"),
			(b"c\rd", pull, b"c\\\rd"),
			(b"~x", rules(true, true), b"~x"),
			(b"~x", pull, b"\\~x"),
			(b"~/x", pull, b"~/x"),
			(b"it's \"q\"", pull, b"it\\'s\\ \\\"q\\\""),
			(b"a\\*b", pull, b"a\\*b"),
			(b"a\\b", pull, b"a\\\\b"),
			(b"end\\", pull, b"end\\\\"),
			(b"a b*c", rules(false, false), b"a b*c"),
			(b"-x y", rules(false, false), b"./-x y"),
		];
		for (arg, rules, want) in cases {
			assert_eq!(
				safe_file_arg(arg, *rules),
				*want,
				"{:?}",
				String::from_utf8_lossy(arg)
			);
		}
		let relative =
			FileArgRules { escape: true, am_sender: false, trust_sender_args: false, relative_paths: true };
		assert_eq!(safe_file_arg(b"~/x", relative), b"\\~/x");
		assert_eq!(safe_file_arg(b"~/./x", relative), b"~/./x");
		let trusted =
			FileArgRules { escape: true, am_sender: false, trust_sender_args: true, relative_paths: true };
		assert_eq!(safe_file_arg(b"~/x", trusted), b"~/x");
	}

	#[test]
	fn child_argv_line_quotes_like_print_child_argv() {
		let line = child_argv_line("opening connection using:", &[b"ssh", b"host", b"a b", b""]);
		assert_eq!(line, b"opening connection using: ssh host \"a b\"   (4 args)\n");
	}

	#[test]
	fn secluded_stream_is_nul_separated() {
		let args = vec![b"rsync".to_vec(), b".".to_vec(), b"a b*c".to_vec(), Vec::new()];
		assert_eq!(secluded_stream(&args), b"rsync\0.\0a b*c\0.\0\0");
	}

	#[test]
	fn local_pair_transfers_both_ways_and_reports_eof() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (mut client, mut server) = local_pair(Arc::clone(&cancel));
		let big: Vec<u8> = (0..pipe_capacity() * 3).map(|i| (i % 251) as u8).collect();
		let expect = big.clone();
		let writer = std::thread::spawn(move || {
			client.writer.write_all(&big).unwrap();
			let mut reply = [0u8; 5];
			client.reader.read_exact(&mut reply).unwrap();
			drop(client.writer);
			reply
		});
		let mut got = vec![0u8; expect.len()];
		server.reader.read_exact(&mut got).unwrap();
		assert_eq!(got, expect);
		server.writer.write_all(b"hello").unwrap();
		assert_eq!(&writer.join().unwrap(), b"hello");
		let mut rest = Vec::new();
		server.reader.read_to_end(&mut rest).unwrap();
		assert!(rest.is_empty());
	}

	#[test]
	fn local_pair_cancel_unblocks_reader_and_writer() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (mut client, server) = local_pair(Arc::clone(&cancel));
		let flag = Arc::clone(&cancel);
		let started = Instant::now();
		let blocked = std::thread::spawn(move || {
			let mut buf = [0u8; 1];
			client.reader.read_exact(&mut buf).unwrap_err()
		});
		std::thread::sleep(Duration::from_millis(150));
		flag.store(true, Ordering::Relaxed);
		let err = blocked.join().unwrap();
		assert!(started.elapsed() < Duration::from_secs(5));
		let mapped = RsyncError::from_io(&err, 12);
		assert_eq!(mapped.code, RERR_SIGNAL);
		// A writer blocked on a full pipe is released too.
		let mut writer = server.writer;
		let err = writer.write_all(&vec![0u8; pipe_capacity() * 2]).unwrap_err();
		assert_eq!(RsyncError::from_io(&err, 12).code, RERR_SIGNAL);
	}

	#[test]
	fn dropping_a_reader_breaks_the_peer_writer() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (client, mut server) = local_pair(cancel);
		drop(client);
		let err = server.writer.write_all(b"x").unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
	}

	#[test]
	fn conn_ctl_deadline_fails_reads_with_the_configured_error() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (mut client, _server) = local_pair(cancel);
		let wanted = RsyncError::new(35, "[Receiver] connection timed out -- exiting").at("io.c", 173);
		client.ctl.set_deadline(Some((Instant::now() + Duration::from_millis(50), wanted)));
		let mut buf = [0u8; 1];
		let err = client.reader.read(&mut buf).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::TimedOut);
		let mapped = RsyncError::from_io(&err, 12);
		assert_eq!((mapped.code, mapped.site), (35, Some(("io.c", 173))));
	}

	#[test]
	fn shell_basename_strips_directories() {
		assert_eq!(shell_basename("/usr/bin/ssh"), "ssh");
		assert_eq!(shell_basename("rsh"), "rsh");
		if cfg!(windows) {
			assert_eq!(shell_basename("C:\\Tools\\SSH.EXE"), "SSH");
		}
	}

	#[cfg(unix)]
	mod shell {
		use std::{os::unix::fs::PermissionsExt, path::Path};

		use super::*;
		use crate::rsync::log::{LogConfig, Logger};

		fn logger() -> Logger {
			Logger::local(Box::new(io::sink()), Box::new(io::sink()), LogConfig::default())
		}

		fn script(dir: &Path, name: &str, body: &str) -> String {
			let path = dir.join(name);
			std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
			std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
			path.to_string_lossy().into_owned()
		}

		fn child_env(dir: &Path) -> ChildEnv {
			let (mut host, _) = crate::host::Host::for_test("rsync", "", dir);
			host.set_test_var("PATH", "/usr/bin:/bin");
			host.child_env()
		}

		fn base_cfg<'a>(rsh: &'a str, logger: &'a Logger) -> ShellConfig<'a> {
			ShellConfig {
				rsh,
				user: None,
				host: "host",
				remote_argv: &[],
				blocking_io: false,
				old_args: false,
				secluded_args: false,
				rsync_path: OsStr::new("rsync"),
				remote_is_sender: true,
				daemon: false,
				secluded_cut: None,
				files: &[],
				trust_sender_args: false,
				relative_paths: false,
				af_hint: 0,
				env: &[],
				logger,
			}
		}

		/// Runs a fake shell that prints each argv word NUL-terminated, then
		/// echoes its stdin; returns (argv, stdin bytes).
		fn capture(cfg: &ShellConfig<'_>, dir: &Path) -> (Vec<Vec<u8>>, Vec<u8>) {
			let cancel = Arc::new(AtomicBool::new(false));
			let mut conn = spawn_shell(&child_env(dir), cfg, cancel).expect("spawn");
			conn.writer.flush().unwrap();
			let writer = std::mem::replace(&mut conn.writer, Box::new(io::sink()));
			drop(writer);
			let mut out = Vec::new();
			conn.reader.read_to_end(&mut out).unwrap();
			conn.finish().unwrap();
			let split = out.windows(4).position(|w| w == b"\n--\n").expect("marker");
			let argv = out[..split].split(|&b| b == 0).filter(|a| !a.is_empty()).map(<[u8]>::to_vec);
			(argv.collect(), out[split + 4..].to_vec())
		}

		const DUMP: &str = "for a in \"$@\"; do printf '%s\\0' \"$a\"; done; printf '\\n--\\n'; cat\n";

		#[test]
		fn remote_command_line_matches_reference() {
			let dir = tempfile::tempdir().unwrap();
			let rsh = script(dir.path(), "fake-rsh", DUMP);
			let logger = logger();
			let server = [OsString::from("-logDtpre.iLsfxCIvu")];
			let files = [OsString::from("a b*c"), OsString::from("-y"), OsString::from("x\ny")];
			let cfg = ShellConfig {
				user: Some("u"),
				remote_argv: &server,
				files: &files,
				..base_cfg(&rsh, &logger)
			};
			let (argv, stdin) = capture(&cfg, dir.path());
			let want: Vec<&[u8]> = vec![
				b"-l", b"u", b"host", b"rsync", b"--server", b"--sender", b"-logDtpre.iLsfxCIvu",
				b".", b"a\\ b*c", b"./-y", b"x\\\ny",
			];
			assert_eq!(argv, want);
			assert!(stdin.is_empty());
		}

		#[test]
		fn secluded_args_go_over_the_pipe() {
			let dir = tempfile::tempdir().unwrap();
			let rsh = script(dir.path(), "fake-rsh", DUMP);
			let logger = logger();
			let server = [OsString::from("-se.LsfxCIvu")];
			let files = [OsString::from("a b*c")];
			let cfg = ShellConfig {
				remote_argv: &server,
				files: &files,
				secluded_args: true,
				secluded_cut: Some(1),
				..base_cfg(&rsh, &logger)
			};
			let (argv, stdin) = capture(&cfg, dir.path());
			let want: Vec<&[u8]> = vec![b"host", b"rsync", b"--server", b"--sender", b"-se.LsfxCIvu"];
			assert_eq!(argv, want);
			assert_eq!(stdin, b"rsync\0.\0a b*c\0\0");
		}

		#[test]
		fn daemon_over_shell_and_dash_l_rules() {
			let dir = tempfile::tempdir().unwrap();
			let rsh = script(dir.path(), "fake-rsh", DUMP);
			let with_l = format!("{rsh} -l bob");
			let logger = logger();
			let cfg = ShellConfig {
				user: Some("u"),
				daemon: true,
				rsync_path: OsStr::new("sudo rsync"),
				..base_cfg(&with_l, &logger)
			};
			let (argv, _) = capture(&cfg, dir.path());
			let want: Vec<&[u8]> =
				vec![b"-l", b"bob", b"host", b"sudo rsync", b"--server", b"--daemon", b"."];
			assert_eq!(argv, want);
			// Without the daemon, upstream still adds its own -l.
			let cfg = ShellConfig { user: Some("u"), ..base_cfg(&with_l, &logger) };
			let (argv, _) = capture(&cfg, dir.path());
			assert_eq!(&argv[..4], &[&b"-l"[..], b"bob", b"-l", b"u"]);
		}

		#[test]
		fn ssh_gets_the_address_family_hint() {
			let dir = tempfile::tempdir().unwrap();
			let rsh = script(dir.path(), "ssh", DUMP);
			let logger = logger();
			let cfg = ShellConfig { af_hint: 6, ..base_cfg(&rsh, &logger) };
			let (argv, _) = capture(&cfg, dir.path());
			assert_eq!(&argv[..2], &[&b"-6"[..], b"host"]);
			let other = script(dir.path(), "fakessh", DUMP);
			let cfg = ShellConfig { af_hint: 6, ..base_cfg(&other, &logger) };
			let (argv, _) = capture(&cfg, dir.path());
			assert_eq!(argv[0], b"host");
		}

		#[test]
		fn exit_status_maps_like_upstream() {
			let dir = tempfile::tempdir().unwrap();
			let logger = logger();
			for (body, code) in [("exit 0\n", None), ("exit 3\n", Some(3)), ("exit 127\n", Some(127)), ("exit 255\n", Some(255)), ("kill -TERM $$\n", Some(crate::rsync::exit::RERR_TERMINATED))] {
				let rsh = script(dir.path(), "status-rsh", body);
				let cancel = Arc::new(AtomicBool::new(false));
				let conn = spawn_shell(&child_env(dir.path()), &base_cfg(&rsh, &logger), cancel).unwrap();
				let got = conn.finish().err().map(|e| e.code);
				assert_eq!(got, code, "{body}");
			}
		}

		#[test]
		fn missing_shell_fails_like_failed_exec() {
			let dir = tempfile::tempdir().unwrap();
			let logger = logger();
			let cancel = Arc::new(AtomicBool::new(false));
			let err = spawn_shell(&child_env(dir.path()), &base_cfg("/nonexistent/ssh", &logger), cancel)
				.err()
				.expect("spawn must fail");
			assert_eq!(err.code, RERR_IPC);
			assert_eq!(err.site, Some(("pipe.c", 85)));
			let msg = err.message.unwrap();
			assert!(msg.starts_with("rsync: ["), "{msg}");
			assert!(
				msg.ends_with("Failed to exec /nonexistent/ssh: No such file or directory (2)"),
				"{msg}"
			);
		}

		#[test]
		fn cancel_kills_the_shell() {
			let dir = tempfile::tempdir().unwrap();
			let rsh = script(dir.path(), "sleepy-rsh", "exec sleep 30\n");
			let logger = logger();
			let cancel = Arc::new(AtomicBool::new(false));
			let mut conn =
				spawn_shell(&child_env(dir.path()), &base_cfg(&rsh, &logger), Arc::clone(&cancel))
					.unwrap();
			let flag = Arc::clone(&cancel);
			std::thread::spawn(move || {
				std::thread::sleep(Duration::from_millis(150));
				flag.store(true, Ordering::Relaxed);
			});
			let started = Instant::now();
			let mut buf = [0u8; 1];
			let err = conn.reader.read(&mut buf).unwrap_err();
			assert_eq!(RsyncError::from_io(&err, 12).code, RERR_SIGNAL);
			assert_eq!(conn.finish().unwrap_err().code, RERR_SIGNAL);
			assert!(started.elapsed() < Duration::from_secs(10));
		}
	}
}
